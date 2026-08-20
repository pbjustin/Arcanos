import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION } from '@shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '@shared/backstage/backstageNotionScopeIndex.js';
import { getPool } from '../client.js';

export const BACKSTAGE_NOTION_SYNC_LEASE_MIN_MS = 1_000;
export const BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS = 15 * 60 * 1_000;
export const BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT = 5_000;
export const BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT = 2_048;
export const BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES = 1_000;

const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BACKSTAGE_NOTION_CHUNK_METADATA_PROJECTION_SQL = `jsonb_build_object(
  'category', CASE
    WHEN jsonb_typeof(chunk.metadata -> 'category') = 'string'
      AND octet_length(convert_to(chunk.metadata ->> 'category', 'UTF8')) <= 32
    THEN chunk.metadata -> 'category'
    ELSE NULL
  END,
  'headingIndexVersion', CASE
    WHEN jsonb_typeof(chunk.metadata -> 'headingIndexVersion') = 'number'
      AND octet_length(convert_to(
        (chunk.metadata -> 'headingIndexVersion')::TEXT,
        'UTF8'
      )) <= 16
    THEN chunk.metadata -> 'headingIndexVersion'
    ELSE NULL
  END,
  'headingOccurrencePath', CASE
    WHEN jsonb_typeof(chunk.metadata -> 'headingOccurrencePath') = 'array'
      AND jsonb_array_length(chunk.metadata -> 'headingOccurrencePath') <= 32
      AND octet_length(convert_to(
        (chunk.metadata -> 'headingOccurrencePath')::TEXT,
        'UTF8'
      )) <= 1024
    THEN chunk.metadata -> 'headingOccurrencePath'
    ELSE NULL
  END,
  'sourceHash', CASE
    WHEN jsonb_typeof(chunk.metadata -> 'sourceHash') = 'string'
      AND octet_length(convert_to(chunk.metadata ->> 'sourceHash', 'UTF8')) <= 64
    THEN chunk.metadata -> 'sourceHash'
    ELSE NULL
  END,
  'sourceLastEditedAt', CASE
    WHEN chunk.metadata -> 'sourceLastEditedAt' = 'null'::JSONB
    THEN 'null'::JSONB
    WHEN jsonb_typeof(chunk.metadata -> 'sourceLastEditedAt') = 'string'
      AND octet_length(convert_to(
        chunk.metadata ->> 'sourceLastEditedAt',
        'UTF8'
      )) <= 64
    THEN chunk.metadata -> 'sourceLastEditedAt'
    ELSE to_jsonb('__INVALID_SOURCE_LAST_EDITED_AT__'::TEXT)
  END
)`;

type TimestampValue = Date | string;

export type BackstageNotionAuthority = 'postgres' | 'notion';

export interface BackstageNotionAuthorityHead {
  universeId: string;
  authority: BackstageNotionAuthority;
  activeSnapshotId: string | null;
  rootPageId: string | null;
}

export interface BackstageNotionSyncLease {
  universeId: string;
  holderId: string;
  leaseToken: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface BackstageNotionSnapshotPageInput {
  pageId: string;
  parentPageId?: string | null;
  title: string;
  canonicalUrl?: string | null;
  contentHash: string;
  markdown: string;
  sourceLastEditedAt?: Date | string | null;
  depth: number;
  path: string[];
  metadata?: Record<string, unknown>;
}

export interface BackstageNotionSnapshotChunkInput {
  chunkId: string;
  pageId: string;
  ordinal: number;
  contentHash: string;
  content: string;
  codePoints: number;
  embedding: number[];
  headingPath?: string[];
  metadata?: Record<string, unknown>;
}

export interface ActivateBackstageNotionSnapshotInput {
  universeId: string;
  rootPageId: string;
  manifestHash: string;
  embeddingModel: string;
  sourceMaxEditedAt?: Date | string | null;
  lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>;
  pages: BackstageNotionSnapshotPageInput[];
  chunks: BackstageNotionSnapshotChunkInput[];
}

export interface BackstageNotionSnapshotRecord {
  id: string;
  universeId: string;
  rootPageId: string;
  manifestHash: string;
  embeddingModel: string;
  pageCount: number;
  chunkCount: number;
  sourceMaxEditedAt: Date | null;
  syncHolderId: string;
  createdAt: Date;
}

export interface BackstageNotionActiveChunkMetadata {
  id: string;
  pageId: string;
  pageTitle: string;
  pagePath: string[];
  ordinal: number;
  contentHash: string;
  codePoints: number;
  embeddingModel: string;
  headingPath: string[];
  metadata: Record<string, unknown>;
}

export interface BackstageNotionActiveChunk extends BackstageNotionActiveChunkMetadata {
  content: string;
  embedding: number[];
}

export interface BackstageNotionActiveSnapshotHeader {
  authority: 'notion';
  verifiedAt: Date;
  snapshot: BackstageNotionSnapshotRecord;
}

export interface BackstageNotionActiveSnapshot
  extends BackstageNotionActiveSnapshotHeader {
  chunks: BackstageNotionActiveChunk[];
  truncated: boolean;
}

export interface BackstageNotionSnapshotChunkPageSelector {
  pageId: string | null;
  scopeKind: 'all' | 'page' | 'subtree';
  sectionOccurrencePath: readonly number[] | null;
}

export interface BackstageNotionSnapshotScopeLookup {
  pageTitleKey: string;
  pagePathKey: readonly string[] | null;
  sectionPathKey: readonly string[] | null;
  scopeKind?: 'page' | 'subtree';
}

export type BackstageNotionSnapshotScopeResolution =
  | { status: 'not_found' | 'ambiguous' | 'invalid' }
  | {
      status: 'resolved';
      pageTitle: string;
      pagePath: string[];
      sectionPath: string[] | null;
      selector: BackstageNotionSnapshotChunkPageSelector;
      scopeChunkCount: number;
      scopePageCount: number;
    };

export interface BackstageNotionSnapshotChunkPageChunk
  extends BackstageNotionActiveChunkMetadata {
  content: string;
}

export interface BackstageNotionSnapshotChunkPage {
  scopeChunkCount: number;
  chunks: BackstageNotionSnapshotChunkPageChunk[];
}

export interface BackstageNotionPageInventoryRecord {
  pageId: string;
  parentPageId: string | null;
  title: string;
  canonicalUrl: string | null;
  contentHash: string;
  sourceLastEditedAt: Date | null;
  depth: number;
  path: string[];
  metadata: Record<string, unknown>;
}

export interface BackstageNotionActiveInventory {
  authority: 'notion';
  verifiedAt: Date;
  snapshot: BackstageNotionSnapshotRecord;
  pages: BackstageNotionPageInventoryRecord[];
}

export interface BackstageNotionRagRepository {
  loadAuthorityHead(universeId: string): Promise<BackstageNotionAuthorityHead | null>;
  acquireSyncLease(
    universeId: string,
    holderId: string,
    ttlMs: number
  ): Promise<BackstageNotionSyncLease | null>;
  renewSyncLease(
    universeId: string,
    holderId: string,
    leaseToken: string,
    ttlMs: number
  ): Promise<BackstageNotionSyncLease | null>;
  releaseSyncLease(
    universeId: string,
    holderId: string,
    leaseToken: string
  ): Promise<boolean>;
  loadReusableEmbeddings(
    universeId: string,
    embeddingModel: string,
    contentHashes: string[]
  ): Promise<Map<string, number[]>>;
  markActiveSnapshotVerified(
    universeId: string,
    manifestHash: string,
    lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>
  ): Promise<Date | null>;
  activateSnapshot(
    input: ActivateBackstageNotionSnapshotInput
  ): Promise<BackstageNotionSnapshotRecord>;
  loadActiveSnapshot(
    universeId: string,
    maxChunks: number
  ): Promise<BackstageNotionActiveSnapshot | null>;
  loadActiveSnapshotHeader(
    universeId: string
  ): Promise<BackstageNotionActiveSnapshotHeader | null>;
  resolveSnapshotScope(
    universeId: string,
    snapshotId: string,
    lookup: BackstageNotionSnapshotScopeLookup
  ): Promise<BackstageNotionSnapshotScopeResolution>;
  loadSnapshotChunkPage(
    universeId: string,
    snapshotId: string,
    selector: BackstageNotionSnapshotChunkPageSelector,
    /** Null for SQL counting; otherwise a MAC-authenticated immutable-snapshot count. */
    knownScopeChunkCount: number | null,
    offset: number,
    limit: number
  ): Promise<BackstageNotionSnapshotChunkPage>;
  loadActiveInventory(universeId: string): Promise<BackstageNotionActiveInventory | null>;
}

interface AuthorityHeadRow {
  universe_id: string;
  authority: string;
  active_snapshot_id: string | null;
  root_page_id: string | null;
}

interface LeaseRow {
  universe_id: string;
  holder_id: string;
  lease_token: string;
  acquired_at: TimestampValue;
  expires_at: TimestampValue;
}

interface SnapshotRow {
  snapshot_id: string;
  universe_id: string;
  root_page_id: string;
  manifest_hash: string;
  embedding_model: string;
  page_count: number | string;
  chunk_count: number | string;
  source_max_edited_at: TimestampValue | null;
  sync_holder_id: string;
  snapshot_created_at: TimestampValue;
}

interface ChunkMetadataRow {
  chunk_id: string;
  page_id: string;
  page_title: string;
  page_path: unknown;
  ordinal: number | string;
  content_hash: string;
  code_points: number | string;
  chunk_embedding_model: string;
  heading_path: unknown;
  chunk_metadata: unknown;
}

interface ActiveSnapshotHeaderRow extends SnapshotRow {
  authority: 'notion';
  verified_at: TimestampValue;
}

interface ActiveChunkMetadataRow extends ActiveSnapshotHeaderRow, ChunkMetadataRow {}

interface ActiveChunkRow extends ActiveChunkMetadataRow {
  content: string;
  embedding: unknown;
}

interface SnapshotChunkPageRow extends ChunkMetadataRow {
  content: string;
}

interface SnapshotChunkScopeCountRow {
  scope_chunk_count: number | string;
}

interface SnapshotScopeIntegrityRow {
  scope_integrity_valid: boolean;
}

interface SnapshotPageScopeCandidateRow {
  page_id: string;
  page_title: string;
  page_path: unknown;
  scope_chunk_count: number | string;
  scope_page_count: number | string;
}

interface SnapshotSectionScopeCandidateRow {
  section_occurrence_path: unknown;
  section_path: unknown;
  scope_chunk_count: number | string;
}

interface InventoryRow extends SnapshotRow {
  authority: 'notion';
  verified_at: TimestampValue;
  page_id: string;
  parent_page_id: string | null;
  title: string;
  canonical_url: string | null;
  content_hash: string;
  source_last_edited_at: TimestampValue | null;
  depth: number | string;
  path: unknown;
  page_metadata: unknown;
}

interface ReusableEmbeddingRow {
  content_hash: string;
  embedding: unknown;
}

interface PreparedPage {
  page_id: string;
  parent_page_id: string | null;
  title: string;
  canonical_url: string | null;
  content_hash: string;
  markdown: string;
  source_last_edited_at: string | null;
  depth: number;
  path: string[];
  metadata: Record<string, unknown>;
}

interface PreparedChunk {
  chunk_id: string;
  page_id: string;
  ordinal: number;
  content_hash: string;
  content: string;
  code_points: number;
  embedding: number[];
  heading_path: string[];
  metadata: Record<string, unknown>;
}

interface PreparedSnapshotInput {
  universeId: string;
  rootPageId: string;
  manifestHash: string;
  embeddingModel: string;
  sourceMaxEditedAt: Date | null;
  holderId: string;
  leaseToken: string;
  pages: PreparedPage[];
  chunks: PreparedChunk[];
}

export class BackstageNotionRagRepositoryUnavailableError extends Error {
  readonly code = 'BACKSTAGE_NOTION_RAG_REPOSITORY_UNAVAILABLE';

