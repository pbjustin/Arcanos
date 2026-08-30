import { createHash } from 'node:crypto';

import { describe, expect, jest, test } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import {
  BackstageNotionPartitionRepositoryError,
  PostgresBackstageNotionPartitionRepository,
  type ActivateBackstageNotionShardSnapshotInput,
  type ActivateBackstageNotionUniverseManifestInput,
  type RegisterBackstageNotionPartitionConfigurationInput,
  type RollbackBackstageNotionUniverseManifestInput,
  type VerifyBackstageNotionSourceGenerationInput,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import type {
  BackstageNotionPartitionDefinition,
  BackstageNotionPartitionUniverse,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '../src/shared/backstage/backstageNotionScopeIndex.js';
import {
  hashBackstageNotionPartitionSourceGeneration,
  hashBackstageNotionPartitionSourceVerification,
} from '../src/shared/backstage/backstageNotionPartitionSourceGeneration.js';

const UNIVERSE_ID = 'my-universe-2k26';
const SHARD_KEY = 'raw/2026';
const OPTIONAL_SHARD_KEY = 'archive/raw/2025';
const SECOND_OPTIONAL_SHARD_KEY = 'archive/smackdown/2025';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const OPTIONAL_ROOT_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_OPTIONAL_ROOT_PAGE_ID = '23232323-2323-4232-8232-232323232323';
const PAGE_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const CHUNK_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const PARTITION_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const OPTIONAL_PARTITION_VERSION_A = '66666666-6666-4666-8666-666666666666';
const OPTIONAL_PARTITION_VERSION_B = '77777777-7777-4777-8777-777777777777';
const SECOND_OPTIONAL_PARTITION_VERSION = '78787878-7878-4787-8787-787878787878';
const SNAPSHOT_ID = '88888888-8888-4888-8888-888888888888';
const OPTIONAL_SNAPSHOT_ID = '99999999-9999-4999-8999-999999999999';
const SECOND_OPTIONAL_SNAPSHOT_ID = '98989898-9898-4989-8989-989898989898';
const CONFIGURATION_VERSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HISTORICAL_CONFIGURATION_VERSION_ID = 'acacacac-acac-4aca-8cac-acacacacacac';
const MANIFEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CURRENT_MANIFEST_ID = '12121212-1212-4121-8121-121212121212';
const LEASE_TOKEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONFIGURATION_GENERATION = 'partition-generation-1';
const CONFIGURATION_HASH = 'd'.repeat(64);
const HISTORICAL_CONFIGURATION_GENERATION = 'partition-generation-historical';
const HISTORICAL_CONFIGURATION_HASH = 'c'.repeat(64);
const SOURCE_MANIFEST_HASH = 'e'.repeat(64);
const SOURCE_GENERATION_ID = 'edededed-eded-4ede-8ded-edededededed';
const SOURCE_DRIFT_HASH = '1'.repeat(64);
const RECONCILIATION_GENERATION = '7';
const SOURCE_EDITED_AT = new Date('2026-08-24T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-08-24T12:02:00.000Z');
const ROOT_TITLE = 'Monday Night Raw';
const ROOT_CANONICAL_URL = `https://www.notion.so/${ROOT_PAGE_ID.replaceAll('-', '')}`;
const MANIFEST_CREATED_AT = new Date('2026-08-24T12:03:00.000Z');
const SNAPSHOT_SEALED_AT = new Date('2026-08-24T12:03:30.000Z');
const MANIFEST_SEALED_AT = new Date('2026-08-24T12:04:00.000Z');
const DIAGNOSTICS_OBSERVED_AT = new Date('2026-08-24T12:05:00.000Z');

interface QueryRecord {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface MockQueryResult {
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function result(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length
): MockQueryResult {
  return { rows, rowCount };
}

function routingMemberRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    manifest_id: MANIFEST_ID,
    manifest_generation: '3',
    desired_configuration_version_id: CONFIGURATION_VERSION_ID,
    desired_configuration_generation: CONFIGURATION_GENERATION,
    desired_configuration_hash: CONFIGURATION_HASH,
    configuration_version_id: CONFIGURATION_VERSION_ID,
    configuration_generation: CONFIGURATION_GENERATION,
    configuration_hash: CONFIGURATION_HASH,
    configured_shard_count: '1',
    configuration_state: 'sealed',
    embedding_model: 'text-embedding-test',
    embedding_version: '1',
    embedding_dimension: '2',
    index_format_version: '1',
    member_count: '1',
    omission_count: '0',
    manifest_page_count: '1',
    manifest_chunk_count: '1',
    manifest_state: 'sealed',
    manifest_created_at: MANIFEST_CREATED_AT,
    manifest_sealed_at: MANIFEST_SEALED_AT,
    record_kind: 'member',
    shard_key: SHARD_KEY,
    partition_version_id: PARTITION_VERSION_ID,
    retrieval_tier: 'hot',
    is_required: true,
    scope_tags: ['brand:raw', 'year:2026'],
    category_tags: ['current'],
    shard_snapshot_id: SNAPSHOT_ID,
    member_decision: 'fresh',
    member_verified_at: VERIFIED_AT,
    snapshot_page_count: '1',
    snapshot_chunk_count: '1',
    snapshot_embedding_model: 'text-embedding-test',
    snapshot_embedding_version: '1',
    snapshot_embedding_dimension: '2',
    snapshot_index_format_version: '1',
    snapshot_state: 'sealed',
    snapshot_created_at: SOURCE_EDITED_AT,
    snapshot_sealed_at: SNAPSHOT_SEALED_AT,
    omission_decision: null,
    safe_reason_code: null,
    ...overrides,
  };
}

function routingOmissionRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return routingMemberRow({
    configured_shard_count: '2',
    member_count: '1',
    omission_count: '1',
    record_kind: 'omission',
    shard_key: OPTIONAL_SHARD_KEY,
    partition_version_id: OPTIONAL_PARTITION_VERSION_A,
    retrieval_tier: 'archive',
    is_required: false,
    scope_tags: ['brand:raw', 'year:2025'],
    category_tags: ['archive'],
    shard_snapshot_id: null,
    member_decision: null,
    member_verified_at: null,
    snapshot_page_count: null,
    snapshot_chunk_count: null,
    snapshot_embedding_model: null,
    snapshot_embedding_version: null,
    snapshot_embedding_dimension: null,
    snapshot_index_format_version: null,
    snapshot_state: null,
    snapshot_created_at: null,
    snapshot_sealed_at: null,
    omission_decision: 'optional_unavailable',
    safe_reason_code: 'SHARD_SYNC_INCOMPLETE',
    ...overrides,
  });
}

function diagnosticsMemberRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    observed_at: DIAGNOSTICS_OBSERVED_AT,
    authority: 'notion',
    desired_configuration_version_id: CONFIGURATION_VERSION_ID,
    desired_configuration_generation: CONFIGURATION_GENERATION,
    desired_configuration_hash: CONFIGURATION_HASH,
    universe_head_generation: '4',
    manifest_generation: '3',
    configured_shard_count: '1',
    configuration_state: 'sealed',
    head_active_manifest_id: MANIFEST_ID,
    head_active_configuration_version_id: CONFIGURATION_VERSION_ID,
    active_manifest_id: MANIFEST_ID,
    manifest_configuration_version_id: CONFIGURATION_VERSION_ID,
    manifest_configuration_generation: CONFIGURATION_GENERATION,
    manifest_configuration_hash: CONFIGURATION_HASH,
    manifest_member_count: '1',
    manifest_omission_count: '0',
    manifest_page_count: '1',
    manifest_chunk_count: '1',
    manifest_state: 'sealed',
    manifest_created_at: MANIFEST_CREATED_AT,
    manifest_sealed_at: MANIFEST_SEALED_AT,
    shard_key: SHARD_KEY,
    partition_version_id: PARTITION_VERSION_ID,
    retrieval_tier: 'hot',
    is_required: true,
    scope_tags: ['brand:raw', 'year:2026'],
    category_tags: ['current'],
    current_partition_version_id: PARTITION_VERSION_ID,
    active_snapshot_id: SNAPSHOT_ID,
    shard_head_generation: '3',
    snapshot_generation: '1',
    last_attempt_at: SNAPSHOT_SEALED_AT,
    last_verified_at: VERIFIED_AT,
    lkg_snapshot_id: SNAPSHOT_ID,
    lkg_partition_version_id: PARTITION_VERSION_ID,
    lkg_page_count: '1',
    lkg_chunk_count: '1',
    lkg_state: 'sealed',
    lkg_created_at: SOURCE_EDITED_AT,
    lkg_sealed_at: SNAPSHOT_SEALED_AT,
    manifest_member_snapshot_id: SNAPSHOT_ID,
    manifest_member_decision: 'fresh',
    manifest_member_required: true,
    manifest_member_verified_at: VERIFIED_AT,
    manifest_snapshot_id: SNAPSHOT_ID,
    manifest_snapshot_page_count: '1',
    manifest_snapshot_chunk_count: '1',
    manifest_snapshot_state: 'sealed',
    manifest_snapshot_created_at: SOURCE_EDITED_AT,
    manifest_snapshot_sealed_at: SNAPSHOT_SEALED_AT,
    omission_decision: null,
    omission_safe_reason_code: null,
    lease_acquired_at: null,
    lease_expires_at: null,
    active_job_candidate_count: '0',
    universe_active_job_count: '0',
    invalid_active_job_count: '0',
    unconfigured_active_job_count: '0',
    shard_active_job_count: '0',
    shard_pending_job_count: '0',
    shard_running_job_count: '0',
    shard_stale_configuration_job_count: '0',
    ...overrides,
  };
}

function diagnosticsOmissionRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return diagnosticsMemberRow({
    configured_shard_count: '2',
    manifest_member_count: '1',
    manifest_omission_count: '1',
    shard_key: OPTIONAL_SHARD_KEY,
    partition_version_id: OPTIONAL_PARTITION_VERSION_A,
    retrieval_tier: 'archive',
    is_required: false,
    scope_tags: ['brand:raw', 'year:2025'],
    category_tags: ['archive'],
    current_partition_version_id: OPTIONAL_PARTITION_VERSION_A,
    active_snapshot_id: OPTIONAL_SNAPSHOT_ID,
    lkg_snapshot_id: OPTIONAL_SNAPSHOT_ID,
    lkg_partition_version_id: OPTIONAL_PARTITION_VERSION_A,
    manifest_member_snapshot_id: null,
    manifest_member_decision: null,
    manifest_member_required: null,
    manifest_member_verified_at: null,
    manifest_snapshot_id: null,
    manifest_snapshot_page_count: null,
    manifest_snapshot_chunk_count: null,
    manifest_snapshot_state: null,
    manifest_snapshot_created_at: null,
    manifest_snapshot_sealed_at: null,
    omission_decision: 'optional_unavailable',
    omission_safe_reason_code: 'SHARD_SYNC_FAILED',
    ...overrides,
  });
}

class PartitionRepositoryHarness {
  readonly queries: QueryRecord[] = [];
  readonly release = jest.fn();
  readonly connect = jest.fn(async () => this.client);

