import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION,
  BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS,
  BACKSTAGE_NOTION_PARTITION_MAX_DEPTH,
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
  BACKSTAGE_NOTION_PARTITION_MAX_TAGS_PER_KIND,
  type BackstageNotionPartitionDefinition,
  type BackstageNotionPartitionUniverse,
  type BackstageNotionRetrievalTier,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import type { BackstageNotionRagCategory } from '@shared/backstage/backstageNotionRagCore.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '@shared/backstage/backstageNotionScopeIndex.js';
import { getPool } from '../client.js';

export const BACKSTAGE_NOTION_PARTITION_LEASE_MIN_MS = 1_000;
export const BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS = 15 * 60 * 1_000;
export const BACKSTAGE_NOTION_PROVIDER_DELAY_MAX_MS = 60_000;
export const BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS = 128;
export const BACKSTAGE_NOTION_SHADOW_COVERAGE_DEFAULT_SAMPLE_PAGE_IDS = 8;
export const BACKSTAGE_NOTION_SHADOW_COVERAGE_MAX_SAMPLE_PAGE_IDS = 16;
export const BACKSTAGE_NOTION_PARTITION_SCOPE_LOOKUP_MAX_PATH_SEGMENTS = 101;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_QUERY_CODE_POINTS = 32_000;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_LEXICAL_TOKENS = 256;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_LEXICAL_TOKEN_CODE_POINTS = 64;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_EXACT_SCAN_MAX_CHUNKS = 2_048;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_LEXICAL_POOL_SIZE = 256;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_SEMANTIC_POOL_PER_SHARD = 32;
export const BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS = 128;

const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHARD_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,63}$/u;
const SAFE_REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BIGINT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const TRANSACTION_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s'`;
const CANDIDATE_SEARCH_TIMEOUT_SQL = `SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '5s';
SET LOCAL work_mem = '8MB';
SET LOCAL temp_file_limit = '256MB'`;
const CONFIGURATION_ADVISORY_LOCK_NAMESPACE =
  'backstage-notion-partition-configuration-v1:';
const MANIFEST_PAGE_OWNERSHIP_UNIQUE_CONSTRAINT =
  'backstage_notion_manifest_page_ownership_pkey';
const BACKSTAGE_NOTION_RAG_CATEGORIES: ReadonlySet<BackstageNotionRagCategory> =
  new Set([
    'championships',
    'events',
    'general',
    'kayfabe',
    'nxt',
    'raw',
    'roster',
    'smackdown',
    'storylines',
  ]);

export type BackstageNotionPartitionRepositoryErrorCode =
  | 'BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION'
  | 'BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION'
  | 'BACKSTAGE_NOTION_PARTITION_LEASE_LOST'
  | 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD'
  | 'BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION'
  | 'BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE'
  | 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT'
  | 'BACKSTAGE_NOTION_PARTITION_AUTHORITY_UNAVAILABLE';

const ERROR_MESSAGES: Readonly<Record<BackstageNotionPartitionRepositoryErrorCode, string>> = {
  BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION:
    'The partition configuration generation conflicts with immutable storage.',
  BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION:
    'Normalized Notion material conflicts with immutable storage.',
  BACKSTAGE_NOTION_PARTITION_LEASE_LOST:
    'The partition synchronization lease is absent, expired, or stale.',
  BACKSTAGE_NOTION_PARTITION_STALE_HEAD:
    'The partition authority head changed before activation.',
  BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION:
    'The desired partition configuration changed before activation.',
  BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE:
    'A required partition shard is not eligible for manifest publication.',
  BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT:
    'A page is owned by more than one shard in the candidate manifest.',
  BACKSTAGE_NOTION_PARTITION_AUTHORITY_UNAVAILABLE:
    'The legacy Notion authority fence is not active for this universe.',
};

export class BackstageNotionPartitionRepositoryError extends Error {
  constructor(readonly code: BackstageNotionPartitionRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BackstageNotionPartitionRepositoryError';
  }
}

export class BackstageNotionPartitionRepositoryUnavailableError extends Error {
  readonly code = 'BACKSTAGE_NOTION_PARTITION_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Backstage Notion partition persistence requires PostgreSQL.');
    this.name = 'BackstageNotionPartitionRepositoryUnavailableError';
  }
}

export interface BackstageNotionPartitionHeadExpectation {
  readonly headGeneration: string;
  readonly snapshotGeneration: string;
  readonly currentPartitionVersionId: string;
  readonly activeSnapshotId: string | null;
}

export interface BackstageNotionUniverseHeadExpectation {
  readonly headGeneration: string;
  readonly manifestGeneration: string;
  readonly desiredConfigurationVersionId: string;
  readonly activeManifestId: string | null;
}

export interface BackstageNotionPartitionLeaseFence {
  readonly holderId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: string;
}

export interface BackstageNotionPartitionLease
  extends BackstageNotionPartitionLeaseFence {
  readonly universeId: string;
  readonly shardKey: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

export interface BackstageNotionProviderLease
  extends BackstageNotionPartitionLeaseFence {
  readonly providerKey: string;
  readonly modelKey: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly nextRequestAt: Date;
}

export interface RegisterBackstageNotionPartitionConfigurationInput {
  readonly configurationGeneration: string;
  readonly configurationHash: string;
  readonly universe: BackstageNotionPartitionUniverse;
  readonly expectedUniverseHead: BackstageNotionUniverseHeadExpectation | null;
}

export interface RegisteredBackstageNotionPartitionDefinition {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly rootPageId: string;
}

export interface RegisteredBackstageNotionPartitionConfiguration {
  readonly configurationVersionId: string;
  readonly universeId: string;
  readonly configurationGeneration: string;
  readonly configurationHash: string;
  readonly reused: boolean;
  readonly universeHeadGeneration: string;
  readonly definitions: readonly RegisteredBackstageNotionPartitionDefinition[];
}

export interface StoreBackstageNotionChunkVersionInput {
  readonly universeId: string;
  readonly contentHash: string;
  readonly chunkerVersion: number;
  readonly content: string;
  readonly contentCodePoints: number;
}

export interface BackstageNotionStoredChunkVersion {
  readonly id: string;
  readonly reused: boolean;
}

export interface StoreBackstageNotionEmbeddingInput {
  readonly universeId: string;
  readonly chunkVersionId: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embedding: readonly number[];
}

export interface BackstageNotionStoredEmbedding {
  readonly chunkVersionId: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly embeddingNorm: number;
  readonly reused: boolean;
}

export interface BackstageNotionPageChunkReference {
  readonly ordinal: number;
  readonly chunkVersionId: string;
  readonly headingPath: readonly string[];
  readonly scopeHeadingPathKey: readonly string[];
  readonly headingOccurrencePath: readonly number[];
}

export interface StoreBackstageNotionPageVersionInput {
  readonly universeId: string;
  readonly pageId: string;
  readonly contentHash: string;
  readonly pageFormatVersion: number;
  readonly chunkerVersion: number;
  readonly markdown: string;
  readonly contentCodePoints: number;
  readonly chunks: readonly BackstageNotionPageChunkReference[];
}

export interface BackstageNotionStoredPageVersion {
  readonly id: string;
  readonly reused: boolean;
}

export interface FindBackstageNotionReusablePageMaterialInput {
  readonly universeId: string;
  readonly pageId: string;
  readonly contentHash: string;
  readonly pageFormatVersion: number;
  readonly chunkerVersion: number;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
}

export interface FindBackstageNotionReusableChunkMaterialsInput {
  readonly universeId: string;
  readonly contentHashes: readonly string[];
  readonly chunkerVersion: number;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
}

export interface BackstageNotionReusableChunkMaterial {
  readonly chunkVersionId: string;
  readonly contentHash: string;
  readonly content: string;
  readonly contentCodePoints: number;
  readonly embeddingAvailable: boolean;
}

export interface BackstageNotionReusablePageChunkMaterial
  extends BackstageNotionReusableChunkMaterial {
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  readonly scopeHeadingPathKey: readonly string[];
  readonly headingOccurrencePath: readonly number[];
}

export interface BackstageNotionReusablePageMaterial {
  readonly pageVersionId: string;
  readonly pageId: string;
  readonly contentHash: string;
  readonly pageFormatVersion: number;
  readonly chunkerVersion: number;
  readonly chunks: readonly BackstageNotionReusablePageChunkMaterial[];
}

export interface BackstageNotionShardSnapshotPageInput {
  readonly pageId: string;
  readonly pageVersionId: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly sourceLastEditedAt: Date | string;
  readonly depth: number;
  readonly path: readonly string[];
  readonly scopePath: readonly string[];
  readonly scopeTitleKey: string;
  readonly scopePathKey: readonly string[];
}

export interface BackstageNotionShardSnapshotOccurrenceInput {
  readonly pageId: string;
  readonly pageVersionId: string;
  readonly ordinal: number;
  readonly chunkVersionId: string;
  readonly category: BackstageNotionRagCategory;
}

export type BackstageNotionShardVerificationKind =
  | 'capture'
  | 'source_drift'
  | 'completeness';

export interface BackstageNotionShardVerificationInput {
  readonly kind: BackstageNotionShardVerificationKind;
  readonly resultHash: string;
  readonly verifiedAt: Date | string;
}

export interface ActivateBackstageNotionShardSnapshotInput {
  readonly snapshotId: string;
  readonly universeId: string;
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly rootPageId: string;
  readonly sourceManifestHash: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly indexFormatVersion: number;
  readonly sourceMaxLastEditedAt: Date | string;
  readonly expectedHead: BackstageNotionPartitionHeadExpectation;
  readonly lease: BackstageNotionPartitionLeaseFence;
  readonly pages: readonly BackstageNotionShardSnapshotPageInput[];
  readonly occurrences: readonly BackstageNotionShardSnapshotOccurrenceInput[];
  readonly verifications: readonly BackstageNotionShardVerificationInput[];
}

export interface ActivatedBackstageNotionShardSnapshot {
  readonly snapshotId: string;
  readonly universeId: string;
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly verifiedAt: Date;
  readonly headGeneration: string;
  readonly snapshotGeneration: string;
}

export type BackstageNotionManifestMemberDecision =
  | 'fresh'
  | 'retained_last_known_good';
export type BackstageNotionManifestOmissionDecision =
  | 'optional_unavailable'
  | 'optional_disabled';

export interface BackstageNotionManifestMemberInput {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
  readonly decision: BackstageNotionManifestMemberDecision;
  readonly verifiedAt: Date | string;
  readonly expectedHead: BackstageNotionPartitionHeadExpectation;
}

export interface BackstageNotionManifestOmissionInput {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly decision: BackstageNotionManifestOmissionDecision;
  readonly safeReasonCode: string;
  readonly expectedHead: BackstageNotionPartitionHeadExpectation;
}

export interface ActivateBackstageNotionUniverseManifestInput {
  readonly manifestId: string;
  readonly universeId: string;
  readonly configurationVersionId: string;
  readonly configurationGeneration: string;
  readonly configurationHash: string;
  readonly indexFormatVersion: number;
  readonly expectedUniverseHead: BackstageNotionUniverseHeadExpectation;
  readonly members: readonly BackstageNotionManifestMemberInput[];
  readonly omissions: readonly BackstageNotionManifestOmissionInput[];
}

export interface ActivatedBackstageNotionUniverseManifest {
  readonly manifestId: string;
  readonly universeId: string;
  readonly configurationVersionId: string;
  readonly memberCount: number;
  readonly omissionCount: number;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly headGeneration: string;
  readonly manifestGeneration: string;
}

export interface BackstageNotionPartitionSynchronizationActiveSnapshot {
  readonly snapshotId: string;
  readonly partitionVersionId: string;
  readonly sourceManifestHash: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
  readonly verifiedAt: Date;
}

export interface BackstageNotionPartitionSynchronizationShardState {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly rootPageId: string;
  readonly expectedHead: BackstageNotionPartitionHeadExpectation;
  readonly activeSnapshot: BackstageNotionPartitionSynchronizationActiveSnapshot | null;
}

export interface BackstageNotionPartitionSynchronizationState {
  readonly universeId: string;
  readonly configurationVersionId: string;
  readonly configurationGeneration: string;
  readonly configurationHash: string;
  readonly expectedUniverseHead: BackstageNotionUniverseHeadExpectation;
  readonly shards: readonly BackstageNotionPartitionSynchronizationShardState[];
}

export interface BackstageNotionPartitionShardPageInventoryItem {
  readonly pageId: string;
  readonly pageVersionId: string;
  readonly contentHash: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly path: readonly string[];
  readonly scopePath: readonly string[];
}

/**
 * Bounded identity-only comparison of the two active authority generations.
 * Page samples are retained for future protected diagnostics and must never be
 * written to ordinary worker logs.
 */
export interface BackstageNotionPartitionShadowCoverage {
  readonly universeId: string;
  readonly monolithSnapshotId: string | null;
  readonly partitionManifestId: string | null;
  readonly partitionConfigurationHash: string | null;
  readonly monolithPageCount: number;
  readonly monolithChunkCount: number;
  readonly partitionPageCount: number;
  readonly partitionChunkCount: number;
  readonly sharedPageCount: number;
  readonly monolithOnlyPageCount: number;
  readonly partitionOnlyPageCount: number;
  readonly monolithOnlyPageIds: readonly string[];
  readonly partitionOnlyPageIds: readonly string[];
}

export interface BackstageNotionActiveManifestRoutingMember {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: boolean;
  readonly decision: BackstageNotionManifestMemberDecision;
  readonly verifiedAt: Date;
  readonly snapshotCreatedAt: Date;
  readonly snapshotSealedAt: Date;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
}

export interface BackstageNotionActiveManifestRoutingOmission {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly retrievalTier: BackstageNotionRetrievalTier;
  readonly required: false;
  readonly decision: BackstageNotionManifestOmissionDecision;
  readonly safeReasonCode: string;
  readonly scopeTags: readonly string[];
  readonly categoryTags: readonly string[];
}

export interface BackstageNotionActiveManifestRoutingState {
  readonly universeId: string;
  readonly manifestId: string;
  readonly manifestGeneration: string;
  readonly configurationVersionId: string;
  readonly configurationGeneration: string;
  readonly configurationHash: string;
  readonly configurationCurrent: boolean;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
  readonly manifestCreatedAt: Date;
  readonly manifestSealedAt: Date;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly members: readonly BackstageNotionActiveManifestRoutingMember[];
  readonly omissions: readonly BackstageNotionActiveManifestRoutingOmission[];
}

export interface BackstageNotionManifestScopeOwnerLookup {
  readonly pageTitleKey: string;
  readonly pagePathKey: readonly string[] | null;
  readonly scopeKind: 'page' | 'subtree';
}

export type BackstageNotionManifestScopeOwnerResolution =
  | Readonly<{ status: 'not_found' | 'ambiguous' | 'invalid' }>
  | Readonly<{
      status: 'resolved';
      manifestId: string;
      shardKey: string;
      partitionVersionId: string;
      snapshotId: string;
      pageId: string;
      pageTitle: string;
      pagePath: readonly string[];
      scopeKind: 'page' | 'subtree';
      scopeChunkCount: number;
      scopePageCount: number;
    }>;

export interface BackstageNotionPartitionCandidateShard {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
}

export interface RankBackstageNotionPartitionCandidatesInput {
  readonly universeId: string;
  readonly manifestId: string;
  readonly configurationVersionId: string;
  readonly configurationHash: string;
  readonly embeddingModel: string;
  readonly embeddingVersion: number;
  readonly embeddingDimension: number;
  readonly indexFormatVersion: number;
  readonly shards: readonly BackstageNotionPartitionCandidateShard[];
  readonly queryText: string;
  readonly queryEmbedding: readonly number[];
  readonly limit: number;
}

export type BackstageNotionPartitionCandidateSearchStrategy =
  | 'exact_float8_hybrid_v1'
  | 'bounded_float8_hybrid_v1';

export interface BackstageNotionPartitionRankedCandidate {
  readonly shardKey: string;
  readonly partitionVersionId: string;
  readonly snapshotId: string;
  readonly pageId: string;
  readonly pageVersionId: string;
  readonly pageTitle: string;
  readonly pagePath: readonly string[];
  readonly canonicalUrl: string;
  readonly sourceLastEditedAt: Date;
  readonly ordinal: number;
  readonly chunkVersionId: string;
  readonly contentHash: string;
  readonly contentCodePoints: number;
  readonly content: string;
  readonly headingPath: readonly string[];
  readonly headingOccurrencePath: readonly number[];
  readonly category: BackstageNotionRagCategory;
  readonly semanticScore: number;
  readonly lexicalScore: number;
  readonly score: number;
}

export type BackstageNotionPartitionCandidateSearchResolution =
  | Readonly<{ status: 'invalid' }>
  | Readonly<{
      status: 'ready';
      searchVersion: typeof BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_VERSION;
      manifestId: string;
      strategy: BackstageNotionPartitionCandidateSearchStrategy;
      exhaustive: boolean;
      selectedShardCount: number;
      selectedChunkCount: number;
      candidatePoolCount: number;
      candidates: readonly BackstageNotionPartitionRankedCandidate[];
    }>;

type TimestampValue = Date | string;

interface ConfigurationRow {
  id: string;
  configuration_generation: string;
  configuration_hash: string;
  shard_count: number | string;
  state: string;
}

interface DefinitionRow {
  id: string;
  shard_key: string;
  root_page_id: string;
  configuration_version: number | string;
  display_name: string;
  retrieval_tier: string;
  is_required: boolean;
  scope_tags: unknown;
  category_tags: unknown;
  max_pages: number | string;
  max_chunks: number | string;
  max_depth: number | string;
  max_content_code_points: number | string;
  semantic_hash: string;
}

interface PartitionedUniverseHeadRow {
  desired_configuration_version_id: string;
  desired_configuration_generation: string;
  desired_configuration_hash: string;
  active_manifest_id: string | null;
  active_configuration_version_id: string | null;
  head_generation: number | string;
  manifest_generation: number | string;
}

interface ShardHeadRow {
  shard_key: string;
  current_partition_version_id: string;
  root_page_id: string;
  active_snapshot_id: string | null;
  head_generation: number | string;
  snapshot_generation: number | string;
}

interface SynchronizationShardRow extends ShardHeadRow {
  desired_configuration_version_id: string;
  desired_configuration_generation: string;
  desired_configuration_hash: string;
  active_manifest_id: string | null;
  universe_head_generation: number | string;
  manifest_generation: number | string;
  configured_shard_count: number | string;
  partition_version_id: string;
  configured_root_page_id: string;
  snapshot_partition_version_id: string | null;
  source_manifest_hash: string | null;
  embedding_model: string | null;
  embedding_version: number | string | null;
  embedding_dimension: number | string | null;
  index_format_version: number | string | null;
  last_verified_at: TimestampValue | null;
}

interface ShardLeaseRow {
  universe_id: string;
  shard_key: string;
  holder_id: string;
  lease_token: string;
  lease_generation: number | string;
  acquired_at: TimestampValue;
  expires_at: TimestampValue;
}

interface ProviderLeaseRow {
  provider_key: string;
  model_key: string;
  holder_id: string;
  lease_token: string;
  lease_generation: number | string;
  acquired_at: TimestampValue;
  expires_at: TimestampValue;
  next_request_at: TimestampValue;
}

interface ChunkVersionRow {
  id: string;
  content: string;
  content_code_points: number | string;
}

interface EmbeddingRow {
  chunk_version_id: string;
  embedding_model: string;
  embedding_version: number | string;
  embedding_dimension: number | string;
  embedding_norm: number | string;
  embedding: number[] | string;
}

interface PageVersionRow {
  id: string;
  markdown: string;
  content_code_points: number | string;
  chunk_count: number | string;
  state: string;
}

interface PageVersionChunkRow {
  ordinal: number | string;
  chunk_version_id: string;
  heading_path: unknown;
  scope_heading_path_key: unknown;
  heading_occurrence_path: unknown;
}

interface ReusablePageMaterialRow {
  page_version_id: string;
  page_id: string;
  page_content_hash: string;
  page_format_version: number | string;
  chunker_version: number | string;
  chunk_count: number | string;
  ordinal: number | string | null;
  chunk_version_id: string | null;
  chunk_content_hash: string | null;
  chunk_content: string | null;
  chunk_content_code_points: number | string | null;
  heading_path: unknown;
  scope_heading_path_key: unknown;
  heading_occurrence_path: unknown;
  embedding_available: boolean;
}

interface ReusableChunkMaterialRow {
  chunk_version_id: string;
  content_hash: string;
  content: string;
  content_code_points: number | string;
  embedding_available: boolean;
}

interface SnapshotPageMaterialRow {
  id: string;
  page_id: string;
  chunk_count: number | string;
  content_code_points: number | string;
  state: string;
}

interface ManifestSnapshotRow {
  id: string;
  shard_key: string;
  partition_version_id: string;
  page_count: number | string;
  chunk_count: number | string;
  embedding_model: string;
  embedding_version: number | string;
  embedding_dimension: number | string;
  index_format_version: number | string;
  state: string;
  latest_verified_at: TimestampValue | null;
}

interface ManifestOwnershipConflictRow {
  left_shard_key: string;
  right_shard_key: string;
}

interface SnapshotEmbeddingCoverageRow {
  page_id: string;
  ordinal: number | string;
  embedding_dimension: number | string;
}

interface ActiveManifestRoutingRow {
  manifest_id: string;
  manifest_generation: number | string;
  desired_configuration_version_id: string;
  desired_configuration_generation: string;
  desired_configuration_hash: string;
  configuration_version_id: string;
  configuration_generation: string;
  configuration_hash: string;
  configured_shard_count: number | string;
  configuration_state: string;
  embedding_model: string;
  embedding_version: number | string;
  embedding_dimension: number | string;
  index_format_version: number | string;
  member_count: number | string;
  omission_count: number | string;
  manifest_page_count: number | string;
  manifest_chunk_count: number | string;
  manifest_state: string;
  manifest_created_at: TimestampValue;
  manifest_sealed_at: TimestampValue | null;
  record_kind: string;
  shard_key: string;
  partition_version_id: string;
  retrieval_tier: string;
  is_required: boolean;
  scope_tags: unknown;
  category_tags: unknown;
  shard_snapshot_id: string | null;
  member_decision: string | null;
  member_verified_at: TimestampValue | null;
  snapshot_page_count: number | string | null;
  snapshot_chunk_count: number | string | null;
  snapshot_embedding_model: string | null;
  snapshot_embedding_version: number | string | null;
  snapshot_embedding_dimension: number | string | null;
  snapshot_index_format_version: number | string | null;
  snapshot_state: string | null;
  snapshot_created_at: TimestampValue | null;
  snapshot_sealed_at: TimestampValue | null;
  omission_decision: string | null;
  safe_reason_code: string | null;
}

interface ManifestScopeOwnerRow {
  manifest_id: string;
  shard_key: string | null;
  partition_version_id: string | null;
  shard_snapshot_id: string | null;
  page_id: string | null;
  page_title: string | null;
  scope_path: unknown | null;
  scope_chunk_count: number | string | null;
  scope_page_count: number | string | null;
}

interface PartitionCandidateSearchRow {
  record_kind: string;
  manifest_id: string;
  search_strategy: string;
  exhaustive: boolean;
  selected_shard_count: number | string;
  selected_chunk_count: number | string;
  candidate_pool_count: number | string;
  candidate_shard_count: number | string;
  invalid_embedding_count: number | string;
  shard_key: string | null;
  partition_version_id: string | null;
  shard_snapshot_id: string | null;
  page_id: string | null;
  page_version_id: string | null;
  page_title: string | null;
  page_path: unknown | null;
  canonical_url: string | null;
  source_last_edited_at: TimestampValue | null;
  ordinal: number | string | null;
  chunk_version_id: string | null;
  content_hash: string | null;
  content_code_points: number | string | null;
  content: string | null;
  heading_path: unknown | null;
  heading_occurrence_path: unknown | null;
  category: string | null;
  semantic_score: number | string | null;
  lexical_score: number | string | null;
  score: number | string | null;
}

function repositoryError(
  code: BackstageNotionPartitionRepositoryErrorCode
): BackstageNotionPartitionRepositoryError {
  return new BackstageNotionPartitionRepositoryError(code);
}

function normalizePattern(
  value: string,
  label: string,
  pattern: RegExp
): string {
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizeUniverseId(value: string): string {
  return normalizePattern(value, 'universeId', UNIVERSE_ID_PATTERN);
}

function normalizeShardKey(value: string): string {
  return normalizePattern(value, 'shardKey', SHARD_KEY_PATTERN);
}

function normalizeUuid(value: string, label: string): string {
  return normalizePattern(value.toLowerCase(), label, UUID_PATTERN);
}

function normalizeSha256(value: string, label: string): string {
  return normalizePattern(value.toLowerCase(), label, SHA256_PATTERN);
}

function normalizeRequiredText(value: string, label: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || Array.from(value).length < 1
    || Array.from(value).length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its supported range.`);
  }
  return value;
}

function normalizeDatabaseInteger(
  value: number | string,
  label: string,
  minimum = 0
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} is not a safe integer.`);
  }
  return parsed;
}

function normalizeGeneration(value: string, label: string, minimum = 0n): string {
  if (!BIGINT_PATTERN.test(value)) {
    throw new Error(`${label} is not a PostgreSQL BIGINT decimal.`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > POSTGRES_BIGINT_MAX) {
    throw new Error(`${label} is outside the PostgreSQL BIGINT range.`);
  }
  return parsed.toString();
}

function mapGeneration(value: number | string, label: string): string {
  return normalizeGeneration(String(value), label);
}

function incrementGeneration(value: string, label: string): string {
  const normalized = normalizeGeneration(value, label);
  const incremented = BigInt(normalized) + 1n;
  if (incremented > POSTGRES_BIGINT_MAX) {
    throw new Error(`${label} cannot be incremented.`);
  }
  return incremented.toString();
}

function normalizeDate(value: Date | string, label: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be a finite timestamp.`);
  }
  return parsed;
}

function parseDate(value: TimestampValue, label: string): Date {
  if (value instanceof Date) {
    return normalizeDate(value, label);
  }
  return normalizeDate(String(value), label);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeCandidateQuery(value: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length < 1
    || codePointLength(value) > BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_QUERY_CODE_POINTS
    || value.includes('\u0000')
  ) {
    throw new Error('queryText is outside its supported range.');
  }
  return value;
}

function buildCandidateLexicalProjection(value: string): string {
  const tokens = value
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => codePointLength(token) >= 3)
    .slice(0, BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_LEXICAL_TOKENS)
    .map(token => Array.from(token)
      .slice(0, BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_LEXICAL_TOKEN_CODE_POINTS)
      .join(''));
  return [...new Set(tokens)].map(token => `"${token}"`).join(' OR ');
}

function normalizeCandidateShards(
  value: readonly BackstageNotionPartitionCandidateShard[]
): readonly BackstageNotionPartitionCandidateShard[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  ) {
    throw new Error('shards is outside its supported range.');
  }
  const seenShardKeys = new Set<string>();
  const normalized = value.map((shard, index) => {
    const shardKey = normalizeShardKey(shard.shardKey);
    if (seenShardKeys.has(shardKey)) {
      throw new Error('shards contains a duplicate shardKey.');
    }
    seenShardKeys.add(shardKey);
    return Object.freeze({
      shardKey,
      partitionVersionId: normalizeUuid(
        shard.partitionVersionId,
        `shards[${index}].partitionVersionId`
      ),
      snapshotId: normalizeUuid(shard.snapshotId, `shards[${index}].snapshotId`),
    });
  });
  normalized.sort((left, right) => compareText(left.shardKey, right.shardKey));
  return Object.freeze(normalized);
}

function parseFiniteDatabaseNumber(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} is not finite.`);
  }
  return parsed;
}