  constructor() {
    super('Backstage Notion RAG persistence requires PostgreSQL.');
    this.name = 'BackstageNotionRagRepositoryUnavailableError';
  }
}

export class BackstageNotionSyncLeaseError extends Error {
  readonly code = 'BACKSTAGE_NOTION_SYNC_LEASE_LOST';

  constructor() {
    super('The Backstage Notion synchronization lease is absent, expired, or no longer owned by this synchronizer.');
    this.name = 'BackstageNotionSyncLeaseError';
  }
}

function normalizeUniverseId(value: string): string {
  const normalized = value.trim();
  if (!UNIVERSE_ID_PATTERN.test(normalized)) {
    throw new Error('universeId must be 1-128 supported characters.');
  }
  return normalized;
}

function normalizeRequiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a canonical UUID.`);
  }
  return normalized;
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid finite timestamp.`);
  }
  return date;
}

function parseDate(value: TimestampValue, label: string): Date {
  return normalizeDate(value, label);
}

function normalizeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseInteger(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is not a safe integer.`);
  }
  return parsed;
}

function normalizeStringArray(
  value: string[],
  label: string,
  maxItems: number,
  maxItemLength = 500
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} strings.`);
  }
  return value.map((item, index) =>
    normalizeRequiredText(item, `${label}[${index}]`, maxItemLength)
  );
}

function normalizeScopeLookupKey(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || !SHA256_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a canonical Notion scope-key digest.`);
  }
  return value;
}

function normalizeScopeLookupPath(
  value: readonly string[] | null,
  label: string,
  maximumItems: number
): string[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems) {
    throw new Error(`${label} must contain 1-${maximumItems} scope keys.`);
  }
  return value.map((item, index) => normalizeScopeLookupKey(
    item,
    `${label}[${index}]`
  ));
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} is not a string array.`);
  }
  return value.map(item => item as string);
}

function parseBoundedPersistedStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  minimumItems = 0
): string[] {
  const parsed = parseStringArray(value, label);
  if (parsed.length < minimumItems || parsed.length > maximumItems) {
    throw new Error(`${label} escaped its supported item bounds.`);
  }
  for (const [index, item] of parsed.entries()) {
    if (normalizeRequiredText(item, `${label}[${index}]`, 500) !== item) {
      throw new Error(`${label}[${index}] is not canonical persisted text.`);
    }
  }
  return parsed;
}

function parseBoundedPersistedOccurrencePath(
  value: unknown,
  label: string,
  expectedLength: number
): number[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label} escaped its expected length.`);
  }
  return value.map((occurrence, index) => normalizeInteger(
    typeof occurrence === 'string' ? Number(occurrence) : occurrence as number,
    `${label}[${index}]`,
    1,
    BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
  ));
}

function normalizeJsonObject(
  value: Record<string, unknown> | undefined,
  label: string
): Record<string, unknown> {
  const candidate = value ?? {};
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(candidate);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > 262_144) {
    throw new Error(`${label} exceeds the 262144-byte limit.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function requireExactStringArray(
  value: unknown,
  expected: readonly string[],
  label: string
): void {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])
  ) {
    throw new Error(`${label} does not match its normalized indexed source.`);
  }
}

function validatePageScopeIndexMetadata(
  metadata: Record<string, unknown>,
  title: string,
  path: readonly string[],
  label: string
): void {
  if (
    metadata.indexFormat !== BACKSTAGE_NOTION_RAG_INDEX_FORMAT
    || metadata.headingIndexVersion !== BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION
    || metadata.scopeTitleKey !== normalizeBackstageNotionScopeKey(title)
  ) {
    throw new Error(`${label} does not describe the current Notion scope index.`);
  }
  requireExactStringArray(
    metadata.scopePathKey,
    normalizeBackstageNotionScopePath(path),
    `${label}.scopePathKey`
  );
}

function validateChunkScopeIndexMetadata(
  metadata: Record<string, unknown>,
  headingPath: readonly string[],
  label: string
): void {
  if (metadata.headingIndexVersion !== BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION) {
    throw new Error(`${label} does not describe the current heading index.`);
  }
  requireExactStringArray(
    metadata.scopeHeadingPathKey,
    normalizeBackstageNotionScopePath(headingPath),
    `${label}.scopeHeadingPathKey`
  );
  const occurrences = metadata.headingOccurrencePath;
  if (
    !Array.isArray(occurrences)
    || occurrences.length !== headingPath.length
    || occurrences.some(value => (
      !Number.isSafeInteger(value)
      || (value as number) < 1
      || (value as number) > BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
    ))
  ) {
    throw new Error(`${label}.headingOccurrencePath is invalid.`);
  }
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeEmbedding(value: number[], label: string): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192) {
    throw new Error(`${label} must contain 1-8192 dimensions.`);
  }
  if (value.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new Error(`${label} must contain only finite numbers.`);
  }
  return [...value];
}