  readonly client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) =>
      this.dispatch(sql, values)
    ),
    release: this.release,
  } as unknown as PoolClient;

  readonly pool = { connect: this.connect } as unknown as Pool;

  constructor(
    private readonly handler: (
      sql: string,
      values: readonly unknown[]
    ) => MockQueryResult | Promise<MockQueryResult>,
    private readonly rollbackFails = false
  ) {}

  private async dispatch(rawSql: string, values: readonly unknown[]): Promise<MockQueryResult> {
    const sql = normalizeSql(rawSql);
    this.queries.push({ sql, values });
    if (sql === 'ROLLBACK' && this.rollbackFails) {
      throw new Error('rollback connection failure');
    }
    if (
      sql === 'BEGIN'
      || sql === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      || sql === 'COMMIT'
      || sql === 'ROLLBACK'
      || sql.startsWith('SET LOCAL lock_timeout')
    ) {
      return result();
    }
    return this.handler(sql, values);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function definition(
  overrides: Partial<BackstageNotionPartitionDefinition> = {}
): BackstageNotionPartitionDefinition {
  return {
    universeId: UNIVERSE_ID,
    shardKey: SHARD_KEY,
    rootPageId: ROOT_PAGE_ID,
    displayName: 'Monday Night Raw',
    retrievalTier: 'hot',
    required: true,
    scopeTags: ['brand:raw'],
    categoryTags: ['current'],
    capacity: {
      maxPages: 100,
      maxChunks: 500,
      maxDepth: 8,
      maxContentCodePoints: 1_000_000,
    },
    ...overrides,
  };
}

function universe(
  shards: readonly BackstageNotionPartitionDefinition[] = [definition()]
): BackstageNotionPartitionUniverse {
  return { universeId: UNIVERSE_ID, shards };
}

function partitionSemanticHash(value: BackstageNotionPartitionDefinition): string {
  return hash(JSON.stringify({
    format: 'backstage-notion-partition-definition-v1',
    version: 1,
    universeId: value.universeId,
    shardKey: value.shardKey,
    rootPageId: value.rootPageId,
    displayName: value.displayName,
    retrievalTier: value.retrievalTier,
    required: value.required,
    scopeTags: value.scopeTags,
    categoryTags: value.categoryTags,
    capacity: value.capacity,
  }));
}

function registerInput(
  overrides: Partial<RegisterBackstageNotionPartitionConfigurationInput> = {}
): RegisterBackstageNotionPartitionConfigurationInput {
  return {
    configurationGeneration: CONFIGURATION_GENERATION,
    configurationHash: CONFIGURATION_HASH,
    universe: universe(),
    expectedUniverseHead: null,
    ...overrides,
  };
}

function shardHead(
  partitionVersionId = PARTITION_VERSION_ID,
  activeSnapshotId: string | null = null
) {
  return {
    shard_key: SHARD_KEY,
    current_partition_version_id: partitionVersionId,
    root_page_id: ROOT_PAGE_ID,
    active_snapshot_id: activeSnapshotId,
    head_generation: '0',
    snapshot_generation: '0',
  };
}

function snapshotInput(
  overrides: Partial<ActivateBackstageNotionShardSnapshotInput> = {}
): ActivateBackstageNotionShardSnapshotInput {
  return {
    snapshotId: SNAPSHOT_ID,
    universeId: UNIVERSE_ID,
    shardKey: SHARD_KEY,
    partitionVersionId: PARTITION_VERSION_ID,
    rootPageId: ROOT_PAGE_ID,
    sourceGenerationId: SOURCE_GENERATION_ID,
    sourceManifestHash: SOURCE_MANIFEST_HASH,
    embeddingModel: 'text-embedding-test',
    embeddingVersion: 1,
    indexFormatVersion: 1,
    sourceMaxLastEditedAt: SOURCE_EDITED_AT,
    expectedHead: {
      headGeneration: '0',
      snapshotGeneration: '0',
      currentPartitionVersionId: PARTITION_VERSION_ID,
      activeSnapshotId: null,
    },
    lease: {
      holderId: 'partition-worker-1',
      leaseToken: LEASE_TOKEN,
      leaseGeneration: '3',
    },
    pages: [{
      pageId: ROOT_PAGE_ID,
      pageVersionId: PAGE_VERSION_ID,
      parentPageId: null,
      title: ROOT_TITLE,
      canonicalUrl: ROOT_CANONICAL_URL,
      sourceLastEditedAt: SOURCE_EDITED_AT,
      depth: 0,
      path: [ROOT_PAGE_ID],
      scopePath: [ROOT_TITLE],
      scopeTitleKey: normalizeBackstageNotionScopeKey(ROOT_TITLE),
      scopePathKey: normalizeBackstageNotionScopePath([ROOT_TITLE]),
    }],
    occurrences: [{
      pageId: ROOT_PAGE_ID,
      pageVersionId: PAGE_VERSION_ID,
      ordinal: 0,
      chunkVersionId: CHUNK_VERSION_ID,
      category: 'raw',
    }],
    verifications: [{
      kind: 'source_drift',
      resultHash: '1'.repeat(64),
      verifiedAt: new Date('2026-08-24T12:01:00.000Z'),
    }, {
      kind: 'completeness',
      resultHash: '2'.repeat(64),
      verifiedAt: VERIFIED_AT,
    }],
    ...overrides,
  };
}

function leaseRow() {
  return {
    universe_id: UNIVERSE_ID,
    shard_key: SHARD_KEY,
    holder_id: 'partition-worker-1',
    lease_token: LEASE_TOKEN,
    lease_generation: '3',
    acquired_at: '2026-08-24T11:59:00.000Z',
    expires_at: '2026-08-24T12:10:00.000Z',
  };
}

function createSnapshotHarness(options: {
  terminalLeasePresent: boolean;
  head?: ReturnType<typeof shardHead>;
}) {
  let leaseReads = 0;
  return new PartitionRepositoryHarness((sql) => {
    if (sql.includes('FROM public.backstage_notion_universe_heads')) {
      return result([{ authority: 'notion' }]);
    }
    if (sql.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
      return result([{
        desired_configuration_version_id: CONFIGURATION_VERSION_ID,
        desired_configuration_generation: CONFIGURATION_GENERATION,
        desired_configuration_hash: CONFIGURATION_HASH,
        active_manifest_id: null,
        active_configuration_version_id: null,
        head_generation: '4',
        manifest_generation: '2',
      }]);
    }
    if (sql.includes('FROM public.backstage_notion_shard_sync_leases')) {
      leaseReads += 1;
      return leaseReads === 1 || options.terminalLeasePresent
        ? result([leaseRow()])
        : result();
    }
    if (sql.includes('FROM public.backstage_notion_shard_heads')) {
      return result([options.head ?? shardHead()]);
    }
    if (sql.includes('JOIN public.backstage_notion_partition_versions AS definition')) {
      return result([{
        root_page_id: ROOT_PAGE_ID,
        state: 'sealed',
        max_pages: '100',
        max_chunks: '500',
        max_depth: '8',
        max_content_code_points: '1000000',
      }]);
    }
    if (sql.includes('FROM public.backstage_notion_page_versions')) {
      return result([{
        id: PAGE_VERSION_ID,
        page_id: ROOT_PAGE_ID,
        chunk_count: '1',
        content_code_points: '20',
        state: 'sealed',
      }]);
    }
    if (sql.includes('JOIN public.backstage_notion_chunk_embeddings AS embedding')) {
      return result([{
        page_id: ROOT_PAGE_ID,
        ordinal: '0',
        embedding_dimension: '2',
      }]);
    }
    if (sql.startsWith('UPDATE public.backstage_notion_shard_snapshots')) {
      return result([{}]);
    }
    if (sql.startsWith('UPDATE public.backstage_notion_shard_heads')) {
      return result([{
        head_generation: '1',
        snapshot_generation: '1',
      }]);
    }
    if (sql.startsWith('INSERT INTO public.backstage_notion_')) {
      return result();
    }
    throw new Error(`Unexpected snapshot query: ${sql}`);
  });
}

function manifestInput(): ActivateBackstageNotionUniverseManifestInput {
  const members: ActivateBackstageNotionUniverseManifestInput['members'] = [{
    shardKey: SHARD_KEY,
    partitionVersionId: PARTITION_VERSION_ID,
    snapshotId: SNAPSHOT_ID,
    decision: 'fresh',
    verifiedAt: VERIFIED_AT,
    expectedHead: {
      headGeneration: '0',
      snapshotGeneration: '0',
      currentPartitionVersionId: PARTITION_VERSION_ID,
      activeSnapshotId: SNAPSHOT_ID,
    },
  }, {
    shardKey: OPTIONAL_SHARD_KEY,
    partitionVersionId: OPTIONAL_PARTITION_VERSION_B,
    snapshotId: OPTIONAL_SNAPSHOT_ID,
    decision: 'fresh',
    verifiedAt: VERIFIED_AT,
    expectedHead: {
      headGeneration: '7',
      snapshotGeneration: '5',
      currentPartitionVersionId: OPTIONAL_PARTITION_VERSION_B,
      activeSnapshotId: OPTIONAL_SNAPSHOT_ID,
    },
  }];
  const sourceMembers = members.map(member => ({
    shardKey: member.shardKey,
    partitionVersionId: member.partitionVersionId,
    sourceManifestHash: SOURCE_MANIFEST_HASH,
    pageCount: 1,
    chunkCount: 1,
    terminalDriftHash: SOURCE_DRIFT_HASH,
  }));
  return {
    manifestId: MANIFEST_ID,
    universeId: UNIVERSE_ID,
    configurationVersionId: CONFIGURATION_VERSION_ID,
    configurationGeneration: CONFIGURATION_GENERATION,
    configurationHash: CONFIGURATION_HASH,
    sourceGenerationId: SOURCE_GENERATION_ID,
    sourceDigest: hashBackstageNotionPartitionSourceGeneration({
      universeId: UNIVERSE_ID,
      members: sourceMembers,
    }),
    sourcePageCount: sourceMembers.length,
    sourceChunkCount: sourceMembers.length,
    sourceVerifiedAt: VERIFIED_AT,
    sourceVerificationHash: hashBackstageNotionPartitionSourceVerification({
      universeId: UNIVERSE_ID,
      sourceGenerationId: SOURCE_GENERATION_ID,
      members: sourceMembers,
    }),
    indexFormatVersion: 1,
    reconciliationGeneration: RECONCILIATION_GENERATION,
    expectedUniverseHead: {
      headGeneration: '4',
      manifestGeneration: '2',
      desiredConfigurationVersionId: CONFIGURATION_VERSION_ID,
      activeManifestId: null,
    },
    members,
    omissions: [],
  };
}

function manifestInputWithOptionalMember(): ActivateBackstageNotionUniverseManifestInput {
  return manifestInput();
}

function manifestInputWithTwoOptionalMembers(): ActivateBackstageNotionUniverseManifestInput {
  const input = manifestInputWithOptionalMember();
  const members: ActivateBackstageNotionUniverseManifestInput['members'] = [
    ...input.members,
    {
      shardKey: SECOND_OPTIONAL_SHARD_KEY,
      partitionVersionId: SECOND_OPTIONAL_PARTITION_VERSION,
      snapshotId: SECOND_OPTIONAL_SNAPSHOT_ID,
      decision: 'fresh',
      verifiedAt: VERIFIED_AT,
      expectedHead: {
        headGeneration: '3',
        snapshotGeneration: '2',
        currentPartitionVersionId: SECOND_OPTIONAL_PARTITION_VERSION,
        activeSnapshotId: SECOND_OPTIONAL_SNAPSHOT_ID,
      },
    },
  ];
  const sourceMembers = members.map(member => ({
    shardKey: member.shardKey,
    partitionVersionId: member.partitionVersionId,
    sourceManifestHash: SOURCE_MANIFEST_HASH,
    pageCount: 1,
    chunkCount: 1,
    terminalDriftHash: SOURCE_DRIFT_HASH,
  }));
  return {
    ...input,
    members,
    sourceDigest: hashBackstageNotionPartitionSourceGeneration({
      universeId: UNIVERSE_ID,
      members: sourceMembers,
    }),
    sourcePageCount: sourceMembers.length,
    sourceChunkCount: sourceMembers.length,
    sourceVerificationHash: hashBackstageNotionPartitionSourceVerification({
      universeId: UNIVERSE_ID,
      sourceGenerationId: SOURCE_GENERATION_ID,
      members: sourceMembers,
    }),
  };
}

function sourceGenerationInput(): VerifyBackstageNotionSourceGenerationInput {
  return {
    universeId: UNIVERSE_ID,
    configurationVersionId: CONFIGURATION_VERSION_ID,
    sourceGenerationId: SOURCE_GENERATION_ID,
    members: [{
      shardKey: SHARD_KEY,
      partitionVersionId: PARTITION_VERSION_ID,
      snapshotId: SNAPSHOT_ID,
      sourceManifestHash: SOURCE_MANIFEST_HASH,
      pageCount: 1,
      chunkCount: 1,
      terminalDriftHash: SOURCE_DRIFT_HASH,
      verifiedAt: VERIFIED_AT,
    }, {
      shardKey: OPTIONAL_SHARD_KEY,
      partitionVersionId: OPTIONAL_PARTITION_VERSION_B,
      snapshotId: OPTIONAL_SNAPSHOT_ID,
      sourceManifestHash: SOURCE_MANIFEST_HASH,
      pageCount: 1,
      chunkCount: 1,
      terminalDriftHash: SOURCE_DRIFT_HASH,
      verifiedAt: VERIFIED_AT,
    }],
  };
}

function createSourceGenerationHarness(options: {
  readonly driftHash?: string;
} = {}): PartitionRepositoryHarness {
  const input = sourceGenerationInput();
  const members = [...input.members].sort((left, right) =>
    left.shardKey < right.shardKey ? -1 : left.shardKey > right.shardKey ? 1 : 0
  );
  const sourceDigest = hashBackstageNotionPartitionSourceGeneration({
    universeId: input.universeId,
    members,
  });
  const sourceVerificationHash = hashBackstageNotionPartitionSourceVerification({
    universeId: input.universeId,
    sourceGenerationId: input.sourceGenerationId,
    members,
  });
  return new PartitionRepositoryHarness((sql) => {
    if (sql.includes(
      'FROM public.backstage_notion_partition_configuration_members AS configured'
    )) {
      return result(members.map(member => ({
        shard_key: member.shardKey,
        partition_version_id: member.partitionVersionId,
        active_snapshot_id: member.snapshotId,
        source_generation_id: SOURCE_GENERATION_ID,
        source_manifest_hash: member.sourceManifestHash,
        page_count: String(member.pageCount),
        chunk_count: String(member.chunkCount),
        snapshot_state: 'sealed',
        drift_hash: options.driftHash ?? member.terminalDriftHash,
        drift_verified_at: VERIFIED_AT,
      })));
    }
    if (sql.startsWith(
      'INSERT INTO public.backstage_notion_partition_source_generations'
    )) {
      return result([{
        source_digest: sourceDigest,
        source_page_count: '2',
        source_chunk_count: '2',
        source_verified_at: VERIFIED_AT,
        source_verification_hash: sourceVerificationHash,
      }]);
    }
    throw new Error(`Unexpected source-generation query: ${sql}`);
  });
}

function createManifestHarness(options: {
  readonly ownershipError?: unknown;
  readonly ownershipConflicts?: readonly Readonly<{
    left_shard_key: string;
    right_shard_key: string;
  }>[];
  readonly optionalMember?: boolean;
  readonly optionalRequired?: boolean;
  readonly secondOptionalMember?: boolean;
  readonly sourceGenerationEvidencePresent?: boolean;
  readonly snapshotSourceGenerationId?: string;
  readonly reconciliationGeneration?: string;
  readonly publishedReconciliationGeneration?: string;
  readonly activationRows?: readonly Record<string, unknown>[];
} = {}) {
  const optionalMember = options.optionalMember ?? true;
  return new PartitionRepositoryHarness((sql) => {
    if (sql.includes('FROM public.backstage_notion_universe_heads')) {
      return result([{ authority: 'notion' }]);
    }
    if (sql.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
      return result([{
        desired_configuration_version_id: CONFIGURATION_VERSION_ID,
        desired_configuration_generation: CONFIGURATION_GENERATION,
        desired_configuration_hash: CONFIGURATION_HASH,
        active_manifest_id: null,
        active_configuration_version_id: null,
        head_generation: '4',
        manifest_generation: '2',
        reconciliation_generation: options.reconciliationGeneration
          ?? RECONCILIATION_GENERATION,
        published_reconciliation_generation:
          options.publishedReconciliationGeneration ?? '6',
      }]);
    }
    if (sql.includes('FROM public.backstage_notion_partition_configuration_versions')) {
      return result([{
        id: CONFIGURATION_VERSION_ID,
        configuration_generation: CONFIGURATION_GENERATION,
        configuration_hash: CONFIGURATION_HASH,
        shard_count: options.secondOptionalMember ? '3' : '2',
        state: 'sealed',
      }]);
    }
    if (sql.includes('JOIN public.backstage_notion_shard_heads AS head')) {
      return result([
        shardHead(PARTITION_VERSION_ID, SNAPSHOT_ID),
        {
          shard_key: OPTIONAL_SHARD_KEY,
          current_partition_version_id: optionalMember
            ? OPTIONAL_PARTITION_VERSION_B
            : OPTIONAL_PARTITION_VERSION_A,
          root_page_id: OPTIONAL_ROOT_PAGE_ID,
          active_snapshot_id: OPTIONAL_SNAPSHOT_ID,
          head_generation: '7',
          snapshot_generation: '5',
        },
        ...(options.secondOptionalMember ? [{
          shard_key: SECOND_OPTIONAL_SHARD_KEY,
          current_partition_version_id: SECOND_OPTIONAL_PARTITION_VERSION,
          root_page_id: SECOND_OPTIONAL_ROOT_PAGE_ID,
          active_snapshot_id: SECOND_OPTIONAL_SNAPSHOT_ID,
          head_generation: '3',
          snapshot_generation: '2',
        }] : []),
      ]);
    }
    if (
      sql.includes('JOIN public.backstage_notion_partition_versions AS definition')
      && sql.includes('partition_configuration_version_id')
    ) {
      return result([
        {
          id: OPTIONAL_PARTITION_VERSION_B,
          shard_key: OPTIONAL_SHARD_KEY,
          is_required: options.optionalRequired ?? false,
        },
        ...(options.secondOptionalMember ? [{
          id: SECOND_OPTIONAL_PARTITION_VERSION,
          shard_key: SECOND_OPTIONAL_SHARD_KEY,
          is_required: false,
        }] : []),
        { id: PARTITION_VERSION_ID, shard_key: SHARD_KEY, is_required: true },
      ]);
    }
    if (sql.includes('FROM public.backstage_notion_shard_snapshots AS snapshot')) {
      return result([{
        id: SNAPSHOT_ID,
        shard_key: SHARD_KEY,
        partition_version_id: PARTITION_VERSION_ID,
        source_generation_id: options.snapshotSourceGenerationId
          ?? SOURCE_GENERATION_ID,
        source_manifest_hash: SOURCE_MANIFEST_HASH,
        page_count: '1',
        chunk_count: '1',
        embedding_model: 'text-embedding-test',
        embedding_version: '1',
        embedding_dimension: '2',
        index_format_version: '1',
        state: 'sealed',
        latest_verified_at: VERIFIED_AT.toISOString(),
      }, ...(optionalMember ? [{
        id: OPTIONAL_SNAPSHOT_ID,
        shard_key: OPTIONAL_SHARD_KEY,
        partition_version_id: OPTIONAL_PARTITION_VERSION_B,
        source_generation_id: options.snapshotSourceGenerationId
          ?? SOURCE_GENERATION_ID,
        source_manifest_hash: SOURCE_MANIFEST_HASH,
        page_count: '1',
        chunk_count: '1',
        embedding_model: 'text-embedding-test',
        embedding_version: '1',
        embedding_dimension: '2',
        index_format_version: '1',
        state: 'sealed',
        latest_verified_at: VERIFIED_AT.toISOString(),
      }] : []), ...(options.secondOptionalMember ? [{
        id: SECOND_OPTIONAL_SNAPSHOT_ID,
        shard_key: SECOND_OPTIONAL_SHARD_KEY,
        partition_version_id: SECOND_OPTIONAL_PARTITION_VERSION,
        source_generation_id: options.snapshotSourceGenerationId
          ?? SOURCE_GENERATION_ID,
        source_manifest_hash: SOURCE_MANIFEST_HASH,
        page_count: '1',
        chunk_count: '1',
        embedding_model: 'text-embedding-test',
        embedding_version: '1',
        embedding_dimension: '2',
        index_format_version: '1',
        state: 'sealed',
        latest_verified_at: VERIFIED_AT.toISOString(),
      }] : [])]);
    }
    if (sql.includes('FROM public.backstage_notion_partition_source_generations')) {
      return options.sourceGenerationEvidencePresent === false
        ? result()
        : result([{ source_generation_id: SOURCE_GENERATION_ID }]);
    }
    if (sql.startsWith('WITH candidate_members AS')) {
      return result([...(options.ownershipConflicts ?? [])]);
    }
    if (sql.startsWith('UPDATE public.backstage_notion_universe_manifests')) {
      return result([{}]);
    }
    if (sql.startsWith('UPDATE public.backstage_notion_partitioned_universe_heads')) {
      return result([...(options.activationRows ?? [{
        head_generation: '5',
        manifest_generation: '3',
      }])]);
    }
    if (sql.startsWith('INSERT INTO public.backstage_notion_manifest_page_ownership')) {
      if (options.ownershipError !== undefined) {
        throw options.ownershipError;
      }
      return result();
    }
    if (sql.startsWith('INSERT INTO public.backstage_notion_')) {
      return result();
    }
    if (sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')) {
      return result();
    }
    throw new Error(`Unexpected manifest query: ${sql}`);
  });
}

function rollbackInput(
  overrides: Partial<RollbackBackstageNotionUniverseManifestInput> = {}
): RollbackBackstageNotionUniverseManifestInput {
  return {
    universeId: UNIVERSE_ID,
    targetManifestId: MANIFEST_ID,
    expectedUniverseHead: {
      headGeneration: '5',
      manifestGeneration: '3',
      desiredConfigurationVersionId: CONFIGURATION_VERSION_ID,
      activeManifestId: CURRENT_MANIFEST_ID,
    },
    ...overrides,
  };
}

function rollbackTargetRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    configuration_version_id: CONFIGURATION_VERSION_ID,
    configuration_generation: CONFIGURATION_GENERATION,
    configuration_hash: CONFIGURATION_HASH,
    configuration_state: 'sealed',
    configured_shard_count: '1',
    source_generation_id: SOURCE_GENERATION_ID,
    source_digest: hashBackstageNotionPartitionSourceGeneration({
      universeId: UNIVERSE_ID,
      members: [{
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        sourceManifestHash: SOURCE_MANIFEST_HASH,
        pageCount: 1,
        chunkCount: 1,
        terminalDriftHash: SOURCE_DRIFT_HASH,
      }],
    }),
    source_page_count: '1',
    source_chunk_count: '1',
    source_verified_at: VERIFIED_AT,
    source_verification_hash: hashBackstageNotionPartitionSourceVerification({
      universeId: UNIVERSE_ID,
      sourceGenerationId: SOURCE_GENERATION_ID,
      members: [{
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        sourceManifestHash: SOURCE_MANIFEST_HASH,
        pageCount: 1,
        chunkCount: 1,
        terminalDriftHash: SOURCE_DRIFT_HASH,
      }],
    }),
    embedding_model: 'text-embedding-test',
    embedding_version: '1',
    embedding_dimension: '2',
    index_format_version: '1',
    member_count: '1',
    omission_count: '0',
    page_count: '1',
    chunk_count: '1',
    manifest_state: 'sealed',
    manifest_created_at: MANIFEST_CREATED_AT,
    manifest_sealed_at: MANIFEST_SEALED_AT,
    ...overrides,
  };
}

function rollbackMemberRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    shard_key: SHARD_KEY,
    partition_version_id: PARTITION_VERSION_ID,
    decision: 'fresh',
    verified_at: VERIFIED_AT,
    configured_partition_version_id: PARTITION_VERSION_ID,
    snapshot_id: SNAPSHOT_ID,
    snapshot_partition_version_id: PARTITION_VERSION_ID,
    snapshot_source_generation_id: SOURCE_GENERATION_ID,
    snapshot_page_count: '1',
    snapshot_chunk_count: '1',
    snapshot_embedding_model: 'text-embedding-test',
    snapshot_embedding_version: '1',
    snapshot_embedding_dimension: '2',
    snapshot_index_format_version: '1',
    snapshot_state: 'sealed',
    snapshot_created_at: SOURCE_EDITED_AT,
    snapshot_sealed_at: SNAPSHOT_SEALED_AT,
    ...overrides,
  };
}

function createManifestRollbackHarness(options: {
  readonly initialAuthority?: string;
  readonly terminalAuthority?: string;
  readonly headOverrides?: Record<string, unknown>;
  readonly targetRows?: readonly Record<string, unknown>[];
  readonly memberRows?: readonly Record<string, unknown>[];
  readonly actualOmissionCount?: number;
  readonly updateRows?: readonly Record<string, unknown>[];
} = {}) {
  let authorityReads = 0;
  return new PartitionRepositoryHarness((sql) => {
    if (sql.includes('FROM public.backstage_notion_universe_heads')) {
      authorityReads += 1;
      return result([{
        authority: authorityReads === 1
          ? options.initialAuthority ?? 'notion'
          : options.terminalAuthority ?? 'notion',
      }]);
    }
    if (sql.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
      return result([{
        desired_configuration_version_id: CONFIGURATION_VERSION_ID,
        desired_configuration_generation: CONFIGURATION_GENERATION,
        desired_configuration_hash: CONFIGURATION_HASH,
        active_manifest_id: CURRENT_MANIFEST_ID,
        active_configuration_version_id: CONFIGURATION_VERSION_ID,
        head_generation: '5',
        manifest_generation: '3',
        reconciliation_generation: RECONCILIATION_GENERATION,
        published_reconciliation_generation: '6',
        ...options.headOverrides,
      }]);
    }
    if (sql.includes('FROM public.backstage_notion_universe_manifests AS manifest')) {
      return result([...(options.targetRows ?? [rollbackTargetRow()])]);
    }
    if (sql.includes('FROM public.backstage_notion_universe_manifest_shards AS member')) {
      return result([...(options.memberRows ?? [rollbackMemberRow()])]);
    }
    if (sql.includes('FROM public.backstage_notion_universe_manifest_omissions')) {
      return result([{ omission_count: String(options.actualOmissionCount ?? 0) }]);
    }
    if (sql.startsWith('UPDATE public.backstage_notion_partitioned_universe_heads')) {
      return result([...(options.updateRows ?? [{
        head_generation: '6',
        manifest_generation: '4',
      }])]);
    }
    if (sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')) {
      return result();
    }
    throw new Error(`Unexpected rollback query: ${sql}`);
  });
}