function normalizeStringArray(
  value: readonly string[],
  label: string,
  maxLength: number,
  itemMaxLength: number
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze(value.map((item, index) =>
    normalizeRequiredText(item, `${label}[${index}]`, itemMaxLength)
  ));
}

function isNamedUniqueViolation(error: unknown, constraint: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '23505'
    && 'constraint' in error
    && (error as { constraint?: unknown }).constraint === constraint;
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

async function withBoundedTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    await client.query(TRANSACTION_TIMEOUT_SQL);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    discardClient = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(discardClient);
  }
}

async function withCandidateSearchTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(CANDIDATE_SEARCH_TIMEOUT_SQL);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    discardClient = !(await rollbackQuietly(client));
    throw error;
  } finally {
    client.release(discardClient);
  }
}

function partitionSemanticHash(definition: BackstageNotionPartitionDefinition): string {
  return sha256(JSON.stringify({
    format: 'backstage-notion-partition-definition-v1',
    version: BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION,
    universeId: definition.universeId,
    shardKey: definition.shardKey,
    rootPageId: definition.rootPageId,
    displayName: definition.displayName,
    retrievalTier: definition.retrievalTier,
    required: definition.required,
    scopeTags: definition.scopeTags,
    categoryTags: definition.categoryTags,
    capacity: definition.capacity,
  }));
}

interface PreparedDefinition {
  readonly partition_version_id: string;
  readonly universe_id: string;
  readonly shard_key: string;
  readonly root_page_id: string;
  readonly display_name: string;
  readonly retrieval_tier: string;
  readonly is_required: boolean;
  readonly scope_tags: readonly string[];
  readonly category_tags: readonly string[];
  readonly max_pages: number;
  readonly max_chunks: number;
  readonly max_depth: number;
  readonly max_content_code_points: number;
  readonly semantic_hash: string;
}

function prepareDefinitions(
  universe: BackstageNotionPartitionUniverse
): readonly PreparedDefinition[] {
  const universeId = normalizeUniverseId(universe.universeId);
  if (
    !Array.isArray(universe.shards)
    || universe.shards.length < 1
    || universe.shards.length > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  ) {
    throw new Error('universe.shards is outside its supported range.');
  }

  const seenKeys = new Set<string>();
  const seenRoots = new Set<string>();
  return Object.freeze([...universe.shards]
    .sort((left, right) => compareText(left.shardKey, right.shardKey))
    .map((definition, index) => {
      if (definition.universeId !== universeId) {
        throw new Error(`universe.shards[${index}] escaped its universe.`);
      }
      const shardKey = normalizeShardKey(definition.shardKey);
      const rootPageId = normalizeUuid(definition.rootPageId, `shards[${index}].rootPageId`);
      if (seenKeys.has(shardKey) || seenRoots.has(rootPageId)) {
        throw new Error('universe.shards contains duplicate identity.');
      }
      seenKeys.add(shardKey);
      seenRoots.add(rootPageId);
      if (!['hot', 'cold', 'archive'].includes(definition.retrievalTier)) {
        throw new Error(`shards[${index}].retrievalTier is invalid.`);
      }
      const scopeTags = [...definition.scopeTags].sort(compareText);
      const categoryTags = [...definition.categoryTags].sort(compareText);
      if (
        new Set(scopeTags).size !== scopeTags.length
        || new Set(categoryTags).size !== categoryTags.length
      ) {
        throw new Error(`shards[${index}] contains duplicate tags.`);
      }
      for (const [tagIndex, tag] of scopeTags.entries()) {
        normalizePattern(tag, `shards[${index}].scopeTags[${tagIndex}]`, TAG_PATTERN);
      }
      for (const [tagIndex, tag] of categoryTags.entries()) {
        normalizePattern(tag, `shards[${index}].categoryTags[${tagIndex}]`, TAG_PATTERN);
      }
      const displayName = normalizeRequiredText(
        definition.displayName,
        `shards[${index}].displayName`,
        160
      );
      const capacity = Object.freeze({
        maxPages: normalizeInteger(
          definition.capacity.maxPages,
          `shards[${index}].capacity.maxPages`,
          1,
          BACKSTAGE_NOTION_PARTITION_MAX_PAGES
        ),
        maxChunks: normalizeInteger(
          definition.capacity.maxChunks,
          `shards[${index}].capacity.maxChunks`,
          1,
          BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
        ),
        maxDepth: normalizeInteger(
          definition.capacity.maxDepth,
          `shards[${index}].capacity.maxDepth`,
          0,
          BACKSTAGE_NOTION_PARTITION_MAX_DEPTH
        ),
        maxContentCodePoints: normalizeInteger(
          definition.capacity.maxContentCodePoints,
          `shards[${index}].capacity.maxContentCodePoints`,
          1,
          BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS
        ),
      });
      const canonicalDefinition: BackstageNotionPartitionDefinition = Object.freeze({
        universeId,
        shardKey,
        rootPageId,
        displayName,
        retrievalTier: definition.retrievalTier,
        required: definition.required,
        scopeTags,
        categoryTags,
        capacity,
      });
      return Object.freeze({
        partition_version_id: randomUUID(),
        universe_id: universeId,
        shard_key: shardKey,
        root_page_id: rootPageId,
        display_name: displayName,
        retrieval_tier: definition.retrievalTier,
        is_required: definition.required,
        scope_tags: scopeTags,
        category_tags: categoryTags,
        max_pages: capacity.maxPages,
        max_chunks: capacity.maxChunks,
        max_depth: capacity.maxDepth,
        max_content_code_points: capacity.maxContentCodePoints,
        semantic_hash: partitionSemanticHash(canonicalDefinition),
      });
    }));
}

function definitionMatches(
  stored: DefinitionRow,
  expected: PreparedDefinition
): boolean {
  return stored.shard_key === expected.shard_key
    && normalizeUuid(stored.root_page_id, 'root_page_id') === expected.root_page_id
    && normalizeDatabaseInteger(
      stored.configuration_version,
      'configuration_version',
      1
    ) === BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION
    && stored.display_name === expected.display_name
    && stored.retrieval_tier === expected.retrieval_tier
    && stored.is_required === expected.is_required
    && JSON.stringify(parseJsonStringArray(stored.scope_tags))
      === JSON.stringify(expected.scope_tags)
    && JSON.stringify(parseJsonStringArray(stored.category_tags))
      === JSON.stringify(expected.category_tags)
    && normalizeDatabaseInteger(stored.max_pages, 'max_pages', 1) === expected.max_pages
    && normalizeDatabaseInteger(stored.max_chunks, 'max_chunks', 1) === expected.max_chunks
    && normalizeDatabaseInteger(stored.max_depth, 'max_depth') === expected.max_depth
    && normalizeDatabaseInteger(
      stored.max_content_code_points,
      'max_content_code_points',
      1
    ) === expected.max_content_code_points
    && normalizeSha256(stored.semantic_hash, 'semantic_hash') === expected.semantic_hash;
}

function canonicalNotionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replaceAll('-', '')}`;
}

function mapShardLease(row: ShardLeaseRow): BackstageNotionPartitionLease {
  return Object.freeze({
    universeId: normalizeUniverseId(row.universe_id),
    shardKey: normalizeShardKey(row.shard_key),
    holderId: normalizeRequiredText(row.holder_id, 'holder_id', 200),
    leaseToken: normalizeUuid(row.lease_token, 'lease_token'),
    leaseGeneration: mapGeneration(row.lease_generation, 'lease_generation'),
    acquiredAt: parseDate(row.acquired_at, 'acquired_at'),
    expiresAt: parseDate(row.expires_at, 'expires_at'),
  });
}

function mapProviderLease(row: ProviderLeaseRow): BackstageNotionProviderLease {
  return Object.freeze({
    providerKey: normalizePattern(row.provider_key, 'provider_key', PROVIDER_KEY_PATTERN),
    modelKey: normalizeRequiredText(row.model_key, 'model_key', 200),
    holderId: normalizeRequiredText(row.holder_id, 'holder_id', 200),
    leaseToken: normalizeUuid(row.lease_token, 'lease_token'),
    leaseGeneration: mapGeneration(row.lease_generation, 'lease_generation'),
    acquiredAt: parseDate(row.acquired_at, 'acquired_at'),
    expiresAt: parseDate(row.expires_at, 'expires_at'),
    nextRequestAt: parseDate(row.next_request_at, 'next_request_at'),
  });
}

function normalizeLeaseFence(
  lease: BackstageNotionPartitionLeaseFence,
  label = 'lease'
): BackstageNotionPartitionLeaseFence {
  return Object.freeze({
    holderId: normalizeRequiredText(lease.holderId, `${label}.holderId`, 200),
    leaseToken: normalizeUuid(lease.leaseToken, `${label}.leaseToken`),
    leaseGeneration: normalizeGeneration(
      lease.leaseGeneration,
      `${label}.leaseGeneration`,
      1n
    ),
  });
}

function normalizeUniverseHeadExpectation(
  expected: BackstageNotionUniverseHeadExpectation,
  label = 'expectedUniverseHead'
): BackstageNotionUniverseHeadExpectation {
  return Object.freeze({
    headGeneration: normalizeGeneration(expected.headGeneration, `${label}.headGeneration`),
    manifestGeneration: normalizeGeneration(
      expected.manifestGeneration,
      `${label}.manifestGeneration`
    ),
    desiredConfigurationVersionId: normalizeUuid(
      expected.desiredConfigurationVersionId,
      `${label}.desiredConfigurationVersionId`
    ),
    activeManifestId: expected.activeManifestId === null
      ? null
      : normalizeUuid(expected.activeManifestId, `${label}.activeManifestId`),
  });
}

function normalizeShardHeadExpectation(
  expected: BackstageNotionPartitionHeadExpectation,
  label = 'expectedHead'
): BackstageNotionPartitionHeadExpectation {
  return Object.freeze({
    headGeneration: normalizeGeneration(expected.headGeneration, `${label}.headGeneration`),
    snapshotGeneration: normalizeGeneration(
      expected.snapshotGeneration,
      `${label}.snapshotGeneration`
    ),
    currentPartitionVersionId: normalizeUuid(
      expected.currentPartitionVersionId,
      `${label}.currentPartitionVersionId`
    ),
    activeSnapshotId: expected.activeSnapshotId === null
      ? null
      : normalizeUuid(expected.activeSnapshotId, `${label}.activeSnapshotId`),
  });
}

function universeHeadMatches(
  row: PartitionedUniverseHeadRow,
  expected: BackstageNotionUniverseHeadExpectation
): boolean {
  return mapGeneration(row.head_generation, 'head_generation') === expected.headGeneration
    && mapGeneration(row.manifest_generation, 'manifest_generation')
      === expected.manifestGeneration
    && normalizeUuid(
      row.desired_configuration_version_id,
      'desired_configuration_version_id'
    ) === expected.desiredConfigurationVersionId
    && (row.active_manifest_id === null
      ? null
      : normalizeUuid(row.active_manifest_id, 'active_manifest_id'))
      === expected.activeManifestId;
}

function shardHeadMatches(
  row: ShardHeadRow,
  expected: BackstageNotionPartitionHeadExpectation
): boolean {
  return mapGeneration(row.head_generation, 'head_generation') === expected.headGeneration
    && mapGeneration(row.snapshot_generation, 'snapshot_generation')
      === expected.snapshotGeneration
    && normalizeUuid(
      row.current_partition_version_id,
      'current_partition_version_id'
    ) === expected.currentPartitionVersionId
    && (row.active_snapshot_id === null
      ? null
      : normalizeUuid(row.active_snapshot_id, 'active_snapshot_id'))
      === expected.activeSnapshotId;
}

interface PreparedPageChunkReference {
  readonly ordinal: number;
  readonly chunk_version_id: string;
  readonly heading_path: readonly string[];
  readonly scope_heading_path_key: readonly string[];
  readonly heading_occurrence_path: readonly number[];
}

interface ShadowCoverageRow {
  monolith_snapshot_id: string | null;
  partition_manifest_id: string | null;
  partition_configuration_hash: string | null;
  monolith_page_count: number | string;
  monolith_chunk_count: number | string;
  partition_page_count: number | string;
  partition_chunk_count: number | string;
  shared_page_count: number | string;
  monolith_only_page_count: number | string;
  partition_only_page_count: number | string;
  monolith_only_page_ids: unknown;
  partition_only_page_ids: unknown;
}

interface PreparedSnapshotPage {
  readonly page_id: string;
  readonly page_version_id: string;
  readonly parent_page_id: string | null;
  readonly title: string;
  readonly canonical_url: string;
  readonly source_last_edited_at: string;
  readonly depth: number;
  readonly path: readonly string[];
  readonly scope_path: readonly string[];
  readonly scope_title_key: string;
  readonly scope_path_key: readonly string[];
}

interface PreparedSnapshotOccurrence {
  readonly page_id: string;
  readonly page_version_id: string;
  readonly ordinal: number;
  readonly chunk_version_id: string;
  readonly category: BackstageNotionRagCategory;
}

interface PreparedVerification {
  readonly ordinal: number;
  readonly verification_kind: BackstageNotionShardVerificationKind;
  readonly result_hash: string;
  readonly verified_at: string;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeScopeKeyArray(
  value: readonly string[],
  label: string,
  expectedLength: number
): readonly string[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze(value.map((key, index) =>
    normalizeSha256(key, `${label}[${index}]`)
  ));
}

function normalizeHeadingOccurrencePath(
  value: readonly number[],
  label: string,
  expectedLength: number
): readonly number[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze(value.map((occurrence, index) => normalizeInteger(
    occurrence,
    `${label}[${index}]`,
    0,
    BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
  )));
}

function normalizePageChunks(
  chunks: readonly BackstageNotionPageChunkReference[]
): readonly PreparedPageChunkReference[] {
  if (!Array.isArray(chunks) || chunks.length > BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS) {
    throw new Error('chunks is outside its supported range.');
  }
  const prepared = [...chunks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((chunk, index) => {
      const headingPath = normalizeStringArray(
        chunk.headingPath,
        `chunks[${index}].headingPath`,
        32,
        500
      );
      const suppliedScopeKeys = normalizeScopeKeyArray(
        chunk.scopeHeadingPathKey,
        `chunks[${index}].scopeHeadingPathKey`,
        headingPath.length
      );
      const scopeHeadingPathKey = Object.freeze(
        normalizeBackstageNotionScopePath(headingPath)
      );
      if (!arraysEqual(suppliedScopeKeys, scopeHeadingPathKey)) {
        throw new Error(`chunks[${index}].scopeHeadingPathKey is not canonical.`);
      }
      return Object.freeze({
        ordinal: normalizeInteger(chunk.ordinal, `chunks[${index}].ordinal`, 0, 2047),
        chunk_version_id: normalizeUuid(
          chunk.chunkVersionId,
          `chunks[${index}].chunkVersionId`
        ),
        heading_path: headingPath,
        scope_heading_path_key: scopeHeadingPathKey,
        heading_occurrence_path: normalizeHeadingOccurrencePath(
          chunk.headingOccurrencePath,
          `chunks[${index}].headingOccurrencePath`,
          headingPath.length
        ),
      });
    });
  for (const [index, chunk] of prepared.entries()) {
    if (chunk.ordinal !== index) {
      throw new Error('chunks must have contiguous zero-based ordinals.');
    }
  }
  return Object.freeze(prepared);
}

function normalizeEmbedding(value: readonly number[]): {
  readonly embedding: readonly number[];
  readonly norm: number;
} {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192) {
    throw new Error('embedding is outside its supported range.');
  }
  const embedding = Object.freeze(value.map((component, index) => {
    if (!Number.isFinite(component)) {
      throw new Error(`embedding[${index}] must be finite.`);
    }
    return component;
  }));
  const norm = Math.hypot(...embedding);
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error('embedding must have a finite non-zero norm.');
  }
  return Object.freeze({ embedding, norm });
}

function parseEmbedding(value: number[] | string): readonly number[] {
  const raw = Array.isArray(value)
    ? value
    : value.startsWith('{') && value.endsWith('}')
      ? value.slice(1, -1).split(',').map(component => Number(component))
      : [];
  if (!raw.every(component => Number.isFinite(component))) {
    throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
  }
  return raw;
}

function parseJsonStringArray(value: unknown): readonly string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
  }
  return parsed;
}

function parseRoutingTags(value: unknown, label: string): readonly string[] {
  const tags = parseJsonStringArray(value).map((tag, index) => normalizePattern(
    tag,
    `${label}[${index}]`,
    TAG_PATTERN
  ));
  if (
    tags.length > BACKSTAGE_NOTION_PARTITION_MAX_TAGS_PER_KIND
    || new Set(tags).size !== tags.length
  ) {
    throw new Error(`${label} violates the routing tag contract.`);
  }
  return Object.freeze([...tags].sort(compareText));
}

function parseRetrievalTier(
  value: string,
  label: string
): BackstageNotionRetrievalTier {
  if (value !== 'hot' && value !== 'cold' && value !== 'archive') {
    throw new Error(`${label} is not a supported retrieval tier.`);
  }
  return value;
}

function normalizeShadowCoveragePageIds(
  value: unknown,
  label: string,
  maximum: number
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} exceeds its bounded sample contract.`);
  }
  return Object.freeze(value.map((pageId, index) => {
    if (typeof pageId !== 'string') {
      throw new Error(`${label}[${index}] is not a page UUID.`);
    }
    return normalizeUuid(pageId, `${label}[${index}]`);
  }));
}

function parseJsonIntegerArray(value: unknown): readonly number[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || !parsed.every(item => Number.isSafeInteger(item))) {
    throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
  }
  return parsed as number[];
}

function normalizeSnapshotPages(
  pages: readonly BackstageNotionShardSnapshotPageInput[],
  rootPageId: string
): readonly PreparedSnapshotPage[] {
  if (
    !Array.isArray(pages)
    || pages.length < 1
    || pages.length > BACKSTAGE_NOTION_PARTITION_MAX_PAGES
  ) {
    throw new Error('pages is outside its supported range.');
  }
  const seenPageIds = new Set<string>();
  const prepared = pages.map((page, index) => {
    const pageId = normalizeUuid(page.pageId, `pages[${index}].pageId`);
    if (seenPageIds.has(pageId)) {
      throw new Error('pages contains a duplicate pageId.');
    }
    seenPageIds.add(pageId);
    const depth = normalizeInteger(
      page.depth,
      `pages[${index}].depth`,
      0,
      BACKSTAGE_NOTION_PARTITION_MAX_DEPTH
    );
    if (!Array.isArray(page.path)) {
      throw new Error(`pages[${index}].path is invalid.`);
    }
    const path = page.path.map((pathPageId: string, pathIndex: number) => normalizeUuid(
      pathPageId,
      `pages[${index}].path[${pathIndex}]`
    ));
    const title = normalizeRequiredText(page.title, `pages[${index}].title`, 500);
    const scopePath = normalizeStringArray(
      page.scopePath,
      `pages[${index}].scopePath`,
      BACKSTAGE_NOTION_PARTITION_MAX_DEPTH + 1,
      500
    );
    const suppliedScopeTitleKey = normalizeSha256(
      page.scopeTitleKey,
      `pages[${index}].scopeTitleKey`
    );
    const suppliedScopePathKey = normalizeScopeKeyArray(
      page.scopePathKey,
      `pages[${index}].scopePathKey`,
      scopePath.length
    );
    const scopeTitleKey = normalizeBackstageNotionScopeKey(title);
    const scopePathKey = Object.freeze(normalizeBackstageNotionScopePath(scopePath));
    const canonicalUrl = canonicalNotionPageUrl(pageId);
    if (
      path.length !== depth + 1
      || path[0] !== rootPageId
      || path[path.length - 1] !== pageId
    ) {
      throw new Error(`pages[${index}].path is not an exact rooted path.`);
    }
    if (page.canonicalUrl !== canonicalUrl) {
      throw new Error(`pages[${index}].canonicalUrl is not canonical.`);
    }
    if (
      scopePath.length !== depth + 1
      || scopePath[scopePath.length - 1] !== title
      || suppliedScopeTitleKey !== scopeTitleKey
      || !arraysEqual(suppliedScopePathKey, scopePathKey)
    ) {
      throw new Error(`pages[${index}] does not contain canonical scope metadata.`);
    }
    return Object.freeze({
      page_id: pageId,
      page_version_id: normalizeUuid(
        page.pageVersionId,
        `pages[${index}].pageVersionId`
      ),
      parent_page_id: page.parentPageId === null
        ? null
        : normalizeUuid(page.parentPageId, `pages[${index}].parentPageId`),
      title,
      canonical_url: canonicalUrl,
      source_last_edited_at: normalizeDate(
        page.sourceLastEditedAt,
        `pages[${index}].sourceLastEditedAt`
      ).toISOString(),
      depth,
      path: Object.freeze(path),
      scope_path: scopePath,
      scope_title_key: scopeTitleKey,
      scope_path_key: scopePathKey,
    });
  });
  const byPageId = new Map(prepared.map(page => [page.page_id, page]));
  for (const page of prepared) {
    if (page.page_id === rootPageId) {
      if (
        page.parent_page_id !== null
        || page.depth !== 0
        || page.scope_path.length !== 1
      ) {
        throw new Error('The root page must be the sole depth-zero page.');
      }
      continue;
    }
    const parent = page.parent_page_id === null
      ? undefined
      : byPageId.get(page.parent_page_id);
    if (
      !parent
      || page.depth !== parent.depth + 1
      || page.path.length - 1 !== parent.path.length
      || parent.path.some((parentPathPageId: string, index: number) =>
        page.path[index] !== parentPathPageId
      )
      || page.scope_path.length - 1 !== parent.scope_path.length
      || parent.scope_path.some((parentScopeTitle: string, index: number) =>
        page.scope_path[index] !== parentScopeTitle
      )
    ) {
      throw new Error('pages contains an invalid parent relationship.');
    }
  }
  if (!byPageId.has(rootPageId)) {
    throw new Error('pages does not contain the configured root page.');
  }
  return Object.freeze([...prepared].sort((left, right) =>
    left.depth - right.depth || compareText(left.page_id, right.page_id)
  ));
}

function normalizeOccurrences(
  occurrences: readonly BackstageNotionShardSnapshotOccurrenceInput[],
  pages: readonly PreparedSnapshotPage[]
): readonly PreparedSnapshotOccurrence[] {
  if (
    !Array.isArray(occurrences)
    || occurrences.length < 1
    || occurrences.length > BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
  ) {
    throw new Error('occurrences is outside its supported range.');
  }
  const pageVersions = new Map(pages.map(page => [page.page_id, page.page_version_id]));
  const seen = new Set<string>();
  const prepared = occurrences.map((occurrence, index) => {
    const pageId = normalizeUuid(occurrence.pageId, `occurrences[${index}].pageId`);
    const pageVersionId = normalizeUuid(
      occurrence.pageVersionId,
      `occurrences[${index}].pageVersionId`
    );
    const ordinal = normalizeInteger(
      occurrence.ordinal,
      `occurrences[${index}].ordinal`,
      0,
      2047
    );
    if (pageVersions.get(pageId) !== pageVersionId) {
      throw new Error('occurrences escaped the supplied page versions.');
    }
    const occurrenceKey = `${pageId}:${ordinal}`;
    if (seen.has(occurrenceKey)) {
      throw new Error('occurrences contains a duplicate page ordinal.');
    }
    seen.add(occurrenceKey);
    return Object.freeze({
      page_id: pageId,
      page_version_id: pageVersionId,
      ordinal,
      chunk_version_id: normalizeUuid(
        occurrence.chunkVersionId,
        `occurrences[${index}].chunkVersionId`
      ),
      category: (() => {
        if (!BACKSTAGE_NOTION_RAG_CATEGORIES.has(occurrence.category)) {
          throw new Error(`occurrences[${index}].category is invalid.`);
        }
        return occurrence.category;
      })(),
    });
  });
  return Object.freeze([...prepared].sort((left, right) =>
    compareText(left.page_id, right.page_id) || left.ordinal - right.ordinal
  ));
}

function normalizeVerifications(
  verifications: readonly BackstageNotionShardVerificationInput[]
): readonly PreparedVerification[] {
  if (!Array.isArray(verifications) || verifications.length < 2 || verifications.length > 3) {
    throw new Error('verifications is outside its supported range.');
  }
  const order: Readonly<Record<BackstageNotionShardVerificationKind, number>> = {
    capture: 0,
    source_drift: 1,
    completeness: 2,
  };
  const seen = new Set<BackstageNotionShardVerificationKind>();
  const sorted = [...verifications].sort(
    (
      left: BackstageNotionShardVerificationInput,
      right: BackstageNotionShardVerificationInput
    ) => order[left.kind] - order[right.kind]
  );
  const prepared = sorted.map((verification, index) => {
    if (!Object.hasOwn(order, verification.kind) || seen.has(verification.kind)) {
      throw new Error('verifications contains an unsupported or duplicate kind.');
    }
    seen.add(verification.kind);
    return Object.freeze({
      ordinal: index,
      verification_kind: verification.kind,
      result_hash: normalizeSha256(
        verification.resultHash,
        `verifications[${index}].resultHash`
      ),
      verified_at: normalizeDate(
        verification.verifiedAt,
        `verifications[${index}].verifiedAt`
      ).toISOString(),
    });
  });
  if (!seen.has('source_drift') || !seen.has('completeness')) {
    throw new Error('verifications requires source_drift and completeness evidence.');
  }
  return Object.freeze(prepared);
}

function latestRequiredVerification(
  verifications: readonly PreparedVerification[]
): Date {
  return new Date(Math.max(...verifications
    .filter(verification => verification.verification_kind !== 'capture')
    .map(verification => new Date(verification.verified_at).getTime())));
}