function parseEmbedding(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array.`);
  }
  return normalizeEmbedding(value as number[], label);
}

function normalizeCanonicalUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 4096) {
    throw new Error('canonicalUrl must contain 1-4096 characters when provided.');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('canonicalUrl must be a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('canonicalUrl must use HTTPS.');
  }
  return parsed.toString();
}

function prepareSnapshotInput(input: ActivateBackstageNotionSnapshotInput): PreparedSnapshotInput {
  const universeId = normalizeUniverseId(input.universeId);
  const rootPageId = normalizeUuid(input.rootPageId, 'rootPageId');
  const manifestHash = normalizeSha256(input.manifestHash, 'manifestHash');
  const embeddingModel = normalizeRequiredText(input.embeddingModel, 'embeddingModel', 200);
  const holderId = normalizeRequiredText(input.lease.holderId, 'lease.holderId', 200);
  const leaseToken = normalizeUuid(input.lease.leaseToken, 'lease.leaseToken');
  const sourceMaxEditedAt = input.sourceMaxEditedAt === undefined || input.sourceMaxEditedAt === null
    ? null
    : normalizeDate(input.sourceMaxEditedAt, 'sourceMaxEditedAt');

  if (
    !Array.isArray(input.pages)
    || input.pages.length < 1
    || input.pages.length > BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT
  ) {
    throw new Error(`pages must contain 1-${BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT} records.`);
  }
  if (
    !Array.isArray(input.chunks)
    || input.chunks.length < 1
    || input.chunks.length > BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
  ) {
    throw new Error(`chunks must contain 1-${BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT} records.`);
  }

  const pageIds = new Set<string>();
  const pages = input.pages.map((page, index): PreparedPage => {
    const pageId = normalizeUuid(page.pageId, `pages[${index}].pageId`);
    if (pageIds.has(pageId)) {
      throw new Error(`pages contains duplicate pageId ${pageId}.`);
    }
    pageIds.add(pageId);
    const parentPageId = page.parentPageId === undefined || page.parentPageId === null
      ? null
      : normalizeUuid(page.parentPageId, `pages[${index}].parentPageId`);
    const depth = normalizeInteger(page.depth, `pages[${index}].depth`, 0, 100);
    const path = normalizeStringArray(page.path, `pages[${index}].path`, 101);
    if (path.length !== depth + 1) {
      throw new Error(`pages[${index}].path must contain exactly depth + 1 items.`);
    }
    if (Buffer.byteLength(page.markdown, 'utf8') > 10_485_760) {
      throw new Error(`pages[${index}].markdown exceeds the 10485760-byte limit.`);
    }
    const title = normalizeRequiredText(page.title, `pages[${index}].title`, 500);
    const contentHash = normalizeSha256(page.contentHash, `pages[${index}].contentHash`);
    const expectedSourceHash = sha256(JSON.stringify({
      format: 'backstage-notion-rag-page-v1',
      universeId,
      pageId,
      parentPageId,
      title,
      path,
      markdown: page.markdown
    }));
    if (contentHash !== expectedSourceHash) {
      throw new Error(`pages[${index}].contentHash does not match the normalized page.`);
    }
    const metadata = normalizeJsonObject(page.metadata, `pages[${index}].metadata`);
    validatePageScopeIndexMetadata(
      metadata,
      title,
      path,
      `pages[${index}].metadata`
    );
    return {
      page_id: pageId,
      parent_page_id: parentPageId,
      title,
      canonical_url: normalizeCanonicalUrl(page.canonicalUrl),
      content_hash: contentHash,
      markdown: page.markdown,
      source_last_edited_at:
        page.sourceLastEditedAt === undefined || page.sourceLastEditedAt === null
          ? null
          : normalizeDate(
            page.sourceLastEditedAt,
            `pages[${index}].sourceLastEditedAt`
          ).toISOString(),
      depth,
      path,
      metadata
    };
  });

  const rootPage = pages.find(page => page.page_id === rootPageId);
  if (!rootPage || rootPage.parent_page_id !== null || rootPage.depth !== 0) {
    throw new Error('rootPageId must identify the single depth-zero page with no parent.');
  }
  for (const [index, page] of pages.entries()) {
    if (page.page_id !== rootPageId && page.parent_page_id === null) {
      throw new Error(`pages[${index}] is outside the rooted hierarchy.`);
    }
    if (page.parent_page_id !== null && !pageIds.has(page.parent_page_id)) {
      throw new Error(`pages[${index}].parentPageId is not present in this full snapshot.`);
    }
  }
  const pageById = new Map(pages.map(page => [page.page_id, page]));
  for (const [index, page] of pages.entries()) {
    if (page.parent_page_id === null) {
      continue;
    }
    const parent = pageById.get(page.parent_page_id);
    if (!parent || parent.depth !== page.depth - 1) {
      throw new Error(`pages[${index}] does not descend exactly one level from its parent.`);
    }
    if (parent.path.some((segment, pathIndex) => page.path[pathIndex] !== segment)) {
      throw new Error(`pages[${index}].path does not extend its parent path.`);
    }
  }

  const chunkIds = new Set<string>();
  const positions = new Set<string>();
  let embeddingDimensions: number | null = null;
  const chunks = input.chunks.map((chunk, index): PreparedChunk => {
    const chunkId = normalizeSha256(chunk.chunkId, `chunks[${index}].chunkId`);
    const pageId = normalizeUuid(chunk.pageId, `chunks[${index}].pageId`);
    if (!pageIds.has(pageId)) {
      throw new Error(`chunks[${index}].pageId is not present in this full snapshot.`);
    }
    if (chunkIds.has(chunkId)) {
      throw new Error(`chunks contains duplicate chunkId ${chunkId}.`);
    }
    chunkIds.add(chunkId);
    const ordinal = normalizeInteger(chunk.ordinal, `chunks[${index}].ordinal`, 0, 1_000_000);
    const position = `${pageId}:${ordinal}`;
    if (positions.has(position)) {
      throw new Error(`chunks contains duplicate page ordinal ${position}.`);
    }
    positions.add(position);
    if (!chunk.content.trim() || Buffer.byteLength(chunk.content, 'utf8') > 131_072) {
      throw new Error(`chunks[${index}].content must contain 1-131072 UTF-8 bytes.`);
    }
    const contentHash = normalizeSha256(chunk.contentHash, `chunks[${index}].contentHash`);
    if (contentHash !== sha256(chunk.content)) {
      throw new Error(`chunks[${index}].contentHash does not match its content.`);
    }
    const expectedChunkId = sha256(JSON.stringify({
      format: 'backstage-notion-rag-chunk-v1',
      pageId,
      ordinal,
      contentHash
    }));
    if (chunkId !== expectedChunkId) {
      throw new Error(`chunks[${index}].chunkId does not match its deterministic identity.`);
    }
    const codePoints = normalizeInteger(
      chunk.codePoints,
      `chunks[${index}].codePoints`,
      1,
      131_072
    );
    if (codePoints !== Array.from(chunk.content).length) {
      throw new Error(`chunks[${index}].codePoints does not match its content.`);
    }
    const embedding = normalizeEmbedding(chunk.embedding, `chunks[${index}].embedding`);
    embeddingDimensions ??= embedding.length;
    if (embedding.length !== embeddingDimensions) {
      throw new Error('All snapshot embeddings must have the same dimensionality.');
    }
    const headingPath = normalizeStringArray(
      chunk.headingPath ?? [],
      `chunks[${index}].headingPath`,
      32
    );
    const metadata = normalizeJsonObject(chunk.metadata, `chunks[${index}].metadata`);
    validateChunkScopeIndexMetadata(
      metadata,
      headingPath,
      `chunks[${index}].metadata`
    );
    return {
      chunk_id: chunkId,
      page_id: pageId,
      ordinal,
      content_hash: contentHash,
      content: chunk.content,
      code_points: codePoints,
      embedding,
      heading_path: headingPath,
      metadata
    };
  });

  const ordinalsByPage = new Map<string, number[]>();
  for (const chunk of chunks) {
    const ordinals = ordinalsByPage.get(chunk.page_id) ?? [];
    ordinals.push(chunk.ordinal);
    ordinalsByPage.set(chunk.page_id, ordinals);
  }
  for (const [pageId, ordinals] of ordinalsByPage) {
    ordinals.sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index)) {
      throw new Error(`chunks for page ${pageId} must use contiguous zero-based ordinals.`);
    }
  }
  for (const [index, page] of pages.entries()) {
    if (page.markdown.trim() && !ordinalsByPage.has(page.page_id)) {
      throw new Error(`pages[${index}] has retrievable content but no chunks.`);
    }
  }

  return {
    universeId,
    rootPageId,
    manifestHash,
    embeddingModel,
    sourceMaxEditedAt,
    holderId,
    leaseToken,
    pages,
    chunks
  };
}

function mapLease(row: LeaseRow): BackstageNotionSyncLease {
  return {
    universeId: normalizeUniverseId(row.universe_id),
    holderId: row.holder_id,
    leaseToken: normalizeUuid(row.lease_token, 'lease_token'),
    acquiredAt: parseDate(row.acquired_at, 'acquired_at'),
    expiresAt: parseDate(row.expires_at, 'expires_at')
  };
}

function mapAuthorityHead(row: AuthorityHeadRow): BackstageNotionAuthorityHead {
  const authority = row.authority;
  if (authority !== 'postgres' && authority !== 'notion') {
    throw new Error('authority is not a supported Backstage Notion authority.');
  }
  const activeSnapshotId = row.active_snapshot_id === null
    ? null
    : normalizeUuid(row.active_snapshot_id, 'active_snapshot_id');
  const rootPageId = row.root_page_id === null
    ? null
    : normalizeUuid(row.root_page_id, 'root_page_id');
  if ((activeSnapshotId === null) !== (rootPageId === null)) {
    throw new Error('Backstage Notion authority head has an incomplete active snapshot reference.');
  }
  if (authority === 'notion' && activeSnapshotId === null) {
    throw new Error('Backstage Notion authority head is missing its active snapshot.');
  }
  return {
    universeId: normalizeUniverseId(row.universe_id),
    authority,
    activeSnapshotId,
    rootPageId
  };
}

function mapSnapshot(row: SnapshotRow): BackstageNotionSnapshotRecord {
  return {
    id: normalizeUuid(row.snapshot_id, 'snapshot_id'),
    universeId: normalizeUniverseId(row.universe_id),
    rootPageId: normalizeUuid(row.root_page_id, 'root_page_id'),
    manifestHash: normalizeSha256(row.manifest_hash, 'manifest_hash'),
    embeddingModel: row.embedding_model,
    pageCount: parseInteger(row.page_count, 'page_count'),
    chunkCount: parseInteger(row.chunk_count, 'chunk_count'),
    sourceMaxEditedAt: row.source_max_edited_at === null
      ? null
      : parseDate(row.source_max_edited_at, 'source_max_edited_at'),
    syncHolderId: row.sync_holder_id,
    createdAt: parseDate(row.snapshot_created_at, 'snapshot_created_at')
  };
}

function mapActiveChunkMetadata(
  row: ChunkMetadataRow
): BackstageNotionActiveChunkMetadata {
  return {
    id: normalizeSha256(row.chunk_id, 'chunk_id'),
    pageId: normalizeUuid(row.page_id, 'page_id'),
    pageTitle: row.page_title,
    pagePath: parseStringArray(row.page_path, 'page_path'),
    ordinal: parseInteger(row.ordinal, 'ordinal'),
    contentHash: normalizeSha256(row.content_hash, 'content_hash'),
    codePoints: parseInteger(row.code_points, 'code_points'),
    embeddingModel: row.chunk_embedding_model,
    headingPath: parseStringArray(row.heading_path, 'heading_path'),
    metadata: parseJsonObject(row.chunk_metadata, 'chunk_metadata')
  };
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

export class PostgresBackstageNotionRagRepository implements BackstageNotionRagRepository {
  constructor(private readonly pool: Pool) {}

  async loadAuthorityHead(
    universeId: string
  ): Promise<BackstageNotionAuthorityHead | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const result = await this.pool.query<AuthorityHeadRow>(
      `SELECT
         head.universe_id,
         head.authority,
         head.active_snapshot_id,
         snapshot.root_page_id
       FROM backstage_notion_universe_heads AS head
       LEFT JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       WHERE head.universe_id = $1`,
      [normalizedUniverseId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const head = mapAuthorityHead(row);
    if (head.universeId !== normalizedUniverseId) {
      throw new Error('Backstage Notion authority head escaped its requested universe scope.');
    }
    return head;
  }

  async acquireSyncLease(
    universeId: string,
    holderId: string,
    ttlMs: number
  ): Promise<BackstageNotionSyncLease | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedHolderId = normalizeRequiredText(holderId, 'holderId', 200);
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_SYNC_LEASE_MIN_MS,
      BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
    );
    const leaseToken = randomUUID();

    await this.pool.query(
      `INSERT INTO backstage_notion_universe_heads (universe_id)
       VALUES ($1)
       ON CONFLICT (universe_id) DO NOTHING`,
      [normalizedUniverseId]
    );

    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO backstage_notion_sync_leases (
         universe_id,
         holder_id,
         lease_token,
         acquired_at,
         expires_at
       )
       VALUES (
         $1,
         $2,
         $3::UUID,
         clock_timestamp(),
         clock_timestamp() + ($4::BIGINT * INTERVAL '1 millisecond')
       )
       ON CONFLICT (universe_id) DO UPDATE
       SET
         holder_id = EXCLUDED.holder_id,
         lease_token = EXCLUDED.lease_token,
         acquired_at = EXCLUDED.acquired_at,
         expires_at = EXCLUDED.expires_at
       WHERE backstage_notion_sync_leases.expires_at <= clock_timestamp()
          OR backstage_notion_sync_leases.holder_id = EXCLUDED.holder_id
       RETURNING universe_id, holder_id, lease_token, acquired_at, expires_at`,
      [normalizedUniverseId, normalizedHolderId, leaseToken, normalizedTtlMs]
    );

    const row = result.rows[0];
    return row ? mapLease(row) : null;
  }

  async releaseSyncLease(
    universeId: string,
    holderId: string,
    leaseToken: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM backstage_notion_sync_leases
       WHERE universe_id = $1
         AND holder_id = $2
         AND lease_token = $3::UUID`,
      [
        normalizeUniverseId(universeId),
        normalizeRequiredText(holderId, 'holderId', 200),
        normalizeUuid(leaseToken, 'leaseToken')
      ]
    );
    return result.rowCount === 1;
  }

  async renewSyncLease(
    universeId: string,
    holderId: string,
    leaseToken: string,
    ttlMs: number
  ): Promise<BackstageNotionSyncLease | null> {
    const normalizedTtlMs = normalizeInteger(
      ttlMs,
      'ttlMs',
      BACKSTAGE_NOTION_SYNC_LEASE_MIN_MS,
      BACKSTAGE_NOTION_SYNC_LEASE_MAX_MS
    );
    const result = await this.pool.query<LeaseRow>(
      `UPDATE backstage_notion_sync_leases
       SET expires_at = clock_timestamp() + ($4::BIGINT * INTERVAL '1 millisecond')
       WHERE universe_id = $1
         AND holder_id = $2
         AND lease_token = $3::UUID
         AND expires_at > clock_timestamp()
       RETURNING universe_id, holder_id, lease_token, acquired_at, expires_at`,
      [
        normalizeUniverseId(universeId),
        normalizeRequiredText(holderId, 'holderId', 200),
        normalizeUuid(leaseToken, 'leaseToken'),
        normalizedTtlMs
      ]
    );
    const row = result.rows[0];
    return row ? mapLease(row) : null;
  }

  async loadReusableEmbeddings(
    universeId: string,
    embeddingModel: string,
    contentHashes: string[]
  ): Promise<Map<string, number[]>> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedModel = normalizeRequiredText(embeddingModel, 'embeddingModel', 200);
    if (!Array.isArray(contentHashes) || contentHashes.length > BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES) {
      throw new Error(
        `contentHashes must contain at most ${BACKSTAGE_NOTION_MAX_REUSABLE_EMBEDDING_HASHES} hashes.`
      );
    }
    const normalizedHashes = [...new Set(contentHashes.map((hash, index) =>
      normalizeSha256(hash, `contentHashes[${index}]`)
    ))];
    if (normalizedHashes.length === 0) {
      return new Map();
    }

    const result = await this.pool.query<ReusableEmbeddingRow>(
      `SELECT DISTINCT ON (chunk.content_hash)
         chunk.content_hash,
         chunk.embedding
       FROM backstage_notion_snapshot_chunks AS chunk
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = chunk.universe_id
        AND snapshot.id = chunk.snapshot_id
       WHERE chunk.universe_id = $1
         AND chunk.embedding_model = $2
         AND chunk.content_hash = ANY($3::TEXT[])
       ORDER BY
         chunk.content_hash,
         snapshot.created_at DESC,
         snapshot.id DESC,
         chunk.created_at DESC,
         chunk.id DESC`,
      [normalizedUniverseId, normalizedModel, normalizedHashes]
    );

    return new Map(result.rows.map(row => [
      normalizeSha256(row.content_hash, 'content_hash'),
      parseEmbedding(row.embedding, 'embedding')
    ]));
  }

  async markActiveSnapshotVerified(
    universeId: string,
    manifestHash: string,
    lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>
  ): Promise<Date | null> {
    const result = await this.pool.query<{ last_verified_at: TimestampValue }>(
      `UPDATE backstage_notion_universe_heads AS head
       SET
         last_verified_at = clock_timestamp(),
         updated_at = clock_timestamp()
       FROM backstage_notion_snapshots AS snapshot,
            backstage_notion_sync_leases AS lease
       WHERE head.universe_id = $1
         AND head.authority = 'notion'
         AND snapshot.universe_id = head.universe_id
         AND snapshot.id = head.active_snapshot_id
         AND snapshot.manifest_hash = $2
         AND lease.universe_id = head.universe_id
         AND lease.holder_id = $3
         AND lease.lease_token = $4::UUID
         AND lease.expires_at > clock_timestamp()
       RETURNING head.last_verified_at`,
      [
        normalizeUniverseId(universeId),
        normalizeSha256(manifestHash, 'manifestHash'),
        normalizeRequiredText(lease.holderId, 'lease.holderId', 200),
        normalizeUuid(lease.leaseToken, 'lease.leaseToken')
      ]
    );
    const row = result.rows[0];
    return row ? parseDate(row.last_verified_at, 'last_verified_at') : null;
  }

  async activateSnapshot(
    input: ActivateBackstageNotionSnapshotInput
  ): Promise<BackstageNotionSnapshotRecord> {
    const prepared = prepareSnapshotInput(input);
    const snapshotId = randomUUID();
    const client = await this.pool.connect();
    let discardClient = false;

    try {
      await client.query('BEGIN');
      const leaseResult = await client.query<{ universe_id: string }>(
        `SELECT lease.universe_id
         FROM backstage_notion_sync_leases AS lease
         WHERE lease.universe_id = $1
           AND lease.holder_id = $2
           AND lease.lease_token = $3::UUID
           AND lease.expires_at > clock_timestamp()
         FOR UPDATE OF lease`,
         [prepared.universeId, prepared.holderId, prepared.leaseToken]
      );
      if (leaseResult.rows.length !== 1) {
        throw new BackstageNotionSyncLeaseError();
      }

      // Drain every legacy writer before touching the authority head. Legacy
      // DML takes its table lock before the trigger performs a locking head
      // read, so this order prevents a writer/cutover lock inversion.
      await client.query(
        `LOCK TABLE
           backstage_wrestlers,
           backstage_events,
           backstage_story_beats,
           backstage_storylines,
           backstage_canon_heads,
           backstage_canon_revisions,
           backstage_storyline_threads,
           backstage_storyline_participants,
           backstage_storyline_canon_beats
         IN SHARE ROW EXCLUSIVE MODE`
      );

      const epochResult = await client.query(
        `UPDATE backstage_notion_authority_epoch
         SET
           epoch = CASE
             WHEN epoch = 9223372036854775807 THEN 0
             ELSE epoch + 1
           END,
           updated_at = clock_timestamp()
         WHERE singleton = TRUE
         RETURNING epoch`
      );
      if (epochResult.rowCount !== 1) {
        throw new Error('Backstage Notion authority epoch could not be advanced.');
      }

      // Once all legacy writers are drained, exclude authority readers and
      // refreshers until the immutable candidate and its head flip commit.
      // No earlier statement in this transaction touches this table, avoiding
      // an ACCESS SHARE -> ACCESS EXCLUSIVE upgrade deadlock between syncs.
      await client.query(
        'LOCK TABLE backstage_notion_universe_heads IN ACCESS EXCLUSIVE MODE'
      );

      const snapshotResult = await client.query<SnapshotRow>(
        `INSERT INTO backstage_notion_snapshots (
           id,
           universe_id,
           root_page_id,
           manifest_hash,
           embedding_model,
           page_count,
           chunk_count,
           source_max_edited_at,
           sync_holder_id
         )
         VALUES ($1::UUID, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING
           id AS snapshot_id,
           universe_id,
           root_page_id,
           manifest_hash,
           embedding_model,
           page_count,
           chunk_count,
           source_max_edited_at,
           sync_holder_id,
           created_at AS snapshot_created_at`,
        [
          snapshotId,
          prepared.universeId,
          prepared.rootPageId,
          prepared.manifestHash,
          prepared.embeddingModel,
          prepared.pages.length,
          prepared.chunks.length,
          prepared.sourceMaxEditedAt,
          prepared.holderId
        ]
      );

      await client.query(
        `INSERT INTO backstage_notion_snapshot_pages (
           snapshot_id,
           universe_id,
           page_id,
           parent_page_id,
           title,
           canonical_url,
           content_hash,
           markdown,
           source_last_edited_at,
           depth,
           path,
           metadata
         )
         SELECT
           $1::UUID,
           $2,
           page.page_id,
           page.parent_page_id,
           page.title,
           page.canonical_url,
           page.content_hash,
           page.markdown,
           page.source_last_edited_at::TIMESTAMPTZ,
           page.depth,
           page.path,
           page.metadata
         FROM jsonb_to_recordset($3::JSONB) AS page(
           page_id TEXT,
           parent_page_id TEXT,
           title TEXT,
           canonical_url TEXT,
           content_hash TEXT,
           markdown TEXT,
           source_last_edited_at TEXT,
           depth INTEGER,
           path JSONB,
           metadata JSONB
         )`,
        [snapshotId, prepared.universeId, JSON.stringify(prepared.pages)]
      );

      await client.query(
        `INSERT INTO backstage_notion_snapshot_chunks (
           id,
           snapshot_id,
           universe_id,
           page_id,
           ordinal,
           content_hash,
           content,
           code_points,
           embedding_model,
           embedding,
           heading_path,
           metadata
         )
         SELECT
           chunk.chunk_id,
           $1::UUID,
           $2,
           chunk.page_id,
           chunk.ordinal,
           chunk.content_hash,
           chunk.content,
           chunk.code_points,
           $3,
           chunk.embedding,
           chunk.heading_path,
           chunk.metadata
         FROM jsonb_to_recordset($4::JSONB) AS chunk(
           chunk_id TEXT,
           page_id TEXT,
           ordinal INTEGER,
           content_hash TEXT,
           content TEXT,
           code_points INTEGER,
           embedding JSONB,
           heading_path JSONB,
           metadata JSONB
         )`,
        [
          snapshotId,
          prepared.universeId,
          prepared.embeddingModel,
          JSON.stringify(prepared.chunks)
        ]
      );

      const activationResult = await client.query(
        `UPDATE backstage_notion_universe_heads AS head
         SET
           authority = 'notion',
           active_snapshot_id = $2::UUID,
           activated_at = clock_timestamp(),
           last_verified_at = clock_timestamp(),
           updated_at = clock_timestamp()
         FROM backstage_notion_sync_leases AS lease
         WHERE head.universe_id = $1
           AND lease.universe_id = head.universe_id
           AND lease.holder_id = $3
           AND lease.lease_token = $4::UUID
           AND lease.expires_at > clock_timestamp()
           AND (
             head.authority = 'postgres'
             OR EXISTS (
               SELECT 1
               FROM backstage_notion_snapshots AS active_snapshot
               WHERE active_snapshot.universe_id = head.universe_id
                 AND active_snapshot.id = head.active_snapshot_id
                 AND active_snapshot.root_page_id = $5
             )
           )`,
         [
           prepared.universeId,
           snapshotId,
           prepared.holderId,
           prepared.leaseToken,
           prepared.rootPageId
         ]
      );
      if (activationResult.rowCount !== 1) {
        throw new Error('Backstage Notion snapshot head could not be activated.');
      }

      await client.query('COMMIT');
      const snapshotRow = snapshotResult.rows[0];
      if (!snapshotRow) {
        throw new Error('Backstage Notion snapshot insert could not be confirmed.');
      }
      return mapSnapshot(snapshotRow);
    } catch (error) {
      if (!(await rollbackQuietly(client))) {
        discardClient = true;
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }

  async loadActiveSnapshot(
    universeId: string,
    maxChunks: number
  ): Promise<BackstageNotionActiveSnapshot | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedMaxChunks = normalizeInteger(
      maxChunks,
      'maxChunks',
      1,
      BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
    );
    const result = await this.pool.query<ActiveChunkRow>(
      `SELECT
         head.authority,
         head.last_verified_at AS verified_at,
         snapshot.id AS snapshot_id,
         snapshot.universe_id,
         snapshot.root_page_id,
         snapshot.manifest_hash,
         snapshot.embedding_model,
         snapshot.page_count,
         snapshot.chunk_count,
         snapshot.source_max_edited_at,
         snapshot.sync_holder_id,
         snapshot.created_at AS snapshot_created_at,
         chunk.id AS chunk_id,
         chunk.page_id,
         page.title AS page_title,
         page.path AS page_path,
         chunk.ordinal,
         chunk.content_hash,
         chunk.content,
         chunk.code_points,
         chunk.embedding_model AS chunk_embedding_model,
         chunk.embedding,
         chunk.heading_path,
         ${BACKSTAGE_NOTION_CHUNK_METADATA_PROJECTION_SQL} AS chunk_metadata
       FROM backstage_notion_universe_heads AS head
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       INNER JOIN backstage_notion_snapshot_chunks AS chunk
         ON chunk.universe_id = head.universe_id
        AND chunk.snapshot_id = head.active_snapshot_id
       INNER JOIN backstage_notion_snapshot_pages AS page
         ON page.universe_id = chunk.universe_id
        AND page.snapshot_id = chunk.snapshot_id
        AND page.page_id = chunk.page_id
       WHERE head.universe_id = $1
         AND head.authority = 'notion'
       ORDER BY chunk.page_id, chunk.ordinal, chunk.id
       LIMIT $2`,
      [normalizedUniverseId, normalizedMaxChunks + 1]
    );
    if (result.rows.length === 0) {
      return null;
    }

    const rows = result.rows.slice(0, normalizedMaxChunks);
    return {
      authority: 'notion',
      verifiedAt: parseDate(rows[0].verified_at, 'verified_at'),
      snapshot: mapSnapshot(rows[0]),
      chunks: rows.map(row => ({
        ...mapActiveChunkMetadata(row),
        content: row.content,
        embedding: parseEmbedding(row.embedding, 'embedding')
      })),
      truncated: result.rows.length > normalizedMaxChunks
    };
  }

  async loadActiveSnapshotHeader(
    universeId: string
  ): Promise<BackstageNotionActiveSnapshotHeader | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const result = await this.pool.query<ActiveSnapshotHeaderRow>(
      `SELECT
         head.authority,
         head.last_verified_at AS verified_at,
         snapshot.id AS snapshot_id,
         snapshot.universe_id,
         snapshot.root_page_id,
         snapshot.manifest_hash,
         snapshot.embedding_model,
         snapshot.page_count,
         snapshot.chunk_count,
         snapshot.source_max_edited_at,
         snapshot.sync_holder_id,
         snapshot.created_at AS snapshot_created_at
       FROM backstage_notion_universe_heads AS head
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       WHERE head.universe_id = $1
         AND head.authority = 'notion'`,
      [normalizedUniverseId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      authority: 'notion',
      verifiedAt: parseDate(row.verified_at, 'verified_at'),
      snapshot: mapSnapshot(row)
    };
  }

  async resolveSnapshotScope(
    universeId: string,
    snapshotId: string,
    lookup: BackstageNotionSnapshotScopeLookup
  ): Promise<BackstageNotionSnapshotScopeResolution> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedSnapshotId = normalizeUuid(snapshotId, 'snapshotId');
    if (!lookup || typeof lookup !== 'object' || Array.isArray(lookup)) {
      throw new Error('lookup must describe a bounded Notion scope.');
    }
    const pageTitleKey = normalizeScopeLookupKey(
      lookup.pageTitleKey,
      'lookup.pageTitleKey'
    );
    const pagePathKey = normalizeScopeLookupPath(
      lookup.pagePathKey,
      'lookup.pagePathKey',
      101
    );
    const sectionPathKey = normalizeScopeLookupPath(
      lookup.sectionPathKey,
      'lookup.sectionPathKey',
      32
    );
    const scopeKind = lookup.scopeKind ?? 'page';
    if (
      (scopeKind !== 'page' && scopeKind !== 'subtree')
      || (scopeKind === 'subtree' && sectionPathKey !== null)
    ) {
      throw new Error('lookup.scopeKind must describe a page or section-free subtree scope.');
    }

    const integrityResult = await this.pool.query<SnapshotScopeIntegrityRow>(
      `SELECT (
         snapshot.page_count = (
           SELECT COUNT(*)
           FROM backstage_notion_snapshot_pages AS counted_page
           WHERE counted_page.universe_id = $1
             AND counted_page.snapshot_id = $2::UUID
         )
         AND snapshot.chunk_count = (
           SELECT COUNT(*)
           FROM backstage_notion_snapshot_chunks AS counted_chunk
           WHERE counted_chunk.universe_id = $1
             AND counted_chunk.snapshot_id = $2::UUID
         )
         AND NOT EXISTS (
           SELECT 1
           FROM backstage_notion_snapshot_pages AS page
           WHERE page.universe_id = $1
             AND page.snapshot_id = $2::UUID
             AND (
               jsonb_typeof(page.metadata) IS DISTINCT FROM 'object'
               OR page.metadata ->> 'indexFormat' IS DISTINCT FROM $3
               OR page.metadata ->> 'headingIndexVersion'
                 IS DISTINCT FROM $4::TEXT
               OR jsonb_typeof(page.metadata -> 'scopeTitleKey')
                 IS DISTINCT FROM 'string'
               OR page.metadata ->> 'scopeTitleKey'
                 !~ '^[0-9a-f]{64}$'
               OR CASE
                 WHEN jsonb_typeof(page.metadata -> 'scopePathKey') = 'array'
                   AND jsonb_typeof(page.path) = 'array'
                 THEN
                   jsonb_array_length(page.metadata -> 'scopePathKey')
                     IS DISTINCT FROM jsonb_array_length(page.path)
                   OR jsonb_array_length(page.metadata -> 'scopePathKey')
                     NOT BETWEEN 1 AND 101
                   OR EXISTS (
                     SELECT 1
                     FROM jsonb_array_elements(page.metadata -> 'scopePathKey')
                       AS scope_path_segment(value)
                     WHERE jsonb_typeof(scope_path_segment.value)
                       IS DISTINCT FROM 'string'
                       OR (scope_path_segment.value #>> '{}')
                         !~ '^[0-9a-f]{64}$'
                   )
                 ELSE TRUE
               END
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM backstage_notion_snapshot_chunks AS chunk
           WHERE chunk.universe_id = $1
             AND chunk.snapshot_id = $2::UUID
             AND (
               jsonb_typeof(chunk.metadata) IS DISTINCT FROM 'object'
               OR chunk.metadata ->> 'headingIndexVersion'
                 IS DISTINCT FROM $4::TEXT
               OR CASE
                 WHEN jsonb_typeof(chunk.metadata -> 'scopeHeadingPathKey') = 'array'
                   AND jsonb_typeof(chunk.metadata -> 'headingOccurrencePath') = 'array'
                   AND jsonb_typeof(chunk.heading_path) = 'array'
                 THEN
                   jsonb_array_length(chunk.metadata -> 'scopeHeadingPathKey')
                     IS DISTINCT FROM jsonb_array_length(chunk.heading_path)
                   OR jsonb_array_length(chunk.metadata -> 'headingOccurrencePath')
                     IS DISTINCT FROM jsonb_array_length(chunk.heading_path)
                   OR jsonb_array_length(chunk.heading_path) > 32
                   OR EXISTS (
                     SELECT 1
                     FROM jsonb_array_elements(
                       chunk.metadata -> 'scopeHeadingPathKey'
                     ) AS scope_heading_segment(value)
                     WHERE jsonb_typeof(scope_heading_segment.value)
                       IS DISTINCT FROM 'string'
                       OR (scope_heading_segment.value #>> '{}')
                         !~ '^[0-9a-f]{64}$'
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM jsonb_array_elements(
                       chunk.metadata -> 'headingOccurrencePath'
                     ) AS heading_occurrence(value)
                     WHERE CASE
                       WHEN jsonb_typeof(heading_occurrence.value) = 'number'
                         AND heading_occurrence.value::TEXT
                           ~ '^[1-9][0-9]{0,3}$'
                       THEN (heading_occurrence.value::TEXT)::INTEGER
                         BETWEEN 1 AND 2048
                       ELSE FALSE
                     END IS NOT TRUE
                   )
                 ELSE TRUE
               END
             )
         )
       ) AS scope_integrity_valid
       FROM backstage_notion_snapshots AS snapshot
       WHERE snapshot.universe_id = $1
         AND snapshot.id = $2::UUID`,
      [
        normalizedUniverseId,
        normalizedSnapshotId,
        BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
        BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION
      ]
    );
    if (
      integrityResult.rows.length !== 1
      || integrityResult.rows[0]?.scope_integrity_valid !== true
    ) {
      return { status: 'invalid' };
    }

    const pageResult = await this.pool.query<SnapshotPageScopeCandidateRow>(
      `WITH RECURSIVE title_matching_pages AS (
         SELECT page.page_id, page.title, page.path
         FROM backstage_notion_snapshot_pages AS page
         WHERE page.universe_id = $1
           AND page.snapshot_id = $2::UUID
           AND (page.metadata ->> 'scopeTitleKey') COLLATE "C"
             = $3 COLLATE "C"
            AND (
              $4::TEXT[] IS NULL
              OR page.metadata -> 'scopePathKey' = to_jsonb($4::TEXT[])
            )
            AND (
              $5::TEXT = 'subtree'
              OR EXISTS (
                SELECT 1
                FROM backstage_notion_snapshot_chunks AS retrievable_chunk
                WHERE retrievable_chunk.universe_id = page.universe_id
                  AND retrievable_chunk.snapshot_id = page.snapshot_id
                  AND retrievable_chunk.page_id = page.page_id
              )
            )
          ORDER BY page.page_id COLLATE "C"
          LIMIT 2
        ), scoped_pages(anchor_page_id, scoped_page_id) AS (
         SELECT matching_page.page_id, matching_page.page_id
         FROM title_matching_pages AS matching_page
         UNION
         SELECT scoped_page.anchor_page_id, child.page_id
         FROM scoped_pages AS scoped_page
         INNER JOIN backstage_notion_snapshot_pages AS child
           ON child.universe_id = $1
          AND child.snapshot_id = $2::UUID
          AND child.parent_page_id = scoped_page.scoped_page_id
         WHERE $5::TEXT = 'subtree'
       ), scope_counts AS (
         SELECT
           scoped_page.anchor_page_id,
           COUNT(scoped_chunk.id) AS scope_chunk_count,
           COUNT(DISTINCT scoped_chunk.page_id) AS scope_page_count
         FROM scoped_pages AS scoped_page
         LEFT JOIN backstage_notion_snapshot_chunks AS scoped_chunk
           ON scoped_chunk.universe_id = $1
          AND scoped_chunk.snapshot_id = $2::UUID
          AND scoped_chunk.page_id = scoped_page.scoped_page_id
         GROUP BY scoped_page.anchor_page_id
       ), matching_pages AS (
         SELECT
           matching_page.page_id,
           matching_page.title,
           matching_page.path,
           scope_count.scope_chunk_count,
           scope_count.scope_page_count
         FROM title_matching_pages AS matching_page
         INNER JOIN scope_counts AS scope_count
           ON scope_count.anchor_page_id = matching_page.page_id
         ORDER BY matching_page.page_id COLLATE "C"
         LIMIT 2
       )
       SELECT
         matching_page.page_id,
         matching_page.title AS page_title,
         matching_page.path AS page_path,
         matching_page.scope_chunk_count,
         matching_page.scope_page_count
       FROM matching_pages AS matching_page
       ORDER BY matching_page.page_id COLLATE "C"`,
      [
        normalizedUniverseId,
        normalizedSnapshotId,
        pageTitleKey,
        pagePathKey,
        scopeKind
      ]
    );
    if (pageResult.rows.length === 0) {
      return { status: 'not_found' };
    }
    if (pageResult.rows.length > 1) {
      return { status: 'ambiguous' };
    }

    const page = pageResult.rows[0];
    if (!page) {
      return { status: 'invalid' };
    }
    const pageId = normalizeUuid(page.page_id, 'page_id');
    const pageTitle = normalizeRequiredText(page.page_title, 'page_title', 500);
    const pagePath = parseBoundedPersistedStringArray(
      page.page_path,
      'page_path',
      101,
      1
    );
    const pageScopeChunkCount = parseInteger(
      page.scope_chunk_count,
      'scope_chunk_count'
    );
    const pageScopePageCount = parseInteger(
      page.scope_page_count,
      'scope_page_count'
    );
    if (pageScopeChunkCount === 0 && pageScopePageCount === 0) {
      return { status: 'not_found' };
    }
    if (
      pageScopeChunkCount < 1
      || pageScopeChunkCount > BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
      || pageScopePageCount < 1
      || pageScopePageCount > BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT
    ) {
      return { status: 'invalid' };
    }

    if (sectionPathKey === null) {
      return {
        status: 'resolved',
        pageTitle,
        pagePath,
        sectionPath: null,
        selector: {
          pageId,
          scopeKind,
          sectionOccurrencePath: null,
        },
        scopeChunkCount: pageScopeChunkCount,
        scopePageCount: pageScopePageCount,
      };
    }

    const sectionResult = await this.pool.query<SnapshotSectionScopeCandidateRow>(
      `WITH matching_chunks AS (
         SELECT
           chunk.id,
           chunk.ordinal,
           ARRAY(
             SELECT (
               chunk.metadata -> 'headingOccurrencePath'
                 ->> requested_position.position
             )::INTEGER
             FROM generate_series(
               0,
               cardinality($4::TEXT[]) - 1
             ) AS requested_position(position)
             ORDER BY requested_position.position
           ) AS section_occurrence_path,
           ARRAY(
             SELECT chunk.heading_path ->> requested_position.position
             FROM generate_series(
               0,
               cardinality($4::TEXT[]) - 1
             ) AS requested_position(position)
             ORDER BY requested_position.position
           ) AS section_path
         FROM backstage_notion_snapshot_chunks AS chunk
         WHERE chunk.universe_id = $1
           AND chunk.snapshot_id = $2::UUID
           AND chunk.page_id = $3
           AND jsonb_array_length(
             chunk.metadata -> 'scopeHeadingPathKey'
           ) >= cardinality($4::TEXT[])
           AND NOT EXISTS (
             SELECT 1
             FROM unnest($4::TEXT[]) WITH ORDINALITY
               AS requested_scope_key(value, position)
             WHERE (
               chunk.metadata -> 'scopeHeadingPathKey'
                 ->> (requested_scope_key.position - 1)::INTEGER
             ) COLLATE "C" IS DISTINCT FROM
               requested_scope_key.value COLLATE "C"
           )
       ), ranked_matches AS (
         SELECT
           matching_chunk.*,
           COUNT(*) OVER (
             PARTITION BY matching_chunk.section_occurrence_path
           ) AS scope_chunk_count,
           ROW_NUMBER() OVER (
             PARTITION BY matching_chunk.section_occurrence_path
             ORDER BY matching_chunk.ordinal, matching_chunk.id COLLATE "C"
           ) AS representative_rank
         FROM matching_chunks AS matching_chunk
       )
       SELECT
         ranked_match.section_occurrence_path,
         ranked_match.section_path,
         ranked_match.scope_chunk_count
       FROM ranked_matches AS ranked_match
       WHERE ranked_match.representative_rank = 1
       ORDER BY ranked_match.section_occurrence_path
       LIMIT 2`,
      [
        normalizedUniverseId,
        normalizedSnapshotId,
        page.page_id,
        sectionPathKey
      ]
    );
    if (sectionResult.rows.length === 0) {
      return { status: 'not_found' };
    }
    if (sectionResult.rows.length > 1) {
      return { status: 'ambiguous' };
    }
    const section = sectionResult.rows[0];
    if (!section) {
      return { status: 'invalid' };
    }
    const sectionPath = parseBoundedPersistedStringArray(
      section.section_path,
      'section_path',
      32,
      sectionPathKey.length
    );
    if (sectionPath.length !== sectionPathKey.length) {
      return { status: 'invalid' };
    }
    const sectionOccurrencePath = parseBoundedPersistedOccurrencePath(
      section.section_occurrence_path,
      'section_occurrence_path',
      sectionPathKey.length
    );
    const scopeChunkCount = parseInteger(
      section.scope_chunk_count,
      'scope_chunk_count'
    );
    if (
      scopeChunkCount < 1
      || scopeChunkCount > pageScopeChunkCount
    ) {
      return { status: 'invalid' };
    }
    return {
      status: 'resolved',
      pageTitle,
      pagePath,
      sectionPath,
      selector: {
        pageId,
        scopeKind: 'page',
        sectionOccurrencePath,
      },
      scopeChunkCount,
      scopePageCount: 1,
    };
  }

  async loadSnapshotChunkPage(
    universeId: string,
    snapshotId: string,
    selector: BackstageNotionSnapshotChunkPageSelector,
    knownScopeChunkCount: number | null,
    offset: number,
    limit: number
  ): Promise<BackstageNotionSnapshotChunkPage> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedSnapshotId = normalizeUuid(snapshotId, 'snapshotId');
    if (
      !selector
      || typeof selector !== 'object'
      || Array.isArray(selector)
      || (selector.pageId !== null && typeof selector.pageId !== 'string')
      || !['all', 'page', 'subtree'].includes(selector.scopeKind)
      || (selector.sectionOccurrencePath !== null
        && !Array.isArray(selector.sectionOccurrencePath))
      || (selector.sectionOccurrencePath !== null
        && (selector.pageId === null || selector.scopeKind !== 'page'))
      || (selector.scopeKind === 'all' && selector.pageId !== null)
      || (selector.scopeKind !== 'all' && selector.pageId === null)
    ) {
      throw new Error('selector must describe a supported snapshot scope.');
    }
    const normalizedPageId = selector.pageId === null
      ? null
      : normalizeUuid(selector.pageId, 'selector.pageId');
    const normalizedSectionOccurrencePath = selector.sectionOccurrencePath === null
      ? null
      : selector.sectionOccurrencePath.map((occurrence, index) => normalizeInteger(
        occurrence,
        `selector.sectionOccurrencePath[${index}]`,
        1,
        BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
      ));
    if (
      normalizedSectionOccurrencePath !== null
      && (
        normalizedSectionOccurrencePath.length < 1
        || normalizedSectionOccurrencePath.length > 32
      )
    ) {
      throw new Error('selector.sectionOccurrencePath must contain 1-32 occurrences.');
    }
    const normalizedOffset = normalizeInteger(
      offset,
      'offset',
      0,
      BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT - 1
    );
    const normalizedLimit = normalizeInteger(
      limit,
      'limit',
      1,
      BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
    );
    const normalizedKnownScopeChunkCount = knownScopeChunkCount === null
      ? null
      : normalizeInteger(
        knownScopeChunkCount,
        'knownScopeChunkCount',
        1,
        BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
      );
    const queryValues = [
      normalizedUniverseId,
      normalizedSnapshotId,
      normalizedPageId,
      selector.scopeKind,
      normalizedSectionOccurrencePath
    ];
    let scopeChunkCount = normalizedKnownScopeChunkCount;
    if (scopeChunkCount === null) {
      const countResult = await this.pool.query<SnapshotChunkScopeCountRow>(
        `WITH RECURSIVE scope_pages(page_id) AS (
           SELECT anchor.page_id
           FROM backstage_notion_snapshot_pages AS anchor
           WHERE anchor.universe_id = $1
             AND anchor.snapshot_id = $2::UUID
             AND anchor.page_id = $3
           UNION
           SELECT child.page_id
           FROM scope_pages AS parent
           INNER JOIN backstage_notion_snapshot_pages AS child
             ON child.universe_id = $1
            AND child.snapshot_id = $2::UUID
            AND child.parent_page_id = parent.page_id
           WHERE $4::TEXT = 'subtree'
         )
         SELECT COUNT(*) AS scope_chunk_count
         FROM backstage_notion_snapshot_chunks AS chunk
         WHERE chunk.universe_id = $1
           AND chunk.snapshot_id = $2::UUID
           AND (
             $4::TEXT = 'all'
             OR chunk.page_id IN (SELECT scope_page.page_id FROM scope_pages AS scope_page)
           )
           AND (
             $5::INTEGER[] IS NULL
             OR CASE
               WHEN jsonb_typeof(chunk.metadata -> 'headingOccurrencePath') = 'array'
               THEN
                 jsonb_array_length(chunk.metadata -> 'headingOccurrencePath')
                   >= cardinality($5::INTEGER[])
                  AND NOT EXISTS (
                    SELECT 1
                    FROM unnest($5::INTEGER[]) WITH ORDINALITY
                      AS requested_occurrence(value, position)
                   WHERE chunk.metadata -> 'headingOccurrencePath'
                     ->> (requested_occurrence.position - 1)::INTEGER
                     IS DISTINCT FROM requested_occurrence.value::TEXT
                 )
               ELSE FALSE
             END
           )`,
        queryValues
      );
      scopeChunkCount = parseInteger(
        countResult.rows[0]?.scope_chunk_count ?? -1,
        'scope_chunk_count'
      );
    }
    if (
      scopeChunkCount < 0
      || scopeChunkCount > BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT
    ) {
      throw new Error('Snapshot scope chunk count escaped its supported bounds.');
    }
    if (scopeChunkCount === 0 || normalizedOffset >= scopeChunkCount) {
      return { scopeChunkCount, chunks: [] };
    }

    const pageResult = await this.pool.query<SnapshotChunkPageRow>(
      `WITH RECURSIVE scope_pages(page_id) AS (
         SELECT anchor.page_id
         FROM backstage_notion_snapshot_pages AS anchor
         WHERE anchor.universe_id = $1
           AND anchor.snapshot_id = $2::UUID
           AND anchor.page_id = $3
         UNION
         SELECT child.page_id
         FROM scope_pages AS parent
         INNER JOIN backstage_notion_snapshot_pages AS child
           ON child.universe_id = $1
          AND child.snapshot_id = $2::UUID
          AND child.parent_page_id = parent.page_id
         WHERE $4::TEXT = 'subtree'
       )
       SELECT
         chunk.id AS chunk_id,
         chunk.page_id,
         page.title AS page_title,
         page.path AS page_path,
         chunk.ordinal,
         chunk.content_hash,
         chunk.content,
         chunk.code_points,
         chunk.embedding_model AS chunk_embedding_model,
         chunk.heading_path,
         ${BACKSTAGE_NOTION_CHUNK_METADATA_PROJECTION_SQL} AS chunk_metadata
       FROM backstage_notion_snapshot_chunks AS chunk
       INNER JOIN backstage_notion_snapshot_pages AS page
         ON page.universe_id = chunk.universe_id
        AND page.snapshot_id = chunk.snapshot_id
        AND page.page_id = chunk.page_id
       WHERE chunk.universe_id = $1
         AND chunk.snapshot_id = $2::UUID
         AND (
           $4::TEXT = 'all'
           OR chunk.page_id IN (SELECT scope_page.page_id FROM scope_pages AS scope_page)
         )
         AND (
           $5::INTEGER[] IS NULL
           OR CASE
             WHEN jsonb_typeof(chunk.metadata -> 'headingOccurrencePath') = 'array'
             THEN
               jsonb_array_length(chunk.metadata -> 'headingOccurrencePath')
                 >= cardinality($5::INTEGER[])
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest($5::INTEGER[]) WITH ORDINALITY
                    AS requested_occurrence(value, position)
                 WHERE chunk.metadata -> 'headingOccurrencePath'
                   ->> (requested_occurrence.position - 1)::INTEGER
                   IS DISTINCT FROM requested_occurrence.value::TEXT
               )
             ELSE FALSE
           END
         )
       ORDER BY
         (ARRAY(
           SELECT path_segment.value COLLATE "C"
           FROM jsonb_array_elements_text(page.path) WITH ORDINALITY
             AS path_segment(value, position)
           ORDER BY path_segment.position
         )) COLLATE "C",
         page.title COLLATE "C",
         chunk.ordinal,
         chunk.id COLLATE "C"
       LIMIT $6
       OFFSET $7`,
      [...queryValues, normalizedLimit, normalizedOffset]
    );
    if (pageResult.rows.length > normalizedLimit) {
      throw new Error('Snapshot chunk page exceeded its requested limit.');
    }
    return {
      scopeChunkCount,
      chunks: pageResult.rows.map(row => ({
        ...mapActiveChunkMetadata(row),
        content: row.content
      }))
    };
  }

  async loadActiveInventory(
    universeId: string
  ): Promise<BackstageNotionActiveInventory | null> {
    const result = await this.pool.query<InventoryRow>(
      `SELECT
         head.authority,
         head.last_verified_at AS verified_at,
         snapshot.id AS snapshot_id,
         snapshot.universe_id,
         snapshot.root_page_id,
         snapshot.manifest_hash,
         snapshot.embedding_model,
         snapshot.page_count,
         snapshot.chunk_count,
         snapshot.source_max_edited_at,
         snapshot.sync_holder_id,
         snapshot.created_at AS snapshot_created_at,
         page.page_id,
         page.parent_page_id,
         page.title,
         page.canonical_url,
         page.content_hash,
         page.source_last_edited_at,
         page.depth,
         page.path,
         page.metadata AS page_metadata
       FROM backstage_notion_universe_heads AS head
       INNER JOIN backstage_notion_snapshots AS snapshot
         ON snapshot.universe_id = head.universe_id
        AND snapshot.id = head.active_snapshot_id
       INNER JOIN backstage_notion_snapshot_pages AS page
         ON page.universe_id = head.universe_id
        AND page.snapshot_id = head.active_snapshot_id
       WHERE head.universe_id = $1
         AND head.authority = 'notion'
       ORDER BY page.depth, page.page_id`,
      [normalizeUniverseId(universeId)]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return {
      authority: 'notion',
      verifiedAt: parseDate(result.rows[0].verified_at, 'verified_at'),
      snapshot: mapSnapshot(result.rows[0]),
      pages: result.rows.map(row => ({
        pageId: normalizeUuid(row.page_id, 'page_id'),
        parentPageId: row.parent_page_id === null
          ? null
          : normalizeUuid(row.parent_page_id, 'parent_page_id'),
        title: row.title,
        canonicalUrl: row.canonical_url,
        contentHash: normalizeSha256(row.content_hash, 'content_hash'),
        sourceLastEditedAt: row.source_last_edited_at === null
          ? null
          : parseDate(row.source_last_edited_at, 'source_last_edited_at'),
        depth: parseInteger(row.depth, 'depth'),
        path: parseStringArray(row.path, 'path'),
        metadata: parseJsonObject(row.page_metadata, 'page_metadata')
      }))
    };
  }
}

export function getBackstageNotionRagRepository(
  pool: Pool | null = getPool()
): BackstageNotionRagRepository {
  if (!pool) {
    throw new BackstageNotionRagRepositoryUnavailableError();
  }
  return new PostgresBackstageNotionRagRepository(pool);
}