describe('PostgresBackstageNotionPartitionRepository', () => {
  test('loads bounded synchronization metadata without projecting Markdown or embeddings', async () => {
    const query = jest.fn(async (sql: string, values: readonly unknown[]) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
        expect(normalized).not.toMatch(/\bmarkdown\b|embedding\.embedding\b/iu);
        return result([{
          desired_configuration_version_id: CONFIGURATION_VERSION_ID,
          desired_configuration_generation: CONFIGURATION_GENERATION,
          desired_configuration_hash: CONFIGURATION_HASH,
          active_manifest_id: null,
          universe_head_generation: '4',
          manifest_generation: '2',
          configured_shard_count: '1',
          shard_key: SHARD_KEY,
          partition_version_id: OPTIONAL_PARTITION_VERSION_B,
          configured_root_page_id: ROOT_PAGE_ID,
          current_partition_version_id: PARTITION_VERSION_ID,
          root_page_id: ROOT_PAGE_ID,
          active_snapshot_id: SNAPSHOT_ID,
          head_generation: '3',
          snapshot_generation: '1',
          snapshot_partition_version_id: PARTITION_VERSION_ID,
          source_manifest_hash: SOURCE_MANIFEST_HASH,
          embedding_model: 'text-embedding-test',
          embedding_version: '1',
          embedding_dimension: '2',
          index_format_version: '1',
          last_verified_at: VERIFIED_AT,
        }]);
      }
      expect(normalized).toContain('LIMIT $4');
      expect(normalized).not.toMatch(/markdown|embedding/iu);
      expect(values[3]).toBe(101);
      return result([{
        page_id: ROOT_PAGE_ID,
        page_version_id: PAGE_VERSION_ID,
        content_hash: hash('page'),
        parent_page_id: null,
        title: ROOT_TITLE,
        path: [ROOT_PAGE_ID],
        scope_path: [ROOT_TITLE],
      }]);
    });
    const repository = new PostgresBackstageNotionPartitionRepository({
      query,
    } as unknown as Pool);

    await expect(repository.loadUniverseSynchronizationState(
      UNIVERSE_ID,
      CONFIGURATION_VERSION_ID
    )).resolves.toMatchObject({
      expectedUniverseHead: { headGeneration: '4', manifestGeneration: '2' },
      shards: [{
        shardKey: SHARD_KEY,
        partitionVersionId: OPTIONAL_PARTITION_VERSION_B,
        expectedHead: { currentPartitionVersionId: PARTITION_VERSION_ID },
        activeSnapshot: {
          snapshotId: SNAPSHOT_ID,
          partitionVersionId: PARTITION_VERSION_ID,
          embeddingModel: 'text-embedding-test',
          embeddingVersion: 1,
          embeddingDimension: 2,
          indexFormatVersion: 1,
        },
      }],
    });
    await expect(repository.loadShardPageInventory(
      UNIVERSE_ID,
      SHARD_KEY,
      SNAPSHOT_ID,
      100
    )).resolves.toEqual([expect.objectContaining({
      pageId: ROOT_PAGE_ID,
      pageVersionId: PAGE_VERSION_ID,
    })]);
  });

  test.each([
    ['neither generation', {
      monolith_snapshot_id: null,
      partition_manifest_id: null,
      partition_configuration_hash: null,
      monolith_page_count: 0,
      monolith_chunk_count: 0,
      partition_page_count: 0,
      partition_chunk_count: 0,
      shared_page_count: '0',
      monolith_only_page_count: '0',
      partition_only_page_count: '0',
      monolith_only_page_ids: [],
      partition_only_page_ids: [],
    }, { monolithSnapshotId: null, partitionManifestId: null }],
    ['exact page parity', {
      monolith_snapshot_id: SNAPSHOT_ID,
      partition_manifest_id: MANIFEST_ID,
      partition_configuration_hash: CONFIGURATION_HASH,
      monolith_page_count: 1,
      monolith_chunk_count: 2,
      partition_page_count: 1,
      partition_chunk_count: 3,
      shared_page_count: '1',
      monolith_only_page_count: '0',
      partition_only_page_count: '0',
      monolith_only_page_ids: [],
      partition_only_page_ids: [],
    }, {
      partitionConfigurationHash: CONFIGURATION_HASH,
      sharedPageCount: 1,
      monolithOnlyPageCount: 0,
      partitionOnlyPageCount: 0,
    }],
    ['monolith only', {
      monolith_snapshot_id: SNAPSHOT_ID,
      partition_manifest_id: null,
      partition_configuration_hash: null,
      monolith_page_count: 1,
      monolith_chunk_count: 2,
      partition_page_count: 0,
      partition_chunk_count: 0,
      shared_page_count: '0',
      monolith_only_page_count: '1',
      partition_only_page_count: '0',
      monolith_only_page_ids: [ROOT_PAGE_ID],
      partition_only_page_ids: [],
    }, { monolithOnlyPageIds: [ROOT_PAGE_ID], partitionManifestId: null }],
    ['partition only', {
      monolith_snapshot_id: null,
      partition_manifest_id: MANIFEST_ID,
      partition_configuration_hash: CONFIGURATION_HASH,
      monolith_page_count: 0,
      monolith_chunk_count: 0,
      partition_page_count: 1,
      partition_chunk_count: 3,
      shared_page_count: '0',
      monolith_only_page_count: '0',
      partition_only_page_count: '1',
      monolith_only_page_ids: [],
      partition_only_page_ids: [OPTIONAL_ROOT_PAGE_ID],
    }, { monolithSnapshotId: null, partitionOnlyPageIds: [OPTIONAL_ROOT_PAGE_ID] }],
    ['no overlap', {
      monolith_snapshot_id: SNAPSHOT_ID,
      partition_manifest_id: MANIFEST_ID,
      partition_configuration_hash: CONFIGURATION_HASH,
      monolith_page_count: 1,
      monolith_chunk_count: 2,
      partition_page_count: 1,
      partition_chunk_count: 3,
      shared_page_count: '0',
      monolith_only_page_count: '1',
      partition_only_page_count: '1',
      monolith_only_page_ids: [ROOT_PAGE_ID],
      partition_only_page_ids: [OPTIONAL_ROOT_PAGE_ID],
    }, { sharedPageCount: 0, monolithOnlyPageCount: 1, partitionOnlyPageCount: 1 }],
  ] as const)(
    'loads one statement-pinned, bounded shadow coverage row for %s',
    async (_name, row, expected) => {
      const query = jest.fn(async (sql: string, values: readonly unknown[]) => {
        const normalized = normalizeSql(sql);
        expect(normalized).toContain('WITH selected_heads AS MATERIALIZED');
        expect(normalized.match(/LIMIT \$2/gu)).toHaveLength(2);
        expect(normalized).not.toMatch(
          /\b(?:markdown|content|embedding|metadata|title|path)\b/iu
        );
        expect(normalized).not.toMatch(
          /backstage_notion_(?:page_versions|chunk_versions|chunk_embeddings)/iu
        );
        expect(values).toEqual([UNIVERSE_ID, 8]);
        return result([{ ...row }]);
      });
      const repository = new PostgresBackstageNotionPartitionRepository({
        query,
      } as unknown as Pool);

      await expect(repository.loadShadowCoverage(UNIVERSE_ID)).resolves
        .toEqual(expect.objectContaining({ universeId: UNIVERSE_ID, ...expected }));
      expect(query).toHaveBeenCalledTimes(1);
    }
  );

  test('rejects unbounded shadow samples and inconsistent repository output', async () => {
    const query = jest.fn(async () => result([{
      monolith_snapshot_id: SNAPSHOT_ID,
      partition_manifest_id: null,
      partition_configuration_hash: null,
      monolith_page_count: 1,
      monolith_chunk_count: 1,
      partition_page_count: 0,
      partition_chunk_count: 0,
      shared_page_count: '0',
      monolith_only_page_count: '1',
      partition_only_page_count: '0',
      monolith_only_page_ids: [ROOT_PAGE_ID, OPTIONAL_ROOT_PAGE_ID],
      partition_only_page_ids: [],
    }]));
    const repository = new PostgresBackstageNotionPartitionRepository({
      query,
    } as unknown as Pool);

    await expect(repository.loadShadowCoverage(UNIVERSE_ID, 17))
      .rejects.toThrow('samplePageIdLimit is outside its supported range');
    expect(query).not.toHaveBeenCalled();
    await expect(repository.loadShadowCoverage(UNIVERSE_ID, 1))
      .rejects.toThrow('monolith_only_page_ids exceeds its bounded sample contract');
  });

  test('loads one bounded routing generation from exact immutable manifest membership', async () => {
    const nextConfigurationId = 'abababab-abab-4bab-8bab-abababababab';
    const nextConfigurationHash = 'f'.repeat(64);
    const harness = new PartitionRepositoryHarness(async (
      sql: string,
      values: readonly unknown[]
    ) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain('WITH pinned_manifest AS MATERIALIZED');
      expect(normalized).toContain('manifest.id = partition_head.active_manifest_id');
      expect(normalized).toContain('member.shard_snapshot_id');
      expect(normalized).toContain('LIMIT $2');
      expect(normalized).not.toMatch(/backstage_notion_partition_heads/iu);
      expect(normalized).not.toMatch(
        /backstage_notion_(?:page_versions|chunk_versions|chunk_embeddings)/iu
      );
      expect(normalized).not.toMatch(/\b(?:markdown|content)\b/iu);
      expect(values).toEqual([UNIVERSE_ID, 129]);
      const common = {
        configured_shard_count: '2',
        member_count: '1',
        omission_count: '1',
        desired_configuration_version_id: nextConfigurationId,
        desired_configuration_generation: 'partition-generation-2',
        desired_configuration_hash: nextConfigurationHash,
      };
      return result([
        routingMemberRow(common),
        routingOmissionRow(common),
      ]);
    });
    const repository = new PostgresBackstageNotionPartitionRepository(
      harness.pool
    );

    const state = await repository.loadActiveManifestRoutingState(UNIVERSE_ID);

    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.queries.map(item => item.sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining("SET LOCAL lock_timeout = '1s'"),
      expect.stringContaining('WITH pinned_manifest AS MATERIALIZED'),
      'COMMIT',
    ]);
    expect(harness.release).toHaveBeenCalledWith(false);
    expect(state).toMatchObject({
      universeId: UNIVERSE_ID,
      manifestId: MANIFEST_ID,
      manifestGeneration: '3',
      configurationVersionId: CONFIGURATION_VERSION_ID,
      configurationGeneration: CONFIGURATION_GENERATION,
      configurationHash: CONFIGURATION_HASH,
      configurationCurrent: false,
      embeddingModel: 'text-embedding-test',
      embeddingVersion: 1,
      embeddingDimension: 2,
      indexFormatVersion: 1,
      pageCount: 1,
      chunkCount: 1,
      members: [{
        shardKey: SHARD_KEY,
        snapshotId: SNAPSHOT_ID,
        verifiedAt: VERIFIED_AT,
        snapshotSealedAt: SNAPSHOT_SEALED_AT,
        pageCount: 1,
        chunkCount: 1,
        scopeTags: ['brand:raw', 'year:2026'],
      }],
      omissions: [{
        shardKey: OPTIONAL_SHARD_KEY,
        required: false,
        decision: 'optional_unavailable',
        safeReasonCode: 'SHARD_SYNC_INCOMPLETE',
      }],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.members)).toBe(true);
    expect(Object.isFrozen(state?.members[0])).toBe(true);
  });

  test('loads one repeatable-read, bounded diagnostics generation without corpus or secret fields', async () => {
    const harness = new PartitionRepositoryHarness(async (
      sql: string,
      values: readonly unknown[]
    ) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain('WITH pinned_universe AS MATERIALIZED');
      expect(normalized).toContain('statement_timestamp() AS observed_at');
      expect(normalized).not.toContain('transaction_timestamp() AS observed_at');
      expect(normalized).toContain('active_job_candidates AS MATERIALIZED');
      expect(normalized).toContain('configured_shards AS MATERIALIZED');
      expect(normalized).toContain('LIMIT $2');
      expect(normalized).toContain('LIMIT $3');
      expect(normalized).toContain("active_lease.expires_at > pinned.observed_at");
      expect(normalized).toContain('ELSE COALESCE(( job.input ->> \'protocol\' = $5');
      expect(normalized).toContain('NOT target_valid OR NOT timestamps_valid');
      expect(normalized).toContain("AND job.input ->> 'universeId' = $1");
      expect(normalized).toContain('job.updated_at < job.created_at');
      expect(normalized).toContain("job.status = 'running' AND job.started_at IS NULL");
      expect(normalized).not.toMatch(
        /backstage_notion_(?:shard_snapshot_pages|shard_snapshot_chunk_occurrences|page_versions|page_version_chunks|chunk_versions|chunk_embeddings|manifest_page_ownership)/iu
      );
      expect(normalized).not.toMatch(
        /\b(?:root_page_id|page_id|title|canonical_url|path|markdown|content|embedding_model|embedding_dimension|lease_token|holder_id|lease_generation|correlation_id|idempotency_scope_hash|idempotency_key_hash)\b/iu
      );
      expect(normalized).not.toMatch(
        /\bjob\.(?:id|output|error_message|request_fingerprint_hash)\b/iu
      );
      expect(values).toEqual([
        UNIVERSE_ID,
        17,
        129,
        'backstage-notion-partition-sync',
        'backstage-notion-partition-sync-job-v1',
      ]);
      return result([diagnosticsMemberRow()]);
    });
    const repository = new PostgresBackstageNotionPartitionRepository(
      harness.pool
    );

    const state = await repository.loadUniverseDiagnosticsState(UNIVERSE_ID);

    expect(harness.queries.map(item => item.sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining("SET LOCAL lock_timeout = '1s'"),
      expect.stringContaining('WITH pinned_universe AS MATERIALIZED'),
      'COMMIT',
    ]);
    expect(state).toEqual({
      universeId: UNIVERSE_ID,
      observedAt: DIAGNOSTICS_OBSERVED_AT,
      authorityActive: true,
      desiredConfigurationVersionId: CONFIGURATION_VERSION_ID,
      desiredConfigurationGeneration: CONFIGURATION_GENERATION,
      desiredConfigurationHash: CONFIGURATION_HASH,
      headGeneration: '4',
      manifestGeneration: '3',
      activeManifest: {
        manifestId: MANIFEST_ID,
        configurationVersionId: CONFIGURATION_VERSION_ID,
        configurationGeneration: CONFIGURATION_GENERATION,
        configurationHash: CONFIGURATION_HASH,
        createdAt: MANIFEST_CREATED_AT,
        sealedAt: MANIFEST_SEALED_AT,
        memberCount: 1,
        omissionCount: 0,
        pageCount: 1,
        chunkCount: 1,
      },
      activeJobCount: 0,
      unconfiguredActiveJobCount: 0,
      shards: [{
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        currentHeadPartitionVersionId: PARTITION_VERSION_ID,
        retrievalTier: 'hot',
        required: true,
        scopeTags: ['brand:raw', 'year:2026'],
        categoryTags: ['current'],
        headGeneration: '3',
        snapshotGeneration: '1',
        lastAttemptAt: SNAPSHOT_SEALED_AT,
        lastVerifiedAt: VERIFIED_AT,
        lastKnownGood: {
          snapshotId: SNAPSHOT_ID,
          partitionVersionId: PARTITION_VERSION_ID,
          exactForConfiguredPartition: true,
          pageCount: 1,
          chunkCount: 1,
          createdAt: SOURCE_EDITED_AT,
          sealedAt: SNAPSHOT_SEALED_AT,
        },
        manifestRecord: {
          kind: 'member',
          decision: 'fresh',
          snapshotId: SNAPSHOT_ID,
          verifiedAt: VERIFIED_AT,
          pageCount: 1,
          chunkCount: 1,
        },
        lease: null,
        activeJobs: {
          total: 0,
          pending: 0,
          running: 0,
          configurationStale: 0,
        },
      }],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.shards)).toBe(true);
    expect(Object.isFrozen(state?.shards[0]?.lastKnownGood)).toBe(true);
  });

  test('projects only active leases, closed omission reasons, and aggregate job counts', async () => {
    const leaseAcquiredAt = new Date('2026-08-24T12:04:30.000Z');
    const leaseExpiresAt = new Date('2026-08-24T12:06:00.000Z');
    const commonJobs = {
      active_job_candidate_count: '1',
      universe_active_job_count: '1',
      invalid_active_job_count: '0',
      unconfigured_active_job_count: '0',
    };
    const harness = new PartitionRepositoryHarness(async () => result([
      diagnosticsOmissionRow({
        ...commonJobs,
        lease_acquired_at: leaseAcquiredAt,
        lease_expires_at: leaseExpiresAt,
        shard_active_job_count: '1',
        shard_pending_job_count: '0',
        shard_running_job_count: '1',
        shard_stale_configuration_job_count: '1',
      }),
      diagnosticsMemberRow({
        ...commonJobs,
        configured_shard_count: '2',
        manifest_member_count: '1',
        manifest_omission_count: '1',
      }),
    ]));
    const repository = new PostgresBackstageNotionPartitionRepository(
      harness.pool
    );

    const state = await repository.loadUniverseDiagnosticsState(UNIVERSE_ID);

    expect(state?.activeJobCount).toBe(1);
    expect(state?.shards).toHaveLength(2);
    expect(state?.shards[0]).toMatchObject({
      shardKey: OPTIONAL_SHARD_KEY,
      required: false,
      manifestRecord: {
        kind: 'omission',
        decision: 'optional_unavailable',
        safeReasonCode: 'SHARD_SYNC_FAILED',
      },
      lease: { acquiredAt: leaseAcquiredAt, expiresAt: leaseExpiresAt },
      activeJobs: {
        total: 1,
        pending: 0,
        running: 1,
        configurationStale: 1,
      },
    });
    expect(state?.shards[1]).toMatchObject({
      shardKey: SHARD_KEY,
      lease: null,
      activeJobs: { total: 0 },
    });
  });

  test('labels a historical shard head as non-exact for the desired partition version', async () => {
    const harness = new PartitionRepositoryHarness(async () => result([
      diagnosticsMemberRow({
        desired_configuration_version_id: OPTIONAL_PARTITION_VERSION_B,
        desired_configuration_generation: 'partition-generation-2',
        desired_configuration_hash: 'f'.repeat(64),
        partition_version_id: OPTIONAL_PARTITION_VERSION_B,
        current_partition_version_id: PARTITION_VERSION_ID,
        manifest_member_snapshot_id: null,
        manifest_member_decision: null,
        manifest_member_required: null,
        manifest_member_verified_at: null,
        manifest_snapshot_id: null,
        manifest_snapshot_page_count: null,
        manifest_snapshot_chunk_count: null,
        manifest_snapshot_state: null,
        manifest_snapshot_created_at: null,
        manifest_snapshot_sealed_at: null,
      }),
    ]));
    const repository = new PostgresBackstageNotionPartitionRepository(
      harness.pool
    );

    const state = await repository.loadUniverseDiagnosticsState(UNIVERSE_ID);

    expect(state?.activeManifest?.configurationVersionId)
      .toBe(CONFIGURATION_VERSION_ID);
    expect(state?.desiredConfigurationVersionId)
      .toBe(OPTIONAL_PARTITION_VERSION_B);
    expect(state?.shards[0]).toMatchObject({
      partitionVersionId: OPTIONAL_PARTITION_VERSION_B,
      currentHeadPartitionVersionId: PARTITION_VERSION_ID,
      lastKnownGood: {
        partitionVersionId: PARTITION_VERSION_ID,
        exactForConfiguredPartition: false,
      },
      manifestRecord: null,
    });
  });

  test('rejects diagnostics overflow, duplicates, cross-generation rows, and malformed metadata', async () => {
    const repositoryFor = (rows: Array<Record<string, unknown>>) =>
      new PostgresBackstageNotionPartitionRepository(
        new PartitionRepositoryHarness(async () => result(rows)).pool
      );

    await expect(repositoryFor(Array.from({ length: 129 }, (_, index) =>
      diagnosticsMemberRow({
        configured_shard_count: '129',
        shard_key: `raw/${String(index).padStart(3, '0')}`,
      })
    )).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/bounded shard contract/u);

    await expect(repositoryFor([diagnosticsMemberRow({
      active_job_candidate_count: '17',
    })]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/active-job metadata is invalid or unbounded/u);

    await expect(repositoryFor([
      diagnosticsMemberRow({ configured_shard_count: '2' }),
      diagnosticsMemberRow({ configured_shard_count: '2' }),
    ]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/duplicate configured shards/u);

    await expect(repositoryFor([
      diagnosticsMemberRow({ configured_shard_count: '2' }),
      diagnosticsOmissionRow({
        manifest_generation: '4',
        omission_safe_reason_code: 'NOT_AN_APPROVED_REASON',
      }),
    ]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/crossed authority generations/u);

    await expect(repositoryFor([
      diagnosticsMemberRow({
        configured_shard_count: '2',
        manifest_omission_count: '1',
      }),
      diagnosticsOmissionRow({
        omission_safe_reason_code: 'NOT_AN_APPROVED_REASON',
      }),
    ]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/not an approved shard failure reason/u);

    await expect(repositoryFor([diagnosticsMemberRow({
      active_job_candidate_count: '1',
      invalid_active_job_count: '1',
    })]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/active-job metadata is invalid or unbounded/u);

    await expect(repositoryFor([diagnosticsMemberRow({
      active_job_candidate_count: '2',
      universe_active_job_count: '2',
      shard_active_job_count: '2',
      shard_pending_job_count: '1',
      shard_running_job_count: '1',
    })]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/active-job summary is inconsistent/u);

    await expect(repositoryFor([
      diagnosticsMemberRow({
        configured_shard_count: '2',
        manifest_omission_count: '1',
      }),
      diagnosticsOmissionRow({ manifest_page_count: '2' }),
    ]).loadUniverseDiagnosticsState(UNIVERSE_ID))
      .rejects.toThrow(/manifest rows are inconsistent/u);
  });

  test('fails closed for missing authority, oversized metadata, and inconsistent totals', async () => {
    const absentHarness = new PartitionRepositoryHarness(async () => result());
    const absent = new PostgresBackstageNotionPartitionRepository(
      absentHarness.pool
    );
    await expect(absent.loadActiveManifestRoutingState(UNIVERSE_ID))
      .resolves.toBeNull();

    const oversizedHarness = new PartitionRepositoryHarness(async () => result(Array.from(
        { length: 129 },
        () => routingMemberRow()
      )));
    const oversized = new PostgresBackstageNotionPartitionRepository(
      oversizedHarness.pool
    );
    await expect(oversized.loadActiveManifestRoutingState(UNIVERSE_ID))
      .rejects.toThrow(/exceeds its bounded contract/u);

    const inconsistentHarness = new PartitionRepositoryHarness(async () => result([
        routingMemberRow({ manifest_chunk_count: '2' }),
      ]));
    const inconsistent = new PostgresBackstageNotionPartitionRepository(
      inconsistentHarness.pool
    );
    await expect(inconsistent.loadActiveManifestRoutingState(UNIVERSE_ID))
      .rejects.toThrow(/totals are internally inconsistent/u);
  });

  test('resolves exact manifest scope ownership with bounded suffix matching', async () => {
    const requestedPath = [
      ...Array.from({ length: 100 }, (_, index) => `Ancestor ${index}`),
      'Monday Night Raw',
    ];
    const requestedPathKey = normalizeBackstageNotionScopePath(requestedPath);
    const titleKey = normalizeBackstageNotionScopeKey(ROOT_TITLE);
    const harness = new PartitionRepositoryHarness(async (
      sql: string,
      values: readonly unknown[]
    ) => {
      const normalized = normalizeSql(sql);
      expect(normalized).toContain('WITH RECURSIVE pinned_manifest AS MATERIALIZED');
      expect(normalized).toContain('manifest.id = $2');
      expect(normalized).not.toContain(
        'backstage_notion_partitioned_universe_heads'
      );
      expect(normalized).toContain('page.scope_title_key = $3');
      expect(normalized).toContain('jsonb_array_length(page.scope_path_key)');
      expect(normalized).toContain('parent.traversal_depth < $7');
      expect(normalized).toContain('child.depth = parent.page_depth + 1');
      expect(normalized).toContain('COUNT(DISTINCT occurrence.page_id)');
      expect(normalized).toContain(
        'OR EXISTS ( SELECT 1 FROM public.backstage_notion_shard_snapshot_chunk_occurrences AS retrievable_occurrence'
      );
      expect(normalized).toMatch(/FROM candidates AS candidate UNION SELECT/iu);
      expect(normalized.match(/LIMIT \$6/gu)).toHaveLength(2);
      expect(normalized).not.toMatch(
        /backstage_notion_(?:page_versions|chunk_versions|chunk_embeddings)/iu
      );
      expect(normalized).not.toMatch(/\b(?:markdown|content|embedding)\b/iu);
      expect(values).toEqual([
        UNIVERSE_ID,
        MANIFEST_ID,
        titleKey,
        requestedPathKey,
        'subtree',
        2,
        16,
      ]);
      return result([{
        manifest_id: MANIFEST_ID,
        shard_key: SHARD_KEY,
        partition_version_id: PARTITION_VERSION_ID,
        shard_snapshot_id: SNAPSHOT_ID,
        page_id: ROOT_PAGE_ID,
        page_title: ROOT_TITLE,
        scope_path: [ROOT_TITLE],
        scope_chunk_count: '3',
        scope_page_count: '2',
      }]);
    });
    const repository = new PostgresBackstageNotionPartitionRepository(
      harness.pool
    );

    await expect(repository.resolveManifestScopeOwner(
      UNIVERSE_ID,
      MANIFEST_ID,
      {
        pageTitleKey: titleKey,
        pagePathKey: Array.from({ length: 102 }, () => titleKey),
        scopeKind: 'subtree',
      }
    )).rejects.toThrow(/pagePathKey is invalid/u);
    expect(harness.connect).not.toHaveBeenCalled();
    await expect(repository.resolveManifestScopeOwner(
      UNIVERSE_ID,
      MANIFEST_ID,
      {
        pageTitleKey: titleKey,
        pagePathKey: requestedPathKey,
        scopeKind: 'subtree',
      }
    )).resolves.toEqual({
      status: 'resolved',
      manifestId: MANIFEST_ID,
      shardKey: SHARD_KEY,
      partitionVersionId: PARTITION_VERSION_ID,
      snapshotId: SNAPSHOT_ID,
      pageId: ROOT_PAGE_ID,
      pageTitle: ROOT_TITLE,
      pagePath: [ROOT_TITLE],
      sectionPath: null,
      sectionOccurrencePath: null,
      scopeKind: 'subtree',
      scopeChunkCount: 3,
      scopePageCount: 2,
    });
    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.queries.map(item => item.sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining("SET LOCAL lock_timeout = '1s'"),
      expect.stringContaining('WITH RECURSIVE pinned_manifest AS MATERIALIZED'),
      'COMMIT',
    ]);
    expect(harness.release).toHaveBeenCalledWith(false);
  });

  test('distinguishes stale manifests, missing scopes, ambiguity, and corrupt scope rows', async () => {
    const titleKey = normalizeBackstageNotionScopeKey(ROOT_TITLE);
    const baseRow = {
      manifest_id: MANIFEST_ID,
      shard_key: SHARD_KEY,
      partition_version_id: PARTITION_VERSION_ID,
      shard_snapshot_id: SNAPSHOT_ID,
      page_id: ROOT_PAGE_ID,
      page_title: ROOT_TITLE,
      scope_path: [ROOT_TITLE],
      scope_chunk_count: '1',
      scope_page_count: '1',
    };
    const resolveRows = async (rows: Array<Record<string, unknown>>) => {
      const harness = new PartitionRepositoryHarness(async () => result(rows));
      return new PostgresBackstageNotionPartitionRepository(
        harness.pool
      ).resolveManifestScopeOwner(
        UNIVERSE_ID,
        MANIFEST_ID,
        { pageTitleKey: titleKey, pagePathKey: null, scopeKind: 'page' }
      );
    };

    await expect(resolveRows([])).resolves.toEqual({ status: 'invalid' });
    await expect(resolveRows([{
      manifest_id: MANIFEST_ID,
      shard_key: null,
      partition_version_id: null,
      shard_snapshot_id: null,
      page_id: null,
      page_title: null,
      scope_path: null,
      scope_chunk_count: null,
      scope_page_count: null,
    }])).resolves.toEqual({ status: 'not_found' });
    await expect(resolveRows([
      baseRow,
      { ...baseRow, page_id: OPTIONAL_ROOT_PAGE_ID },
    ])).resolves.toEqual({ status: 'ambiguous' });
    await expect(resolveRows([{
      ...baseRow,
      page_title: 'SmackDown',
    }])).resolves.toEqual({ status: 'invalid' });
    await expect(resolveRows([{
      ...baseRow,
      scope_chunk_count: '0',
      scope_page_count: '0',
    }])).resolves.toEqual({ status: 'not_found' });
  });

  test('rejects malformed inputs before obtaining a database connection', async () => {
    const connect = jest.fn(async () => {
      throw new Error('SENTINEL_CONNECT');
    });
    const repository = new PostgresBackstageNotionPartitionRepository({
      connect,
    } as unknown as Pool);

    const invalidCalls: Array<readonly [() => Promise<unknown>, string]> = [
      [() => repository.registerConfiguration(registerInput({
        universe: universe([
          definition(),
          definition({ shardKey: 'duplicate-root' }),
        ]),
      })), 'universe.shards contains duplicate identity'],
      [() => repository.storeChunkVersion({
        universeId: UNIVERSE_ID,
        contentHash: 'not-a-hash',
        chunkerVersion: 1,
        content: 'content',
        contentCodePoints: 7,
      }), 'contentHash is invalid'],
      [() => repository.storeChunkVersion({
        universeId: UNIVERSE_ID,
        contentHash: hash('different'),
        chunkerVersion: 1,
        content: 'content',
        contentCodePoints: 7,
      }), 'contentHash does not match content'],
      [() => repository.storeEmbedding({
        universeId: UNIVERSE_ID,
        chunkVersionId: CHUNK_VERSION_ID,
        embeddingModel: 'text-embedding-test',
        embeddingVersion: 1,
        embedding: [0, 0],
      }), 'embedding must have a finite non-zero norm'],
      [() => repository.storePageVersion({
        universeId: UNIVERSE_ID,
        pageId: ROOT_PAGE_ID,
        contentHash: hash('page'),
        pageFormatVersion: 1,
        chunkerVersion: 1,
        markdown: 'page',
        contentCodePoints: 4,
        chunks: [{
          ordinal: 1,
          chunkVersionId: CHUNK_VERSION_ID,
          headingPath: [],
          scopeHeadingPathKey: [],
          headingOccurrencePath: [],
        }],
      }), 'chunks must have contiguous zero-based ordinals'],
      [() => repository.storePageVersion({
        universeId: UNIVERSE_ID,
        pageId: ROOT_PAGE_ID,
        contentHash: hash('different'),
        pageFormatVersion: 1,
        chunkerVersion: 1,
        markdown: 'page',
        contentCodePoints: 4,
        chunks: [],
      }), 'contentHash does not match markdown'],
      [() => repository.acquireShardLease(UNIVERSE_ID, SHARD_KEY, 'worker', 999),
        'ttlMs is outside its supported range'],
      [() => repository.activateShardSnapshot(snapshotInput({
        snapshotId: 'caller-generated',
      })),
        'snapshotId is invalid'],
      [() => repository.activateShardSnapshot(snapshotInput({
        pages: [{
          ...snapshotInput().pages[0]!,
          scopeTitleKey: 'f'.repeat(64),
        }],
      })), 'does not contain canonical scope metadata'],
      [() => repository.activateShardSnapshot(snapshotInput({
        pages: [{
          ...snapshotInput().pages[0]!,
          canonicalUrl: 'https://www.notion.so/not-the-page-id',
        }],
      })), 'canonicalUrl is not canonical'],
      [() => repository.activateShardSnapshot(snapshotInput({
        occurrences: [{
          ...snapshotInput().occurrences[0]!,
          category: 'unsupported' as 'raw',
        }],
      })), 'category is invalid'],
      [() => repository.activateUniverseManifest({
        ...manifestInput(),
        manifestId: 'caller-generated',
      }), 'manifestId is invalid'],
      [() => repository.activateUniverseManifest({
        ...manifestInput(),
        omissions: [{
          shardKey: OPTIONAL_SHARD_KEY,
          partitionVersionId: OPTIONAL_PARTITION_VERSION_B,
          decision: 'optional_unavailable',
          safeReasonCode: 'SOURCE_UNAVAILABLE',
          expectedHead: {
            headGeneration: '7',
            snapshotGeneration: '5',
            currentPartitionVersionId: OPTIONAL_PARTITION_VERSION_B,
            activeSnapshotId: OPTIONAL_SNAPSHOT_ID,
          },
        }],
      }), 'manifest decisions are outside their supported range'],
      [() => repository.activateUniverseManifest({
        ...manifestInput(),
        members: manifestInput().members.map((member, index) => index === 0
          ? { ...member, decision: 'retained_last_known_good' as const }
          : member),
      }), 'decision is invalid'],
    ];

    for (const [call, message] of invalidCalls) {
      await expect(call()).rejects.toThrow(message);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  test('reuses only an exact immutable configuration generation', async () => {
    const shard = definition();
    const harness = new PartitionRepositoryHarness((sql, values) => {
      if (sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')) {
        return result();
      }
      if (sql.startsWith('INSERT INTO public.backstage_notion_universe_heads')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
        return result([{
          desired_configuration_version_id: CONFIGURATION_VERSION_ID,
          desired_configuration_generation: CONFIGURATION_GENERATION,
          desired_configuration_hash: CONFIGURATION_HASH,
          active_manifest_id: null,
          active_configuration_version_id: null,
          head_generation: '9',
          manifest_generation: '4',
          reconciliation_generation: '7',
          published_reconciliation_generation: '6',
        }]);
      }
      if (sql.startsWith(
        'INSERT INTO public.backstage_notion_partition_configuration_versions'
      )) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_partition_configuration_versions')) {
        return result([{
          id: CONFIGURATION_VERSION_ID,
          configuration_generation: CONFIGURATION_GENERATION,
          configuration_hash: CONFIGURATION_HASH,
          shard_count: '1',
          state: 'sealed',
        }]);
      }
      if (sql.includes('JOIN public.backstage_notion_partition_versions AS definition')) {
        return result([{
          id: PARTITION_VERSION_ID,
          shard_key: SHARD_KEY,
          root_page_id: ROOT_PAGE_ID,
          configuration_version: '1',
          display_name: shard.displayName,
          retrieval_tier: shard.retrievalTier,
          is_required: shard.required,
          scope_tags: shard.scopeTags,
          category_tags: shard.categoryTags,
          max_pages: String(shard.capacity.maxPages),
          max_chunks: String(shard.capacity.maxChunks),
          max_depth: String(shard.capacity.maxDepth),
          max_content_code_points: String(
            shard.capacity.maxContentCodePoints
          ),
          semantic_hash: partitionSemanticHash(shard),
        }]);
      }
      if (sql.startsWith('INSERT INTO public.backstage_notion_shard_heads')) {
        return result();
      }
      if (sql.startsWith('UPDATE public.backstage_notion_partitioned_universe_heads')) {
        expect(values).toEqual([
          UNIVERSE_ID,
          CONFIGURATION_VERSION_ID,
          CONFIGURATION_GENERATION,
          CONFIGURATION_HASH,
        ]);
        return result([{ head_generation: '9', reconciliation_generation: '8' }]);
      }
      throw new Error(`Unexpected configuration query: ${sql}`);
    });

    const stored = await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .registerConfiguration(registerInput({ universe: universe([shard]) }));

    expect(stored).toEqual({
      configurationVersionId: CONFIGURATION_VERSION_ID,
      universeId: UNIVERSE_ID,
      configurationGeneration: CONFIGURATION_GENERATION,
      configurationHash: CONFIGURATION_HASH,
      reused: true,
      universeHeadGeneration: '9',
      reconciliationGeneration: '8',
      definitions: [{
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        rootPageId: ROOT_PAGE_ID,
      }],
    });
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(true);
    expect(harness.release).toHaveBeenCalledWith(false);
    expect(harness.queries.every(query =>
      !query.sql.startsWith('UPDATE public.backstage_notion_shard_heads')
    )).toBe(true);
    expect(harness.queries.every(query =>
      !query.sql.startsWith('DELETE FROM public.backstage_notion_universe_manifests')
    )).toBe(true);
    expect(harness.queries.every(query =>
      !query.sql.startsWith('UPDATE public.backstage_notion_shard_sync_leases')
    )).toBe(true);
  });

  test('fences only bounded changed configuration members after the desired-head CAS', async () => {
    const desired = definition({ displayName: 'Raw renamed' });
    let candidateConfigurationId = '';
    const harness = new PartitionRepositoryHarness((sql, values) => {
      if (sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')) {
        return result();
      }
      if (sql.startsWith('INSERT INTO public.backstage_notion_universe_heads')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
        return result([{
          desired_configuration_version_id: CONFIGURATION_VERSION_ID,
          desired_configuration_generation: CONFIGURATION_GENERATION,
          desired_configuration_hash: CONFIGURATION_HASH,
          active_manifest_id: MANIFEST_ID,
          active_configuration_version_id: CONFIGURATION_VERSION_ID,
          head_generation: '9',
          manifest_generation: '4',
          reconciliation_generation: '7',
          published_reconciliation_generation: '7',
        }]);
      }
      if (sql.startsWith(
        'INSERT INTO public.backstage_notion_partition_configuration_versions'
      )) {
        candidateConfigurationId = String(values[0]);
        return result([{ id: candidateConfigurationId }]);
      }
      if (
        sql.startsWith('INSERT INTO public.backstage_notion_partition_identities')
        || sql.startsWith('INSERT INTO public.backstage_notion_partition_versions')
        || sql.startsWith('INSERT INTO public.backstage_notion_partition_configuration_members')
        || sql.startsWith('INSERT INTO public.backstage_notion_shard_heads')
      ) {
        return result();
      }
      if (
        sql.includes('FROM public.backstage_notion_partition_versions AS definition')
        && sql.includes('JOIN pg_catalog.jsonb_to_recordset')
      ) {
        return result([{
          id: OPTIONAL_PARTITION_VERSION_B,
          shard_key: SHARD_KEY,
          root_page_id: ROOT_PAGE_ID,
          configuration_version: '1',
          display_name: desired.displayName,
          retrieval_tier: desired.retrievalTier,
          is_required: desired.required,
          scope_tags: desired.scopeTags,
          category_tags: desired.categoryTags,
          max_pages: String(desired.capacity.maxPages),
          max_chunks: String(desired.capacity.maxChunks),
          max_depth: String(desired.capacity.maxDepth),
          max_content_code_points: String(desired.capacity.maxContentCodePoints),
          semantic_hash: partitionSemanticHash(desired),
        }]);
      }
      if (sql.startsWith(
        'UPDATE public.backstage_notion_partition_configuration_versions'
      )) {
        return result([{}]);
      }
      if (sql.startsWith('WITH previous_members AS')) {
        expect(values).toEqual([
          UNIVERSE_ID,
          candidateConfigurationId,
          CONFIGURATION_VERSION_ID,
          257,
        ]);
        return result([{ shard_key: SHARD_KEY }, { shard_key: OPTIONAL_SHARD_KEY }]);
      }
      if (sql.startsWith('UPDATE public.backstage_notion_partitioned_universe_heads')) {
        return result([{ head_generation: '10', reconciliation_generation: '8' }]);
      }
      if (sql.startsWith('UPDATE public.backstage_notion_shard_sync_leases')) {
        return result();
      }
      throw new Error(`Unexpected rotated configuration query: ${sql}`);
    });

    await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .registerConfiguration(registerInput({
        configurationGeneration: 'partition-generation-2',
        configurationHash: 'a'.repeat(64),
        universe: universe([desired]),
        expectedUniverseHead: {
          headGeneration: '9',
          manifestGeneration: '4',
          desiredConfigurationVersionId: CONFIGURATION_VERSION_ID,
          activeManifestId: MANIFEST_ID,
        },
      }));

    const desiredHeadCas = harness.queries.findIndex(query =>
      query.sql.startsWith('UPDATE public.backstage_notion_partitioned_universe_heads')
    );
    const leaseFenceIndex = harness.queries.findIndex(query =>
      query.sql.startsWith('UPDATE public.backstage_notion_shard_sync_leases')
    );
    expect(desiredHeadCas).toBeGreaterThanOrEqual(0);
    expect(leaseFenceIndex).toBeGreaterThan(desiredHeadCas);
    const leaseFence = harness.queries[leaseFenceIndex];
    expect(leaseFence?.values).toEqual([
      UNIVERSE_ID,
      [SHARD_KEY, OPTIONAL_SHARD_KEY],
    ]);
    expect(leaseFence?.sql).toContain('expires_at > statement_timestamp()');
    expect(harness.queries.every(query =>
      !query.sql.startsWith('UPDATE public.backstage_notion_shard_heads')
    )).toBe(true);
  });

  test('reuses an exact semantic partition version in a new configuration generation', async () => {
    const shard = definition();
    let candidateConfigurationId: string | null = null;
    let storedMembers: Array<Record<string, unknown>> = [];
    const harness = new PartitionRepositoryHarness((sql, values) => {
      if (sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')) {
        return result();
      }
      if (sql.startsWith('INSERT INTO public.backstage_notion_universe_heads')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_partitioned_universe_heads')) {
        return result();
      }
      if (sql.startsWith(
        'INSERT INTO public.backstage_notion_partition_configuration_versions'
      )) {
        candidateConfigurationId = String(values[0]);
        return result([{ id: candidateConfigurationId }]);
      }
      if (
        sql.startsWith('INSERT INTO public.backstage_notion_partition_identities')
        || sql.startsWith('INSERT INTO public.backstage_notion_partition_versions')
      ) {
        return result();
      }
      if (
        sql.includes('FROM public.backstage_notion_partition_versions AS definition')
        && sql.includes('JOIN pg_catalog.jsonb_to_recordset')
      ) {
        return result([{
          id: PARTITION_VERSION_ID,
          shard_key: SHARD_KEY,
          root_page_id: ROOT_PAGE_ID,
          configuration_version: '1',
          display_name: shard.displayName,
          retrieval_tier: shard.retrievalTier,
          is_required: shard.required,
          scope_tags: shard.scopeTags,
          category_tags: shard.categoryTags,
          max_pages: String(shard.capacity.maxPages),
          max_chunks: String(shard.capacity.maxChunks),
          max_depth: String(shard.capacity.maxDepth),
          max_content_code_points: String(shard.capacity.maxContentCodePoints),
          semantic_hash: partitionSemanticHash(shard),
        }]);
      }
      if (sql.startsWith(
        'INSERT INTO public.backstage_notion_partition_configuration_members'
      )) {
        storedMembers = JSON.parse(String(values[3])) as Array<Record<string, unknown>>;
        return result();
      }
      if (sql.startsWith(
        'UPDATE public.backstage_notion_partition_configuration_versions'
      )) {
        return result([{}]);
      }
      if (sql.startsWith('INSERT INTO public.backstage_notion_shard_heads')) {
        return result();
      }
      if (sql.startsWith(
        'INSERT INTO public.backstage_notion_partitioned_universe_heads'
      )) {
        return result([{ head_generation: '0', reconciliation_generation: '1' }]);
      }
      throw new Error(`Unexpected new configuration query: ${sql}`);
    });

    const stored = await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .registerConfiguration(registerInput({
        configurationGeneration: 'partition-generation-2',
        configurationHash: 'a'.repeat(64),
      }));

    expect(stored).toMatchObject({
      configurationVersionId: candidateConfigurationId,
      reused: false,
      reconciliationGeneration: '1',
      definitions: [{ partitionVersionId: PARTITION_VERSION_ID }],
    });
    expect(storedMembers).toEqual([{
      shard_key: SHARD_KEY,
      partition_version_id: PARTITION_VERSION_ID,
      root_page_id: ROOT_PAGE_ID,
    }]);
  });

  test('rejects an immutable material collision and rolls the transaction back', async () => {
    const harness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_chunk_versions')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_chunk_versions')) {
        return result([{
          id: CHUNK_VERSION_ID,
          content: 'different',
          content_code_points: '9',
        }]);
      }
      throw new Error(`Unexpected material query: ${sql}`);
    });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.storeChunkVersion({
      universeId: UNIVERSE_ID,
      contentHash: hash('content'),
      chunkerVersion: 1,
      content: 'content',
      contentCodePoints: 7,
    })).rejects.toEqual(new BackstageNotionPartitionRepositoryError(
      'BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION'
    ));
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(false);
    expect(harness.release).toHaveBeenCalledWith(false);
  });

  test('reuses exact chunk and embedding material without regenerating identifiers', async () => {
    const chunkHarness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_chunk_versions')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_chunk_versions')) {
        return result([{
          id: CHUNK_VERSION_ID,
          content: 'content',
          content_code_points: '7',
        }]);
      }
      throw new Error(`Unexpected chunk query: ${sql}`);
    });
    const chunk = await new PostgresBackstageNotionPartitionRepository(chunkHarness.pool)
      .storeChunkVersion({
        universeId: UNIVERSE_ID,
        contentHash: hash('content'),
        chunkerVersion: 1,
        content: 'content',
        contentCodePoints: 7,
      });
    expect(chunk).toEqual({ id: CHUNK_VERSION_ID, reused: true });

    const embeddingHarness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_chunk_embeddings')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_chunk_embeddings')) {
        return result([{
          chunk_version_id: CHUNK_VERSION_ID,
          embedding_model: 'text-embedding-test',
          embedding_version: '1',
          embedding_dimension: '2',
          embedding_norm: '5',
          embedding: '{3,4}',
        }]);
      }
      throw new Error(`Unexpected embedding query: ${sql}`);
    });
    const embedding = await new PostgresBackstageNotionPartitionRepository(
      embeddingHarness.pool
    ).storeEmbedding({
      universeId: UNIVERSE_ID,
      chunkVersionId: CHUNK_VERSION_ID,
      embeddingModel: 'text-embedding-test',
      embeddingVersion: 1,
      embedding: [3, 4],
    });
    expect(embedding).toMatchObject({
      chunkVersionId: CHUNK_VERSION_ID,
      embeddingDimension: 2,
      embeddingNorm: 5,
      reused: true,
    });
  });

  test('stores and collision-checks canonical page heading metadata', async () => {
    const headingPath = ['History'];
    const scopeHeadingPathKey = normalizeBackstageNotionScopePath(headingPath);
    const pageInput = {
      universeId: UNIVERSE_ID,
      pageId: ROOT_PAGE_ID,
      contentHash: hash('page'),
      pageFormatVersion: 1,
      chunkerVersion: 1,
      markdown: 'page',
      contentCodePoints: 4,
      chunks: [{
        ordinal: 0,
        chunkVersionId: CHUNK_VERSION_ID,
        headingPath,
        scopeHeadingPathKey,
        headingOccurrencePath: [0],
      }],
    } as const;
    const harness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_page_versions')) {
        return result([{ id: PAGE_VERSION_ID }]);
      }
      if (sql.startsWith('INSERT INTO public.backstage_notion_page_version_chunks')) {
        return result();
      }
      if (sql.startsWith('UPDATE public.backstage_notion_page_versions')) {
        return result([{}]);
      }
      if (sql.includes('FROM public.backstage_notion_page_versions')) {
        return result([{
          id: PAGE_VERSION_ID,
          markdown: 'page',
          content_code_points: '4',
          chunk_count: '1',
          state: 'sealed',
        }]);
      }
      if (sql.includes('FROM public.backstage_notion_page_version_chunks')) {
        return result([{
          ordinal: '0',
          chunk_version_id: CHUNK_VERSION_ID,
          heading_path: headingPath,
          scope_heading_path_key: scopeHeadingPathKey,
          heading_occurrence_path: [0],
        }]);
      }
      throw new Error(`Unexpected page query: ${sql}`);
    });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .storePageVersion(pageInput)).resolves.toMatchObject({ reused: false });
    const chunkInsert = harness.queries.find(query =>
      query.sql.startsWith('INSERT INTO public.backstage_notion_page_version_chunks')
    );
    expect(chunkInsert?.sql).toContain('scope_heading_path_key');
    expect(chunkInsert?.sql).toContain('heading_occurrence_path');
    expect(JSON.parse(String(chunkInsert?.values[2]))).toEqual([{
      ordinal: 0,
      chunk_version_id: CHUNK_VERSION_ID,
      heading_path: headingPath,
      scope_heading_path_key: scopeHeadingPathKey,
      heading_occurrence_path: [0],
    }]);

    const collisionHarness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_page_versions')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_page_versions')) {
        return result([{
          id: PAGE_VERSION_ID,
          markdown: 'page',
          content_code_points: '4',
          chunk_count: '1',
          state: 'sealed',
        }]);
      }
      if (sql.includes('FROM public.backstage_notion_page_version_chunks')) {
        return result([{
          ordinal: '0',
          chunk_version_id: CHUNK_VERSION_ID,
          heading_path: headingPath,
          scope_heading_path_key: ['f'.repeat(64)],
          heading_occurrence_path: [0],
        }]);
      }
      throw new Error(`Unexpected page collision query: ${sql}`);
    });
    await expect(new PostgresBackstageNotionPartitionRepository(
      collisionHarness.pool
    ).storePageVersion(pageInput)).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION',
    });
  });

  test('rejects even small immutable embedding component collisions', async () => {
    const harness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_chunk_embeddings')) {
        return result();
      }
      if (sql.includes('FROM public.backstage_notion_chunk_embeddings')) {
        return result([{
          chunk_version_id: CHUNK_VERSION_ID,
          embedding_model: 'text-embedding-test',
          embedding_version: '1',
          embedding_dimension: '2',
          embedding_norm: '5',
          embedding: [3, 4 + (Number.EPSILON * 4)],
        }]);
      }
      throw new Error(`Unexpected embedding collision query: ${sql}`);
    });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .storeEmbedding({
        universeId: UNIVERSE_ID,
        chunkVersionId: CHUNK_VERSION_ID,
        embeddingModel: 'text-embedding-test',
        embeddingVersion: 1,
        embedding: [3, 4],
      })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION',
    });
  });

  test('discards a client when rollback itself fails', async () => {
    const failure = new Error('storage failure');
    const harness = new PartitionRepositoryHarness(() => {
      throw failure;
    }, true);

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .storeChunkVersion({
        universeId: UNIVERSE_ID,
        contentHash: hash('content'),
        chunkerVersion: 1,
        content: 'content',
        contentCodePoints: 7,
      })).rejects.toBe(failure);
    expect(harness.release).toHaveBeenCalledWith(true);
  });

  test('uses generation-and-token fencing when a shard lease is renewed', async () => {
    const harness = new PartitionRepositoryHarness((sql, values) => {
      expect(sql).toContain('lease_token = $4::UUID');
      expect(sql).toContain('lease_generation = $5::BIGINT');
      expect(sql).toContain('expires_at > statement_timestamp()');
      expect(values.slice(2, 7)).toEqual([
        'partition-worker-1',
        LEASE_TOKEN,
        '3',
        '4',
        5_000,
      ]);
      return result();
    });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .renewShardLease(UNIVERSE_ID, SHARD_KEY, {
        holderId: 'partition-worker-1',
        leaseToken: LEASE_TOKEN,
        leaseGeneration: '3',
      }, 5_000)).resolves.toBeNull();
  });

  test('keeps unexpired leases busy even for the same holder and preserves the rate fence', async () => {
    const harness = new PartitionRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO public.backstage_notion_shard_sync_leases')) {
        return result();
      }
      if (sql.startsWith(
        'INSERT INTO public.backstage_notion_provider_coordinator_leases'
      )) {
        return result();
      }
      throw new Error(`Unexpected lease query: ${sql}`);
    });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.acquireShardLease(
      UNIVERSE_ID,
      SHARD_KEY,
      'partition-worker-1',
      5_000
    )).resolves.toBeNull();
    await expect(repository.acquireProviderLease(
      'notion',
      'text-embedding-test',
      'partition-worker-1',
      5_000,
      1_000
    )).resolves.toBeNull();

    const shardAcquire = harness.queries.find(query =>
      query.sql.startsWith('INSERT INTO public.backstage_notion_shard_sync_leases')
    );
    expect(shardAcquire?.sql).toContain('lease_token = EXCLUDED.lease_token');
    expect(shardAcquire?.sql).not.toContain('holder_id = EXCLUDED.holder_id\n            OR');
    expect(shardAcquire?.sql).toContain(
      'lease_generation = backstage_notion_shard_sync_leases.lease_generation + 1'
    );
    const providerAcquire = harness.queries.find(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_provider_coordinator_leases'
    ));
    expect(providerAcquire?.sql).toContain('next_request_at = GREATEST');
    expect(providerAcquire?.sql).not.toContain(
      'backstage_notion_provider_coordinator_leases.holder_id = EXCLUDED.holder_id'
    );
    expect(providerAcquire?.sql).toContain(
      'backstage_notion_provider_coordinator_leases.next_request_at <= statement_timestamp()'
    );
  });

  test('honors the caller snapshot id and rechecks the lease before head activation', async () => {
    const harness = createSnapshotHarness({ terminalLeasePresent: true });
    const activated = await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .activateShardSnapshot(snapshotInput());

    expect(activated).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      headGeneration: '1',
      snapshotGeneration: '1',
    });
    const snapshotInsert = harness.queries.find(query =>
      query.sql.startsWith('INSERT INTO public.backstage_notion_shard_snapshots')
    );
    expect(snapshotInsert?.values[0]).toBe(SNAPSHOT_ID);
    const pageInsert = harness.queries.find(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_shard_snapshot_pages'
    ));
    expect(pageInsert?.sql).toContain('scope_title_key');
    expect(JSON.parse(String(pageInsert?.values[3]))).toEqual([expect.objectContaining({
      path: [ROOT_PAGE_ID],
      scope_path: [ROOT_TITLE],
      scope_title_key: normalizeBackstageNotionScopeKey(ROOT_TITLE),
      scope_path_key: normalizeBackstageNotionScopePath([ROOT_TITLE]),
      canonical_url: ROOT_CANONICAL_URL,
    })]);
    const occurrenceInsert = harness.queries.find(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_shard_snapshot_chunk_occurrences'
    ));
    expect(occurrenceInsert?.sql).toContain('category');
    expect(JSON.parse(String(occurrenceInsert?.values[5]))).toEqual([
      expect.objectContaining({ category: 'raw' }),
    ]);
    expect(harness.queries.some(query => query.sql.includes(
      'JOIN public.backstage_notion_chunk_embeddings AS embedding'
    ))).toBe(true);
    const universeHeadLock = harness.queries.findIndex(query =>
      query.sql.includes('FROM public.backstage_notion_partitioned_universe_heads')
    );
    const shardHeadLock = harness.queries.findIndex(query =>
      query.sql.includes('FROM public.backstage_notion_shard_heads')
    );
    const firstLeaseLock = harness.queries.findIndex(query =>
      query.sql.includes('FROM public.backstage_notion_shard_sync_leases')
    );
    expect(universeHeadLock).toBeLessThan(shardHeadLock);
    expect(shardHeadLock).toBeLessThan(firstLeaseLock);
    expect(harness.queries.some(query =>
      query.sql.includes('backstage_notion_partition_configuration_members')
      && query.values[1] === CONFIGURATION_VERSION_ID
    )).toBe(true);
    const leaseReads = harness.queries.filter(query =>
      query.sql.includes('FROM public.backstage_notion_shard_sync_leases')
    );
    expect(leaseReads).toHaveLength(2);
    expect(leaseReads.map(query => query.values.slice(2, 5))).toEqual([
      ['partition-worker-1', LEASE_TOKEN, '3'],
      ['partition-worker-1', LEASE_TOKEN, '3'],
    ]);
  });

  test('atomically rotates a definition and non-null LKG snapshot under one head CAS', async () => {
    const harness = createSnapshotHarness({
      terminalLeasePresent: true,
      head: {
        ...shardHead(PARTITION_VERSION_ID, SNAPSHOT_ID),
        head_generation: '4',
        snapshot_generation: '3',
      },
    });
    await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .activateShardSnapshot(snapshotInput({
        snapshotId: OPTIONAL_SNAPSHOT_ID,
        partitionVersionId: OPTIONAL_PARTITION_VERSION_B,
        expectedHead: {
          headGeneration: '4',
          snapshotGeneration: '3',
          currentPartitionVersionId: PARTITION_VERSION_ID,
          activeSnapshotId: SNAPSHOT_ID,
        },
      }));

    const activation = harness.queries.find(query =>
      query.sql.startsWith('UPDATE public.backstage_notion_shard_heads')
    );
    expect(activation?.sql).toContain('active_snapshot_id = $5::UUID');
    expect(activation?.sql).not.toContain('active_snapshot_id = NULL');
    expect(activation?.values).toEqual([
      UNIVERSE_ID,
      SHARD_KEY,
      OPTIONAL_PARTITION_VERSION_B,
      ROOT_PAGE_ID,
      OPTIONAL_SNAPSHOT_ID,
      '5',
      '4',
      VERIFIED_AT.toISOString(),
      '4',
      '3',
      PARTITION_VERSION_ID,
      SNAPSHOT_ID,
    ]);
  });

  test('rolls back a sealed snapshot candidate when the terminal lease fence is lost', async () => {
    const harness = createSnapshotHarness({ terminalLeasePresent: false });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .activateShardSnapshot(snapshotInput())).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_LEASE_LOST',
    });
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
    expect(harness.queries.some(query =>
      query.sql.startsWith('UPDATE public.backstage_notion_shard_heads')
    )).toBe(false);
  });

  test('atomically rolls the universe head back to an existing complete sealed manifest', async () => {
    const harness = createManifestRollbackHarness();

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .rollbackUniverseManifest(rollbackInput())).resolves.toEqual({
      universeId: UNIVERSE_ID,
      previousManifestId: CURRENT_MANIFEST_ID,
      manifestId: MANIFEST_ID,
      configurationVersionId: CONFIGURATION_VERSION_ID,
      memberCount: 1,
      pageCount: 1,
      chunkCount: 1,
      headGeneration: '6',
      manifestGeneration: '4',
    });

    const update = harness.queries.find(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ));
    expect(update?.values).toEqual([
      UNIVERSE_ID,
      MANIFEST_ID,
      CONFIGURATION_VERSION_ID,
      CONFIGURATION_GENERATION,
      CONFIGURATION_HASH,
      '6',
      '4',
      VERIFIED_AT.toISOString(),
      '5',
      '3',
      CONFIGURATION_VERSION_ID,
      CONFIGURATION_GENERATION,
      CONFIGURATION_HASH,
      CURRENT_MANIFEST_ID,
      CONFIGURATION_VERSION_ID,
    ]);
    expect(harness.queries.some(query => /^(?:INSERT|DELETE) /u.test(query.sql))).toBe(false);
    expect(update?.sql).toContain(
      'reconciliation_generation = reconciliation_generation + 1'
    );
    expect(update?.sql).toContain(
      'published_reconciliation_generation = reconciliation_generation + 1'
    );
    expect(harness.queries.some(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_shard_heads'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(true);
  });

  test('atomically restores a historical manifest and its sealed configuration', async () => {
    const harness = createManifestRollbackHarness({
      targetRows: [rollbackTargetRow({
        configuration_version_id: HISTORICAL_CONFIGURATION_VERSION_ID,
        configuration_generation: HISTORICAL_CONFIGURATION_GENERATION,
        configuration_hash: HISTORICAL_CONFIGURATION_HASH,
      })],
    });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .rollbackUniverseManifest(rollbackInput())).resolves.toMatchObject({
        previousManifestId: CURRENT_MANIFEST_ID,
        manifestId: MANIFEST_ID,
        configurationVersionId: HISTORICAL_CONFIGURATION_VERSION_ID,
        headGeneration: '6',
        manifestGeneration: '4',
      });
    const update = harness.queries.find(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ));
    expect(update?.sql).toContain('desired_configuration_version_id = $3::UUID');
    expect(update?.sql).toContain('desired_configuration_generation = $4');
    expect(update?.sql).toContain('desired_configuration_hash = $5');
    expect(update?.values).toEqual([
      UNIVERSE_ID,
      MANIFEST_ID,
      HISTORICAL_CONFIGURATION_VERSION_ID,
      HISTORICAL_CONFIGURATION_GENERATION,
      HISTORICAL_CONFIGURATION_HASH,
      '6',
      '4',
      VERIFIED_AT.toISOString(),
      '5',
      '3',
      CONFIGURATION_VERSION_ID,
      CONFIGURATION_GENERATION,
      CONFIGURATION_HASH,
      CURRENT_MANIFEST_ID,
      CONFIGURATION_VERSION_ID,
    ]);
    expect(harness.queries.some(query => /^(?:INSERT|DELETE) /u.test(query.sql))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(true);
  });

  test('keeps the current configuration active when a cross-configuration rollback CAS loses', async () => {
    const harness = createManifestRollbackHarness({
      targetRows: [rollbackTargetRow({
        configuration_version_id: HISTORICAL_CONFIGURATION_VERSION_ID,
        configuration_generation: HISTORICAL_CONFIGURATION_GENERATION,
        configuration_hash: HISTORICAL_CONFIGURATION_HASH,
      })],
      updateRows: [],
    });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .rollbackUniverseManifest(rollbackInput())).rejects.toMatchObject({
        code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
      });
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('rejects missing, unsealed, omitted, unsupported, or incomplete rollback manifests', async () => {
    const cases = [
      { targetRows: [] },
      {
        targetRows: [rollbackTargetRow({
          manifest_state: 'building',
          manifest_sealed_at: null,
        })],
      },
      { targetRows: [rollbackTargetRow({ omission_count: '1' })] },
      { targetRows: [rollbackTargetRow({ index_format_version: '2' })] },
      { targetRows: [rollbackTargetRow({ configured_shard_count: '2' })] },
    ] as const;

    for (const options of cases) {
      const harness = createManifestRollbackHarness(options);
      await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
        .rollbackUniverseManifest(rollbackInput())).rejects.toMatchObject({
        code: 'BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE',
      });
      expect(harness.queries.some(query => query.sql.startsWith(
        'UPDATE public.backstage_notion_partitioned_universe_heads'
      ))).toBe(false);
      expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
    }
  });

  test('rejects rollback manifests with non-fresh, missing, unreadable, or inconsistent members', async () => {
    const cases = [
      { memberRows: [rollbackMemberRow({ decision: 'retained_last_known_good' })] },
      { memberRows: [rollbackMemberRow({ snapshot_state: 'building' })] },
      { memberRows: [rollbackMemberRow({ configured_partition_version_id: null })] },
      { memberRows: [] },
      { actualOmissionCount: 1 },
      { memberRows: [rollbackMemberRow({ snapshot_chunk_count: '2' })] },
    ] as const;

    for (const options of cases) {
      const harness = createManifestRollbackHarness(options);
      await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
        .rollbackUniverseManifest(rollbackInput())).rejects.toMatchObject({
        code: 'BACKSTAGE_NOTION_PARTITION_REQUIRED_SHARD_UNAVAILABLE',
      });
      expect(harness.queries.some(query => query.sql.startsWith(
        'UPDATE public.backstage_notion_partitioned_universe_heads'
      ))).toBe(false);
      expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
    }
  });

  test('keeps the current manifest active when rollback authority, configuration, or CAS changes', async () => {
    const cases = [
      {
        options: { headOverrides: { head_generation: '6' } },
        code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
      },
      {
        options: {
          targetRows: [rollbackTargetRow({
            configuration_state: 'building',
          })],
        },
        code: 'BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION',
      },
      {
        options: { updateRows: [] },
        code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
      },
      {
        options: { terminalAuthority: 'conversation' },
        code: 'BACKSTAGE_NOTION_PARTITION_AUTHORITY_UNAVAILABLE',
      },
    ] as const;

    for (const { options, code } of cases) {
      const harness = createManifestRollbackHarness(options);
      await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
        .rollbackUniverseManifest(rollbackInput())).rejects.toMatchObject({ code });
      expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(false);
      expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
    }
  });

  test('rejects a rollback target that is already active before opening a transaction', async () => {
    const harness = createManifestRollbackHarness();
    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .rollbackUniverseManifest(rollbackInput({
        expectedUniverseHead: {
          ...rollbackInput().expectedUniverseHead,
          activeManifestId: MANIFEST_ID,
        },
      }))).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
    });
    expect(harness.connect).not.toHaveBeenCalled();
  });

  test('persists one immutable terminal source-generation barrier', async () => {
    const input = sourceGenerationInput();
    const harness = createSourceGenerationHarness();
    const verified = await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .verifySourceGeneration(input);
    const sortedMembers = [...input.members].sort((left, right) =>
      left.shardKey < right.shardKey ? -1 : left.shardKey > right.shardKey ? 1 : 0
    );

    expect(verified).toEqual({
      universeId: UNIVERSE_ID,
      configurationVersionId: CONFIGURATION_VERSION_ID,
      sourceGenerationId: SOURCE_GENERATION_ID,
      sourceDigest: hashBackstageNotionPartitionSourceGeneration({
        universeId: UNIVERSE_ID,
        members: sortedMembers,
      }),
      sourcePageCount: 2,
      sourceChunkCount: 2,
      sourceVerifiedAt: VERIFIED_AT,
      sourceVerificationHash: hashBackstageNotionPartitionSourceVerification({
        universeId: UNIVERSE_ID,
        sourceGenerationId: SOURCE_GENERATION_ID,
        members: sortedMembers,
      }),
    });
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_partition_source_generations'
    ))).toBe(true);
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(true);
  });

  test('rejects changed terminal shard evidence before persisting a source generation', async () => {
    const harness = createSourceGenerationHarness({ driftHash: 'a'.repeat(64) });
    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .verifySourceGeneration(sourceGenerationInput())).rejects.toMatchObject({
        code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
      });
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_partition_source_generations'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('publishes only a complete fresh configured shard set after leases are released', async () => {
    const harness = createManifestHarness();
    const activated = await new PostgresBackstageNotionPartitionRepository(harness.pool)
      .activateUniverseManifest(manifestInput());

    expect(activated).toEqual({
      manifestId: MANIFEST_ID,
      universeId: UNIVERSE_ID,
      configurationVersionId: CONFIGURATION_VERSION_ID,
      memberCount: 2,
      omissionCount: 0,
      omissions: [],
      pageCount: 2,
      chunkCount: 2,
      headGeneration: '5',
      manifestGeneration: '3',
    });
    const manifestInsert = harness.queries.find(query =>
      query.sql.startsWith('INSERT INTO public.backstage_notion_universe_manifests')
    );
    expect(manifestInsert?.values[0]).toBe(MANIFEST_ID);
    expect(manifestInsert?.values.slice(11, 14)).toEqual([
      'text-embedding-test',
      1,
      2,
    ]);
    const headActivation = harness.queries.find(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ));
    expect(headActivation?.sql).toContain(
      'published_reconciliation_generation = $13::BIGINT'
    );
    expect(headActivation?.sql).toContain(
      'reconciliation_generation = $13::BIGINT'
    );
    expect(headActivation?.values[12]).toBe(RECONCILIATION_GENERATION);
    expect(harness.queries.some(query =>
      query.sql.includes('backstage_notion_shard_sync_leases')
    )).toBe(false);
    expect(harness.queries.some(query =>
      query.sql.includes('JOIN public.backstage_notion_partition_versions AS definition')
      && query.sql.includes(
        'FROM public.backstage_notion_partition_configuration_members AS member'
      )
    )).toBe(true);
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_universe_manifest_omissions'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(true);
  });

  test('rejects a stale registration epoch before constructing a manifest', async () => {
    const harness = createManifestHarness({ reconciliationGeneration: '8' });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .activateUniverseManifest(manifestInput())).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_STALE_CONFIGURATION',
    });
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_universe_manifests'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('rolls back a manifest when an overlapping epoch wins the activation CAS', async () => {
    const harness = createManifestHarness({ activationRows: [] });

    await expect(new PostgresBackstageNotionPartitionRepository(harness.pool)
      .activateUniverseManifest(manifestInput())).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
    });
    const headActivation = harness.queries.find(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ));
    expect(headActivation?.values[12]).toBe(RECONCILIATION_GENERATION);
    expect(harness.queries.some(query => query.sql === 'COMMIT')).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('rejects fabricated source barrier evidence before manifest publication', async () => {
    const harness = createManifestHarness({ sourceGenerationEvidencePresent: false });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.activateUniverseManifest({
      ...manifestInput(),
      sourceVerificationHash: 'f'.repeat(64),
      sourceVerifiedAt: new Date('2026-08-24T12:02:01.000Z'),
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
    });
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_universe_manifests'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('rejects mixed source generations before manifest publication', async () => {
    const harness = createManifestHarness({
      snapshotSourceGenerationId: 'abababab-abab-4aba-8bab-abababababab',
    });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.activateUniverseManifest(
      manifestInput()
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_STALE_HEAD',
    });
    expect(harness.queries.some(query =>
      query.sql.includes('FROM public.backstage_notion_partition_source_generations')
    )).toBe(false);
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_universe_manifests'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('blocks optional-to-required ownership overlap without moving the head', async () => {
    const harness = createManifestHarness({
      optionalMember: true,
      ownershipConflicts: [{
        left_shard_key: OPTIONAL_SHARD_KEY,
        right_shard_key: SHARD_KEY,
      }],
    });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.activateUniverseManifest(
      manifestInputWithOptionalMember()
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT',
    });
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_universe_manifests'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('blocks a required-to-required ownership overlap without moving the head', async () => {
    const harness = createManifestHarness({
      optionalMember: true,
      optionalRequired: true,
      ownershipConflicts: [{
        left_shard_key: OPTIONAL_SHARD_KEY,
        right_shard_key: SHARD_KEY,
      }],
    });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.activateUniverseManifest(
      manifestInputWithOptionalMember()
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT',
    });
    expect(harness.queries.some(query => query.sql.startsWith(
      'INSERT INTO public.backstage_notion_universe_manifests'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('blocks optional-to-optional ownership ambiguity', async () => {
    const harness = createManifestHarness({
      optionalMember: true,
      secondOptionalMember: true,
      ownershipConflicts: [{
        left_shard_key: OPTIONAL_SHARD_KEY,
        right_shard_key: SECOND_OPTIONAL_SHARD_KEY,
      }],
    });
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.activateUniverseManifest(
      manifestInputWithTwoOptionalMembers()
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT',
    });
    expect(harness.queries.some(query => query.sql.startsWith(
      'UPDATE public.backstage_notion_partitioned_universe_heads'
    ))).toBe(false);
    expect(harness.queries.some(query => query.sql === 'ROLLBACK')).toBe(true);
  });

  test('maps only the manifest page-ownership unique constraint', async () => {
    const namedOwnershipViolation = Object.assign(new Error('duplicate owner'), {
      code: '23505',
      constraint: 'backstage_notion_manifest_page_ownership_pkey',
    });
    await expect(new PostgresBackstageNotionPartitionRepository(
      createManifestHarness({ ownershipError: namedOwnershipViolation }).pool
    ).activateUniverseManifest(manifestInput())).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT',
    });

    const unrelatedViolation = Object.assign(new Error('unrelated duplicate'), {
      code: '23505',
      constraint: 'unrelated_unique_constraint',
    });
    await expect(new PostgresBackstageNotionPartitionRepository(
      createManifestHarness({ ownershipError: unrelatedViolation }).pool
    ).activateUniverseManifest(manifestInput())).rejects.toBe(unrelatedViolation);
  });
});