export class PostgresBackstageNotionPartitionRepository {
  constructor(private readonly pool: Pool) {}

  async loadUniverseHead(
    universeId: string
  ): Promise<BackstageNotionUniverseHeadExpectation | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const result = await this.pool.query<PartitionedUniverseHeadRow>(
      `SELECT
         desired_configuration_version_id,
         desired_configuration_generation,
         desired_configuration_hash,
         active_manifest_id,
         active_configuration_version_id,
         head_generation,
         manifest_generation
       FROM public.backstage_notion_partitioned_universe_heads
       WHERE universe_id = $1`,
      [normalizedUniverseId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return Object.freeze({
      headGeneration: mapGeneration(row.head_generation, 'head_generation'),
      manifestGeneration: mapGeneration(
        row.manifest_generation,
        'manifest_generation'
      ),
      desiredConfigurationVersionId: normalizeUuid(
        row.desired_configuration_version_id,
        'desired_configuration_version_id'
      ),
      activeManifestId: row.active_manifest_id === null
        ? null
        : normalizeUuid(row.active_manifest_id, 'active_manifest_id'),
    });
  }

  async loadShadowCoverage(
    universeId: string,
    samplePageIdLimit = BACKSTAGE_NOTION_SHADOW_COVERAGE_DEFAULT_SAMPLE_PAGE_IDS
  ): Promise<BackstageNotionPartitionShadowCoverage> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedSampleLimit = normalizeInteger(
      samplePageIdLimit,
      'samplePageIdLimit',
      0,
      BACKSTAGE_NOTION_SHADOW_COVERAGE_MAX_SAMPLE_PAGE_IDS
    );
    const result = await this.pool.query<ShadowCoverageRow>(
      `WITH selected_heads AS MATERIALIZED (
         SELECT
           requested.universe_id,
           CASE
             WHEN legacy_head.authority = 'notion'
             THEN legacy_head.active_snapshot_id
             ELSE NULL
           END AS monolith_snapshot_id,
           partition_head.active_manifest_id AS partition_manifest_id
         FROM (VALUES ($1::TEXT)) AS requested(universe_id)
         LEFT JOIN public.backstage_notion_universe_heads AS legacy_head
           ON legacy_head.universe_id = requested.universe_id
         LEFT JOIN public.backstage_notion_partitioned_universe_heads AS partition_head
           ON partition_head.universe_id = requested.universe_id
       ),
       monolith_generation AS MATERIALIZED (
         SELECT snapshot.id, snapshot.page_count, snapshot.chunk_count
         FROM selected_heads AS head
         JOIN public.backstage_notion_snapshots AS snapshot
           ON snapshot.universe_id = head.universe_id
          AND snapshot.id = head.monolith_snapshot_id
       ),
       partition_generation AS MATERIALIZED (
         SELECT
           manifest.id,
           manifest.configuration_hash,
           manifest.page_count,
           manifest.chunk_count
         FROM selected_heads AS head
         JOIN public.backstage_notion_universe_manifests AS manifest
           ON manifest.universe_id = head.universe_id
          AND manifest.id = head.partition_manifest_id
          AND manifest.state = 'sealed'
       ),
       monolith_pages AS MATERIALIZED (
         SELECT page.page_id
         FROM selected_heads AS head
         JOIN public.backstage_notion_snapshot_pages AS page
           ON page.universe_id = head.universe_id
          AND page.snapshot_id = head.monolith_snapshot_id
       ),
       partition_pages AS MATERIALIZED (
         SELECT ownership.page_id::TEXT AS page_id
         FROM selected_heads AS head
         JOIN public.backstage_notion_manifest_page_ownership AS ownership
           ON ownership.universe_id = head.universe_id
          AND ownership.manifest_id = head.partition_manifest_id
       )
       SELECT
         (SELECT id::TEXT FROM monolith_generation) AS monolith_snapshot_id,
         (SELECT id::TEXT FROM partition_generation) AS partition_manifest_id,
         (SELECT configuration_hash FROM partition_generation)
           AS partition_configuration_hash,
         COALESCE((SELECT page_count FROM monolith_generation), 0)
           AS monolith_page_count,
         COALESCE((SELECT chunk_count FROM monolith_generation), 0)
           AS monolith_chunk_count,
         COALESCE((SELECT page_count FROM partition_generation), 0)
           AS partition_page_count,
         COALESCE((SELECT chunk_count FROM partition_generation), 0)
           AS partition_chunk_count,
         (SELECT COUNT(*)
            FROM monolith_pages AS monolith_page
            JOIN partition_pages AS partition_page USING (page_id))
           AS shared_page_count,
         (SELECT COUNT(*)
            FROM monolith_pages AS monolith_page
            WHERE NOT EXISTS (
              SELECT 1
              FROM partition_pages AS partition_page
              WHERE partition_page.page_id = monolith_page.page_id
            )) AS monolith_only_page_count,
         (SELECT COUNT(*)
            FROM partition_pages AS partition_page
            WHERE NOT EXISTS (
              SELECT 1
              FROM monolith_pages AS monolith_page
              WHERE monolith_page.page_id = partition_page.page_id
            )) AS partition_only_page_count,
         ARRAY(
           SELECT monolith_page.page_id
           FROM monolith_pages AS monolith_page
           WHERE NOT EXISTS (
             SELECT 1
             FROM partition_pages AS partition_page
             WHERE partition_page.page_id = monolith_page.page_id
           )
           ORDER BY monolith_page.page_id
           LIMIT $2
         ) AS monolith_only_page_ids,
         ARRAY(
           SELECT partition_page.page_id
           FROM partition_pages AS partition_page
           WHERE NOT EXISTS (
             SELECT 1
             FROM monolith_pages AS monolith_page
             WHERE monolith_page.page_id = partition_page.page_id
           )
           ORDER BY partition_page.page_id
           LIMIT $2
         ) AS partition_only_page_ids`,
      [normalizedUniverseId, normalizedSampleLimit]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Shadow coverage query returned no result.');
    }
    const monolithSnapshotId = row.monolith_snapshot_id === null
      ? null
      : normalizeUuid(row.monolith_snapshot_id, 'monolith_snapshot_id');
    const partitionManifestId = row.partition_manifest_id === null
      ? null
      : normalizeUuid(row.partition_manifest_id, 'partition_manifest_id');
    const partitionConfigurationHash = row.partition_configuration_hash === null
      ? null
      : normalizeSha256(
          row.partition_configuration_hash,
          'partition_configuration_hash'
        );
    const monolithPageCount = normalizeDatabaseInteger(
      row.monolith_page_count,
      'monolith_page_count'
    );
    const monolithChunkCount = normalizeDatabaseInteger(
      row.monolith_chunk_count,
      'monolith_chunk_count'
    );
    const partitionPageCount = normalizeDatabaseInteger(
      row.partition_page_count,
      'partition_page_count'
    );
    const partitionChunkCount = normalizeDatabaseInteger(
      row.partition_chunk_count,
      'partition_chunk_count'
    );
    const sharedPageCount = normalizeDatabaseInteger(
      row.shared_page_count,
      'shared_page_count'
    );
    const monolithOnlyPageCount = normalizeDatabaseInteger(
      row.monolith_only_page_count,
      'monolith_only_page_count'
    );
    const partitionOnlyPageCount = normalizeDatabaseInteger(
      row.partition_only_page_count,
      'partition_only_page_count'
    );
    const monolithOnlyPageIds = normalizeShadowCoveragePageIds(
      row.monolith_only_page_ids,
      'monolith_only_page_ids',
      normalizedSampleLimit
    );
    const partitionOnlyPageIds = normalizeShadowCoveragePageIds(
      row.partition_only_page_ids,
      'partition_only_page_ids',
      normalizedSampleLimit
    );
    if (
      (monolithSnapshotId === null
        && (monolithPageCount !== 0 || monolithChunkCount !== 0))
      || (partitionManifestId === null
        && (
          partitionConfigurationHash !== null
          || partitionPageCount !== 0
          || partitionChunkCount !== 0
        ))
      || (partitionManifestId !== null && partitionConfigurationHash === null)
      || monolithPageCount !== sharedPageCount + monolithOnlyPageCount
      || partitionPageCount !== sharedPageCount + partitionOnlyPageCount
      || monolithOnlyPageIds.length > monolithOnlyPageCount
      || partitionOnlyPageIds.length > partitionOnlyPageCount
    ) {
      throw new Error('Shadow coverage result is internally inconsistent.');
    }
    return Object.freeze({
      universeId: normalizedUniverseId,
      monolithSnapshotId,
      partitionManifestId,
      partitionConfigurationHash,
      monolithPageCount,
      monolithChunkCount,
      partitionPageCount,
      partitionChunkCount,
      sharedPageCount,
      monolithOnlyPageCount,
      partitionOnlyPageCount,
      monolithOnlyPageIds,
      partitionOnlyPageIds,
    });
  }

  async loadActiveManifestRoutingState(
    universeId: string
  ): Promise<BackstageNotionActiveManifestRoutingState | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const result = await this.pool.query<ActiveManifestRoutingRow>(
      `WITH pinned_manifest AS MATERIALIZED (
         SELECT
           partition_head.manifest_generation,
           partition_head.desired_configuration_version_id,
           partition_head.desired_configuration_generation,
           partition_head.desired_configuration_hash,
           manifest.id AS manifest_id,
           manifest.partition_configuration_version_id
             AS configuration_version_id,
           manifest.configuration_generation,
           manifest.configuration_hash,
           configuration.shard_count AS configured_shard_count,
           configuration.state AS configuration_state,
           manifest.embedding_model,
           manifest.embedding_version,
           manifest.embedding_dimension,
           manifest.index_format_version,
           manifest.member_count,
           manifest.omission_count,
           manifest.page_count AS manifest_page_count,
           manifest.chunk_count AS manifest_chunk_count,
           manifest.state AS manifest_state,
           manifest.created_at AS manifest_created_at,
           manifest.sealed_at AS manifest_sealed_at
         FROM public.backstage_notion_universe_heads AS authority_head
         JOIN public.backstage_notion_partitioned_universe_heads AS partition_head
           ON partition_head.universe_id = authority_head.universe_id
         JOIN public.backstage_notion_universe_manifests AS manifest
           ON manifest.universe_id = partition_head.universe_id
          AND manifest.id = partition_head.active_manifest_id
          AND manifest.partition_configuration_version_id =
            partition_head.active_configuration_version_id
          AND manifest.state = 'sealed'
         JOIN public.backstage_notion_partition_configuration_versions
           AS configuration
           ON configuration.universe_id = manifest.universe_id
          AND configuration.id = manifest.partition_configuration_version_id
          AND configuration.configuration_generation =
            manifest.configuration_generation
          AND configuration.configuration_hash = manifest.configuration_hash
          AND configuration.state = 'sealed'
         WHERE authority_head.universe_id = $1
           AND authority_head.authority = 'notion'
       ),
       manifest_records AS MATERIALIZED (
         SELECT
           'member'::TEXT AS record_kind,
           definition.shard_key,
           definition.id AS partition_version_id,
           definition.retrieval_tier,
           member.is_required,
           definition.scope_tags,
           definition.category_tags,
           member.shard_snapshot_id,
           member.decision AS member_decision,
           member.verified_at AS member_verified_at,
           snapshot.page_count AS snapshot_page_count,
           snapshot.chunk_count AS snapshot_chunk_count,
           snapshot.embedding_model AS snapshot_embedding_model,
           snapshot.embedding_version AS snapshot_embedding_version,
           snapshot.embedding_dimension AS snapshot_embedding_dimension,
           snapshot.index_format_version AS snapshot_index_format_version,
           snapshot.state AS snapshot_state,
           snapshot.created_at AS snapshot_created_at,
           snapshot.sealed_at AS snapshot_sealed_at,
           NULL::TEXT AS omission_decision,
           NULL::TEXT AS safe_reason_code
         FROM pinned_manifest AS pinned
         JOIN public.backstage_notion_universe_manifest_shards AS member
           ON member.universe_id = $1
          AND member.manifest_id = pinned.manifest_id
         JOIN public.backstage_notion_partition_configuration_members
           AS configured_member
           ON configured_member.universe_id = member.universe_id
          AND configured_member.partition_configuration_version_id =
            pinned.configuration_version_id
          AND configured_member.configuration_generation =
            pinned.configuration_generation
          AND configured_member.shard_key = member.shard_key
          AND configured_member.partition_version_id = member.partition_version_id
         JOIN public.backstage_notion_partition_versions AS definition
           ON definition.universe_id = configured_member.universe_id
          AND definition.shard_key = configured_member.shard_key
          AND definition.id = configured_member.partition_version_id
         JOIN public.backstage_notion_shard_snapshots AS snapshot
           ON snapshot.universe_id = member.universe_id
          AND snapshot.shard_key = member.shard_key
          AND snapshot.partition_version_id = member.partition_version_id
          AND snapshot.id = member.shard_snapshot_id
         WHERE member.is_required = definition.is_required

         UNION ALL

         SELECT
           'omission'::TEXT AS record_kind,
           definition.shard_key,
           definition.id AS partition_version_id,
           definition.retrieval_tier,
           definition.is_required,
           definition.scope_tags,
           definition.category_tags,
           NULL::UUID AS shard_snapshot_id,
           NULL::TEXT AS member_decision,
           NULL::TIMESTAMPTZ AS member_verified_at,
           NULL::INTEGER AS snapshot_page_count,
           NULL::INTEGER AS snapshot_chunk_count,
           NULL::TEXT AS snapshot_embedding_model,
           NULL::INTEGER AS snapshot_embedding_version,
           NULL::INTEGER AS snapshot_embedding_dimension,
           NULL::INTEGER AS snapshot_index_format_version,
           NULL::TEXT AS snapshot_state,
           NULL::TIMESTAMPTZ AS snapshot_created_at,
           NULL::TIMESTAMPTZ AS snapshot_sealed_at,
           omission.decision AS omission_decision,
           omission.safe_reason_code
         FROM pinned_manifest AS pinned
         JOIN public.backstage_notion_universe_manifest_omissions AS omission
           ON omission.universe_id = $1
          AND omission.manifest_id = pinned.manifest_id
         JOIN public.backstage_notion_partition_configuration_members
           AS configured_member
           ON configured_member.universe_id = omission.universe_id
          AND configured_member.partition_configuration_version_id =
            pinned.configuration_version_id
          AND configured_member.configuration_generation =
            pinned.configuration_generation
          AND configured_member.shard_key = omission.shard_key
          AND configured_member.partition_version_id = omission.partition_version_id
         JOIN public.backstage_notion_partition_versions AS definition
           ON definition.universe_id = configured_member.universe_id
          AND definition.shard_key = configured_member.shard_key
          AND definition.id = configured_member.partition_version_id
       )
       SELECT pinned.*, record.*
       FROM pinned_manifest AS pinned
       JOIN manifest_records AS record ON TRUE
       ORDER BY record.shard_key, record.record_kind
       LIMIT $2`,
      [
        normalizedUniverseId,
        BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE + 1,
      ]
    );
    if (result.rows.length === 0) {
      return null;
    }
    if (result.rows.length > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE) {
      throw new Error('Active manifest routing metadata exceeds its bounded contract.');
    }

    const first = result.rows[0]!;
    const manifestId = normalizeUuid(first.manifest_id, 'manifest_id');
    const manifestGeneration = mapGeneration(
      first.manifest_generation,
      'manifest_generation'
    );
    const desiredConfigurationVersionId = normalizeUuid(
      first.desired_configuration_version_id,
      'desired_configuration_version_id'
    );
    const desiredConfigurationGeneration = normalizePattern(
      first.desired_configuration_generation,
      'desired_configuration_generation',
      GENERATION_PATTERN
    );
    const desiredConfigurationHash = normalizeSha256(
      first.desired_configuration_hash,
      'desired_configuration_hash'
    );
    const configurationVersionId = normalizeUuid(
      first.configuration_version_id,
      'configuration_version_id'
    );
    const configurationGeneration = normalizePattern(
      first.configuration_generation,
      'configuration_generation',
      GENERATION_PATTERN
    );
    const configurationHash = normalizeSha256(
      first.configuration_hash,
      'configuration_hash'
    );
    const configuredShardCount = normalizeDatabaseInteger(
      first.configured_shard_count,
      'configured_shard_count',
      1
    );
    const embeddingModel = normalizeRequiredText(
      first.embedding_model,
      'embedding_model',
      200
    );
    const embeddingVersion = normalizeDatabaseInteger(
      first.embedding_version,
      'embedding_version',
      1
    );
    const embeddingDimension = normalizeDatabaseInteger(
      first.embedding_dimension,
      'embedding_dimension',
      1
    );
    const indexFormatVersion = normalizeDatabaseInteger(
      first.index_format_version,
      'index_format_version',
      1
    );
    const memberCount = normalizeDatabaseInteger(
      first.member_count,
      'member_count',
      1
    );
    const omissionCount = normalizeDatabaseInteger(
      first.omission_count,
      'omission_count'
    );
    const pageCount = normalizeDatabaseInteger(
      first.manifest_page_count,
      'manifest_page_count',
      1
    );
    const chunkCount = normalizeDatabaseInteger(
      first.manifest_chunk_count,
      'manifest_chunk_count',
      1
    );
    const manifestCreatedAt = parseDate(
      first.manifest_created_at,
      'manifest_created_at'
    );
    if (first.manifest_sealed_at === null) {
      throw new Error('Active manifest routing metadata is not sealed.');
    }
    const manifestSealedAt = parseDate(
      first.manifest_sealed_at,
      'manifest_sealed_at'
    );
    if (
      first.manifest_state !== 'sealed'
      || first.configuration_state !== 'sealed'
      || manifestCreatedAt.getTime() > manifestSealedAt.getTime()
      || configuredShardCount !== memberCount + omissionCount
      || result.rows.length !== configuredShardCount
    ) {
      throw new Error('Active manifest routing metadata is internally inconsistent.');
    }

    const members: BackstageNotionActiveManifestRoutingMember[] = [];
    const omissions: BackstageNotionActiveManifestRoutingOmission[] = [];
    const shardKeys = new Set<string>();
    let memberPageCount = 0;
    let memberChunkCount = 0;
    for (const [index, row] of result.rows.entries()) {
      const rowLabel = `routing_rows[${index}]`;
      const rowManifestSealedAt = row.manifest_sealed_at === null
        ? null
        : parseDate(row.manifest_sealed_at, `${rowLabel}.manifest_sealed_at`);
      if (
        normalizeUuid(row.manifest_id, `${rowLabel}.manifest_id`) !== manifestId
        || mapGeneration(
          row.manifest_generation,
          `${rowLabel}.manifest_generation`
        ) !== manifestGeneration
        || normalizeUuid(
          row.desired_configuration_version_id,
          `${rowLabel}.desired_configuration_version_id`
        ) !== desiredConfigurationVersionId
        || normalizePattern(
          row.desired_configuration_generation,
          `${rowLabel}.desired_configuration_generation`,
          GENERATION_PATTERN
        ) !== desiredConfigurationGeneration
        || normalizeSha256(
          row.desired_configuration_hash,
          `${rowLabel}.desired_configuration_hash`
        ) !== desiredConfigurationHash
        || normalizeUuid(
          row.configuration_version_id,
          `${rowLabel}.configuration_version_id`
        ) !== configurationVersionId
        || normalizePattern(
          row.configuration_generation,
          `${rowLabel}.configuration_generation`,
          GENERATION_PATTERN
        ) !== configurationGeneration
        || normalizeSha256(
          row.configuration_hash,
          `${rowLabel}.configuration_hash`
        ) !== configurationHash
        || normalizeDatabaseInteger(
          row.configured_shard_count,
          `${rowLabel}.configured_shard_count`,
          1
        ) !== configuredShardCount
        || row.configuration_state !== 'sealed'
        || normalizeRequiredText(
          row.embedding_model,
          `${rowLabel}.embedding_model`,
          200
        ) !== embeddingModel
        || normalizeDatabaseInteger(
          row.embedding_version,
          `${rowLabel}.embedding_version`,
          1
        ) !== embeddingVersion
        || normalizeDatabaseInteger(
          row.embedding_dimension,
          `${rowLabel}.embedding_dimension`,
          1
        ) !== embeddingDimension
        || normalizeDatabaseInteger(
          row.index_format_version,
          `${rowLabel}.index_format_version`,
          1
        ) !== indexFormatVersion
        || normalizeDatabaseInteger(
          row.member_count,
          `${rowLabel}.member_count`,
          1
        ) !== memberCount
        || normalizeDatabaseInteger(
          row.omission_count,
          `${rowLabel}.omission_count`
        ) !== omissionCount
        || normalizeDatabaseInteger(
          row.manifest_page_count,
          `${rowLabel}.manifest_page_count`,
          1
        ) !== pageCount
        || normalizeDatabaseInteger(
          row.manifest_chunk_count,
          `${rowLabel}.manifest_chunk_count`,
          1
        ) !== chunkCount
        || row.manifest_state !== 'sealed'
        || parseDate(
          row.manifest_created_at,
          `${rowLabel}.manifest_created_at`
        ).getTime() !== manifestCreatedAt.getTime()
        || rowManifestSealedAt?.getTime() !== manifestSealedAt.getTime()
      ) {
        throw new Error('Active manifest routing rows crossed authority generations.');
      }

      const shardKey = normalizeShardKey(row.shard_key);
      if (shardKeys.has(shardKey)) {
        throw new Error('Active manifest routing metadata contains duplicate shards.');
      }
      shardKeys.add(shardKey);
      const partitionVersionId = normalizeUuid(
        row.partition_version_id,
        `${rowLabel}.partition_version_id`
      );
      const retrievalTier = parseRetrievalTier(
        row.retrieval_tier,
        `${rowLabel}.retrieval_tier`
      );
      const scopeTags = parseRoutingTags(row.scope_tags, `${rowLabel}.scope_tags`);
      const categoryTags = parseRoutingTags(
        row.category_tags,
        `${rowLabel}.category_tags`
      );
      if (typeof row.is_required !== 'boolean') {
        throw new Error(`${rowLabel}.is_required is invalid.`);
      }

      if (row.record_kind === 'member') {
        if (
          row.shard_snapshot_id === null
          || row.member_verified_at === null
          || row.snapshot_page_count === null
          || row.snapshot_chunk_count === null
          || row.snapshot_embedding_model === null
          || row.snapshot_embedding_version === null
          || row.snapshot_embedding_dimension === null
          || row.snapshot_index_format_version === null
          || row.snapshot_created_at === null
          || row.snapshot_sealed_at === null
          || row.omission_decision !== null
          || row.safe_reason_code !== null
          || (
            row.member_decision !== 'fresh'
            && row.member_decision !== 'retained_last_known_good'
          )
          || row.snapshot_state !== 'sealed'
        ) {
          throw new Error(`${rowLabel} is not a sealed manifest member.`);
        }
        const snapshotCreatedAt = parseDate(
          row.snapshot_created_at,
          `${rowLabel}.snapshot_created_at`
        );
        const snapshotSealedAt = parseDate(
          row.snapshot_sealed_at,
          `${rowLabel}.snapshot_sealed_at`
        );
        const verifiedAt = parseDate(
          row.member_verified_at,
          `${rowLabel}.member_verified_at`
        );
        const snapshotPageCount = normalizeDatabaseInteger(
          row.snapshot_page_count,
          `${rowLabel}.snapshot_page_count`,
          1
        );
        const snapshotChunkCount = normalizeDatabaseInteger(
          row.snapshot_chunk_count,
          `${rowLabel}.snapshot_chunk_count`,
          1
        );
        if (
          normalizeRequiredText(
            row.snapshot_embedding_model,
            `${rowLabel}.snapshot_embedding_model`,
            200
          ) !== embeddingModel
          || normalizeDatabaseInteger(
            row.snapshot_embedding_version,
            `${rowLabel}.snapshot_embedding_version`,
            1
          ) !== embeddingVersion
          || normalizeDatabaseInteger(
            row.snapshot_embedding_dimension,
            `${rowLabel}.snapshot_embedding_dimension`,
            1
          ) !== embeddingDimension
          || normalizeDatabaseInteger(
            row.snapshot_index_format_version,
            `${rowLabel}.snapshot_index_format_version`,
            1
          ) !== indexFormatVersion
          || snapshotCreatedAt.getTime() > snapshotSealedAt.getTime()
          || snapshotSealedAt.getTime() > manifestSealedAt.getTime()
          || verifiedAt.getTime() > manifestSealedAt.getTime()
        ) {
          throw new Error(`${rowLabel} conflicts with its sealed manifest.`);
        }
        memberPageCount += snapshotPageCount;
        memberChunkCount += snapshotChunkCount;
        members.push(Object.freeze({
          shardKey,
          partitionVersionId,
          snapshotId: normalizeUuid(
            row.shard_snapshot_id,
            `${rowLabel}.shard_snapshot_id`
          ),
          retrievalTier,
          required: row.is_required,
          decision: row.member_decision,
          verifiedAt,
          snapshotCreatedAt,
          snapshotSealedAt,
          pageCount: snapshotPageCount,
          chunkCount: snapshotChunkCount,
          scopeTags,
          categoryTags,
        }));
        continue;
      }

      if (
        row.record_kind !== 'omission'
        || row.is_required
        || (
          row.omission_decision !== 'optional_unavailable'
          && row.omission_decision !== 'optional_disabled'
        )
        || row.safe_reason_code === null
        || row.shard_snapshot_id !== null
        || row.member_decision !== null
        || row.member_verified_at !== null
        || row.snapshot_page_count !== null
        || row.snapshot_chunk_count !== null
        || row.snapshot_embedding_model !== null
        || row.snapshot_embedding_version !== null
        || row.snapshot_embedding_dimension !== null
        || row.snapshot_index_format_version !== null
        || row.snapshot_state !== null
        || row.snapshot_created_at !== null
        || row.snapshot_sealed_at !== null
      ) {
        throw new Error(`${rowLabel} is not a valid optional omission.`);
      }
      omissions.push(Object.freeze({
        shardKey,
        partitionVersionId,
        retrievalTier,
        required: false,
        decision: row.omission_decision,
        safeReasonCode: normalizePattern(
          row.safe_reason_code,
          `${rowLabel}.safe_reason_code`,
          SAFE_REASON_CODE_PATTERN
        ),
        scopeTags,
        categoryTags,
      }));
    }
    if (
      members.length !== memberCount
      || omissions.length !== omissionCount
      || memberPageCount !== pageCount
      || memberChunkCount !== chunkCount
    ) {
      throw new Error('Active manifest routing totals are internally inconsistent.');
    }

    members.sort((left, right) => compareText(left.shardKey, right.shardKey));
    omissions.sort((left, right) => compareText(left.shardKey, right.shardKey));
    return Object.freeze({
      universeId: normalizedUniverseId,
      manifestId,
      manifestGeneration,
      configurationVersionId,
      configurationGeneration,
      configurationHash,
      configurationCurrent:
        desiredConfigurationVersionId === configurationVersionId
        && desiredConfigurationGeneration === configurationGeneration
        && desiredConfigurationHash === configurationHash,
      embeddingModel,
      embeddingVersion,
      embeddingDimension,
      indexFormatVersion,
      manifestCreatedAt,
      manifestSealedAt,
      pageCount,
      chunkCount,
      members: Object.freeze(members),
      omissions: Object.freeze(omissions),
    });
  }

  async rankManifestShardCandidates(
    input: RankBackstageNotionPartitionCandidatesInput
  ): Promise<BackstageNotionPartitionCandidateSearchResolution> {
    const universeId = normalizeUniverseId(input.universeId);
    const manifestId = normalizeUuid(input.manifestId, 'manifestId');
    const configurationVersionId = normalizeUuid(
      input.configurationVersionId,
      'configurationVersionId'
    );
    const configurationHash = normalizeSha256(
      input.configurationHash,
      'configurationHash'
    );
    const embeddingModel = normalizeRequiredText(
      input.embeddingModel,
      'embeddingModel',
      200
    );
    const embeddingVersion = normalizeInteger(
      input.embeddingVersion,
      'embeddingVersion',
      1,
      2_147_483_647
    );
    const embeddingDimension = normalizeInteger(
      input.embeddingDimension,
      'embeddingDimension',
      1,
      8_192
    );
    const indexFormatVersion = normalizeInteger(
      input.indexFormatVersion,
      'indexFormatVersion',
      1,
      2_147_483_647
    );
    const shards = normalizeCandidateShards(input.shards);
    const queryText = normalizeCandidateQuery(input.queryText);
    const lexicalProjection = buildCandidateLexicalProjection(queryText);
    const normalizedEmbedding = normalizeEmbedding(input.queryEmbedding);
    if (normalizedEmbedding.embedding.length !== embeddingDimension) {
      throw new Error('queryEmbedding does not match embeddingDimension.');
    }
    const limit = normalizeInteger(
      input.limit,
      'limit',
      1,
      BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS
    );
    const requestedShardsJson = JSON.stringify(shards.map(shard => ({
      shardKey: shard.shardKey,
      partitionVersionId: shard.partitionVersionId,
      snapshotId: shard.snapshotId,
    })));

    const result = await withCandidateSearchTransaction(this.pool, client =>
      client.query<PartitionCandidateSearchRow>(
        `WITH RECURSIVE requested_shards AS MATERIALIZED (
           SELECT
             request.ordinality::INTEGER AS request_ordinal,
             request.value->>'shardKey' AS shard_key,
             (request.value->>'partitionVersionId')::UUID AS partition_version_id,
             (request.value->>'snapshotId')::UUID AS snapshot_id
           FROM pg_catalog.jsonb_array_elements($9::JSONB)
             WITH ORDINALITY AS request(value, ordinality)
         ),
         pinned_manifest AS MATERIALIZED (
           SELECT
             manifest.id AS manifest_id,
             manifest.partition_configuration_version_id AS configuration_version_id,
             manifest.configuration_hash,
             manifest.embedding_model,
             manifest.embedding_version,
             manifest.embedding_dimension,
             manifest.index_format_version
           FROM public.backstage_notion_universe_heads AS authority_head
           JOIN public.backstage_notion_universe_manifests AS manifest
             ON manifest.universe_id = authority_head.universe_id
            AND manifest.id = $2::UUID
            AND manifest.state = 'sealed'
           WHERE authority_head.universe_id = $1
             AND authority_head.authority = 'notion'
             AND manifest.partition_configuration_version_id = $3::UUID
             AND manifest.configuration_hash = $4
             AND manifest.embedding_model = $5
             AND manifest.embedding_version = $6::INTEGER
             AND manifest.embedding_dimension = $7::INTEGER
             AND manifest.index_format_version = $8::INTEGER
         ),
         authorized_shards AS MATERIALIZED (
           SELECT
             requested.request_ordinal,
             requested.shard_key,
             requested.partition_version_id,
             requested.snapshot_id,
             snapshot.chunk_count
           FROM pinned_manifest AS pinned
           JOIN requested_shards AS requested ON TRUE
           JOIN public.backstage_notion_universe_manifest_shards AS member
             ON member.universe_id = $1
            AND member.manifest_id = pinned.manifest_id
            AND member.shard_key = requested.shard_key
            AND member.partition_version_id = requested.partition_version_id
            AND member.shard_snapshot_id = requested.snapshot_id
           JOIN public.backstage_notion_shard_snapshots AS snapshot
             ON snapshot.universe_id = member.universe_id
            AND snapshot.shard_key = member.shard_key
            AND snapshot.id = member.shard_snapshot_id
            AND snapshot.partition_version_id = member.partition_version_id
            AND snapshot.state = 'sealed'
            AND snapshot.embedding_model = pinned.embedding_model
            AND snapshot.embedding_version = pinned.embedding_version
            AND snapshot.embedding_dimension = pinned.embedding_dimension
            AND snapshot.index_format_version = pinned.index_format_version
         ),
         selection_fence AS MATERIALIZED (
           SELECT
             pinned.manifest_id,
             requested.requested_count AS selected_shard_count,
             authorized.authorized_count,
             authorized.selected_chunk_count
           FROM pinned_manifest AS pinned
           CROSS JOIN (
             SELECT COUNT(*)::INTEGER AS requested_count
             FROM requested_shards
           ) AS requested
           CROSS JOIN (
             SELECT
               COUNT(*)::INTEGER AS authorized_count,
               COALESCE(SUM(chunk_count), 0)::BIGINT AS selected_chunk_count
             FROM authorized_shards
           ) AS authorized
           WHERE requested.requested_count = $17::INTEGER
             AND authorized.authorized_count = requested.requested_count
         ),
         selected_embedding_integrity AS MATERIALIZED (
           SELECT
             COUNT(*)::INTEGER AS selected_occurrence_count,
             COUNT(*) FILTER (WHERE
               occurrence.embedding_model <> $5
               OR occurrence.embedding_version <> $6::INTEGER
               OR embedding.chunk_version_id IS NULL
               OR embedding.embedding_dimension <> $7::INTEGER
               OR pg_catalog.cardinality(embedding.embedding) <> $7::INTEGER
               OR NOT public.backstage_notion_embedding_values_are_valid(
                 embedding.embedding,
                 embedding.embedding_dimension,
                 embedding.embedding_norm
               )
             )::INTEGER AS invalid_embedding_count
           FROM selection_fence AS fence
           JOIN authorized_shards AS authorized ON TRUE
           JOIN public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
             ON occurrence.universe_id = $1
            AND occurrence.shard_key = authorized.shard_key
            AND occurrence.shard_snapshot_id = authorized.snapshot_id
           LEFT JOIN public.backstage_notion_chunk_embeddings AS embedding
             ON embedding.universe_id = occurrence.universe_id
            AND embedding.chunk_version_id = occurrence.chunk_version_id
            AND embedding.embedding_model = $5
            AND embedding.embedding_version = $6::INTEGER
         ),
         lexical_query AS MATERIALIZED (
           SELECT CASE
             WHEN $10::TEXT = '' THEN NULL::TSQUERY
             ELSE pg_catalog.websearch_to_tsquery(
               'simple'::pg_catalog.regconfig,
               $10::TEXT
             )
           END AS query
         ),
         exact_candidate_keys AS MATERIALIZED (
           SELECT
             occurrence.shard_key,
             authorized.partition_version_id,
             occurrence.shard_snapshot_id,
             occurrence.page_id,
             occurrence.ordinal,
             occurrence.chunk_version_id,
             0::DOUBLE PRECISION AS lexical_hint
           FROM selection_fence AS fence
           JOIN authorized_shards AS authorized ON TRUE
           JOIN public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
             ON occurrence.universe_id = $1
            AND occurrence.shard_key = authorized.shard_key
            AND occurrence.shard_snapshot_id = authorized.snapshot_id
           WHERE fence.selected_chunk_count <= $13::INTEGER
         ),
         lexical_candidate_keys AS MATERIALIZED (
           SELECT
             occurrence.shard_key,
             authorized.partition_version_id,
             occurrence.shard_snapshot_id,
             occurrence.page_id,
             occurrence.ordinal,
             occurrence.chunk_version_id,
             pg_catalog.ts_rank_cd(
               pg_catalog.to_tsvector(
                 'simple'::pg_catalog.regconfig,
                 chunk.content
               ),
               lexical_query.query,
               32
             )::DOUBLE PRECISION AS lexical_hint
           FROM selection_fence AS fence
           JOIN authorized_shards AS authorized ON TRUE
           JOIN public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
             ON occurrence.universe_id = $1
            AND occurrence.shard_key = authorized.shard_key
            AND occurrence.shard_snapshot_id = authorized.snapshot_id
           JOIN public.backstage_notion_chunk_versions AS chunk
             ON chunk.universe_id = occurrence.universe_id
            AND chunk.id = occurrence.chunk_version_id
           CROSS JOIN lexical_query
           WHERE fence.selected_chunk_count > $13::INTEGER
             AND lexical_query.query IS NOT NULL
             AND pg_catalog.to_tsvector(
               'simple'::pg_catalog.regconfig,
               chunk.content
             ) @@ lexical_query.query
           ORDER BY
             lexical_hint DESC,
             occurrence.shard_key COLLATE "C",
             occurrence.page_id,
             occurrence.ordinal,
             occurrence.chunk_version_id
           LIMIT $14::INTEGER
         ),
         semantic_candidate_keys AS MATERIALIZED (
           SELECT
             authorized.shard_key,
             authorized.partition_version_id,
             authorized.snapshot_id AS shard_snapshot_id,
             semantic.page_id,
             semantic.ordinal,
             semantic.chunk_version_id,
             0::DOUBLE PRECISION AS lexical_hint
           FROM selection_fence AS fence
           JOIN authorized_shards AS authorized ON TRUE
           JOIN LATERAL (
             SELECT
               occurrence.page_id,
               occurrence.ordinal,
               occurrence.chunk_version_id,
               similarity.raw_score
             FROM public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
             JOIN public.backstage_notion_chunk_embeddings AS embedding
               ON embedding.universe_id = occurrence.universe_id
              AND embedding.chunk_version_id = occurrence.chunk_version_id
              AND embedding.embedding_model = occurrence.embedding_model
              AND embedding.embedding_version = occurrence.embedding_version
             CROSS JOIN LATERAL (
               SELECT COALESCE(SUM(
                 (embedding.embedding[coordinate.ordinal] / embedding.embedding_norm)
                 * (
                   ($11::DOUBLE PRECISION[])[coordinate.ordinal]
                   / $12::DOUBLE PRECISION
                 )
               ), 0)::DOUBLE PRECISION AS raw_score
               FROM pg_catalog.generate_subscripts(embedding.embedding, 1)
                 AS coordinate(ordinal)
             ) AS similarity
             WHERE occurrence.universe_id = $1
               AND occurrence.shard_key = authorized.shard_key
               AND occurrence.shard_snapshot_id = authorized.snapshot_id
               AND fence.selected_chunk_count > $13::INTEGER
               AND embedding.embedding_dimension = $7::INTEGER
               AND pg_catalog.cardinality(embedding.embedding) = $7::INTEGER
               AND public.backstage_notion_embedding_values_are_valid(
                 embedding.embedding,
                 embedding.embedding_dimension,
                 embedding.embedding_norm
               )
             ORDER BY
               similarity.raw_score DESC,
               occurrence.page_id,
               occurrence.ordinal,
               occurrence.chunk_version_id
             LIMIT $15::INTEGER
           ) AS semantic ON TRUE
           WHERE fence.selected_chunk_count > $13::INTEGER
         ),
         candidate_keys AS MATERIALIZED (
           SELECT * FROM exact_candidate_keys
           UNION ALL
           SELECT * FROM lexical_candidate_keys
           UNION ALL
           SELECT * FROM semantic_candidate_keys
         ),
         deduplicated_candidate_keys AS MATERIALIZED (
           SELECT
             shard_key,
             partition_version_id,
             shard_snapshot_id,
             page_id,
             ordinal,
             chunk_version_id,
             MAX(lexical_hint) AS lexical_hint
           FROM candidate_keys
           GROUP BY
             shard_key,
             partition_version_id,
             shard_snapshot_id,
             page_id,
             ordinal,
             chunk_version_id
         ),
         candidate_material AS MATERIALIZED (
           SELECT
             candidate.shard_key,
             candidate.partition_version_id,
             candidate.shard_snapshot_id,
             candidate.page_id,
             occurrence.page_version_id,
             page.title AS page_title,
             page.scope_path AS page_path,
             page.canonical_url,
             page.source_last_edited_at,
             candidate.ordinal,
             candidate.chunk_version_id,
             chunk.content_hash,
             chunk.content_code_points,
             chunk.content,
             page_chunk.heading_path,
             page_chunk.heading_occurrence_path,
             occurrence.category,
             embedding.embedding_dimension,
             embedding.embedding_norm,
             embedding.embedding
           FROM deduplicated_candidate_keys AS candidate
           JOIN public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
             ON occurrence.universe_id = $1
            AND occurrence.shard_key = candidate.shard_key
            AND occurrence.shard_snapshot_id = candidate.shard_snapshot_id
            AND occurrence.page_id = candidate.page_id
            AND occurrence.ordinal = candidate.ordinal
            AND occurrence.chunk_version_id = candidate.chunk_version_id
           JOIN public.backstage_notion_shard_snapshot_pages AS page
             ON page.universe_id = occurrence.universe_id
            AND page.shard_key = occurrence.shard_key
            AND page.shard_snapshot_id = occurrence.shard_snapshot_id
            AND page.page_id = occurrence.page_id
            AND page.page_version_id = occurrence.page_version_id
           JOIN public.backstage_notion_manifest_page_ownership AS ownership
             ON ownership.universe_id = occurrence.universe_id
            AND ownership.manifest_id = $2::UUID
            AND ownership.page_id = occurrence.page_id
            AND ownership.shard_key = occurrence.shard_key
            AND ownership.shard_snapshot_id = occurrence.shard_snapshot_id
           JOIN public.backstage_notion_page_version_chunks AS page_chunk
             ON page_chunk.universe_id = occurrence.universe_id
            AND page_chunk.page_version_id = occurrence.page_version_id
            AND page_chunk.ordinal = occurrence.ordinal
            AND page_chunk.chunk_version_id = occurrence.chunk_version_id
           JOIN public.backstage_notion_chunk_versions AS chunk
             ON chunk.universe_id = occurrence.universe_id
            AND chunk.id = occurrence.chunk_version_id
           JOIN public.backstage_notion_chunk_embeddings AS embedding
             ON embedding.universe_id = occurrence.universe_id
            AND embedding.chunk_version_id = occurrence.chunk_version_id
            AND embedding.embedding_model = occurrence.embedding_model
            AND embedding.embedding_version = occurrence.embedding_version
         ),
         candidate_integrity AS MATERIALIZED (
           SELECT
             COUNT(*)::INTEGER AS candidate_pool_count,
             COUNT(DISTINCT material.shard_key)::INTEGER AS candidate_shard_count,
             (
               selected.invalid_embedding_count
               + CASE
                 WHEN selected.selected_occurrence_count <> fence.selected_chunk_count
                   THEN 1
                 ELSE 0
               END
             )::INTEGER AS invalid_embedding_count
           FROM candidate_material AS material
           CROSS JOIN selection_fence AS fence
           CROSS JOIN selected_embedding_integrity AS selected
           GROUP BY
             selected.invalid_embedding_count,
             selected.selected_occurrence_count,
             fence.selected_chunk_count
         ),
         scored_candidates AS MATERIALIZED (
           SELECT
             material.shard_key,
             material.partition_version_id,
             material.shard_snapshot_id,
             material.page_id,
             material.page_version_id,
             material.page_title,
             material.page_path,
             material.canonical_url,
             material.source_last_edited_at,
             material.ordinal,
             material.chunk_version_id,
             material.content_hash,
             material.content_code_points,
             material.content,
             material.heading_path,
             material.heading_occurrence_path,
             material.category,
             GREATEST(
               -1::DOUBLE PRECISION,
               LEAST(1::DOUBLE PRECISION, semantic.raw_score)
             ) AS semantic_score,
             CASE
               WHEN lexical_query.query IS NULL THEN 0::DOUBLE PRECISION
               ELSE pg_catalog.ts_rank_cd(
                 pg_catalog.to_tsvector(
                   'simple'::pg_catalog.regconfig,
                   pg_catalog.concat_ws(
                     ' ',
                     material.content,
                     material.page_title,
                     material.page_path::TEXT,
                     material.heading_path::TEXT,
                     material.category
                   )
                 ),
                 lexical_query.query,
                 32
               )::DOUBLE PRECISION
             END AS lexical_score
           FROM candidate_material AS material
           CROSS JOIN candidate_integrity AS integrity
           CROSS JOIN lexical_query
           CROSS JOIN LATERAL (
             SELECT COALESCE(SUM(
               (material.embedding[coordinate.ordinal] / material.embedding_norm)
               * (
                 ($11::DOUBLE PRECISION[])[coordinate.ordinal]
                 / $12::DOUBLE PRECISION
               )
             ), 0)::DOUBLE PRECISION AS raw_score
             FROM pg_catalog.generate_subscripts(material.embedding, 1)
               AS coordinate(ordinal)
           ) AS semantic
           WHERE integrity.invalid_embedding_count = 0
         ),
         ranked_candidates AS MATERIALIZED (
           SELECT
             scored.*,
             (
               scored.semantic_score
               + (0.12::DOUBLE PRECISION * scored.lexical_score)
             )::DOUBLE PRECISION AS score
           FROM scored_candidates AS scored
         ),
         search_header AS MATERIALIZED (
           SELECT
             fence.manifest_id,
             CASE
               WHEN fence.selected_chunk_count <= $13::INTEGER
                 THEN 'exact_float8_hybrid_v1'
               ELSE 'bounded_float8_hybrid_v1'
             END AS search_strategy,
             fence.selected_chunk_count <= $13::INTEGER AS exhaustive,
             fence.selected_shard_count,
             fence.selected_chunk_count,
             integrity.candidate_pool_count,
             integrity.candidate_shard_count,
             integrity.invalid_embedding_count
           FROM selection_fence AS fence
           CROSS JOIN candidate_integrity AS integrity
         ),
         limited_candidates AS MATERIALIZED (
           SELECT ranked.*
           FROM ranked_candidates AS ranked
           ORDER BY
             ranked.score DESC,
             ranked.semantic_score DESC,
             ranked.lexical_score DESC,
             ranked.shard_key COLLATE "C",
             ranked.page_id,
             ranked.ordinal,
             ranked.chunk_version_id
           LIMIT $16::INTEGER
         ),
         search_rows AS MATERIALIZED (
           SELECT
             'candidate'::TEXT AS record_kind,
             header.manifest_id,
             header.search_strategy,
             header.exhaustive,
             header.selected_shard_count,
             header.selected_chunk_count,
             header.candidate_pool_count,
             header.candidate_shard_count,
             header.invalid_embedding_count,
             candidate.shard_key,
             candidate.partition_version_id,
             candidate.shard_snapshot_id,
             candidate.page_id,
             candidate.page_version_id,
             candidate.page_title,
             candidate.page_path,
             candidate.canonical_url,
             candidate.source_last_edited_at,
             candidate.ordinal,
             candidate.chunk_version_id,
             candidate.content_hash,
             candidate.content_code_points,
             candidate.content,
             candidate.heading_path,
             candidate.heading_occurrence_path,
             candidate.category,
             candidate.semantic_score,
             candidate.lexical_score,
             candidate.score
           FROM search_header AS header
           JOIN limited_candidates AS candidate ON TRUE

           UNION ALL

           SELECT
             'header'::TEXT AS record_kind,
             header.manifest_id,
             header.search_strategy,
             header.exhaustive,
             header.selected_shard_count,
             header.selected_chunk_count,
             header.candidate_pool_count,
             header.candidate_shard_count,
             header.invalid_embedding_count,
             NULL::TEXT AS shard_key,
             NULL::UUID AS partition_version_id,
             NULL::UUID AS shard_snapshot_id,
             NULL::UUID AS page_id,
             NULL::UUID AS page_version_id,
             NULL::TEXT AS page_title,
             NULL::JSONB AS page_path,
             NULL::TEXT AS canonical_url,
             NULL::TIMESTAMPTZ AS source_last_edited_at,
             NULL::INTEGER AS ordinal,
             NULL::UUID AS chunk_version_id,
             NULL::TEXT AS content_hash,
             NULL::INTEGER AS content_code_points,
             NULL::TEXT AS content,
             NULL::JSONB AS heading_path,
             NULL::JSONB AS heading_occurrence_path,
             NULL::TEXT AS category,
             NULL::DOUBLE PRECISION AS semantic_score,
             NULL::DOUBLE PRECISION AS lexical_score,
             NULL::DOUBLE PRECISION AS score
           FROM search_header AS header
           WHERE NOT EXISTS (SELECT 1 FROM limited_candidates)
         )
         SELECT *
         FROM search_rows
         ORDER BY
           record_kind,
           score DESC NULLS LAST,
           semantic_score DESC NULLS LAST,
           lexical_score DESC NULLS LAST,
           shard_key COLLATE "C" NULLS LAST,
           page_id NULLS LAST,
           ordinal NULLS LAST,
           chunk_version_id NULLS LAST`,
        [
          universeId,
          manifestId,
          configurationVersionId,
          configurationHash,
          embeddingModel,
          embeddingVersion,
          embeddingDimension,
          indexFormatVersion,
          requestedShardsJson,
          lexicalProjection,
          normalizedEmbedding.embedding,
          normalizedEmbedding.norm,
          BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_EXACT_SCAN_MAX_CHUNKS,
          BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_LEXICAL_POOL_SIZE,
          BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_SEMANTIC_POOL_PER_SHARD,
          limit,
          shards.length,
        ]
      )
    );

    if (result.rows.length === 0) {
      return Object.freeze({ status: 'invalid' as const });
    }
    const first = result.rows[0]!;
    const normalizedResultManifestId = normalizeUuid(first.manifest_id, 'manifest_id');
    const strategy = first.search_strategy;
    if (
      normalizedResultManifestId !== manifestId
      || (
        strategy !== 'exact_float8_hybrid_v1'
        && strategy !== 'bounded_float8_hybrid_v1'
      )
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    const exhaustive = first.exhaustive;
    const selectedShardCount = normalizeDatabaseInteger(
      first.selected_shard_count,
      'selected_shard_count',
      1
    );
    const selectedChunkCount = normalizeDatabaseInteger(
      first.selected_chunk_count,
      'selected_chunk_count',
      1
    );
    const candidatePoolCount = normalizeDatabaseInteger(
      first.candidate_pool_count,
      'candidate_pool_count'
    );
    const candidateShardCount = normalizeDatabaseInteger(
      first.candidate_shard_count,
      'candidate_shard_count'
    );
    const invalidEmbeddingCount = normalizeDatabaseInteger(
      first.invalid_embedding_count,
      'invalid_embedding_count'
    );
    const maximumPoolCount = strategy === 'exact_float8_hybrid_v1'
      ? BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_EXACT_SCAN_MAX_CHUNKS
      : BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_LEXICAL_POOL_SIZE
        + (
          shards.length
          * BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_SEMANTIC_POOL_PER_SHARD
        );
    if (
      typeof exhaustive !== 'boolean'
      || selectedShardCount !== shards.length
      || selectedChunkCount < selectedShardCount
      || selectedChunkCount > shards.length * BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
      || candidatePoolCount > maximumPoolCount
      || candidatePoolCount < selectedShardCount
      || candidateShardCount !== selectedShardCount
      || (exhaustive && candidatePoolCount !== selectedChunkCount)
      || invalidEmbeddingCount !== 0
      || exhaustive !== (strategy === 'exact_float8_hybrid_v1')
      || exhaustive !== (
        selectedChunkCount
        <= BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_EXACT_SCAN_MAX_CHUNKS
      )
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    for (const [index, row] of result.rows.entries()) {
      if (
        normalizeUuid(row.manifest_id, `rows[${index}].manifest_id`) !== manifestId
        || row.search_strategy !== strategy
        || row.exhaustive !== exhaustive
        || normalizeDatabaseInteger(
          row.selected_shard_count,
          `rows[${index}].selected_shard_count`,
          1
        ) !== selectedShardCount
        || normalizeDatabaseInteger(
          row.selected_chunk_count,
          `rows[${index}].selected_chunk_count`,
          1
        ) !== selectedChunkCount
        || normalizeDatabaseInteger(
          row.candidate_pool_count,
          `rows[${index}].candidate_pool_count`
        ) !== candidatePoolCount
        || normalizeDatabaseInteger(
          row.candidate_shard_count,
          `rows[${index}].candidate_shard_count`
        ) !== candidateShardCount
        || normalizeDatabaseInteger(
          row.invalid_embedding_count,
          `rows[${index}].invalid_embedding_count`
        ) !== 0
      ) {
        return Object.freeze({ status: 'invalid' as const });
      }
    }

    const candidateRows = result.rows.filter(row => row.record_kind === 'candidate');
    const headerRows = result.rows.filter(row => row.record_kind === 'header');
    const expectedCandidateCount = Math.min(limit, candidatePoolCount);
    if (
      candidateRows.length !== expectedCandidateCount
      || (candidateRows.length === 0 ? headerRows.length !== 1 : headerRows.length !== 0)
      || result.rows.length !== candidateRows.length + headerRows.length
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    const requestedShardByKey = new Map(shards.map(shard => [shard.shardKey, shard]));
    const seenCandidates = new Set<string>();
    const candidates = candidateRows.map((row, index) => {
      if (
        row.shard_key === null
        || row.partition_version_id === null
        || row.shard_snapshot_id === null
        || row.page_id === null
        || row.page_version_id === null
        || row.page_title === null
        || row.page_path === null
        || row.canonical_url === null
        || row.source_last_edited_at === null
        || row.ordinal === null
        || row.chunk_version_id === null
        || row.content_hash === null
        || row.content_code_points === null
        || row.content === null
        || row.heading_path === null
        || row.heading_occurrence_path === null
        || row.category === null
        || row.semantic_score === null
        || row.lexical_score === null
        || row.score === null
      ) {
        throw new Error(`candidate row ${index} is incomplete.`);
      }
      const shardKey = normalizeShardKey(row.shard_key);
      const partitionVersionId = normalizeUuid(
        row.partition_version_id,
        `rows[${index}].partition_version_id`
      );
      const snapshotId = normalizeUuid(
        row.shard_snapshot_id,
        `rows[${index}].shard_snapshot_id`
      );
      const requestedShard = requestedShardByKey.get(shardKey);
      if (
        !requestedShard
        || requestedShard.partitionVersionId !== partitionVersionId
        || requestedShard.snapshotId !== snapshotId
      ) {
        throw new Error(`candidate row ${index} is outside the requested shard tuples.`);
      }
      const pageId = normalizeUuid(row.page_id, `rows[${index}].page_id`);
      const pageVersionId = normalizeUuid(
        row.page_version_id,
        `rows[${index}].page_version_id`
      );
      const ordinal = normalizeDatabaseInteger(
        row.ordinal,
        `rows[${index}].ordinal`
      );
      if (ordinal >= BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS) {
        throw new Error(`candidate row ${index} has an invalid ordinal.`);
      }
      const chunkVersionId = normalizeUuid(
        row.chunk_version_id,
        `rows[${index}].chunk_version_id`
      );
      const identity = `${shardKey}:${snapshotId}:${pageId}:${ordinal}`;
      if (seenCandidates.has(identity)) {
        throw new Error('candidate result contains a duplicate occurrence.');
      }
      seenCandidates.add(identity);
      const pageTitle = normalizeRequiredText(
        row.page_title,
        `rows[${index}].page_title`,
        500
      );
      const pagePath = normalizeStringArray(
        parseJsonStringArray(row.page_path),
        `rows[${index}].page_path`,
        BACKSTAGE_NOTION_PARTITION_MAX_DEPTH + 1,
        500
      );
      if (pagePath.length < 1 || pagePath.at(-1) !== pageTitle) {
        throw new Error(`candidate row ${index} has invalid page provenance.`);
      }
      const canonicalUrl = normalizeRequiredText(
        row.canonical_url,
        `rows[${index}].canonical_url`,
        2_048
      );
      const content = row.content;
      const contentCodePoints = normalizeDatabaseInteger(
        row.content_code_points,
        `rows[${index}].content_code_points`,
        1
      );
      if (
        codePointLength(content) !== contentCodePoints
        || contentCodePoints > 20_000
      ) {
        throw new Error(`candidate row ${index} has invalid content bounds.`);
      }
      const contentHash = normalizeSha256(
        row.content_hash,
        `rows[${index}].content_hash`
      );
      if (contentHash !== sha256(content)) {
        throw new Error(`candidate row ${index} has invalid content provenance.`);
      }
      const headingPath = normalizeStringArray(
        parseJsonStringArray(row.heading_path),
        `rows[${index}].heading_path`,
        32,
        500
      );
      const headingOccurrencePath = normalizeHeadingOccurrencePath(
        parseJsonIntegerArray(row.heading_occurrence_path),
        `rows[${index}].heading_occurrence_path`,
        headingPath.length
      );
      if (!BACKSTAGE_NOTION_RAG_CATEGORIES.has(row.category as BackstageNotionRagCategory)) {
        throw new Error(`candidate row ${index} has an invalid category.`);
      }
      const semanticScore = parseFiniteDatabaseNumber(
        row.semantic_score,
        `rows[${index}].semantic_score`
      );
      const lexicalScore = parseFiniteDatabaseNumber(
        row.lexical_score,
        `rows[${index}].lexical_score`
      );
      const score = parseFiniteDatabaseNumber(row.score, `rows[${index}].score`);
      if (
        semanticScore < -1.000_000_001
        || semanticScore > 1.000_000_001
        || lexicalScore < 0
        || lexicalScore > 1.000_000_001
        || score < -1.000_000_001
        || score > 1.120_000_001
        || Math.abs(score - (semanticScore + (0.12 * lexicalScore))) > 1e-9
      ) {
        throw new Error(`candidate row ${index} has invalid scores.`);
      }
      return Object.freeze({
        shardKey,
        partitionVersionId,
        snapshotId,
        pageId,
        pageVersionId,
        pageTitle,
        pagePath,
        canonicalUrl,
        sourceLastEditedAt: parseDate(
          row.source_last_edited_at,
          `rows[${index}].source_last_edited_at`
        ),
        ordinal,
        chunkVersionId,
        contentHash,
        contentCodePoints,
        content,
        headingPath,
        headingOccurrencePath,
        category: row.category as BackstageNotionRagCategory,
        semanticScore,
        lexicalScore,
        score,
      });
    });
    for (let index = 1; index < candidates.length; index += 1) {
      const previous = candidates[index - 1]!;
      const current = candidates[index]!;
      const ordered = previous.score > current.score
        || (
          previous.score === current.score
          && (
            previous.semanticScore > current.semanticScore
            || (
              previous.semanticScore === current.semanticScore
              && (
                previous.lexicalScore > current.lexicalScore
                || (
                  previous.lexicalScore === current.lexicalScore
                  && (
                    compareText(previous.shardKey, current.shardKey) < 0
                    || (
                      previous.shardKey === current.shardKey
                      && (
                        compareText(previous.pageId, current.pageId) < 0
                        || (
                          previous.pageId === current.pageId
                          && (
                            previous.ordinal < current.ordinal
                            || (
                              previous.ordinal === current.ordinal
                              && compareText(
                                previous.chunkVersionId,
                                current.chunkVersionId
                              ) < 0
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        );
      if (!ordered) {
        throw new Error('candidate result order is not deterministic.');
      }
    }
    return Object.freeze({
      status: 'ready' as const,
      searchVersion: BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_VERSION,
      manifestId,
      strategy: strategy as BackstageNotionPartitionCandidateSearchStrategy,
      exhaustive,
      selectedShardCount,
      selectedChunkCount,
      candidatePoolCount,
      candidates: Object.freeze(candidates),
    });
  }

  async resolveManifestScopeOwner(
    universeId: string,
    manifestId: string,
    lookup: BackstageNotionManifestScopeOwnerLookup
  ): Promise<BackstageNotionManifestScopeOwnerResolution> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedManifestId = normalizeUuid(manifestId, 'manifestId');
    const pageTitleKey = normalizeSha256(lookup.pageTitleKey, 'lookup.pageTitleKey');
    if (lookup.scopeKind !== 'page' && lookup.scopeKind !== 'subtree') {
      throw new Error('lookup.scopeKind is invalid.');
    }
    let pagePathKey: readonly string[] | null = null;
    if (lookup.pagePathKey !== null) {
      if (
        !Array.isArray(lookup.pagePathKey)
        || lookup.pagePathKey.length < 1
        || lookup.pagePathKey.length
          > BACKSTAGE_NOTION_PARTITION_SCOPE_LOOKUP_MAX_PATH_SEGMENTS
      ) {
        throw new Error('lookup.pagePathKey is invalid.');
      }
      pagePathKey = normalizeScopeKeyArray(
        lookup.pagePathKey,
        'lookup.pagePathKey',
        lookup.pagePathKey.length
      );
    }

    const result = await this.pool.query<ManifestScopeOwnerRow>(
      `WITH RECURSIVE pinned_manifest AS MATERIALIZED (
         SELECT manifest.id AS manifest_id
         FROM public.backstage_notion_universe_heads AS authority_head
         JOIN public.backstage_notion_universe_manifests AS manifest
           ON manifest.universe_id = authority_head.universe_id
          AND manifest.id = $2
          AND manifest.state = 'sealed'
         WHERE authority_head.universe_id = $1
           AND authority_head.authority = 'notion'
       ),
       candidates AS MATERIALIZED (
         SELECT
           pinned.manifest_id,
           member.shard_key,
           member.partition_version_id,
           member.shard_snapshot_id,
           page.page_id,
           page.title AS page_title,
           page.scope_path,
           page.depth AS page_depth
         FROM pinned_manifest AS pinned
         JOIN public.backstage_notion_universe_manifest_shards AS member
           ON member.universe_id = $1
          AND member.manifest_id = pinned.manifest_id
         JOIN public.backstage_notion_shard_snapshot_pages AS page
           ON page.universe_id = member.universe_id
          AND page.shard_key = member.shard_key
          AND page.shard_snapshot_id = member.shard_snapshot_id
         WHERE page.scope_title_key = $3
           AND (
             $4::TEXT[] IS NULL
             OR (
               pg_catalog.jsonb_array_length(page.scope_path_key)
                 <= pg_catalog.cardinality($4::TEXT[])
               AND page.scope_path_key = pg_catalog.to_jsonb(
                 ($4::TEXT[])[
                   (
                     pg_catalog.cardinality($4::TEXT[])
                     - pg_catalog.jsonb_array_length(page.scope_path_key)
                     + 1
                   ):
                   pg_catalog.cardinality($4::TEXT[])
                 ]
               )
             )
           )
           AND (
             $5::TEXT = 'subtree'
             OR EXISTS (
               SELECT 1
               FROM public.backstage_notion_shard_snapshot_chunk_occurrences
                 AS retrievable_occurrence
               WHERE retrievable_occurrence.universe_id = page.universe_id
                 AND retrievable_occurrence.shard_key = page.shard_key
                 AND retrievable_occurrence.shard_snapshot_id =
                   page.shard_snapshot_id
                 AND retrievable_occurrence.page_id = page.page_id
             )
           )
         ORDER BY member.shard_key, page.scope_path_key, page.page_id
         LIMIT $6
       ),
       scope_pages AS (
         SELECT
           candidate.manifest_id,
           candidate.shard_key,
           candidate.shard_snapshot_id,
           candidate.page_id AS scope_root_page_id,
           candidate.page_id,
           candidate.page_depth,
           0 AS traversal_depth
         FROM candidates AS candidate

         UNION

         SELECT
           parent.manifest_id,
           parent.shard_key,
           parent.shard_snapshot_id,
           parent.scope_root_page_id,
           child.page_id,
           child.depth AS page_depth,
           parent.traversal_depth + 1 AS traversal_depth
         FROM scope_pages AS parent
         JOIN public.backstage_notion_shard_snapshot_pages AS child
           ON child.universe_id = $1
          AND child.shard_key = parent.shard_key
          AND child.shard_snapshot_id = parent.shard_snapshot_id
          AND child.parent_page_id = parent.page_id
         WHERE $5::TEXT = 'subtree'
           AND parent.traversal_depth < $7::INTEGER
           AND child.depth = parent.page_depth + 1
       ),
       resolved_candidates AS MATERIALIZED (
         SELECT
           candidate.manifest_id,
           candidate.shard_key,
           candidate.partition_version_id,
           candidate.shard_snapshot_id,
           candidate.page_id,
           candidate.page_title,
           candidate.scope_path,
           COUNT(DISTINCT occurrence.page_id) AS scope_page_count,
           COUNT(occurrence.page_id) AS scope_chunk_count
         FROM candidates AS candidate
         JOIN scope_pages AS scope_page
           ON scope_page.manifest_id = candidate.manifest_id
          AND scope_page.shard_key = candidate.shard_key
          AND scope_page.shard_snapshot_id = candidate.shard_snapshot_id
          AND scope_page.scope_root_page_id = candidate.page_id
         LEFT JOIN public.backstage_notion_shard_snapshot_chunk_occurrences
           AS occurrence
           ON occurrence.universe_id = $1
          AND occurrence.shard_key = scope_page.shard_key
          AND occurrence.shard_snapshot_id = scope_page.shard_snapshot_id
          AND occurrence.page_id = scope_page.page_id
         GROUP BY
           candidate.manifest_id,
           candidate.shard_key,
           candidate.partition_version_id,
           candidate.shard_snapshot_id,
           candidate.page_id,
           candidate.page_title,
           candidate.scope_path
       )
       SELECT
         resolved.manifest_id,
         resolved.shard_key,
         resolved.partition_version_id,
         resolved.shard_snapshot_id,
         resolved.page_id,
         resolved.page_title,
         resolved.scope_path,
         resolved.scope_chunk_count,
         resolved.scope_page_count
       FROM resolved_candidates AS resolved

       UNION ALL

       SELECT
         pinned.manifest_id,
         NULL::TEXT AS shard_key,
         NULL::UUID AS partition_version_id,
         NULL::UUID AS shard_snapshot_id,
         NULL::UUID AS page_id,
         NULL::TEXT AS page_title,
         NULL::JSONB AS scope_path,
         NULL::BIGINT AS scope_chunk_count,
         NULL::BIGINT AS scope_page_count
       FROM pinned_manifest AS pinned
       WHERE NOT EXISTS (SELECT 1 FROM resolved_candidates)
       ORDER BY shard_key NULLS LAST, scope_path NULLS LAST, page_id NULLS LAST
       LIMIT $6`,
      [
        normalizedUniverseId,
        normalizedManifestId,
        pageTitleKey,
        pagePathKey,
        lookup.scopeKind,
        2,
        BACKSTAGE_NOTION_PARTITION_MAX_DEPTH,
      ]
    );
    if (result.rows.length === 0) {
      return Object.freeze({ status: 'invalid' as const });
    }
    if (result.rows[0]?.page_id === null) {
      if (result.rows.length !== 1) {
        return Object.freeze({ status: 'invalid' as const });
      }
      return Object.freeze({ status: 'not_found' as const });
    }
    if (result.rows.length > 1) {
      return Object.freeze({ status: 'ambiguous' as const });
    }
    const row = result.rows[0]!;
    if (
      row.shard_key === null
      || row.partition_version_id === null
      || row.shard_snapshot_id === null
      || row.page_id === null
      || row.page_title === null
      || row.scope_path === null
      || row.scope_chunk_count === null
      || row.scope_page_count === null
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    const pageTitle = normalizeRequiredText(row.page_title, 'page_title', 500);
    const rawPagePath = parseJsonStringArray(row.scope_path);
    if (
      rawPagePath.length < 1
      || rawPagePath.length > BACKSTAGE_NOTION_PARTITION_MAX_DEPTH + 1
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    const pagePath = normalizeStringArray(
      rawPagePath,
      'scope_path',
      BACKSTAGE_NOTION_PARTITION_MAX_DEPTH + 1,
      500
    );
    const canonicalPagePathKey = normalizeBackstageNotionScopePath(pagePath);
    if (
      normalizeBackstageNotionScopeKey(pageTitle) !== pageTitleKey
      || (
        pagePathKey !== null
        && !arraysEqual(
          canonicalPagePathKey,
          pagePathKey.slice(pagePathKey.length - canonicalPagePathKey.length)
        )
      )
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    const scopePageCount = normalizeDatabaseInteger(
      row.scope_page_count,
      'scope_page_count'
    );
    const scopeChunkCount = normalizeDatabaseInteger(
      row.scope_chunk_count,
      'scope_chunk_count'
    );
    if (scopePageCount === 0 && scopeChunkCount === 0) {
      return Object.freeze({ status: 'not_found' as const });
    }
    if (
      scopePageCount < 1
      || scopeChunkCount < 1
      || scopePageCount > BACKSTAGE_NOTION_PARTITION_MAX_PAGES
      || scopeChunkCount > BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS
      || (lookup.scopeKind === 'page' && scopePageCount !== 1)
    ) {
      return Object.freeze({ status: 'invalid' as const });
    }
    return Object.freeze({
      status: 'resolved' as const,
      manifestId: normalizeUuid(row.manifest_id, 'manifest_id'),
      shardKey: normalizeShardKey(row.shard_key),
      partitionVersionId: normalizeUuid(
        row.partition_version_id,
        'partition_version_id'
      ),
      snapshotId: normalizeUuid(row.shard_snapshot_id, 'shard_snapshot_id'),
      pageId: normalizeUuid(row.page_id, 'page_id'),
      pageTitle,
      pagePath,
      scopeKind: lookup.scopeKind,
      scopeChunkCount,
      scopePageCount,
    });
  }

  async loadUniverseSynchronizationState(
    universeId: string,
    configurationVersionId: string
  ): Promise<BackstageNotionPartitionSynchronizationState | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedConfigurationVersionId = normalizeUuid(
      configurationVersionId,
      'configurationVersionId'
    );
    const result = await this.pool.query<SynchronizationShardRow>(
      `SELECT
         universe_head.desired_configuration_version_id,
         universe_head.desired_configuration_generation,
         universe_head.desired_configuration_hash,
         universe_head.active_manifest_id,
         universe_head.head_generation AS universe_head_generation,
         universe_head.manifest_generation,
         configuration.shard_count AS configured_shard_count,
         member.shard_key,
         member.partition_version_id,
         member.root_page_id AS configured_root_page_id,
         shard_head.current_partition_version_id,
         shard_head.root_page_id,
         shard_head.active_snapshot_id,
         shard_head.head_generation,
         shard_head.snapshot_generation,
         snapshot.partition_version_id AS snapshot_partition_version_id,
         snapshot.source_manifest_hash,
         snapshot.embedding_model,
         snapshot.embedding_version,
         snapshot.embedding_dimension,
         snapshot.index_format_version,
         shard_head.last_verified_at
       FROM public.backstage_notion_partitioned_universe_heads AS universe_head
       JOIN public.backstage_notion_partition_configuration_versions AS configuration
         ON configuration.universe_id = universe_head.universe_id
        AND configuration.id = universe_head.desired_configuration_version_id
        AND configuration.state = 'sealed'
       JOIN public.backstage_notion_partition_configuration_members AS member
         ON member.universe_id = configuration.universe_id
        AND member.partition_configuration_version_id = configuration.id
       JOIN public.backstage_notion_shard_heads AS shard_head
         ON shard_head.universe_id = member.universe_id
        AND shard_head.shard_key = member.shard_key
       LEFT JOIN public.backstage_notion_shard_snapshots AS snapshot
         ON snapshot.universe_id = shard_head.universe_id
        AND snapshot.shard_key = shard_head.shard_key
        AND snapshot.id = shard_head.active_snapshot_id
        AND snapshot.state = 'sealed'
       WHERE universe_head.universe_id = $1
         AND universe_head.desired_configuration_version_id = $2::UUID
       ORDER BY member.shard_key
       LIMIT $3`,
      [
        normalizedUniverseId,
        normalizedConfigurationVersionId,
        BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE + 1,
      ]
    );
    const first = result.rows[0];
    if (!first) {
      return null;
    }
    const desiredConfigurationVersionId = normalizeUuid(
      first.desired_configuration_version_id,
      'desired_configuration_version_id'
    );
    if (desiredConfigurationVersionId !== normalizedConfigurationVersionId) {
      return null;
    }
    const configuredShardCount = normalizeDatabaseInteger(
      first.configured_shard_count,
      'configured_shard_count',
      1
    );
    if (
      configuredShardCount > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
      || result.rows.length !== configuredShardCount
    ) {
      throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
    }
    const expectedUniverseHead = Object.freeze({
      headGeneration: mapGeneration(
        first.universe_head_generation,
        'universe_head_generation'
      ),
      manifestGeneration: mapGeneration(
        first.manifest_generation,
        'manifest_generation'
      ),
      desiredConfigurationVersionId,
      activeManifestId: first.active_manifest_id === null
        ? null
        : normalizeUuid(first.active_manifest_id, 'active_manifest_id'),
    });
    const shards = result.rows.map(row => {
      if (
        normalizeUuid(
          row.desired_configuration_version_id,
          'desired_configuration_version_id'
        ) !== desiredConfigurationVersionId
        || row.desired_configuration_generation
          !== first.desired_configuration_generation
        || normalizeSha256(
          row.desired_configuration_hash,
          'desired_configuration_hash'
        ) !== normalizeSha256(
          first.desired_configuration_hash,
          'desired_configuration_hash'
        )
        || mapGeneration(row.universe_head_generation, 'universe_head_generation')
          !== expectedUniverseHead.headGeneration
        || mapGeneration(row.manifest_generation, 'manifest_generation')
          !== expectedUniverseHead.manifestGeneration
        || normalizeDatabaseInteger(
          row.configured_shard_count,
          'configured_shard_count',
          1
        ) !== configuredShardCount
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
      }
      const partitionVersionId = normalizeUuid(
        row.partition_version_id,
        'partition_version_id'
      );
      const currentPartitionVersionId = normalizeUuid(
        row.current_partition_version_id,
        'current_partition_version_id'
      );
      const rootPageId = normalizeUuid(
        row.configured_root_page_id,
        'configured_root_page_id'
      );
      const activeSnapshotId = row.active_snapshot_id === null
        ? null
        : normalizeUuid(row.active_snapshot_id, 'active_snapshot_id');
      const activeSnapshot = activeSnapshotId === null
        ? null
        : (() => {
            if (
              row.snapshot_partition_version_id === null
              || row.source_manifest_hash === null
              || row.embedding_model === null
              || row.embedding_version === null
              || row.embedding_dimension === null
              || row.index_format_version === null
              || row.last_verified_at === null
            ) {
              throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
            }
            const snapshotPartitionVersionId = normalizeUuid(
              row.snapshot_partition_version_id,
              'snapshot_partition_version_id'
            );
            if (snapshotPartitionVersionId !== currentPartitionVersionId) {
              throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
            }
            return Object.freeze({
              snapshotId: activeSnapshotId,
              partitionVersionId: snapshotPartitionVersionId,
              sourceManifestHash: normalizeSha256(
                row.source_manifest_hash,
                'source_manifest_hash'
              ),
              embeddingModel: normalizeRequiredText(
                row.embedding_model,
                'embedding_model',
                200
              ),
              embeddingVersion: normalizeDatabaseInteger(
                row.embedding_version,
                'embedding_version',
                1
              ),
              embeddingDimension: normalizeDatabaseInteger(
                row.embedding_dimension,
                'embedding_dimension',
                1
              ),
              indexFormatVersion: normalizeDatabaseInteger(
                row.index_format_version,
                'index_format_version',
                1
              ),
              verifiedAt: parseDate(row.last_verified_at, 'last_verified_at'),
            });
          })();
      return Object.freeze({
        shardKey: normalizeShardKey(row.shard_key),
        partitionVersionId,
        rootPageId,
        expectedHead: Object.freeze({
          headGeneration: mapGeneration(row.head_generation, 'head_generation'),
          snapshotGeneration: mapGeneration(
            row.snapshot_generation,
            'snapshot_generation'
          ),
          currentPartitionVersionId,
          activeSnapshotId,
        }),
        activeSnapshot,
      });
    });
    return Object.freeze({
      universeId: normalizedUniverseId,
      configurationVersionId: desiredConfigurationVersionId,
      configurationGeneration: normalizePattern(
        first.desired_configuration_generation,
        'desired_configuration_generation',
        GENERATION_PATTERN
      ),
      configurationHash: normalizeSha256(
        first.desired_configuration_hash,
        'desired_configuration_hash'
      ),
      expectedUniverseHead,
      shards: Object.freeze(shards),
    });
  }

  async loadShardPageInventory(
    universeId: string,
    shardKey: string,
    snapshotId: string,
    maximumPages: number
  ): Promise<readonly BackstageNotionPartitionShardPageInventoryItem[]> {
    const normalizedMaximumPages = normalizeInteger(
      maximumPages,
      'maximumPages',
      1,
      BACKSTAGE_NOTION_PARTITION_MAX_PAGES
    );
    const result = await this.pool.query<{
      page_id: string;
      page_version_id: string;
      content_hash: string;
      parent_page_id: string | null;
      title: string;
      path: unknown;
      scope_path: unknown;
    }>(
      `SELECT
         page.page_id,
         page.page_version_id,
         version.content_hash,
         page.parent_page_id,
         page.title,
         page.path,
         page.scope_path
       FROM public.backstage_notion_shard_snapshot_pages AS page
       JOIN public.backstage_notion_page_versions AS version
         ON version.universe_id = page.universe_id
        AND version.id = page.page_version_id
        AND version.state = 'sealed'
       WHERE page.universe_id = $1
         AND page.shard_key = $2
         AND page.shard_snapshot_id = $3::UUID
       ORDER BY page.depth, page.page_id
       LIMIT $4`,
      [
        normalizeUniverseId(universeId),
        normalizeShardKey(shardKey),
        normalizeUuid(snapshotId, 'snapshotId'),
        normalizedMaximumPages + 1,
      ]
    );
    if (result.rows.length > normalizedMaximumPages) {
      throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
    }
    return Object.freeze(result.rows.map(row => Object.freeze({
      pageId: normalizeUuid(row.page_id, 'page_id'),
      pageVersionId: normalizeUuid(row.page_version_id, 'page_version_id'),
      contentHash: normalizeSha256(row.content_hash, 'content_hash'),
      parentPageId: row.parent_page_id === null
        ? null
        : normalizeUuid(row.parent_page_id, 'parent_page_id'),
      title: normalizeRequiredText(row.title, 'title', 2_000),
      path: Object.freeze(parseJsonStringArray(row.path)),
      scopePath: Object.freeze(parseJsonStringArray(row.scope_path)),
    })));
  }

  async registerConfiguration(
    input: RegisterBackstageNotionPartitionConfigurationInput
  ): Promise<RegisteredBackstageNotionPartitionConfiguration> {
    const configurationGeneration = normalizePattern(
      input.configurationGeneration,
      'configurationGeneration',
      GENERATION_PATTERN
    );
    const configurationHash = normalizeSha256(
      input.configurationHash,
      'configurationHash'
    );
    const universeId = normalizeUniverseId(input.universe.universeId);
    const definitions = prepareDefinitions(input.universe);
    const expectedHead = input.expectedUniverseHead === null
      ? null
      : normalizeUniverseHeadExpectation(input.expectedUniverseHead);
    const candidateConfigurationId = randomUUID();

    return withBoundedTransaction(this.pool, async client => {
      await client.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtextextended($1, 0)
         )`,
        [`${CONFIGURATION_ADVISORY_LOCK_NAMESPACE}${universeId}`]
      );
      await client.query(
        `INSERT INTO public.backstage_notion_universe_heads (universe_id)
         VALUES ($1)
         ON CONFLICT (universe_id) DO NOTHING`,
        [universeId]
      );

      const headResult = await client.query<PartitionedUniverseHeadRow>(
        `SELECT
           desired_configuration_version_id,
           desired_configuration_generation,
           desired_configuration_hash,
           active_manifest_id,
           active_configuration_version_id,
           head_generation,
           manifest_generation
         FROM public.backstage_notion_partitioned_universe_heads
         WHERE universe_id = $1
         FOR UPDATE`,
        [universeId]
      );
      const existingHead = headResult.rows[0] ?? null;

      const insertedConfiguration = await client.query<{ id: string }>(
        `INSERT INTO public.backstage_notion_partition_configuration_versions (
           id,
           universe_id,
           configuration_generation,
           configuration_hash,
           shard_count
         ) VALUES ($1::UUID, $2, $3, $4, $5)
         ON CONFLICT (universe_id, configuration_generation) DO NOTHING
         RETURNING id`,
        [
          candidateConfigurationId,
          universeId,
          configurationGeneration,
          configurationHash,
          definitions.length,
        ]
      );
      const wasInserted = insertedConfiguration.rowCount === 1;
      let configurationId: string = candidateConfigurationId;
      let storedDefinitions: DefinitionRow[];

      if (wasInserted) {
        await client.query(
          `INSERT INTO public.backstage_notion_partition_identities (
             universe_id,
             shard_key
           )
           SELECT $1, definition.shard_key
           FROM pg_catalog.jsonb_to_recordset($2::JSONB) AS definition(
             shard_key TEXT
           )
           ORDER BY definition.shard_key
           ON CONFLICT (universe_id, shard_key) DO NOTHING`,
          [universeId, JSON.stringify(definitions)]
        );
        await client.query(
          `INSERT INTO public.backstage_notion_partition_versions (
             id,
             universe_id,
             shard_key,
             configuration_version,
             root_page_id,
             display_name,
             retrieval_tier,
             is_required,
             scope_tags,
             category_tags,
             max_pages,
             max_chunks,
             max_depth,
             max_content_code_points,
             semantic_hash
           )
           SELECT
             definition.partition_version_id::UUID,
             $1,
             definition.shard_key,
             $2,
             definition.root_page_id::UUID,
             definition.display_name,
             definition.retrieval_tier,
             definition.is_required,
             definition.scope_tags,
             definition.category_tags,
             definition.max_pages,
             definition.max_chunks,
             definition.max_depth,
             definition.max_content_code_points,
             definition.semantic_hash
           FROM pg_catalog.jsonb_to_recordset($3::JSONB) AS definition(
             partition_version_id TEXT,
             shard_key TEXT,
             root_page_id TEXT,
             display_name TEXT,
             retrieval_tier TEXT,
             is_required BOOLEAN,
             scope_tags JSONB,
             category_tags JSONB,
             max_pages INTEGER,
             max_chunks INTEGER,
             max_depth INTEGER,
             max_content_code_points INTEGER,
             semantic_hash TEXT
           )
           ORDER BY definition.shard_key
           ON CONFLICT (universe_id, shard_key, semantic_hash) DO NOTHING`,
          [
            universeId,
            BACKSTAGE_NOTION_PARTITION_CONFIGURATION_VERSION,
            JSON.stringify(definitions),
          ]
        );

        const semanticDefinitions = await client.query<DefinitionRow>(
          `SELECT
             definition.id,
             definition.shard_key,
             definition.root_page_id,
             definition.configuration_version,
             definition.display_name,
             definition.retrieval_tier,
             definition.is_required,
             definition.scope_tags,
             definition.category_tags,
             definition.max_pages,
             definition.max_chunks,
             definition.max_depth,
             definition.max_content_code_points,
             definition.semantic_hash
           FROM public.backstage_notion_partition_versions AS definition
           JOIN pg_catalog.jsonb_to_recordset($2::JSONB) AS expected(
             shard_key TEXT,
             semantic_hash TEXT
           )
             ON expected.shard_key = definition.shard_key
            AND expected.semantic_hash = definition.semantic_hash
           WHERE definition.universe_id = $1
           ORDER BY definition.shard_key
           FOR SHARE OF definition`,
          [universeId, JSON.stringify(definitions)]
        );
        storedDefinitions = semanticDefinitions.rows;
        if (storedDefinitions.length !== definitions.length) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION');
        }
        for (const [index, definition] of definitions.entries()) {
          const stored = storedDefinitions[index];
          if (!stored || !definitionMatches(stored, definition)) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION');
          }
        }

        await client.query(
          `INSERT INTO public.backstage_notion_partition_configuration_members (
             universe_id,
             partition_configuration_version_id,
             configuration_generation,
             shard_key,
             partition_version_id,
             root_page_id
           )
           SELECT
             $1,
             $2::UUID,
             $3,
             definition.shard_key,
             definition.partition_version_id::UUID,
             definition.root_page_id::UUID
           FROM pg_catalog.jsonb_to_recordset($4::JSONB) AS definition(
             shard_key TEXT,
             partition_version_id TEXT,
             root_page_id TEXT
           )
           ORDER BY definition.shard_key`,
          [
            universeId,
            candidateConfigurationId,
            configurationGeneration,
            JSON.stringify(storedDefinitions.map(definition => ({
              shard_key: definition.shard_key,
              partition_version_id: definition.id,
              root_page_id: definition.root_page_id,
            }))),
          ]
        );
        const sealed = await client.query(
          `UPDATE public.backstage_notion_partition_configuration_versions
           SET state = 'sealed', sealed_at = statement_timestamp()
           WHERE universe_id = $1
             AND id = $2::UUID
             AND state = 'building'`,
          [universeId, candidateConfigurationId]
        );
        if (sealed.rowCount !== 1) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION');
        }
      } else {
        const existingConfiguration = await client.query<ConfigurationRow>(
          `SELECT
             id,
             configuration_generation,
             configuration_hash,
             shard_count,
             state
           FROM public.backstage_notion_partition_configuration_versions
           WHERE universe_id = $1
             AND configuration_generation = $2
           FOR SHARE`,
          [universeId, configurationGeneration]
        );
        const row = existingConfiguration.rows[0];
        if (
          !row
          || row.state !== 'sealed'
          || normalizeSha256(row.configuration_hash, 'configuration_hash')
            !== configurationHash
          || normalizeDatabaseInteger(row.shard_count, 'shard_count', 1)
            !== definitions.length
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION');
        }
        configurationId = normalizeUuid(row.id, 'configuration_id');

        const existingDefinitions = await client.query<DefinitionRow>(
          `SELECT
             definition.id,
             definition.shard_key,
             definition.root_page_id,
             definition.configuration_version,
             definition.display_name,
             definition.retrieval_tier,
             definition.is_required,
             definition.scope_tags,
             definition.category_tags,
             definition.max_pages,
             definition.max_chunks,
             definition.max_depth,
             definition.max_content_code_points,
             definition.semantic_hash
           FROM public.backstage_notion_partition_configuration_members AS member
           JOIN public.backstage_notion_partition_versions AS definition
             ON definition.universe_id = member.universe_id
            AND definition.shard_key = member.shard_key
            AND definition.id = member.partition_version_id
           WHERE member.universe_id = $1
             AND member.partition_configuration_version_id = $2::UUID
           ORDER BY member.shard_key
           FOR SHARE OF member, definition`,
          [universeId, configurationId]
        );
        storedDefinitions = existingDefinitions.rows;
        if (storedDefinitions.length !== definitions.length) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION');
        }
        for (const [index, definition] of definitions.entries()) {
          const stored = storedDefinitions[index];
          if (!stored || !definitionMatches(stored, definition)) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_CONFIGURATION_COLLISION');
          }
        }
      }

      await client.query(
        `INSERT INTO public.backstage_notion_shard_heads (
           universe_id,
           shard_key,
           current_partition_version_id,
           root_page_id
         )
           SELECT
             member.universe_id,
             member.shard_key,
             member.partition_version_id,
             member.root_page_id
           FROM public.backstage_notion_partition_configuration_members AS member
           WHERE member.universe_id = $1
             AND member.partition_configuration_version_id = $2::UUID
           ORDER BY member.shard_key
           ON CONFLICT (universe_id, shard_key) DO NOTHING`,
        [universeId, configurationId]
      );

      const previousConfigurationId = existingHead === null
        ? configurationId
        : normalizeUuid(
            existingHead.desired_configuration_version_id,
            'desired_configuration_version_id'
          );
      let definitionChangedShardKeys: string[] = [];
      if (previousConfigurationId !== configurationId) {
        const definitionChangedShards = await client.query<{ shard_key: string }>(
          `WITH previous_members AS (
             SELECT shard_key, partition_version_id, root_page_id
             FROM public.backstage_notion_partition_configuration_members
             WHERE universe_id = $1
               AND partition_configuration_version_id = $3::UUID
           ), desired_members AS (
             SELECT shard_key, partition_version_id, root_page_id
             FROM public.backstage_notion_partition_configuration_members
             WHERE universe_id = $1
               AND partition_configuration_version_id = $2::UUID
           )
           SELECT COALESCE(previous.shard_key, desired.shard_key) AS shard_key
           FROM previous_members AS previous
           FULL OUTER JOIN desired_members AS desired
             ON desired.shard_key = previous.shard_key
           WHERE previous.shard_key IS NULL
              OR desired.shard_key IS NULL
              OR previous.partition_version_id IS DISTINCT FROM desired.partition_version_id
              OR previous.root_page_id IS DISTINCT FROM desired.root_page_id
           ORDER BY shard_key
           LIMIT $4`,
          [
            universeId,
            configurationId,
            previousConfigurationId,
            BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE * 2 + 1,
          ]
        );
        if (
          definitionChangedShards.rows.length
            > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE * 2
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }
        definitionChangedShardKeys = definitionChangedShards.rows.map(row =>
          normalizeShardKey(row.shard_key)
        );
      }

      let universeHeadGeneration: string;
      if (!existingHead) {
        if (expectedHead !== null) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }
        const insertedHead = await client.query<{ head_generation: number | string }>(
          `INSERT INTO public.backstage_notion_partitioned_universe_heads (
             universe_id,
             desired_configuration_version_id,
             desired_configuration_generation,
             desired_configuration_hash
           ) VALUES ($1, $2::UUID, $3, $4)
           RETURNING head_generation`,
          [universeId, configurationId, configurationGeneration, configurationHash]
        );
        const row = insertedHead.rows[0];
        if (!row) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }
        universeHeadGeneration = mapGeneration(row.head_generation, 'head_generation');
      } else if (
        normalizeUuid(
          existingHead.desired_configuration_version_id,
          'desired_configuration_version_id'
        ) === configurationId
        && existingHead.desired_configuration_generation === configurationGeneration
        && normalizeSha256(
          existingHead.desired_configuration_hash,
          'desired_configuration_hash'
        ) === configurationHash
      ) {
        universeHeadGeneration = mapGeneration(
          existingHead.head_generation,
          'head_generation'
        );
      } else {
        if (!expectedHead || !universeHeadMatches(existingHead, expectedHead)) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }
        const nextGeneration = incrementGeneration(
          expectedHead.headGeneration,
          'expectedUniverseHead.headGeneration'
        );
        const updatedHead = await client.query<{ head_generation: number | string }>(
          `UPDATE public.backstage_notion_partitioned_universe_heads
           SET
             desired_configuration_version_id = $2::UUID,
             desired_configuration_generation = $3,
             desired_configuration_hash = $4,
             head_generation = $5::BIGINT,
             updated_at = statement_timestamp()
           WHERE universe_id = $1
             AND head_generation = $6::BIGINT
             AND desired_configuration_version_id = $7::UUID
             AND active_manifest_id IS NOT DISTINCT FROM $8::UUID
           RETURNING head_generation`,
          [
            universeId,
            configurationId,
            configurationGeneration,
            configurationHash,
            nextGeneration,
            expectedHead.headGeneration,
            expectedHead.desiredConfigurationVersionId,
            expectedHead.activeManifestId,
          ]
        );
        const row = updatedHead.rows[0];
        if (!row) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }
        universeHeadGeneration = mapGeneration(row.head_generation, 'head_generation');
      }

      if (definitionChangedShardKeys.length > 0) {
        await client.query(
          `UPDATE public.backstage_notion_shard_sync_leases
           SET
             lease_generation = lease_generation + 1,
             expires_at = GREATEST(
               acquired_at + INTERVAL '1 microsecond',
               statement_timestamp()
             )
           WHERE universe_id = $1
             AND shard_key = ANY($2::TEXT[])
             AND expires_at > statement_timestamp()`,
          [universeId, definitionChangedShardKeys]
        );
      }

      return Object.freeze({
        configurationVersionId: configurationId,
        universeId,
        configurationGeneration,
        configurationHash,
        reused: !wasInserted,
        universeHeadGeneration,
        definitions: Object.freeze(storedDefinitions.map(row => Object.freeze({
          shardKey: normalizeShardKey(row.shard_key),
          partitionVersionId: normalizeUuid(row.id, 'partition_version_id'),
          rootPageId: normalizeUuid(row.root_page_id, 'root_page_id'),
        }))),
      });
    });
  }

  async findReusablePageMaterial(
    input: FindBackstageNotionReusablePageMaterialInput
  ): Promise<BackstageNotionReusablePageMaterial | null> {
    const universeId = normalizeUniverseId(input.universeId);
    const pageId = normalizeUuid(input.pageId, 'pageId');
    const contentHash = normalizeSha256(input.contentHash, 'contentHash');
    const pageFormatVersion = normalizeInteger(
      input.pageFormatVersion,
      'pageFormatVersion',
      1,
      2_147_483_647
    );
    const chunkerVersion = normalizeInteger(
      input.chunkerVersion,
      'chunkerVersion',
      1,
      2_147_483_647
    );
    const embeddingModel = normalizeRequiredText(
      input.embeddingModel,
      'embeddingModel',
      200
    );
    const embeddingVersion = normalizeInteger(
      input.embeddingVersion,
      'embeddingVersion',
      1,
      2_147_483_647
    );
    const embeddingDimension = normalizeInteger(
      input.embeddingDimension,
      'embeddingDimension',
      1,
      4_096
    );
    const result = await this.pool.query<ReusablePageMaterialRow>(
      `SELECT
         page.id AS page_version_id,
         page.page_id,
         page.content_hash AS page_content_hash,
         page.page_format_version,
         page.chunker_version,
         page.chunk_count,
         page_chunk.ordinal,
         page_chunk.chunk_version_id,
         chunk.content_hash AS chunk_content_hash,
         chunk.content AS chunk_content,
         chunk.content_code_points AS chunk_content_code_points,
         page_chunk.heading_path,
         page_chunk.scope_heading_path_key,
         page_chunk.heading_occurrence_path,
         (embedding.chunk_version_id IS NOT NULL) AS embedding_available
       FROM public.backstage_notion_page_versions AS page
       LEFT JOIN public.backstage_notion_page_version_chunks AS page_chunk
         ON page_chunk.universe_id = page.universe_id
        AND page_chunk.page_version_id = page.id
       LEFT JOIN public.backstage_notion_chunk_versions AS chunk
         ON chunk.universe_id = page_chunk.universe_id
        AND chunk.id = page_chunk.chunk_version_id
       LEFT JOIN public.backstage_notion_chunk_embeddings AS embedding
         ON embedding.universe_id = page_chunk.universe_id
        AND embedding.chunk_version_id = page_chunk.chunk_version_id
        AND embedding.embedding_model = $6
        AND embedding.embedding_version = $7
        AND embedding.embedding_dimension = $8
       WHERE page.universe_id = $1
         AND page.page_id = $2::UUID
         AND page.content_hash = $3
         AND page.page_format_version = $4
         AND page.chunker_version = $5
         AND page.state = 'sealed'
       ORDER BY page_chunk.ordinal NULLS FIRST
       LIMIT 2049`,
      [
        universeId,
        pageId,
        contentHash,
        pageFormatVersion,
        chunkerVersion,
        embeddingModel,
        embeddingVersion,
        embeddingDimension,
      ]
    );
    const first = result.rows[0];
    if (!first) {
      return null;
    }
    const pageVersionId = normalizeUuid(first.page_version_id, 'page_version_id');
    if (
      normalizeUuid(first.page_id, 'page_id') !== pageId
      || normalizeSha256(first.page_content_hash, 'page_content_hash') !== contentHash
      || normalizeDatabaseInteger(first.page_format_version, 'page_format_version', 1)
        !== pageFormatVersion
      || normalizeDatabaseInteger(first.chunker_version, 'chunker_version', 1)
        !== chunkerVersion
    ) {
      throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
    }
    const chunkCount = normalizeDatabaseInteger(first.chunk_count, 'chunk_count');
    if (chunkCount > BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS) {
      throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
    }
    if (chunkCount === 0) {
      if (
        result.rows.length !== 1
        || first.ordinal !== null
        || first.chunk_version_id !== null
        || first.chunk_content_hash !== null
        || first.chunk_content !== null
        || first.chunk_content_code_points !== null
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      return Object.freeze({
        pageVersionId,
        pageId,
        contentHash,
        pageFormatVersion,
        chunkerVersion,
        chunks: Object.freeze([]),
      });
    }
    if (result.rows.length !== chunkCount) {
      throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
    }
    const chunks = result.rows.map((row, index) => {
      if (
        normalizeUuid(row.page_version_id, 'page_version_id') !== pageVersionId
        || row.ordinal === null
        || row.chunk_version_id === null
        || row.chunk_content_hash === null
        || row.chunk_content === null
        || row.chunk_content_code_points === null
        || typeof row.embedding_available !== 'boolean'
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      const ordinal = normalizeDatabaseInteger(row.ordinal, 'ordinal');
      const chunkContentHash = normalizeSha256(
        row.chunk_content_hash,
        'chunk_content_hash'
      );
      const contentCodePoints = normalizeDatabaseInteger(
        row.chunk_content_code_points,
        'chunk_content_code_points',
        1
      );
      const headingPath = normalizeStringArray(
        parseJsonStringArray(row.heading_path),
        `storedChunks[${index}].headingPath`,
        32,
        500
      );
      const scopeHeadingPathKey = normalizeScopeKeyArray(
        parseJsonStringArray(row.scope_heading_path_key),
        `storedChunks[${index}].scopeHeadingPathKey`,
        headingPath.length
      );
      const headingOccurrencePath = normalizeHeadingOccurrencePath(
        parseJsonIntegerArray(row.heading_occurrence_path),
        `storedChunks[${index}].headingOccurrencePath`,
        headingPath.length
      );
      if (
        ordinal !== index
        || chunkContentHash !== sha256(row.chunk_content)
        || contentCodePoints !== codePointLength(row.chunk_content)
        || !arraysEqual(
          scopeHeadingPathKey,
          normalizeBackstageNotionScopePath(headingPath)
        )
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      return Object.freeze({
        ordinal,
        chunkVersionId: normalizeUuid(row.chunk_version_id, 'chunk_version_id'),
        contentHash: chunkContentHash,
        content: row.chunk_content,
        contentCodePoints,
        headingPath,
        scopeHeadingPathKey,
        headingOccurrencePath,
        embeddingAvailable: row.embedding_available,
      });
    });
    return Object.freeze({
      pageVersionId,
      pageId,
      contentHash,
      pageFormatVersion,
      chunkerVersion,
      chunks: Object.freeze(chunks),
    });
  }

  async findReusableChunkMaterials(
    input: FindBackstageNotionReusableChunkMaterialsInput
  ): Promise<readonly BackstageNotionReusableChunkMaterial[]> {
    const universeId = normalizeUniverseId(input.universeId);
    if (
      !Array.isArray(input.contentHashes)
      || input.contentHashes.length > BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS
    ) {
      throw new Error('contentHashes is outside its supported range.');
    }
    const contentHashes = input.contentHashes.map((hash, index) =>
      normalizeSha256(hash, `contentHashes[${index}]`)
    );
    if (new Set(contentHashes).size !== contentHashes.length) {
      throw new Error('contentHashes must be unique.');
    }
    const chunkerVersion = normalizeInteger(
      input.chunkerVersion,
      'chunkerVersion',
      1,
      2_147_483_647
    );
    const embeddingModel = normalizeRequiredText(
      input.embeddingModel,
      'embeddingModel',
      200
    );
    const embeddingVersion = normalizeInteger(
      input.embeddingVersion,
      'embeddingVersion',
      1,
      2_147_483_647
    );
    const embeddingDimension = normalizeInteger(
      input.embeddingDimension,
      'embeddingDimension',
      1,
      4_096
    );
    if (contentHashes.length === 0) {
      return Object.freeze([]);
    }
    const result = await this.pool.query<ReusableChunkMaterialRow>(
      `SELECT
         chunk.id AS chunk_version_id,
         chunk.content_hash,
         chunk.content,
         chunk.content_code_points,
         (embedding.chunk_version_id IS NOT NULL) AS embedding_available
       FROM public.backstage_notion_chunk_versions AS chunk
       LEFT JOIN public.backstage_notion_chunk_embeddings AS embedding
         ON embedding.universe_id = chunk.universe_id
        AND embedding.chunk_version_id = chunk.id
        AND embedding.embedding_model = $3
        AND embedding.embedding_version = $4
        AND embedding.embedding_dimension = $6
       WHERE chunk.universe_id = $1
         AND chunk.chunker_version = $2
         AND chunk.content_hash = ANY($5::TEXT[])
       ORDER BY pg_catalog.array_position($5::TEXT[], chunk.content_hash)
       LIMIT 129`,
      [
        universeId,
        chunkerVersion,
        embeddingModel,
        embeddingVersion,
        contentHashes,
        embeddingDimension,
      ]
    );
    if (result.rows.length > contentHashes.length) {
      throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
    }
    const requested = new Set(contentHashes);
    const seen = new Set<string>();
    const byHash = new Map<string, BackstageNotionReusableChunkMaterial>();
    for (const row of result.rows) {
      const hash = normalizeSha256(row.content_hash, 'content_hash');
      const contentCodePoints = normalizeDatabaseInteger(
        row.content_code_points,
        'content_code_points',
        1
      );
      if (
        !requested.has(hash)
        || seen.has(hash)
        || hash !== sha256(row.content)
        || contentCodePoints !== codePointLength(row.content)
        || typeof row.embedding_available !== 'boolean'
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      seen.add(hash);
      byHash.set(hash, Object.freeze({
        chunkVersionId: normalizeUuid(row.chunk_version_id, 'chunk_version_id'),
        contentHash: hash,
        content: row.content,
        contentCodePoints,
        embeddingAvailable: row.embedding_available,
      }));
    }
    return Object.freeze(contentHashes.flatMap(hash => {
      const material = byHash.get(hash);
      return material ? [material] : [];
    }));
  }

  async storeChunkVersion(
    input: StoreBackstageNotionChunkVersionInput
  ): Promise<BackstageNotionStoredChunkVersion> {
    const universeId = normalizeUniverseId(input.universeId);
    const contentHash = normalizeSha256(input.contentHash, 'contentHash');
    const chunkerVersion = normalizeInteger(
      input.chunkerVersion,
      'chunkerVersion',
      1,
      2_147_483_647
    );
    if (
      typeof input.content !== 'string'
      || codePointLength(input.content) < 1
      || codePointLength(input.content) > 20_000
      || input.content.includes('\u0000')
    ) {
      throw new Error('content is outside its supported range.');
    }
    const contentCodePoints = normalizeInteger(
      input.contentCodePoints,
      'contentCodePoints',
      1,
      20_000
    );
    if (contentCodePoints !== codePointLength(input.content)) {
      throw new Error('contentCodePoints does not match content.');
    }
    if (contentHash !== sha256(input.content)) {
      throw new Error('contentHash does not match content.');
    }
    const candidateId = randomUUID();

    return withBoundedTransaction(this.pool, async client => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.backstage_notion_chunk_versions (
           id,
           universe_id,
           content_hash,
           chunker_version,
           content,
           content_code_points
         ) VALUES ($1::UUID, $2, $3, $4, $5, $6)
         ON CONFLICT (universe_id, content_hash, chunker_version) DO NOTHING
         RETURNING id`,
        [
          candidateId,
          universeId,
          contentHash,
          chunkerVersion,
          input.content,
          contentCodePoints,
        ]
      );
      const reused = inserted.rowCount !== 1;
      const stored = await client.query<ChunkVersionRow>(
        `SELECT id, content, content_code_points
         FROM public.backstage_notion_chunk_versions
         WHERE universe_id = $1
           AND content_hash = $2
           AND chunker_version = $3
         FOR SHARE`,
        [universeId, contentHash, chunkerVersion]
      );
      const row = stored.rows[0];
      if (
        !row
        || row.content !== input.content
        || normalizeDatabaseInteger(row.content_code_points, 'content_code_points', 1)
          !== contentCodePoints
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      return Object.freeze({
        id: normalizeUuid(row.id, 'chunk_version_id'),
        reused,
      });
    });
  }

  async storeEmbedding(
    input: StoreBackstageNotionEmbeddingInput
  ): Promise<BackstageNotionStoredEmbedding> {
    const universeId = normalizeUniverseId(input.universeId);
    const chunkVersionId = normalizeUuid(input.chunkVersionId, 'chunkVersionId');
    const embeddingModel = normalizeRequiredText(
      input.embeddingModel,
      'embeddingModel',
      200
    );
    const embeddingVersion = normalizeInteger(
      input.embeddingVersion,
      'embeddingVersion',
      1,
      2_147_483_647
    );
    const normalized = normalizeEmbedding(input.embedding);

    return withBoundedTransaction(this.pool, async client => {
      const inserted = await client.query(
        `INSERT INTO public.backstage_notion_chunk_embeddings (
           universe_id,
           chunk_version_id,
           embedding_model,
           embedding_version,
           embedding_dimension,
           embedding_norm,
           embedding
         ) VALUES ($1, $2::UUID, $3, $4, $5, $6, $7::DOUBLE PRECISION[])
         ON CONFLICT (
           universe_id,
           chunk_version_id,
           embedding_model,
           embedding_version
         ) DO NOTHING`,
        [
          universeId,
          chunkVersionId,
          embeddingModel,
          embeddingVersion,
          normalized.embedding.length,
          normalized.norm,
          normalized.embedding,
        ]
      );
      const stored = await client.query<EmbeddingRow>(
        `SELECT
           chunk_version_id,
           embedding_model,
           embedding_version,
           embedding_dimension,
           embedding_norm,
           embedding
         FROM public.backstage_notion_chunk_embeddings
         WHERE universe_id = $1
           AND chunk_version_id = $2::UUID
           AND embedding_model = $3
           AND embedding_version = $4
         FOR SHARE`,
        [universeId, chunkVersionId, embeddingModel, embeddingVersion]
      );
      const row = stored.rows[0];
      const storedEmbedding = row ? parseEmbedding(row.embedding) : [];
      if (
        !row
        || normalizeUuid(row.chunk_version_id, 'chunk_version_id') !== chunkVersionId
        || row.embedding_model !== embeddingModel
        || normalizeDatabaseInteger(row.embedding_version, 'embedding_version', 1)
          !== embeddingVersion
        || normalizeDatabaseInteger(row.embedding_dimension, 'embedding_dimension', 1)
          !== normalized.embedding.length
        || !Object.is(Number(row.embedding_norm), normalized.norm)
        || storedEmbedding.length !== normalized.embedding.length
        || storedEmbedding.some((component, index) =>
          !Object.is(component, normalized.embedding[index] ?? Number.NaN)
        )
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      return Object.freeze({
        chunkVersionId,
        embeddingModel,
        embeddingVersion,
        embeddingDimension: normalized.embedding.length,
        embeddingNorm: normalized.norm,
        reused: inserted.rowCount !== 1,
      });
    });
  }

  async storePageVersion(
    input: StoreBackstageNotionPageVersionInput
  ): Promise<BackstageNotionStoredPageVersion> {
    const universeId = normalizeUniverseId(input.universeId);
    const pageId = normalizeUuid(input.pageId, 'pageId');
    const contentHash = normalizeSha256(input.contentHash, 'contentHash');
    const pageFormatVersion = normalizeInteger(
      input.pageFormatVersion,
      'pageFormatVersion',
      1,
      2_147_483_647
    );
    const chunkerVersion = normalizeInteger(
      input.chunkerVersion,
      'chunkerVersion',
      1,
      2_147_483_647
    );
    if (
      typeof input.markdown !== 'string'
      || codePointLength(input.markdown) > BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS
      || input.markdown.includes('\u0000')
    ) {
      throw new Error('markdown is outside its supported range.');
    }
    const contentCodePoints = normalizeInteger(
      input.contentCodePoints,
      'contentCodePoints',
      0,
      BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS
    );
    if (contentCodePoints !== codePointLength(input.markdown)) {
      throw new Error('contentCodePoints does not match markdown.');
    }
    if (contentHash !== sha256(input.markdown)) {
      throw new Error('contentHash does not match markdown.');
    }
    const chunks = normalizePageChunks(input.chunks);
    const candidateId = randomUUID();

    return withBoundedTransaction(this.pool, async client => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.backstage_notion_page_versions (
           id,
           universe_id,
           page_id,
           content_hash,
           page_format_version,
           chunker_version,
           markdown,
           content_code_points,
           chunk_count
         ) VALUES ($1::UUID, $2, $3::UUID, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (
           universe_id,
           page_id,
           content_hash,
           page_format_version,
           chunker_version
         ) DO NOTHING
         RETURNING id`,
        [
          candidateId,
          universeId,
          pageId,
          contentHash,
          pageFormatVersion,
          chunkerVersion,
          input.markdown,
          contentCodePoints,
          chunks.length,
        ]
      );
      const reused = inserted.rowCount !== 1;
      if (!reused && chunks.length > 0) {
        await client.query(
          `INSERT INTO public.backstage_notion_page_version_chunks (
             universe_id,
             page_version_id,
             ordinal,
             chunk_version_id,
             heading_path,
             scope_heading_path_key,
             heading_occurrence_path
           )
           SELECT
             $1,
             $2::UUID,
             chunk.ordinal,
             chunk.chunk_version_id::UUID,
             chunk.heading_path,
             chunk.scope_heading_path_key,
             chunk.heading_occurrence_path
           FROM pg_catalog.jsonb_to_recordset($3::JSONB) AS chunk(
             ordinal INTEGER,
             chunk_version_id TEXT,
             heading_path JSONB,
             scope_heading_path_key JSONB,
             heading_occurrence_path JSONB
           )
           ORDER BY chunk.ordinal`,
          [universeId, candidateId, JSON.stringify(chunks)]
        );
      }
      if (!reused) {
        const sealed = await client.query(
          `UPDATE public.backstage_notion_page_versions
           SET state = 'sealed', sealed_at = statement_timestamp()
           WHERE universe_id = $1
             AND id = $2::UUID
             AND state = 'building'`,
          [universeId, candidateId]
        );
        if (sealed.rowCount !== 1) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
        }
      }

      const stored = await client.query<PageVersionRow>(
        `SELECT id, markdown, content_code_points, chunk_count, state
         FROM public.backstage_notion_page_versions
         WHERE universe_id = $1
           AND page_id = $2::UUID
           AND content_hash = $3
           AND page_format_version = $4
           AND chunker_version = $5
         FOR SHARE`,
        [universeId, pageId, contentHash, pageFormatVersion, chunkerVersion]
      );
      const row = stored.rows[0];
      if (
        !row
        || row.state !== 'sealed'
        || row.markdown !== input.markdown
        || normalizeDatabaseInteger(row.content_code_points, 'content_code_points')
          !== contentCodePoints
        || normalizeDatabaseInteger(row.chunk_count, 'chunk_count') !== chunks.length
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      const storedChunks = await client.query<PageVersionChunkRow>(
        `SELECT
           ordinal,
           chunk_version_id,
           heading_path,
           scope_heading_path_key,
           heading_occurrence_path
         FROM public.backstage_notion_page_version_chunks
         WHERE universe_id = $1
           AND page_version_id = $2::UUID
         ORDER BY ordinal`,
        [universeId, row.id]
      );
      if (storedChunks.rows.length !== chunks.length) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      for (const [index, chunk] of chunks.entries()) {
        const storedChunk = storedChunks.rows[index];
        if (
          !storedChunk
          || normalizeDatabaseInteger(storedChunk.ordinal, 'ordinal') !== chunk.ordinal
          || normalizeUuid(storedChunk.chunk_version_id, 'chunk_version_id')
            !== chunk.chunk_version_id
          || JSON.stringify(parseJsonStringArray(storedChunk.heading_path))
            !== JSON.stringify(chunk.heading_path)
          || JSON.stringify(parseJsonStringArray(storedChunk.scope_heading_path_key))
            !== JSON.stringify(chunk.scope_heading_path_key)
          || JSON.stringify(parseJsonIntegerArray(storedChunk.heading_occurrence_path))
            !== JSON.stringify(chunk.heading_occurrence_path)
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
        }
      }
      return Object.freeze({
        id: normalizeUuid(row.id, 'page_version_id'),
        reused,
      });
    });
  }

  async acquireShardLease(
    universeId: string,
    shardKey: string,
    holderId: string,
    ttlMs: number
  ): Promise<BackstageNotionPartitionLease | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedShardKey = normalizeShardKey(shardKey);
    const normalizedHolderId = normalizeRequiredText(holderId, 'holderId', 200);
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_PARTITION_LEASE_MIN_MS,
      BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS
    );
    const token = randomUUID();
    return withBoundedTransaction(this.pool, async client => {
      const result = await client.query<ShardLeaseRow>(
        `INSERT INTO public.backstage_notion_shard_sync_leases (
           universe_id,
           shard_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at
         ) VALUES (
           $1,
           $2,
           $3,
           $4::UUID,
           1,
           statement_timestamp(),
           statement_timestamp() + ($5::BIGINT * INTERVAL '1 millisecond')
         )
         ON CONFLICT (universe_id, shard_key) DO UPDATE
         SET
           holder_id = EXCLUDED.holder_id,
           lease_token = EXCLUDED.lease_token,
           lease_generation = backstage_notion_shard_sync_leases.lease_generation + 1,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at
         WHERE backstage_notion_shard_sync_leases.expires_at <= statement_timestamp()
         RETURNING
           universe_id,
           shard_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at`,
        [
          normalizedUniverseId,
          normalizedShardKey,
          normalizedHolderId,
          token,
          normalizedTtlMs,
        ]
      );
      return result.rows[0] ? mapShardLease(result.rows[0]) : null;
    });
  }

  async renewShardLease(
    universeId: string,
    shardKey: string,
    lease: BackstageNotionPartitionLeaseFence,
    ttlMs: number
  ): Promise<BackstageNotionPartitionLease | null> {
    const normalizedLease = normalizeLeaseFence(lease);
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_PARTITION_LEASE_MIN_MS,
      BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS
    );
    return withBoundedTransaction(this.pool, async client => {
      const result = await client.query<ShardLeaseRow>(
        `UPDATE public.backstage_notion_shard_sync_leases
         SET
           lease_generation = $6::BIGINT,
           expires_at = statement_timestamp() + ($7::BIGINT * INTERVAL '1 millisecond')
         WHERE universe_id = $1
           AND shard_key = $2
           AND holder_id = $3
           AND lease_token = $4::UUID
           AND lease_generation = $5::BIGINT
           AND expires_at > statement_timestamp()
         RETURNING
           universe_id,
           shard_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at`,
        [
          normalizeUniverseId(universeId),
          normalizeShardKey(shardKey),
          normalizedLease.holderId,
          normalizedLease.leaseToken,
          normalizedLease.leaseGeneration,
          incrementGeneration(normalizedLease.leaseGeneration, 'lease.leaseGeneration'),
          normalizedTtlMs,
        ]
      );
      return result.rows[0] ? mapShardLease(result.rows[0]) : null;
    });
  }

  async releaseShardLease(
    universeId: string,
    shardKey: string,
    lease: BackstageNotionPartitionLeaseFence
  ): Promise<boolean> {
    const normalizedLease = normalizeLeaseFence(lease);
    return withBoundedTransaction(this.pool, async client => {
      const result = await client.query(
        `UPDATE public.backstage_notion_shard_sync_leases
         SET
           lease_generation = lease_generation + 1,
           expires_at = GREATEST(
             acquired_at + INTERVAL '1 microsecond',
             statement_timestamp()
           )
         WHERE universe_id = $1
           AND shard_key = $2
           AND holder_id = $3
           AND lease_token = $4::UUID
           AND lease_generation = $5::BIGINT
           AND expires_at > statement_timestamp()`,
        [
          normalizeUniverseId(universeId),
          normalizeShardKey(shardKey),
          normalizedLease.holderId,
          normalizedLease.leaseToken,
          normalizedLease.leaseGeneration,
        ]
      );
      return result.rowCount === 1;
    });
  }

  async acquireProviderLease(
    providerKey: string,
    modelKey: string,
    holderId: string,
    ttlMs: number,
    nextRequestDelayMs = 0
  ): Promise<BackstageNotionProviderLease | null> {
    const normalizedProviderKey = normalizePattern(
      providerKey,
      'providerKey',
      PROVIDER_KEY_PATTERN
    );
    const normalizedModelKey = normalizeRequiredText(modelKey, 'modelKey', 200);
    const normalizedHolderId = normalizeRequiredText(holderId, 'holderId', 200);
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_PARTITION_LEASE_MIN_MS,
      BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS
    );
    const normalizedDelayMs = normalizeInteger(
      nextRequestDelayMs,
      'nextRequestDelayMs',
      0,
      BACKSTAGE_NOTION_PROVIDER_DELAY_MAX_MS
    );
    const token = randomUUID();
    return withBoundedTransaction(this.pool, async client => {
      const result = await client.query<ProviderLeaseRow>(
        `INSERT INTO public.backstage_notion_provider_coordinator_leases (
           provider_key,
           model_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at,
           next_request_at
         ) VALUES (
           $1,
           $2,
           $3,
           $4::UUID,
           1,
           statement_timestamp(),
           statement_timestamp() + ($5::BIGINT * INTERVAL '1 millisecond'),
           statement_timestamp() + ($6::BIGINT * INTERVAL '1 millisecond')
         )
         ON CONFLICT (provider_key, model_key) DO UPDATE
         SET
           holder_id = EXCLUDED.holder_id,
           lease_token = EXCLUDED.lease_token,
           lease_generation = backstage_notion_provider_coordinator_leases.lease_generation + 1,
           acquired_at = EXCLUDED.acquired_at,
           expires_at = EXCLUDED.expires_at,
           next_request_at = GREATEST(
             backstage_notion_provider_coordinator_leases.next_request_at,
             EXCLUDED.next_request_at
           )
         WHERE backstage_notion_provider_coordinator_leases.expires_at
                 <= statement_timestamp()
           AND backstage_notion_provider_coordinator_leases.next_request_at
                 <= statement_timestamp()
         RETURNING
           provider_key,
           model_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at,
           next_request_at`,
        [
          normalizedProviderKey,
          normalizedModelKey,
          normalizedHolderId,
          token,
          normalizedTtlMs,
          normalizedDelayMs,
        ]
      );
      return result.rows[0] ? mapProviderLease(result.rows[0]) : null;
    });
  }

  async renewProviderLease(
    providerKey: string,
    modelKey: string,
    lease: BackstageNotionPartitionLeaseFence,
    ttlMs: number,
    nextRequestDelayMs = 0
  ): Promise<BackstageNotionProviderLease | null> {
    const normalizedLease = normalizeLeaseFence(lease);
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_PARTITION_LEASE_MIN_MS,
      BACKSTAGE_NOTION_PARTITION_LEASE_MAX_MS
    );
    const normalizedDelayMs = normalizeInteger(
      nextRequestDelayMs,
      'nextRequestDelayMs',
      0,
      BACKSTAGE_NOTION_PROVIDER_DELAY_MAX_MS
    );
    return withBoundedTransaction(this.pool, async client => {
      const result = await client.query<ProviderLeaseRow>(
        `UPDATE public.backstage_notion_provider_coordinator_leases
         SET
           lease_generation = $6::BIGINT,
           expires_at = statement_timestamp() + ($7::BIGINT * INTERVAL '1 millisecond'),
           next_request_at = GREATEST(
             next_request_at,
             statement_timestamp() + ($8::BIGINT * INTERVAL '1 millisecond')
           )
         WHERE provider_key = $1
           AND model_key = $2
           AND holder_id = $3
           AND lease_token = $4::UUID
           AND lease_generation = $5::BIGINT
           AND expires_at > statement_timestamp()
         RETURNING
           provider_key,
           model_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at,
           next_request_at`,
        [
          normalizePattern(providerKey, 'providerKey', PROVIDER_KEY_PATTERN),
          normalizeRequiredText(modelKey, 'modelKey', 200),
          normalizedLease.holderId,
          normalizedLease.leaseToken,
          normalizedLease.leaseGeneration,
          incrementGeneration(normalizedLease.leaseGeneration, 'lease.leaseGeneration'),
          normalizedTtlMs,
          normalizedDelayMs,
        ]
      );
      return result.rows[0] ? mapProviderLease(result.rows[0]) : null;
    });
  }

  async releaseProviderLease(
    providerKey: string,
    modelKey: string,
    lease: BackstageNotionPartitionLeaseFence
  ): Promise<boolean> {
    const normalizedLease = normalizeLeaseFence(lease);
    return withBoundedTransaction(this.pool, async client => {
      const result = await client.query(
        `UPDATE public.backstage_notion_provider_coordinator_leases
         SET
           lease_generation = lease_generation + 1,
           expires_at = GREATEST(
             acquired_at + INTERVAL '1 microsecond',
             statement_timestamp()
           )
         WHERE provider_key = $1
           AND model_key = $2
           AND holder_id = $3
           AND lease_token = $4::UUID
           AND lease_generation = $5::BIGINT
           AND expires_at > statement_timestamp()`,
        [
          normalizePattern(providerKey, 'providerKey', PROVIDER_KEY_PATTERN),
          normalizeRequiredText(modelKey, 'modelKey', 200),
          normalizedLease.holderId,
          normalizedLease.leaseToken,
          normalizedLease.leaseGeneration,
        ]
      );
      return result.rowCount === 1;
    });
  }

  async activateShardSnapshot(
    input: ActivateBackstageNotionShardSnapshotInput
  ): Promise<ActivatedBackstageNotionShardSnapshot> {
    const snapshotId = normalizeUuid(input.snapshotId, 'snapshotId');
    const universeId = normalizeUniverseId(input.universeId);
    const shardKey = normalizeShardKey(input.shardKey);
    const partitionVersionId = normalizeUuid(
      input.partitionVersionId,
      'partitionVersionId'
    );
    const rootPageId = normalizeUuid(input.rootPageId, 'rootPageId');
    const sourceManifestHash = normalizeSha256(
      input.sourceManifestHash,
      'sourceManifestHash'
    );
    const embeddingModel = normalizeRequiredText(
      input.embeddingModel,
      'embeddingModel',
      200
    );
    const embeddingVersion = normalizeInteger(
      input.embeddingVersion,
      'embeddingVersion',
      1,
      2_147_483_647
    );
    const indexFormatVersion = normalizeInteger(
      input.indexFormatVersion,
      'indexFormatVersion',
      1,
      2_147_483_647
    );
    const sourceMaxLastEditedAt = normalizeDate(
      input.sourceMaxLastEditedAt,
      'sourceMaxLastEditedAt'
    );
    const expectedHead = normalizeShardHeadExpectation(input.expectedHead);
    const lease = normalizeLeaseFence(input.lease);
    const pages = normalizeSnapshotPages(input.pages, rootPageId);
    const occurrences = normalizeOccurrences(input.occurrences, pages);
    const verifications = normalizeVerifications(input.verifications);
    const derivedSourceMax = new Date(Math.max(...pages.map(page =>
      new Date(page.source_last_edited_at).getTime()
    )));
    if (derivedSourceMax.getTime() !== sourceMaxLastEditedAt.getTime()) {
      throw new Error('sourceMaxLastEditedAt does not match the supplied pages.');
    }
    const verifiedAt = latestRequiredVerification(verifications);

    return withBoundedTransaction(this.pool, async client => {
      const legacyAuthority = await client.query<{ authority: string }>(
        `SELECT authority
         FROM public.backstage_notion_universe_heads
         WHERE universe_id = $1
         FOR SHARE`,
        [universeId]
      );
      if (legacyAuthority.rows[0]?.authority !== 'notion') {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_AUTHORITY_UNAVAILABLE');
      }

      const universeHeadResult = await client.query<PartitionedUniverseHeadRow>(
        `SELECT
           desired_configuration_version_id,
           desired_configuration_generation,
           desired_configuration_hash,
           active_manifest_id,
           active_configuration_version_id,
           head_generation,
           manifest_generation
         FROM public.backstage_notion_partitioned_universe_heads
         WHERE universe_id = $1
         FOR SHARE`,
        [universeId]
      );
      const universeHead = universeHeadResult.rows[0];
      if (!universeHead) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
      }
      const desiredConfigurationVersionId = normalizeUuid(
        universeHead.desired_configuration_version_id,
        'desired_configuration_version_id'
      );

      const headResult = await client.query<ShardHeadRow>(
        `SELECT
           shard_key,
           current_partition_version_id,
           root_page_id,
           active_snapshot_id,
           head_generation,
           snapshot_generation
         FROM public.backstage_notion_shard_heads
         WHERE universe_id = $1
           AND shard_key = $2
         FOR UPDATE`,
        [universeId, shardKey]
      );
      const head = headResult.rows[0];
      if (!head || !shardHeadMatches(head, expectedHead)) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
      }

      const leaseResult = await client.query<ShardLeaseRow>(
        `SELECT
           universe_id,
           shard_key,
           holder_id,
           lease_token,
           lease_generation,
           acquired_at,
           expires_at
         FROM public.backstage_notion_shard_sync_leases
         WHERE universe_id = $1
           AND shard_key = $2
           AND holder_id = $3
           AND lease_token = $4::UUID
           AND lease_generation = $5::BIGINT
           AND expires_at > statement_timestamp()
         FOR UPDATE`,
        [
          universeId,
          shardKey,
          lease.holderId,
          lease.leaseToken,
          lease.leaseGeneration,
        ]
      );
      if (!leaseResult.rows[0]) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_LEASE_LOST');
      }

      const definition = await client.query<{
        root_page_id: string;
        state: string;
        max_pages: number | string;
        max_chunks: number | string;
        max_depth: number | string;
        max_content_code_points: number | string;
      }>(
         `SELECT
            definition.root_page_id,
            configuration.state,
           definition.max_pages,
           definition.max_chunks,
           definition.max_depth,
           definition.max_content_code_points
          FROM public.backstage_notion_partition_configuration_members AS member
          JOIN public.backstage_notion_partition_configuration_versions AS configuration
            ON configuration.universe_id = member.universe_id
           AND configuration.id = member.partition_configuration_version_id
           AND configuration.configuration_generation = member.configuration_generation
          JOIN public.backstage_notion_partition_versions AS definition
            ON definition.universe_id = member.universe_id
           AND definition.shard_key = member.shard_key
           AND definition.id = member.partition_version_id
          WHERE member.universe_id = $1
            AND member.partition_configuration_version_id = $2::UUID
            AND member.shard_key = $3
            AND member.partition_version_id = $4::UUID
          FOR SHARE OF member, definition, configuration`,
        [universeId, desiredConfigurationVersionId, shardKey, partitionVersionId]
      );
      const definitionRow = definition.rows[0];
      if (
        !definitionRow
        || definitionRow.state !== 'sealed'
        || normalizeUuid(definitionRow.root_page_id, 'root_page_id') !== rootPageId
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
      }

      const pageVersionIds = pages.map(page => page.page_version_id);
      const pageMaterial = await client.query<SnapshotPageMaterialRow>(
        `SELECT id, page_id, chunk_count, content_code_points, state
         FROM public.backstage_notion_page_versions
         WHERE universe_id = $1
           AND id = ANY($2::UUID[])
         ORDER BY id
         FOR SHARE`,
        [universeId, pageVersionIds]
      );
      if (pageMaterial.rows.length !== pages.length) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      const expectedPagesByVersion = new Map(pages.map(page => [
        page.page_version_id,
        page.page_id,
      ]));
      let contentCodePoints = 0;
      let derivedChunkCount = 0;
      for (const row of pageMaterial.rows) {
        const id = normalizeUuid(row.id, 'page_version_id');
        if (
          row.state !== 'sealed'
          || normalizeUuid(row.page_id, 'page_id') !== expectedPagesByVersion.get(id)
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
        }
        contentCodePoints += normalizeDatabaseInteger(
          row.content_code_points,
          'content_code_points'
        );
        derivedChunkCount += normalizeDatabaseInteger(row.chunk_count, 'chunk_count');
      }
      const maxDepth = Math.max(...pages.map(page => page.depth));
      if (
        derivedChunkCount !== occurrences.length
        || contentCodePoints < 1
        || pages.length > normalizeDatabaseInteger(definitionRow.max_pages, 'max_pages', 1)
        || occurrences.length > normalizeDatabaseInteger(
          definitionRow.max_chunks,
          'max_chunks',
          1
        )
        || maxDepth > normalizeDatabaseInteger(definitionRow.max_depth, 'max_depth')
        || contentCodePoints > normalizeDatabaseInteger(
          definitionRow.max_content_code_points,
          'max_content_code_points',
          1
        )
      ) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }

      const embeddingCoverage = await client.query<SnapshotEmbeddingCoverageRow>(
        `SELECT
           occurrence.page_id,
           occurrence.ordinal,
           embedding.embedding_dimension
         FROM pg_catalog.jsonb_to_recordset($2::JSONB) AS occurrence(
           page_id TEXT,
           page_version_id TEXT,
           ordinal INTEGER,
           chunk_version_id TEXT
         )
         JOIN public.backstage_notion_page_version_chunks AS page_chunk
           ON page_chunk.universe_id = $1
          AND page_chunk.page_version_id = occurrence.page_version_id::UUID
          AND page_chunk.ordinal = occurrence.ordinal
          AND page_chunk.chunk_version_id = occurrence.chunk_version_id::UUID
         JOIN public.backstage_notion_chunk_embeddings AS embedding
           ON embedding.universe_id = page_chunk.universe_id
          AND embedding.chunk_version_id = page_chunk.chunk_version_id
          AND embedding.embedding_model = $3
          AND embedding.embedding_version = $4
         ORDER BY occurrence.page_id, occurrence.ordinal
         FOR SHARE OF page_chunk, embedding`,
        [universeId, JSON.stringify(occurrences), embeddingModel, embeddingVersion]
      );
      if (embeddingCoverage.rows.length !== occurrences.length) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }
      let embeddingDimension: number | null = null;
      for (const [index, occurrence] of occurrences.entries()) {
        const coverage = embeddingCoverage.rows[index];
        const dimension = coverage
          ? normalizeDatabaseInteger(
            coverage.embedding_dimension,
            'embedding_dimension',
            1
          )
          : null;
        if (
          !coverage
          || normalizeUuid(coverage.page_id, 'page_id') !== occurrence.page_id
          || normalizeDatabaseInteger(coverage.ordinal, 'ordinal') !== occurrence.ordinal
          || (embeddingDimension !== null && dimension !== embeddingDimension)
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
        }
        embeddingDimension = dimension;
      }
      if (embeddingDimension === null) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }

      await client.query(
        `INSERT INTO public.backstage_notion_shard_snapshots (
           id,
           universe_id,
           shard_key,
           partition_version_id,
           root_page_id,
           source_manifest_hash,
           embedding_model,
           embedding_version,
           embedding_dimension,
           index_format_version,
           page_count,
           chunk_count,
           content_code_points,
           max_depth,
           source_max_last_edited_at,
           verification_count
         ) VALUES (
           $1::UUID, $2, $3, $4::UUID, $5::UUID, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15::TIMESTAMPTZ, $16
         )`,
        [
          snapshotId,
          universeId,
          shardKey,
          partitionVersionId,
          rootPageId,
          sourceManifestHash,
           embeddingModel,
           embeddingVersion,
           embeddingDimension,
           indexFormatVersion,
          pages.length,
          occurrences.length,
          contentCodePoints,
          maxDepth,
          sourceMaxLastEditedAt.toISOString(),
          verifications.length,
        ]
      );
      await client.query(
        `INSERT INTO public.backstage_notion_shard_snapshot_pages (
           universe_id,
           shard_key,
           shard_snapshot_id,
           page_id,
           page_version_id,
           parent_page_id,
           title,
           canonical_url,
           source_last_edited_at,
           depth,
           path,
           scope_path,
           scope_title_key,
           scope_path_key
         )
         SELECT
           $1,
           $2,
           $3::UUID,
           page.page_id::UUID,
           page.page_version_id::UUID,
           page.parent_page_id::UUID,
           page.title,
           page.canonical_url,
           page.source_last_edited_at::TIMESTAMPTZ,
           page.depth,
           page.path,
           page.scope_path,
           page.scope_title_key,
           page.scope_path_key
         FROM pg_catalog.jsonb_to_recordset($4::JSONB) AS page(
           page_id TEXT,
           page_version_id TEXT,
           parent_page_id TEXT,
           title TEXT,
           canonical_url TEXT,
           source_last_edited_at TEXT,
           depth INTEGER,
           path JSONB,
           scope_path JSONB,
           scope_title_key TEXT,
           scope_path_key JSONB
         )
         ORDER BY page.depth, page.page_id`,
        [universeId, shardKey, snapshotId, JSON.stringify(pages)]
      );
      await client.query(
        `INSERT INTO public.backstage_notion_shard_snapshot_chunk_occurrences (
           universe_id,
           shard_key,
           shard_snapshot_id,
           page_id,
           page_version_id,
           ordinal,
           chunk_version_id,
           embedding_model,
           embedding_version,
           category
         )
         SELECT
           $1,
           $2,
           $3::UUID,
           occurrence.page_id::UUID,
           occurrence.page_version_id::UUID,
           occurrence.ordinal,
           occurrence.chunk_version_id::UUID,
           $4,
           $5,
           occurrence.category
         FROM pg_catalog.jsonb_to_recordset($6::JSONB) AS occurrence(
           page_id TEXT,
           page_version_id TEXT,
           ordinal INTEGER,
           chunk_version_id TEXT,
           category TEXT
         )
         ORDER BY occurrence.page_id, occurrence.ordinal`,
        [
          universeId,
          shardKey,
          snapshotId,
          embeddingModel,
          embeddingVersion,
          JSON.stringify(occurrences),
        ]
      );
      await client.query(
        `INSERT INTO public.backstage_notion_shard_snapshot_verifications (
           universe_id,
           shard_key,
           shard_snapshot_id,
           ordinal,
           verification_kind,
           result_hash,
           verified_at
         )
         SELECT
           $1,
           $2,
           $3::UUID,
           verification.ordinal,
           verification.verification_kind,
           verification.result_hash,
           verification.verified_at::TIMESTAMPTZ
         FROM pg_catalog.jsonb_to_recordset($4::JSONB) AS verification(
           ordinal INTEGER,
           verification_kind TEXT,
           result_hash TEXT,
           verified_at TEXT
         )
         ORDER BY verification.ordinal`,
        [universeId, shardKey, snapshotId, JSON.stringify(verifications)]
      );
      const sealed = await client.query(
        `UPDATE public.backstage_notion_shard_snapshots
         SET state = 'sealed', sealed_at = statement_timestamp()
         WHERE universe_id = $1
           AND shard_key = $2
           AND id = $3::UUID
           AND state = 'building'`,
        [universeId, shardKey, snapshotId]
      );
      if (sealed.rowCount !== 1) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION');
      }

      const terminalLease = await client.query(
        `SELECT 1
         FROM public.backstage_notion_shard_sync_leases
         WHERE universe_id = $1
           AND shard_key = $2
           AND holder_id = $3
           AND lease_token = $4::UUID
           AND lease_generation = $5::BIGINT
           AND expires_at > statement_timestamp()`,
        [
          universeId,
          shardKey,
          lease.holderId,
          lease.leaseToken,
          lease.leaseGeneration,
        ]
      );
      if (!terminalLease.rows[0]) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_LEASE_LOST');
      }

      const nextHeadGeneration = incrementGeneration(
        expectedHead.headGeneration,
        'expectedHead.headGeneration'
      );
      const nextSnapshotGeneration = incrementGeneration(
        expectedHead.snapshotGeneration,
        'expectedHead.snapshotGeneration'
      );
      const activated = await client.query<{
        head_generation: number | string;
        snapshot_generation: number | string;
      }>(
        `UPDATE public.backstage_notion_shard_heads
         SET
           current_partition_version_id = $3::UUID,
           root_page_id = $4::UUID,
           active_snapshot_id = $5::UUID,
           head_generation = $6::BIGINT,
           snapshot_generation = $7::BIGINT,
           last_attempt_at = statement_timestamp(),
           last_verified_at = $8::TIMESTAMPTZ,
           updated_at = statement_timestamp()
         WHERE universe_id = $1
           AND shard_key = $2
           AND head_generation = $9::BIGINT
           AND snapshot_generation = $10::BIGINT
           AND current_partition_version_id = $11::UUID
           AND active_snapshot_id IS NOT DISTINCT FROM $12::UUID
         RETURNING head_generation, snapshot_generation`,
        [
          universeId,
          shardKey,
          partitionVersionId,
          rootPageId,
          snapshotId,
          nextHeadGeneration,
          nextSnapshotGeneration,
          verifiedAt.toISOString(),
          expectedHead.headGeneration,
          expectedHead.snapshotGeneration,
          expectedHead.currentPartitionVersionId,
          expectedHead.activeSnapshotId,
        ]
      );
      const activatedRow = activated.rows[0];
      if (!activatedRow) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
      }
      return Object.freeze({
        snapshotId,
        universeId,
        shardKey,
        partitionVersionId,
        pageCount: pages.length,
        chunkCount: occurrences.length,
        verifiedAt,
        headGeneration: mapGeneration(activatedRow.head_generation, 'head_generation'),
        snapshotGeneration: mapGeneration(
          activatedRow.snapshot_generation,
          'snapshot_generation'
        ),
      });
    });
  }

  async activateUniverseManifest(
    input: ActivateBackstageNotionUniverseManifestInput
  ): Promise<ActivatedBackstageNotionUniverseManifest> {
    const manifestId = normalizeUuid(input.manifestId, 'manifestId');
    const universeId = normalizeUniverseId(input.universeId);
    const configurationVersionId = normalizeUuid(
      input.configurationVersionId,
      'configurationVersionId'
    );
    const configurationGeneration = normalizePattern(
      input.configurationGeneration,
      'configurationGeneration',
      GENERATION_PATTERN
    );
    const configurationHash = normalizeSha256(
      input.configurationHash,
      'configurationHash'
    );
    const indexFormatVersion = normalizeInteger(
      input.indexFormatVersion,
      'indexFormatVersion',
      1,
      2_147_483_647
    );
    const expectedUniverseHead = normalizeUniverseHeadExpectation(
      input.expectedUniverseHead
    );
    if (
      !Array.isArray(input.members)
      || !Array.isArray(input.omissions)
      || input.members.length < 1
      || input.members.length + input.omissions.length
        > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
    ) {
      throw new Error('manifest decisions are outside their supported range.');
    }
    const decisionKeys = new Set<string>();
    const members = Object.freeze([...input.members]
      .sort((left, right) => compareText(left.shardKey, right.shardKey))
      .map((member, index) => {
        const shardKey = normalizeShardKey(member.shardKey);
        if (decisionKeys.has(shardKey)) {
          throw new Error('manifest decisions contain a duplicate shardKey.');
        }
        decisionKeys.add(shardKey);
        if (!['fresh', 'retained_last_known_good'].includes(member.decision)) {
          throw new Error(`members[${index}].decision is invalid.`);
        }
        return Object.freeze({
          shardKey,
          partitionVersionId: normalizeUuid(
            member.partitionVersionId,
            `members[${index}].partitionVersionId`
          ),
          snapshotId: normalizeUuid(member.snapshotId, `members[${index}].snapshotId`),
          decision: member.decision,
          verifiedAt: normalizeDate(
            member.verifiedAt,
            `members[${index}].verifiedAt`
          ),
          expectedHead: normalizeShardHeadExpectation(
            member.expectedHead,
            `members[${index}].expectedHead`
          ),
        });
      }));
    const omissions = Object.freeze([...input.omissions]
      .sort((left, right) => compareText(left.shardKey, right.shardKey))
      .map((omission, index) => {
        const shardKey = normalizeShardKey(omission.shardKey);
        if (decisionKeys.has(shardKey)) {
          throw new Error('manifest decisions contain a duplicate shardKey.');
        }
        decisionKeys.add(shardKey);
        if (!['optional_unavailable', 'optional_disabled'].includes(omission.decision)) {
          throw new Error(`omissions[${index}].decision is invalid.`);
        }
        return Object.freeze({
          shardKey,
          partitionVersionId: normalizeUuid(
            omission.partitionVersionId,
            `omissions[${index}].partitionVersionId`
          ),
          decision: omission.decision,
          safeReasonCode: normalizePattern(
            omission.safeReasonCode,
            `omissions[${index}].safeReasonCode`,
            SAFE_REASON_CODE_PATTERN
          ),
          expectedHead: normalizeShardHeadExpectation(
            omission.expectedHead,
            `omissions[${index}].expectedHead`
          ),
        });
      }));

    try {
      return await withBoundedTransaction(this.pool, async client => {
        await client.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended($1, 0)
           )`,
          [`${CONFIGURATION_ADVISORY_LOCK_NAMESPACE}${universeId}`]
        );
        const legacyAuthority = await client.query<{ authority: string }>(
          `SELECT authority
           FROM public.backstage_notion_universe_heads
           WHERE universe_id = $1
           FOR SHARE`,
          [universeId]
        );
        if (legacyAuthority.rows[0]?.authority !== 'notion') {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_AUTHORITY_UNAVAILABLE');
        }

        const universeHeadResult = await client.query<PartitionedUniverseHeadRow>(
          `SELECT
             desired_configuration_version_id,
             desired_configuration_generation,
             desired_configuration_hash,
             active_manifest_id,
             active_configuration_version_id,
             head_generation,
             manifest_generation
           FROM public.backstage_notion_partitioned_universe_heads
           WHERE universe_id = $1
           FOR UPDATE`,
          [universeId]
        );
        const universeHead = universeHeadResult.rows[0];
        if (
          !universeHead
          || !universeHeadMatches(universeHead, expectedUniverseHead)
          || normalizeUuid(
            universeHead.desired_configuration_version_id,
            'desired_configuration_version_id'
          ) !== configurationVersionId
          || universeHead.desired_configuration_generation !== configurationGeneration
          || normalizeSha256(
            universeHead.desired_configuration_hash,
            'desired_configuration_hash'
          ) !== configurationHash
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }

        const configuration = await client.query<ConfigurationRow>(
          `SELECT
             id,
             configuration_generation,
             configuration_hash,
             shard_count,
             state
           FROM public.backstage_notion_partition_configuration_versions
           WHERE universe_id = $1
             AND id = $2::UUID
             AND configuration_generation = $3
             AND configuration_hash = $4
           FOR SHARE`,
          [
            universeId,
            configurationVersionId,
            configurationGeneration,
            configurationHash,
          ]
        );
        const configurationRow = configuration.rows[0];
        if (
          !configurationRow
          || configurationRow.state !== 'sealed'
          || normalizeDatabaseInteger(configurationRow.shard_count, 'shard_count', 1)
            !== decisionKeys.size
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }

        const allHeadRows = await client.query<ShardHeadRow>(
          `SELECT
             head.shard_key,
             head.current_partition_version_id,
             head.root_page_id,
             head.active_snapshot_id,
             head.head_generation,
             head.snapshot_generation
           FROM public.backstage_notion_partition_configuration_members AS member
           JOIN public.backstage_notion_shard_heads AS head
             ON head.universe_id = member.universe_id
            AND head.shard_key = member.shard_key
           WHERE member.universe_id = $1
             AND member.partition_configuration_version_id = $2::UUID
           ORDER BY member.shard_key
           FOR SHARE OF member, head`,
          [universeId, configurationVersionId]
        );
        const headByShard = new Map(allHeadRows.rows.map(row => [row.shard_key, row]));
        const definitions = await client.query<{
          id: string;
          shard_key: string;
          is_required: boolean;
        }>(
          `SELECT
             definition.id,
             definition.shard_key,
             definition.is_required
           FROM public.backstage_notion_partition_configuration_members AS member
           JOIN public.backstage_notion_partition_versions AS definition
             ON definition.universe_id = member.universe_id
            AND definition.shard_key = member.shard_key
            AND definition.id = member.partition_version_id
           WHERE member.universe_id = $1
             AND member.partition_configuration_version_id = $2::UUID
           ORDER BY member.shard_key
           FOR SHARE OF member, definition`,
          [universeId, configurationVersionId]
        );
        if (definitions.rows.length !== decisionKeys.size) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION');
        }
        const definitionByShard = new Map(definitions.rows.map(row => [
          row.shard_key,
          {
            partitionVersionId: normalizeUuid(row.id, 'partition_version_id'),
            required: row.is_required,
          },
        ]));

        for (const member of members) {
          const definition = definitionByShard.get(member.shardKey);
          const head = headByShard.get(member.shardKey);
          if (
            !definition
            || definition.partitionVersionId !== member.partitionVersionId
            || !head
            || !shardHeadMatches(head, member.expectedHead)
            || normalizeUuid(
              head.current_partition_version_id,
              'current_partition_version_id'
            ) !== member.partitionVersionId
            || (head.active_snapshot_id === null
              ? null
              : normalizeUuid(head.active_snapshot_id, 'active_snapshot_id'))
              !== member.snapshotId
          ) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
          }
        }
        for (const omission of omissions) {
          const definition = definitionByShard.get(omission.shardKey);
          const head = headByShard.get(omission.shardKey);
          if (!definition || definition.required) {
            throw repositoryError(
              'BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE'
            );
          }
          if (
            definition.partitionVersionId !== omission.partitionVersionId
            || !head
            || !shardHeadMatches(head, omission.expectedHead)
          ) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
          }
        }
        for (const definition of definitions.rows) {
          if (definition.is_required && !members.some(member =>
            member.shardKey === definition.shard_key
          )) {
            throw repositoryError(
              'BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE'
            );
          }
        }

        const snapshots = await client.query<ManifestSnapshotRow>(
          `SELECT
             snapshot.id,
             snapshot.shard_key,
             snapshot.partition_version_id,
             snapshot.page_count,
             snapshot.chunk_count,
             snapshot.embedding_model,
             snapshot.embedding_version,
             snapshot.embedding_dimension,
             snapshot.index_format_version,
             snapshot.state,
             verification.latest_verified_at
           FROM public.backstage_notion_shard_snapshots AS snapshot
           LEFT JOIN LATERAL (
             SELECT pg_catalog.max(evidence.verified_at) AS latest_verified_at
             FROM public.backstage_notion_shard_snapshot_verifications AS evidence
             WHERE evidence.universe_id = snapshot.universe_id
               AND evidence.shard_key = snapshot.shard_key
               AND evidence.shard_snapshot_id = snapshot.id
               AND evidence.verification_kind IN ('source_drift', 'completeness')
           ) AS verification ON TRUE
           WHERE snapshot.universe_id = $1
             AND snapshot.id = ANY($2::UUID[])
           ORDER BY snapshot.shard_key
           FOR SHARE OF snapshot`,
          [universeId, members.map(member => member.snapshotId)]
        );
        if (snapshots.rows.length !== members.length) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
        }
        const snapshotById = new Map(snapshots.rows.map(row => [
          normalizeUuid(row.id, 'snapshot_id'),
          row,
        ]));
        for (const member of members) {
          const snapshot = snapshotById.get(member.snapshotId);
          const latestVerifiedAt = snapshot?.latest_verified_at === null
            || snapshot?.latest_verified_at === undefined
            ? null
            : parseDate(snapshot.latest_verified_at, 'latest_verified_at');
          const snapshotEmbeddingModel = snapshot
            ? normalizeRequiredText(
              snapshot.embedding_model,
              'snapshot.embedding_model',
              200
            )
            : null;
          const snapshotEmbeddingVersion = snapshot
            ? normalizeDatabaseInteger(
              snapshot.embedding_version,
              'snapshot.embedding_version',
              1
            )
            : null;
          const snapshotEmbeddingDimension = snapshot
            ? normalizeDatabaseInteger(
              snapshot.embedding_dimension,
              'snapshot.embedding_dimension',
              1
            )
            : null;
          if (
            !snapshot
            || snapshot.shard_key !== member.shardKey
            || normalizeUuid(snapshot.partition_version_id, 'partition_version_id')
              !== member.partitionVersionId
            || snapshot.state !== 'sealed'
            || normalizeDatabaseInteger(
              snapshot.index_format_version,
              'index_format_version',
              1
            ) !== indexFormatVersion
            || snapshotEmbeddingModel === null
            || snapshotEmbeddingVersion === null
            || snapshotEmbeddingDimension === null
            || latestVerifiedAt?.getTime() !== member.verifiedAt.getTime()
          ) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
          }
        }

        const ownershipConflicts = await client.query<ManifestOwnershipConflictRow>(
          `WITH candidate_members AS (
             SELECT
               candidate.shard_key,
               candidate.shard_snapshot_id::UUID AS shard_snapshot_id
             FROM pg_catalog.jsonb_to_recordset($2::JSONB) AS candidate(
               shard_key TEXT,
               shard_snapshot_id TEXT
             )
           ), candidate_pages AS (
             SELECT candidate.shard_key, page.page_id
             FROM candidate_members AS candidate
             JOIN public.backstage_notion_shard_snapshot_pages AS page
               ON page.universe_id = $1
              AND page.shard_key = candidate.shard_key
              AND page.shard_snapshot_id = candidate.shard_snapshot_id
           )
           SELECT
             left_page.shard_key AS left_shard_key,
             right_page.shard_key AS right_shard_key
           FROM candidate_pages AS left_page
           JOIN candidate_pages AS right_page
             ON right_page.page_id = left_page.page_id
            AND right_page.shard_key > left_page.shard_key
           GROUP BY left_page.shard_key, right_page.shard_key
           ORDER BY left_page.shard_key, right_page.shard_key`,
          [
            universeId,
            JSON.stringify(members.map(member => ({
              shard_key: member.shardKey,
              shard_snapshot_id: member.snapshotId,
            }))),
          ]
        );
        const ownershipExcludedShardKeys = new Set<string>();
        for (const conflict of ownershipConflicts.rows) {
          const left = definitionByShard.get(conflict.left_shard_key);
          const right = definitionByShard.get(conflict.right_shard_key);
          if (!left || !right || (left.required && right.required)) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT');
          }
          if (!left.required) {
            ownershipExcludedShardKeys.add(conflict.left_shard_key);
          }
          if (!right.required) {
            ownershipExcludedShardKeys.add(conflict.right_shard_key);
          }
        }
        const effectiveMembers = Object.freeze(members.filter(member =>
          !ownershipExcludedShardKeys.has(member.shardKey)
        ));
        if (effectiveMembers.length < 1) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT');
        }
        const effectiveOmissions = Object.freeze([
          ...omissions,
          ...members.filter(member => ownershipExcludedShardKeys.has(member.shardKey))
            .map(member => Object.freeze({
              shardKey: member.shardKey,
              partitionVersionId: member.partitionVersionId,
              decision: 'optional_unavailable' as const,
              safeReasonCode: 'SHARD_OWNERSHIP_CONFLICT',
              expectedHead: member.expectedHead,
            })),
        ].sort((left, right) => compareText(left.shardKey, right.shardKey)));

        let pageCount = 0;
        let chunkCount = 0;
        let manifestEmbeddingModel: string | null = null;
        let manifestEmbeddingVersion: number | null = null;
        let manifestEmbeddingDimension: number | null = null;
        for (const member of effectiveMembers) {
          const snapshot = snapshotById.get(member.snapshotId)!;
          const snapshotEmbeddingModel = normalizeRequiredText(
            snapshot.embedding_model,
            'snapshot.embedding_model',
            200
          );
          const snapshotEmbeddingVersion = normalizeDatabaseInteger(
            snapshot.embedding_version,
            'snapshot.embedding_version',
            1
          );
          const snapshotEmbeddingDimension = normalizeDatabaseInteger(
            snapshot.embedding_dimension,
            'snapshot.embedding_dimension',
            1
          );
          if (
            (manifestEmbeddingModel !== null
              && snapshotEmbeddingModel !== manifestEmbeddingModel)
            || (manifestEmbeddingVersion !== null
              && snapshotEmbeddingVersion !== manifestEmbeddingVersion)
            || (manifestEmbeddingDimension !== null
              && snapshotEmbeddingDimension !== manifestEmbeddingDimension)
          ) {
            throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
          }
          manifestEmbeddingModel = snapshotEmbeddingModel;
          manifestEmbeddingVersion = snapshotEmbeddingVersion;
          manifestEmbeddingDimension = snapshotEmbeddingDimension;
          pageCount += normalizeDatabaseInteger(snapshot.page_count, 'page_count', 1);
          chunkCount += normalizeDatabaseInteger(snapshot.chunk_count, 'chunk_count', 1);
        }
        if (
          manifestEmbeddingModel === null
          || manifestEmbeddingVersion === null
          || manifestEmbeddingDimension === null
        ) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
        }

        await client.query(
          `INSERT INTO public.backstage_notion_universe_manifests (
             id,
             universe_id,
             partition_configuration_version_id,
             configuration_generation,
             configuration_hash,
             embedding_model,
             embedding_version,
             embedding_dimension,
             index_format_version,
             member_count,
             omission_count,
             page_count,
             chunk_count
           ) VALUES (
             $1::UUID, $2, $3::UUID, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13
           )`,
          [
            manifestId,
            universeId,
            configurationVersionId,
            configurationGeneration,
            configurationHash,
            manifestEmbeddingModel,
            manifestEmbeddingVersion,
            manifestEmbeddingDimension,
            indexFormatVersion,
            effectiveMembers.length,
            effectiveOmissions.length,
            pageCount,
            chunkCount,
          ]
        );
        await client.query(
          `INSERT INTO public.backstage_notion_universe_manifest_shards (
             universe_id,
             manifest_id,
             shard_key,
             partition_version_id,
             shard_snapshot_id,
             decision,
             is_required,
             verified_at
           )
           SELECT
             $1,
             $2::UUID,
             member.shard_key,
             member.partition_version_id::UUID,
             member.shard_snapshot_id::UUID,
             member.decision,
             definition.is_required,
             member.verified_at::TIMESTAMPTZ
           FROM pg_catalog.jsonb_to_recordset($3::JSONB) AS member(
             shard_key TEXT,
             partition_version_id TEXT,
             shard_snapshot_id TEXT,
             decision TEXT,
             verified_at TEXT
           )
           JOIN public.backstage_notion_partition_configuration_members AS configured
             ON configured.universe_id = $1
            AND configured.partition_configuration_version_id = $4::UUID
            AND configured.shard_key = member.shard_key
            AND configured.partition_version_id = member.partition_version_id::UUID
           JOIN public.backstage_notion_partition_versions AS definition
             ON definition.universe_id = configured.universe_id
            AND definition.shard_key = configured.shard_key
            AND definition.id = configured.partition_version_id
           ORDER BY member.shard_key`,
          [
            universeId,
            manifestId,
            JSON.stringify(effectiveMembers.map(member => ({
              shard_key: member.shardKey,
              partition_version_id: member.partitionVersionId,
              shard_snapshot_id: member.snapshotId,
              decision: member.decision,
              verified_at: member.verifiedAt.toISOString(),
            }))),
            configurationVersionId,
          ]
        );
        if (effectiveOmissions.length > 0) {
          await client.query(
            `INSERT INTO public.backstage_notion_universe_manifest_omissions (
               universe_id,
               manifest_id,
               shard_key,
               partition_version_id,
               decision,
               safe_reason_code
             )
             SELECT
               $1,
               $2::UUID,
               omission.shard_key,
               omission.partition_version_id::UUID,
               omission.decision,
               omission.safe_reason_code
             FROM pg_catalog.jsonb_to_recordset($3::JSONB) AS omission(
               shard_key TEXT,
               partition_version_id TEXT,
               decision TEXT,
               safe_reason_code TEXT
             )
             ORDER BY omission.shard_key`,
            [
              universeId,
              manifestId,
              JSON.stringify(effectiveOmissions.map(omission => ({
                shard_key: omission.shardKey,
                partition_version_id: omission.partitionVersionId,
                decision: omission.decision,
                safe_reason_code: omission.safeReasonCode,
              }))),
            ]
          );
        }
        await client.query(
          `INSERT INTO public.backstage_notion_manifest_page_ownership (
             universe_id,
             manifest_id,
             page_id,
             shard_key,
             shard_snapshot_id
           )
           SELECT
             member.universe_id,
             member.manifest_id,
             page.page_id,
             member.shard_key,
             member.shard_snapshot_id
           FROM public.backstage_notion_universe_manifest_shards AS member
           JOIN public.backstage_notion_shard_snapshot_pages AS page
             ON page.universe_id = member.universe_id
            AND page.shard_key = member.shard_key
            AND page.shard_snapshot_id = member.shard_snapshot_id
           WHERE member.universe_id = $1
             AND member.manifest_id = $2::UUID
           ORDER BY member.shard_key, page.page_id`,
          [universeId, manifestId]
        );
        const sealed = await client.query(
          `UPDATE public.backstage_notion_universe_manifests
           SET state = 'sealed', sealed_at = statement_timestamp()
           WHERE universe_id = $1
             AND id = $2::UUID
             AND state = 'building'`,
          [universeId, manifestId]
        );
        if (sealed.rowCount !== 1) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
        }

        const terminalAuthority = await client.query<{ authority: string }>(
          `SELECT authority
           FROM public.backstage_notion_universe_heads
           WHERE universe_id = $1`,
          [universeId]
        );
        if (terminalAuthority.rows[0]?.authority !== 'notion') {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_AUTHORITY_UNAVAILABLE');
        }
        const nextHeadGeneration = incrementGeneration(
          expectedUniverseHead.headGeneration,
          'expectedUniverseHead.headGeneration'
        );
        const nextManifestGeneration = incrementGeneration(
          expectedUniverseHead.manifestGeneration,
          'expectedUniverseHead.manifestGeneration'
        );
        const oldestVerification = new Date(Math.min(...effectiveMembers.map(member =>
          member.verifiedAt.getTime()
        )));
        const activated = await client.query<{
          head_generation: number | string;
          manifest_generation: number | string;
        }>(
          `UPDATE public.backstage_notion_partitioned_universe_heads
           SET
             active_manifest_id = $2::UUID,
             active_configuration_version_id = $3::UUID,
             head_generation = $4::BIGINT,
             manifest_generation = $5::BIGINT,
             last_verified_at = $6::TIMESTAMPTZ,
             updated_at = statement_timestamp()
           WHERE universe_id = $1
             AND head_generation = $7::BIGINT
             AND manifest_generation = $8::BIGINT
             AND desired_configuration_version_id = $9::UUID
             AND desired_configuration_generation = $10
             AND desired_configuration_hash = $11
             AND active_manifest_id IS NOT DISTINCT FROM $12::UUID
           RETURNING head_generation, manifest_generation`,
          [
            universeId,
            manifestId,
            configurationVersionId,
            nextHeadGeneration,
            nextManifestGeneration,
            oldestVerification.toISOString(),
            expectedUniverseHead.headGeneration,
            expectedUniverseHead.manifestGeneration,
            configurationVersionId,
            configurationGeneration,
            configurationHash,
            expectedUniverseHead.activeManifestId,
          ]
        );
        const activatedRow = activated.rows[0];
        if (!activatedRow) {
          throw repositoryError('BACKSTAGE_NOTION_PARTITION_STALE_HEAD');
        }
        return Object.freeze({
          manifestId,
          universeId,
          configurationVersionId,
          memberCount: effectiveMembers.length,
          omissionCount: effectiveOmissions.length,
          pageCount,
          chunkCount,
          headGeneration: mapGeneration(activatedRow.head_generation, 'head_generation'),
          manifestGeneration: mapGeneration(
            activatedRow.manifest_generation,
            'manifest_generation'
          ),
        });
      });
    } catch (error) {
      if (isNamedUniqueViolation(
        error,
        MANIFEST_PAGE_OWNERSHIP_UNIQUE_CONSTRAINT
      )) {
        throw repositoryError('BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT');
      }
      throw error;
    }
  }
}

export function getBackstageNotionPartitionRepository(
  pool: Pool | null = getPool()
): PostgresBackstageNotionPartitionRepository {
  if (!pool) {
    throw new BackstageNotionPartitionRepositoryUnavailableError();
  }
  return new PostgresBackstageNotionPartitionRepository(pool);
}
