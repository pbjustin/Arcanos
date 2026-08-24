import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { Client, type Pool, type PoolClient } from 'pg';

import { BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS } from '../../src/core/db/backstageNotionPartitionStorageSchema.js';
import { PostgresBackstageNotionPartitionRepository } from '../../src/core/db/repositories/backstageNotionPartitionRepository.js';
import { syncBackstageNotionPartitionConfiguration } from '../../src/services/backstageNotionPartitionSync.js';
import { parseBackstageNotionPartitionConfiguration } from '../../src/shared/backstage/backstageNotionPartitionCore.js';
import { inspectBackstageNotionRagPage } from '../../src/shared/backstage/backstageNotionRagCore.js';
import { normalizeBackstageNotionScopeKey } from '../../src/shared/backstage/backstageNotionScopeIndex.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl,
} from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_NOTION_PARTITION_PG18_TEST_DATABASE_URL';
const configuredConnectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredConnectionString) {
  assertDisposablePostgresTestDatabaseUrl(
    configuredConnectionString,
    TEST_DATABASE_ENV
  );
}

const forwardMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260824_backstage_notion_partition_storage_v1.sql'
  ),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260824_backstage_notion_partition_storage_v1.rollback.sql'
  ),
  'utf8'
);
const runtimeSql = BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS.join('\n');

const partitionTables = [
  'backstage_notion_partition_configuration_versions',
  'backstage_notion_partition_identities',
  'backstage_notion_partition_versions',
  'backstage_notion_partition_configuration_members',
  'backstage_notion_chunk_versions',
  'backstage_notion_chunk_embeddings',
  'backstage_notion_page_versions',
  'backstage_notion_page_version_chunks',
  'backstage_notion_shard_snapshots',
  'backstage_notion_shard_snapshot_pages',
  'backstage_notion_shard_snapshot_chunk_occurrences',
  'backstage_notion_shard_snapshot_verifications',
  'backstage_notion_shard_heads',
  'backstage_notion_shard_sync_leases',
  'backstage_notion_provider_coordinator_leases',
  'backstage_notion_universe_manifests',
  'backstage_notion_universe_manifest_shards',
  'backstage_notion_universe_manifest_omissions',
  'backstage_notion_manifest_page_ownership',
  'backstage_notion_partitioned_universe_heads',
] as const;

const describeWithDatabase = configuredConnectionString ? describe : describe.skip;

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function scopeKey(value: string): string {
  return normalizeBackstageNotionScopeKey(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Run the repository's bounded transactions on the suite's single connection
 * without allowing an inner COMMIT to escape the test-level rollback.
 */
function createSavepointRepositoryPool(client: Client): Pool {
  let sequence = 0;
  let activeSavepoint: string | null = null;
  const query = async (
    text: string,
    values: readonly unknown[] = []
  ): Promise<Awaited<ReturnType<Client['query']>>> => {
    const transactionCommand = text.trim().toUpperCase();
    if (transactionCommand === 'BEGIN') {
      if (activeSavepoint !== null) {
        throw new Error('Repository transaction nesting is unsupported in this test adapter.');
      }
      activeSavepoint = `partition_repository_${sequence += 1}`;
      return client.query(`SAVEPOINT ${activeSavepoint}`);
    }
    if (transactionCommand === 'COMMIT') {
      if (activeSavepoint === null) {
        throw new Error('Repository COMMIT has no active test savepoint.');
      }
      const savepoint = activeSavepoint;
      activeSavepoint = null;
      return client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
    if (transactionCommand === 'ROLLBACK') {
      if (activeSavepoint === null) {
        throw new Error('Repository ROLLBACK has no active test savepoint.');
      }
      const savepoint = activeSavepoint;
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      activeSavepoint = null;
      return client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
    return client.query(text, [...values]);
  };
  const repositoryClient = {
    query,
    release: (): void => undefined,
  } as unknown as PoolClient;
  return {
    query,
    connect: async (): Promise<PoolClient> => repositoryClient,
  } as unknown as Pool;
}

async function expectSqlStateAtSavepoint(
  client: Client,
  label: string,
  expectedCode: string,
  action: () => Promise<unknown>
): Promise<void> {
  const savepoint = `partition_${label.replace(/[^a-z0-9_]/gu, '_')}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught: unknown;
  try {
    await action();
  } catch (error: unknown) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  expect(errorCode(caught)).toBe(expectedCode);
}

type SealedFixture = Readonly<{
  universeId: string;
  configurationId: string;
  configurationGeneration: string;
  configurationHash: string;
  shardKey: string;
  rootPageId: string;
  partitionVersionId: string;
  chunkVersionId: string;
  pageVersionId: string;
  snapshotId: string;
  manifestId: string;
  verifiedAt: string;
}>;

type OptionalFixturePartition = Readonly<{
  shardKey: string;
  partitionVersionId: string;
  rootPageId: string;
  semanticHash: string;
}>;

async function insertSealedFixture(
  client: Client,
  label: string,
  optionalPartition?: OptionalFixturePartition
): Promise<SealedFixture> {
  const universeId = `partition-pg18-${label}`;
  const configurationId = randomUUID();
  const configurationGeneration = `generation-${label}`;
  const configurationHash = fingerprint(`configuration:${label}`);
  const shardKey = `hot/${label}`;
  const rootPageId = randomUUID();
  const partitionVersionId = randomUUID();
  const chunkVersionId = randomUUID();
  const pageVersionId = randomUUID();
  const snapshotId = randomUUID();
  const manifestId = randomUUID();
  const sourceEditedAt = '2026-08-24T12:00:00.000Z';
  const driftVerifiedAt = '2026-08-24T12:01:00.000Z';
  const verifiedAt = '2026-08-24T12:02:00.000Z';

  await client.query(
    `INSERT INTO public.backstage_notion_universe_heads (universe_id)
     VALUES ($1)`,
    [universeId]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_partition_configuration_versions (
       id,
       universe_id,
       configuration_generation,
       configuration_hash,
       shard_count
     ) VALUES ($1::UUID, $2, $3, $4, $5)`,
    [
      configurationId,
      universeId,
      configurationGeneration,
      configurationHash,
      optionalPartition ? 2 : 1,
    ]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_partition_identities (
       universe_id,
       shard_key
     ) VALUES ($1, $2)`,
    [universeId, shardKey]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_partition_versions (
       id,
       universe_id,
       shard_key,
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
     ) VALUES (
       $1::UUID,
       $2,
       $3,
       $4::UUID,
       'Current Canon',
       'hot',
       TRUE,
       '["current"]'::JSONB,
       '["canon"]'::JSONB,
       8,
       16,
       4,
       10000,
       $5
     )`,
    [
      partitionVersionId,
      universeId,
      shardKey,
      rootPageId,
      fingerprint(`partition:${label}`),
    ]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_partition_configuration_members (
       universe_id,
       partition_configuration_version_id,
       configuration_generation,
       shard_key,
       partition_version_id,
       root_page_id
     ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID)`,
    [
      universeId,
      configurationId,
      configurationGeneration,
      shardKey,
      partitionVersionId,
      rootPageId,
    ]
  );
  if (optionalPartition) {
    await client.query(
      `INSERT INTO public.backstage_notion_partition_identities (
         universe_id,
         shard_key
       ) VALUES ($1, $2)`,
      [universeId, optionalPartition.shardKey]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_versions (
         id,
         universe_id,
         shard_key,
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
       ) VALUES (
         $1::UUID, $2, $3, $4::UUID,
         'Archive Lane', 'archive', FALSE,
         '["archive"]'::JSONB, '["historical"]'::JSONB,
         8, 16, 4, 10000, $5
       )`,
      [
        optionalPartition.partitionVersionId,
        universeId,
        optionalPartition.shardKey,
        optionalPartition.rootPageId,
        optionalPartition.semanticHash,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_members (
         universe_id,
         partition_configuration_version_id,
         configuration_generation,
         shard_key,
         partition_version_id,
         root_page_id
       ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID)`,
      [
        universeId,
        configurationId,
        configurationGeneration,
        optionalPartition.shardKey,
        optionalPartition.partitionVersionId,
        optionalPartition.rootPageId,
      ]
    );
  }

  await client.query(
    `UPDATE public.backstage_notion_partition_configuration_versions
     SET state = 'sealed', sealed_at = clock_timestamp()
     WHERE universe_id = $1 AND id = $2::UUID`,
    [universeId, configurationId]
  );

  await client.query(
    `INSERT INTO public.backstage_notion_chunk_versions (
       id,
       universe_id,
       content_hash,
       chunker_version,
       content,
       content_code_points
     ) VALUES ($1::UUID, $2, $3, 1, 'canon', 5)`,
    [chunkVersionId, universeId, fingerprint(`chunk:${label}`)]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_chunk_embeddings (
       universe_id,
       chunk_version_id,
       embedding_model,
       embedding_version,
       embedding_dimension,
       embedding_norm,
       embedding
     ) VALUES ($1, $2::UUID, 'pg18-test-model', 1, 2, 5, ARRAY[3, 4]::DOUBLE PRECISION[])`,
    [universeId, chunkVersionId]
  );
  await client.query(
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
     ) VALUES ($1::UUID, $2, $3::UUID, $4, 1, 1, 'canon', 5, 1)`,
    [pageVersionId, universeId, rootPageId, fingerprint(`page:${label}`)]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_page_version_chunks (
       universe_id,
       page_version_id,
       ordinal,
       chunk_version_id,
       heading_path,
       scope_heading_path_key,
       heading_occurrence_path
     ) VALUES (
       $1,
       $2::UUID,
       0,
       $3::UUID,
       '["Canon"]'::JSONB,
       $4::JSONB,
       '[0]'::JSONB
     )`,
    [
      universeId,
      pageVersionId,
      chunkVersionId,
      JSON.stringify([scopeKey('Canon')]),
    ]
  );
  await client.query(
    `UPDATE public.backstage_notion_page_versions
     SET state = 'sealed', sealed_at = clock_timestamp()
     WHERE universe_id = $1 AND id = $2::UUID`,
    [universeId, pageVersionId]
  );

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
       $1::UUID,
       $2,
       $3,
       $4::UUID,
       $5::UUID,
       $6,
       'pg18-test-model',
       1,
       2,
       1,
       1,
       1,
       5,
       0,
       $7::TIMESTAMPTZ,
       2
     )`,
    [
      snapshotId,
      universeId,
      shardKey,
      partitionVersionId,
      rootPageId,
      fingerprint(`snapshot:${label}`),
      sourceEditedAt,
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
     ) VALUES (
       $1,
       $2,
       $3::UUID,
       $4::UUID,
       $5::UUID,
       NULL,
       'Canon Root',
       'https://www.notion.so/canon-root',
       $6::TIMESTAMPTZ,
       0,
       $7::JSONB,
       $8::JSONB,
       $9,
       $10::JSONB
     )`,
    [
      universeId,
      shardKey,
      snapshotId,
      rootPageId,
      pageVersionId,
      sourceEditedAt,
      JSON.stringify([rootPageId]),
      JSON.stringify(['Canon Root']),
      scopeKey('Canon Root'),
      JSON.stringify([scopeKey('Canon Root')]),
    ]
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
     ) VALUES (
       $1,
       $2,
       $3::UUID,
       $4::UUID,
       $5::UUID,
       0,
       $6::UUID,
       'pg18-test-model',
       1,
       'general'
     )`,
    [
      universeId,
      shardKey,
      snapshotId,
      rootPageId,
      pageVersionId,
      chunkVersionId,
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
     ) VALUES
       ($1, $2, $3::UUID, 0, 'source_drift', $4, $5::TIMESTAMPTZ),
       ($1, $2, $3::UUID, 1, 'completeness', $6, $7::TIMESTAMPTZ)`,
    [
      universeId,
      shardKey,
      snapshotId,
      fingerprint(`drift:${label}`),
      driftVerifiedAt,
      fingerprint(`complete:${label}`),
      verifiedAt,
    ]
  );

  await expectSqlStateAtSavepoint(client, `${label}_building_snapshot_head`, '23514', () =>
    client.query(
      `INSERT INTO public.backstage_notion_shard_heads (
         universe_id,
         shard_key,
         current_partition_version_id,
         root_page_id,
         active_snapshot_id,
         head_generation,
         snapshot_generation
       ) VALUES ($1, $2, $3::UUID, $4::UUID, $5::UUID, 1, 1)`,
      [universeId, shardKey, partitionVersionId, rootPageId, snapshotId]
    )
  );

  await client.query(
    `UPDATE public.backstage_notion_shard_snapshots
     SET state = 'sealed', sealed_at = clock_timestamp()
     WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
    [universeId, shardKey, snapshotId]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_shard_heads (
       universe_id,
       shard_key,
       current_partition_version_id,
       root_page_id,
       active_snapshot_id,
       head_generation,
       snapshot_generation,
       last_verified_at
     ) VALUES ($1, $2, $3::UUID, $4::UUID, $5::UUID, 1, 1, $6::TIMESTAMPTZ)`,
    [
      universeId,
      shardKey,
      partitionVersionId,
      rootPageId,
      snapshotId,
      verifiedAt,
    ]
  );

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
       $1::UUID, $2, $3::UUID, $4, $5, 'pg18-test-model', 1, 2, 1, 1, $6, 1, 1
     )`,
    [
      manifestId,
      universeId,
      configurationId,
      configurationGeneration,
      configurationHash,
      optionalPartition ? 1 : 0,
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
     ) VALUES (
       $1,
       $2::UUID,
       $3,
       $4::UUID,
       $5::UUID,
       'fresh',
       TRUE,
       $6::TIMESTAMPTZ
     )`,
    [
      universeId,
      manifestId,
      shardKey,
      partitionVersionId,
      snapshotId,
      verifiedAt,
    ]
  );
  if (optionalPartition) {
    await client.query(
      `INSERT INTO public.backstage_notion_universe_manifest_omissions (
         universe_id,
         manifest_id,
         shard_key,
         partition_version_id,
         decision,
         safe_reason_code
       ) VALUES (
         $1, $2::UUID, $3, $4::UUID,
         'optional_unavailable', 'ARCHIVE_NOT_SYNCHRONIZED'
       )`,
      [
        universeId,
        manifestId,
        optionalPartition.shardKey,
        optionalPartition.partitionVersionId,
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
     ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::UUID)`,
    [universeId, manifestId, rootPageId, shardKey, snapshotId]
  );
  await expectSqlStateAtSavepoint(client, `${label}_building_duplicate_owner`, '23505', () =>
    client.query(
      `INSERT INTO public.backstage_notion_manifest_page_ownership (
         universe_id,
         manifest_id,
         page_id,
         shard_key,
         shard_snapshot_id
       ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::UUID)`,
      [universeId, manifestId, rootPageId, shardKey, snapshotId]
    )
  );

  await expectSqlStateAtSavepoint(client, `${label}_building_manifest_head`, '23514', () =>
    client.query(
      `INSERT INTO public.backstage_notion_partitioned_universe_heads (
         universe_id,
         desired_configuration_version_id,
         desired_configuration_generation,
         desired_configuration_hash,
         active_manifest_id,
         active_configuration_version_id,
         head_generation,
         manifest_generation
       ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $2::UUID, 1, 1)`,
      [
        universeId,
        configurationId,
        configurationGeneration,
        configurationHash,
        manifestId,
      ]
    )
  );

  await client.query(
    `UPDATE public.backstage_notion_universe_manifests
     SET state = 'sealed', sealed_at = clock_timestamp()
     WHERE universe_id = $1 AND id = $2::UUID`,
    [universeId, manifestId]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_partitioned_universe_heads (
       universe_id,
       desired_configuration_version_id,
       desired_configuration_generation,
       desired_configuration_hash,
       active_manifest_id,
       active_configuration_version_id,
       head_generation,
       manifest_generation,
       last_verified_at
     ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $2::UUID, 1, 1, $6::TIMESTAMPTZ)`,
    [
      universeId,
      configurationId,
      configurationGeneration,
      configurationHash,
      manifestId,
      verifiedAt,
    ]
  );

  return {
    universeId,
    configurationId,
    configurationGeneration,
    configurationHash,
    shardKey,
    rootPageId,
    partitionVersionId,
    chunkVersionId,
    pageVersionId,
    snapshotId,
    manifestId,
    verifiedAt,
  };
}

type ScopeHierarchyFixture = Readonly<{
  manifestId: string;
  snapshotId: string;
  contentPageId: string;
  blankPageId: string;
  secondBlankPageId: string;
}>;

async function activateScopeHierarchyFixture(
  client: Client,
  fixture: SealedFixture
): Promise<ScopeHierarchyFixture> {
  const repository = new PostgresBackstageNotionPartitionRepository(
    createSavepointRepositoryPool(client)
  );
  const contentPageId = randomUUID();
  const blankPageId = randomUUID();
  const secondBlankPageId = randomUUID();
  const rootMaterial = await repository.storePageVersion({
    universeId: fixture.universeId,
    pageId: fixture.rootPageId,
    contentHash: fingerprint(''),
    pageFormatVersion: 1,
    chunkerVersion: 1,
    markdown: '',
    contentCodePoints: 0,
    chunks: [],
  });
  const contentMaterial = await repository.storePageVersion({
    universeId: fixture.universeId,
    pageId: contentPageId,
    contentHash: fingerprint('canon'),
    pageFormatVersion: 1,
    chunkerVersion: 1,
    markdown: 'canon',
    contentCodePoints: 5,
    chunks: [{
      ordinal: 0,
      chunkVersionId: fixture.chunkVersionId,
      headingPath: ['Canon'],
      scopeHeadingPathKey: [scopeKey('Canon')],
      headingOccurrencePath: [0],
    }],
  });
  const blankMaterial = await repository.storePageVersion({
    universeId: fixture.universeId,
    pageId: blankPageId,
    contentHash: fingerprint(''),
    pageFormatVersion: 1,
    chunkerVersion: 1,
    markdown: '',
    contentCodePoints: 0,
    chunks: [],
  });
  const secondBlankMaterial = await repository.storePageVersion({
    universeId: fixture.universeId,
    pageId: secondBlankPageId,
    contentHash: fingerprint(''),
    pageFormatVersion: 1,
    chunkerVersion: 1,
    markdown: '',
    contentCodePoints: 0,
    chunks: [],
  });
  const synchronizationState = await repository.loadUniverseSynchronizationState(
    fixture.universeId,
    fixture.configurationId
  );
  if (!synchronizationState?.shards[0]) {
    throw new Error('Scope hierarchy fixture requires one active shard.');
  }
  const lease = await repository.acquireShardLease(
    fixture.universeId,
    fixture.shardKey,
    'pg18-scope-hierarchy',
    60_000
  );
  if (!lease) {
    throw new Error('Scope hierarchy fixture could not acquire its shard lease.');
  }
  const snapshotId = randomUUID();
  const sourceEditedAt = new Date(Date.now() - 60_000);
  const verifiedAt = new Date();
  const activated = await repository.activateShardSnapshot({
    snapshotId,
    universeId: fixture.universeId,
    shardKey: fixture.shardKey,
    partitionVersionId: fixture.partitionVersionId,
    rootPageId: fixture.rootPageId,
    sourceManifestHash: fingerprint('scope-hierarchy-source'),
    embeddingModel: 'pg18-test-model',
    embeddingVersion: 1,
    indexFormatVersion: 1,
    sourceMaxLastEditedAt: sourceEditedAt,
    expectedHead: synchronizationState.shards[0].expectedHead,
    lease,
    pages: [{
      pageId: fixture.rootPageId,
      pageVersionId: rootMaterial.id,
      parentPageId: null,
      title: 'Navigation Root',
      canonicalUrl: `https://www.notion.so/${fixture.rootPageId.replaceAll('-', '')}`,
      sourceLastEditedAt: sourceEditedAt,
      depth: 0,
      path: [fixture.rootPageId],
      scopePath: ['Navigation Root'],
      scopeTitleKey: scopeKey('Navigation Root'),
      scopePathKey: [scopeKey('Navigation Root')],
    }, {
      pageId: contentPageId,
      pageVersionId: contentMaterial.id,
      parentPageId: fixture.rootPageId,
      title: 'Content Child',
      canonicalUrl: `https://www.notion.so/${contentPageId.replaceAll('-', '')}`,
      sourceLastEditedAt: sourceEditedAt,
      depth: 1,
      path: [fixture.rootPageId, contentPageId],
      scopePath: ['Navigation Root', 'Content Child'],
      scopeTitleKey: scopeKey('Content Child'),
      scopePathKey: [scopeKey('Navigation Root'), scopeKey('Content Child')],
    }, {
      pageId: blankPageId,
      pageVersionId: blankMaterial.id,
      parentPageId: fixture.rootPageId,
      title: 'Blank Child',
      canonicalUrl: `https://www.notion.so/${blankPageId.replaceAll('-', '')}`,
      sourceLastEditedAt: sourceEditedAt,
      depth: 1,
      path: [fixture.rootPageId, blankPageId],
      scopePath: ['Navigation Root', 'Blank Child'],
      scopeTitleKey: scopeKey('Blank Child'),
      scopePathKey: [scopeKey('Navigation Root'), scopeKey('Blank Child')],
    }, {
      pageId: secondBlankPageId,
      pageVersionId: secondBlankMaterial.id,
      parentPageId: contentPageId,
      title: 'Blank Child',
      canonicalUrl: `https://www.notion.so/${secondBlankPageId.replaceAll('-', '')}`,
      sourceLastEditedAt: sourceEditedAt,
      depth: 2,
      path: [fixture.rootPageId, contentPageId, secondBlankPageId],
      scopePath: ['Navigation Root', 'Content Child', 'Blank Child'],
      scopeTitleKey: scopeKey('Blank Child'),
      scopePathKey: [
        scopeKey('Navigation Root'),
        scopeKey('Content Child'),
        scopeKey('Blank Child'),
      ],
    }],
    occurrences: [{
      pageId: contentPageId,
      pageVersionId: contentMaterial.id,
      ordinal: 0,
      chunkVersionId: fixture.chunkVersionId,
      category: 'general',
    }],
    verifications: [{
      kind: 'source_drift',
      resultHash: fingerprint('scope-hierarchy-drift'),
      verifiedAt,
    }, {
      kind: 'completeness',
      resultHash: fingerprint('scope-hierarchy-complete'),
      verifiedAt,
    }],
  });
  const terminal = await repository.loadUniverseSynchronizationState(
    fixture.universeId,
    fixture.configurationId
  );
  if (!terminal?.shards[0]) {
    throw new Error('Scope hierarchy fixture lost its activated shard.');
  }
  const manifestId = randomUUID();
  await repository.activateUniverseManifest({
    manifestId,
    universeId: fixture.universeId,
    configurationVersionId: fixture.configurationId,
    configurationGeneration: fixture.configurationGeneration,
    configurationHash: fixture.configurationHash,
    indexFormatVersion: 1,
    expectedUniverseHead: terminal.expectedUniverseHead,
    members: [{
      shardKey: fixture.shardKey,
      partitionVersionId: fixture.partitionVersionId,
      snapshotId: activated.snapshotId,
      decision: 'fresh',
      verifiedAt: activated.verifiedAt,
      expectedHead: terminal.shards[0].expectedHead,
    }],
    omissions: [],
  });
  await repository.releaseShardLease(
    fixture.universeId,
    fixture.shardKey,
    lease
  );
  return Object.freeze({
    manifestId,
    snapshotId,
    contentPageId,
    blankPageId,
    secondBlankPageId,
  });
}

async function insertOptionalOverlapSnapshot(
  client: Client,
  fixture: SealedFixture,
  optionalPartition: OptionalFixturePartition
): Promise<string> {
  const snapshotId = randomUUID();
  const rootPageVersionId = randomUUID();
  const sourceEditedAt = '2026-08-24T12:00:00.000Z';
  const driftVerifiedAt = '2026-08-24T12:01:00.000Z';

  await client.query(
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
     ) VALUES ($1::UUID, $2, $3::UUID, $4, 1, 1, 'archive', 7, 1)`,
    [
      rootPageVersionId,
      fixture.universeId,
      optionalPartition.rootPageId,
      fingerprint('page:optional-overlap-root'),
    ]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_page_version_chunks (
       universe_id,
       page_version_id,
       ordinal,
       chunk_version_id,
       heading_path,
       scope_heading_path_key,
       heading_occurrence_path
     ) VALUES (
       $1, $2::UUID, 0, $3::UUID,
       '["Archive Lane"]'::JSONB, $4::JSONB, '[0]'::JSONB
     )`,
    [
      fixture.universeId,
      rootPageVersionId,
      fixture.chunkVersionId,
      JSON.stringify([scopeKey('Archive Lane')]),
    ]
  );
  await client.query(
    `UPDATE public.backstage_notion_page_versions
     SET state = 'sealed', sealed_at = clock_timestamp()
     WHERE universe_id = $1 AND id = $2::UUID`,
    [fixture.universeId, rootPageVersionId]
  );
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
       $1::UUID, $2, $3, $4::UUID, $5::UUID, $6,
       'pg18-test-model', 1, 2, 1, 2, 2, 12, 1, $7::TIMESTAMPTZ, 2
     )`,
    [
      snapshotId,
      fixture.universeId,
      optionalPartition.shardKey,
      optionalPartition.partitionVersionId,
      optionalPartition.rootPageId,
      fingerprint('snapshot:optional-overlap'),
      sourceEditedAt,
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
     ) VALUES
       (
         $1, $2, $3::UUID, $4::UUID, $5::UUID, NULL,
         'Archive Lane', $6, $7::TIMESTAMPTZ, 0,
         $8::JSONB, '["Archive Lane"]'::JSONB, $9, $10::JSONB
       ),
       (
         $1, $2, $3::UUID, $11::UUID, $12::UUID, $4::UUID,
         'Shared Canon', $13, $7::TIMESTAMPTZ, 1,
         $14::JSONB, '["Archive Lane", "Shared Canon"]'::JSONB, $15, $16::JSONB
       )`,
    [
      fixture.universeId,
      optionalPartition.shardKey,
      snapshotId,
      optionalPartition.rootPageId,
      rootPageVersionId,
      `https://www.notion.so/${optionalPartition.rootPageId.replaceAll('-', '')}`,
      sourceEditedAt,
      JSON.stringify([optionalPartition.rootPageId]),
      scopeKey('Archive Lane'),
      JSON.stringify([scopeKey('Archive Lane')]),
      fixture.rootPageId,
      fixture.pageVersionId,
      `https://www.notion.so/${fixture.rootPageId.replaceAll('-', '')}`,
      JSON.stringify([optionalPartition.rootPageId, fixture.rootPageId]),
      scopeKey('Shared Canon'),
      JSON.stringify([scopeKey('Archive Lane'), scopeKey('Shared Canon')]),
    ]
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
     ) VALUES
       ($1, $2, $3::UUID, $4::UUID, $5::UUID, 0, $6::UUID,
        'pg18-test-model', 1, 'general'),
       ($1, $2, $3::UUID, $7::UUID, $8::UUID, 0, $6::UUID,
        'pg18-test-model', 1, 'general')`,
    [
      fixture.universeId,
      optionalPartition.shardKey,
      snapshotId,
      optionalPartition.rootPageId,
      rootPageVersionId,
      fixture.chunkVersionId,
      fixture.rootPageId,
      fixture.pageVersionId,
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
     ) VALUES
       ($1, $2, $3::UUID, 0, 'source_drift', $4, $5::TIMESTAMPTZ),
       ($1, $2, $3::UUID, 1, 'completeness', $6, $7::TIMESTAMPTZ)`,
    [
      fixture.universeId,
      optionalPartition.shardKey,
      snapshotId,
      fingerprint('drift:optional-overlap'),
      driftVerifiedAt,
      fingerprint('complete:optional-overlap'),
      fixture.verifiedAt,
    ]
  );
  await client.query(
    `UPDATE public.backstage_notion_shard_snapshots
     SET state = 'sealed', sealed_at = clock_timestamp()
     WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
    [fixture.universeId, optionalPartition.shardKey, snapshotId]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_shard_heads (
       universe_id,
       shard_key,
       current_partition_version_id,
       root_page_id,
       active_snapshot_id,
       head_generation,
       snapshot_generation,
       last_verified_at
     ) VALUES ($1, $2, $3::UUID, $4::UUID, $5::UUID, 1, 1, $6::TIMESTAMPTZ)`,
    [
      fixture.universeId,
      optionalPartition.shardKey,
      optionalPartition.partitionVersionId,
      optionalPartition.rootPageId,
      snapshotId,
      fixture.verifiedAt,
    ]
  );
  return snapshotId;
}

describeWithDatabase('Backstage Notion partition storage on PostgreSQL 18', () => {
  let client: Client;

  beforeAll(async () => {
    if (!configuredConnectionString) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
    }

    client = new Client({
      connectionString: configuredConnectionString,
      ssl: false,
      application_name: 'backstage-notion-partition-pg18',
    });
    await client.connect();
    await client.query('SET search_path TO public, pg_catalog');

    const target = await client.query<{
      current_database: string;
      server_version_num: string;
    }>(
      `SELECT
         current_database(),
         current_setting('server_version_num') AS server_version_num`
    );
    expect(target.rows[0]?.current_database).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(target.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);

    const preexisting = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [[...partitionTables, 'backstage_notion_universe_heads']]
    );
    if (preexisting.rows.length > 0) {
      throw new Error(
        `${TEST_DATABASE_ENV} must not contain pre-existing partition test tables: ${preexisting.rows
          .map(row => row.table_name)
          .join(', ')}`
      );
    }

    await client.query(
      `CREATE TABLE public.backstage_notion_universe_heads (
         universe_id TEXT PRIMARY KEY,
         authority TEXT NOT NULL DEFAULT 'notion'
       )`
    );
    await client.query(
      `CREATE FUNCTION public.backstage_notion_reject_immutable_mutation()
       RETURNS TRIGGER
       LANGUAGE plpgsql
       SET search_path = pg_catalog, public
       AS $legacy$
       BEGIN
         RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'legacy monolith evidence is immutable';
       END;
       $legacy$`
    );
    await client.query(forwardMigration);
    await client.query(forwardMigration);
    await client.query(runtimeSql);
  }, 60_000);

  afterEach(async () => {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A successful test may already have closed its transaction.
    }
  });

  afterAll(async () => {
    if (!client) {
      return;
    }
    try {
      await client.query('ROLLBACK');
      await client.query(rollbackMigration);
      await client.query('DROP TABLE IF EXISTS public.backstage_notion_universe_heads');
      await client.query(
        'DROP FUNCTION IF EXISTS public.backstage_notion_reject_immutable_mutation()'
      );
    } finally {
      await client.end();
    }
  }, 60_000);

  test('applies migration and runtime DDL repeatedly with exact array storage', async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [partitionTables]
    );
    expect(tables.rows.map(row => row.table_name)).toEqual(
      [...partitionTables].sort()
    );

    const embeddingType = await client.query<{ data_type: string }>(
      `SELECT pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.backstage_notion_chunk_embeddings'::REGCLASS
         AND attribute.attname = 'embedding'
         AND NOT attribute.attisdropped`
    );
    expect(embeddingType.rows).toEqual([{ data_type: 'double precision[]' }]);

    const lexicalIndex = await client.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'backstage_notion_chunk_versions'
         AND indexname = 'idx_backstage_notion_chunk_versions_lexical'`
    );
    expect(lexicalIndex.rows).toHaveLength(1);
    expect(lexicalIndex.rows[0]?.indexdef).toContain('USING gin');
    expect(lexicalIndex.rows[0]?.indexdef).toContain(
      "to_tsvector('simple'::regconfig, content)"
    );

    const triggers = await client.query<{ trigger_count: string }>(
      `SELECT pg_catalog.count(*)::TEXT AS trigger_count
       FROM pg_catalog.pg_trigger AS installed_trigger
       JOIN pg_catalog.pg_class AS relation ON relation.oid = installed_trigger.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = ANY($1::TEXT[])
         AND NOT installed_trigger.tgisinternal`,
      [partitionTables]
    );
    expect(Number(triggers.rows[0]?.trigger_count)).toBe(24);
  });

  test('database-validates embedding shape, finiteness, non-zero norm, and tolerance', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'embedding');

    const invalidCases = [
      `ARRAY[3, 4]::DOUBLE PRECISION[]`,
      `ARRAY[3, 4]::DOUBLE PRECISION[]`,
      `ARRAY[[3, 4]]::DOUBLE PRECISION[]`,
      `ARRAY['NaN'::DOUBLE PRECISION, 4]::DOUBLE PRECISION[]`,
      `ARRAY[0, 0]::DOUBLE PRECISION[]`,
    ] as const;
    const invalidNorms = [4, 5, 5, 5, 0] as const;
    const invalidDimensions = [2, 1, 2, 2, 2] as const;

    for (const [index, expression] of invalidCases.entries()) {
      await expectSqlStateAtSavepoint(
        client,
        `embedding_constraint_${index}`,
        '23514',
        () => client.query(
          `INSERT INTO public.backstage_notion_chunk_embeddings (
             universe_id,
             chunk_version_id,
             embedding_model,
             embedding_version,
             embedding_dimension,
             embedding_norm,
             embedding
           ) VALUES (
             $1,
             $2::UUID,
             $3,
             2,
             $4,
             $5,
             ${expression}
           )`,
          [
            fixture.universeId,
            fixture.chunkVersionId,
            `invalid-${index}`,
            invalidDimensions[index],
            invalidNorms[index],
          ]
        )
      );
    }
  });

  test('seals only exact rooted ancestor paths and exact occurrence dimensions', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'path-integrity');
    const childPageId = randomUUID();
    const childPageVersionId = randomUUID();
    const sourceEditedAt = '2026-08-24T12:30:00.000Z';
    const driftVerifiedAt = '2026-08-24T12:31:00.000Z';
    const verifiedAt = '2026-08-24T12:32:00.000Z';

    await client.query(
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
       ) VALUES ($1::UUID, $2, $3::UUID, $4, 1, 1, 'child', 5, 1)`,
      [
        childPageVersionId,
        fixture.universeId,
        childPageId,
        fingerprint('page:path-integrity-child'),
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_page_version_chunks (
         universe_id,
         page_version_id,
         ordinal,
         chunk_version_id,
         heading_path,
         scope_heading_path_key,
         heading_occurrence_path
       ) VALUES (
         $1,
         $2::UUID,
         0,
         $3::UUID,
         '["Child"]'::JSONB,
         $4::JSONB,
         '[0]'::JSONB
       )`,
      [
        fixture.universeId,
        childPageVersionId,
        fixture.chunkVersionId,
        JSON.stringify([scopeKey('Child')]),
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_page_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, childPageVersionId]
    );

    const insertCandidate = async (
      snapshotId: string,
      childPath: readonly string[],
      embeddingDimension: number,
      childScopePath: readonly string[] = ['Root', 'Child']
    ): Promise<void> => {
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
           $1::UUID, $2, $3, $4::UUID, $5::UUID, $6,
           'pg18-test-model', 1, $7, 1, 2, 2, 10, 1, $8::TIMESTAMPTZ, 2
         )`,
        [
          snapshotId,
          fixture.universeId,
          fixture.shardKey,
          fixture.partitionVersionId,
          fixture.rootPageId,
          fingerprint(`snapshot:path-integrity:${snapshotId}`),
          embeddingDimension,
          sourceEditedAt,
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
         ) VALUES
           (
             $1, $2, $3::UUID, $4::UUID, $5::UUID, NULL,
             'Root', 'https://www.notion.so/path-root', $6::TIMESTAMPTZ, 0, $7::JSONB,
             $11::JSONB, $12, $13::JSONB
           ),
           (
             $1, $2, $3::UUID, $8::UUID, $9::UUID, $4::UUID,
             'Child', 'https://www.notion.so/path-child', $6::TIMESTAMPTZ, 1, $10::JSONB,
             $14::JSONB, $15, $16::JSONB
           )`,
        [
          fixture.universeId,
          fixture.shardKey,
          snapshotId,
          fixture.rootPageId,
          fixture.pageVersionId,
          sourceEditedAt,
          JSON.stringify([fixture.rootPageId]),
          childPageId,
          childPageVersionId,
          JSON.stringify(childPath),
          JSON.stringify(['Root']),
          scopeKey('Root'),
          JSON.stringify([scopeKey('Root')]),
          JSON.stringify(childScopePath),
          scopeKey('Child'),
          JSON.stringify([scopeKey('Root'), scopeKey('Child')]),
        ]
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
         ) VALUES
           ($1, $2, $3::UUID, $4::UUID, $5::UUID, 0, $6::UUID, 'pg18-test-model', 1, 'general'),
           ($1, $2, $3::UUID, $7::UUID, $8::UUID, 0, $6::UUID, 'pg18-test-model', 1, 'general')`,
        [
          fixture.universeId,
          fixture.shardKey,
          snapshotId,
          fixture.rootPageId,
          fixture.pageVersionId,
          fixture.chunkVersionId,
          childPageId,
          childPageVersionId,
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
         ) VALUES
           ($1, $2, $3::UUID, 0, 'source_drift', $4, $5::TIMESTAMPTZ),
           ($1, $2, $3::UUID, 1, 'completeness', $6, $7::TIMESTAMPTZ)`,
        [
          fixture.universeId,
          fixture.shardKey,
          snapshotId,
          fingerprint(`drift:path-integrity:${snapshotId}`),
          driftVerifiedAt,
          fingerprint(`complete:path-integrity:${snapshotId}`),
          verifiedAt,
        ]
      );
      await client.query(
        `UPDATE public.backstage_notion_shard_snapshots
         SET state = 'sealed', sealed_at = clock_timestamp()
         WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
        [fixture.universeId, fixture.shardKey, snapshotId]
      );
    };

    await expectSqlStateAtSavepoint(
      client,
      'malformed_ancestor_path',
      '23514',
      () => insertCandidate(randomUUID(), [randomUUID(), childPageId], 2)
    );
    await expectSqlStateAtSavepoint(
      client,
      'mismatched_occurrence_dimension',
      '23514',
      () => insertCandidate(
        randomUUID(),
        [fixture.rootPageId, childPageId],
        3
      )
    );
    await expectSqlStateAtSavepoint(
      client,
      'malformed_scope_metadata',
      '23514',
      () => insertCandidate(
        randomUUID(),
        [fixture.rootPageId, childPageId],
        2,
        ['Root', 'Wrong Child']
      )
    );

    const validSnapshotId = randomUUID();
    await insertCandidate(
      validSnapshotId,
      [fixture.rootPageId, childPageId],
      2
    );
    const valid = await client.query<{ state: string }>(
      `SELECT state
       FROM public.backstage_notion_shard_snapshots
       WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
      [fixture.universeId, fixture.shardKey, validSnapshotId]
    );
    expect(valid.rows).toEqual([{ state: 'sealed' }]);
  });

  test('rejects shard-head publication when the durable Notion authority fence is inactive', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'authority-fence');
    const candidateSnapshotId = randomUUID();
    const sourceEditedAt = '2026-08-24T12:40:00.000Z';
    const driftVerifiedAt = '2026-08-24T12:41:00.000Z';
    const verifiedAt = '2026-08-24T12:42:00.000Z';
    await client.query(
      `UPDATE public.backstage_notion_universe_heads
       SET authority = 'postgres'
       WHERE universe_id = $1`,
      [fixture.universeId]
    );

    await expectSqlStateAtSavepoint(
      client,
      'inactive_notion_authority',
      '55000',
      async () => {
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
             $1::UUID, $2, $3, $4::UUID, $5::UUID, $6,
             'pg18-test-model', 1, 2, 1, 1, 1, 5, 0, $7::TIMESTAMPTZ, 2
           )`,
          [
            candidateSnapshotId,
            fixture.universeId,
            fixture.shardKey,
            fixture.partitionVersionId,
            fixture.rootPageId,
            fingerprint('snapshot:authority-fence-candidate'),
            sourceEditedAt,
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
           ) VALUES (
             $1, $2, $3::UUID, $4::UUID, $5::UUID, NULL,
             'Root', 'https://www.notion.so/authority-root',
             $6::TIMESTAMPTZ, 0, $7::JSONB,
             $8::JSONB, $9, $10::JSONB
           )`,
          [
            fixture.universeId,
            fixture.shardKey,
            candidateSnapshotId,
            fixture.rootPageId,
            fixture.pageVersionId,
            sourceEditedAt,
            JSON.stringify([fixture.rootPageId]),
            JSON.stringify(['Root']),
            scopeKey('Root'),
            JSON.stringify([scopeKey('Root')]),
          ]
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
           ) VALUES (
             $1, $2, $3::UUID, $4::UUID, $5::UUID, 0, $6::UUID,
             'pg18-test-model', 1, 'general'
           )`,
          [
            fixture.universeId,
            fixture.shardKey,
            candidateSnapshotId,
            fixture.rootPageId,
            fixture.pageVersionId,
            fixture.chunkVersionId,
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
           ) VALUES
             ($1, $2, $3::UUID, 0, 'source_drift', $4, $5::TIMESTAMPTZ),
             ($1, $2, $3::UUID, 1, 'completeness', $6, $7::TIMESTAMPTZ)`,
          [
            fixture.universeId,
            fixture.shardKey,
            candidateSnapshotId,
            fingerprint('drift:authority-fence-candidate'),
            driftVerifiedAt,
            fingerprint('complete:authority-fence-candidate'),
            verifiedAt,
          ]
        );
        await client.query(
          `UPDATE public.backstage_notion_shard_snapshots
           SET state = 'sealed', sealed_at = clock_timestamp()
           WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
          [fixture.universeId, fixture.shardKey, candidateSnapshotId]
        );
        await client.query(
          `UPDATE public.backstage_notion_shard_heads
           SET
             active_snapshot_id = $3::UUID,
             head_generation = head_generation + 1,
             snapshot_generation = snapshot_generation + 1,
             last_verified_at = $4::TIMESTAMPTZ
           WHERE universe_id = $1 AND shard_key = $2`,
          [
            fixture.universeId,
            fixture.shardKey,
            candidateSnapshotId,
            verifiedAt,
          ]
        );
      }
    );

    const preserved = await client.query<{
      active_snapshot_id: string;
      head_generation: string;
      snapshot_generation: string;
      candidate_count: string;
    }>(
      `SELECT
         head.active_snapshot_id::TEXT,
         head.head_generation::TEXT,
         head.snapshot_generation::TEXT,
         (
           SELECT pg_catalog.count(*)::TEXT
           FROM public.backstage_notion_shard_snapshots AS candidate
           WHERE candidate.universe_id = head.universe_id
             AND candidate.shard_key = head.shard_key
             AND candidate.id = $3::UUID
         ) AS candidate_count
       FROM public.backstage_notion_shard_heads AS head
       WHERE head.universe_id = $1 AND head.shard_key = $2`,
      [fixture.universeId, fixture.shardKey, candidateSnapshotId]
    );
    expect(preserved.rows).toEqual([{
      active_snapshot_id: fixture.snapshotId,
      head_generation: '1',
      snapshot_generation: '1',
      candidate_count: '0',
    }]);
  });

  test('seals immutable evidence, fences child mutations, and activates exact sealed heads', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'sealed');

    const incompatibleEmbeddingSpaces = [
      ['pg18-test-model-other', 1, 2, 1],
      ['pg18-test-model', 2, 2, 1],
      ['pg18-test-model', 1, 3, 1],
      ['pg18-test-model', 1, 2, 2],
    ] as const;
    for (const [index, [embeddingModel, embeddingVersion, embeddingDimension, indexFormatVersion]]
      of incompatibleEmbeddingSpaces.entries()) {
      await expectSqlStateAtSavepoint(
        client,
        `manifest_embedding_space_${index}`,
        '23514',
        async () => {
          const manifestId = randomUUID();
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
               $1::UUID, $2, $3::UUID, $4, $5, $6, $7, $8, $9, 1, 0, 1, 1
             )`,
            [
              manifestId,
              fixture.universeId,
              fixture.configurationId,
              fixture.configurationGeneration,
              fixture.configurationHash,
              embeddingModel,
              embeddingVersion,
              embeddingDimension,
              indexFormatVersion,
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
             ) VALUES (
               $1, $2::UUID, $3, $4::UUID, $5::UUID,
               'retained_last_known_good', TRUE, $6::TIMESTAMPTZ
             )`,
            [
              fixture.universeId,
              manifestId,
              fixture.shardKey,
              fixture.partitionVersionId,
              fixture.snapshotId,
              fixture.verifiedAt,
            ]
          );
          await client.query(
            `INSERT INTO public.backstage_notion_manifest_page_ownership (
               universe_id,
               manifest_id,
               page_id,
               shard_key,
               shard_snapshot_id
             ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::UUID)`,
            [
              fixture.universeId,
              manifestId,
              fixture.rootPageId,
              fixture.shardKey,
              fixture.snapshotId,
            ]
          );
          await client.query(
            `UPDATE public.backstage_notion_universe_manifests
             SET state = 'sealed', sealed_at = clock_timestamp()
             WHERE universe_id = $1 AND id = $2::UUID`,
            [fixture.universeId, manifestId]
          );
        }
      );
    }

    await expectSqlStateAtSavepoint(client, 'partition_after_config_seal', '55000', () =>
      client.query(
        `UPDATE public.backstage_notion_partition_versions
         SET display_name = 'Changed'
         WHERE universe_id = $1 AND id = $2::UUID`,
        [fixture.universeId, fixture.partitionVersionId]
      )
    );
    await expectSqlStateAtSavepoint(client, 'configuration_member_after_seal', '55000', () =>
      client.query(
        `UPDATE public.backstage_notion_partition_configuration_members
         SET partition_version_id = partition_version_id
         WHERE universe_id = $1
           AND partition_configuration_version_id = $2::UUID
           AND shard_key = $3`,
        [fixture.universeId, fixture.configurationId, fixture.shardKey]
      )
    );
    await expectSqlStateAtSavepoint(client, 'configuration_member_insert_after_seal', '55000', () =>
      client.query(
        `INSERT INTO public.backstage_notion_partition_configuration_members (
           universe_id,
           partition_configuration_version_id,
           configuration_generation,
           shard_key,
           partition_version_id,
           root_page_id
         ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID)`,
        [
          fixture.universeId,
          fixture.configurationId,
          fixture.configurationGeneration,
          fixture.shardKey,
          fixture.partitionVersionId,
          fixture.rootPageId,
        ]
      )
    );
    await expectSqlStateAtSavepoint(client, 'chunk_update', '55000', () =>
      client.query(
        `UPDATE public.backstage_notion_chunk_versions
         SET content = 'other', content_code_points = 5
         WHERE universe_id = $1 AND id = $2::UUID`,
        [fixture.universeId, fixture.chunkVersionId]
      )
    );
    await expectSqlStateAtSavepoint(client, 'page_child_after_seal', '55000', () =>
      client.query(
        `INSERT INTO public.backstage_notion_page_version_chunks (
           universe_id,
           page_version_id,
           ordinal,
           chunk_version_id
         ) VALUES ($1, $2::UUID, 1, $3::UUID)`,
        [fixture.universeId, fixture.pageVersionId, fixture.chunkVersionId]
      )
    );
    await expectSqlStateAtSavepoint(client, 'snapshot_child_after_seal', '55000', () =>
      client.query(
        `INSERT INTO public.backstage_notion_shard_snapshot_verifications (
           universe_id,
           shard_key,
           shard_snapshot_id,
           ordinal,
           verification_kind,
           result_hash,
           verified_at
         ) VALUES ($1, $2, $3::UUID, 2, 'capture', $4, clock_timestamp())`,
        [
          fixture.universeId,
          fixture.shardKey,
          fixture.snapshotId,
          fingerprint('late-verification'),
        ]
      )
    );
    await expectSqlStateAtSavepoint(client, 'manifest_child_update', '55000', () =>
      client.query(
        `UPDATE public.backstage_notion_universe_manifest_shards
         SET verified_at = verified_at
         WHERE universe_id = $1 AND manifest_id = $2::UUID`,
        [fixture.universeId, fixture.manifestId]
      )
    );
    await expectSqlStateAtSavepoint(client, 'late_duplicate_page_owner', '55000', () =>
      client.query(
        `INSERT INTO public.backstage_notion_manifest_page_ownership (
           universe_id,
           manifest_id,
           page_id,
           shard_key,
           shard_snapshot_id
         ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::UUID)`,
        [
          fixture.universeId,
          fixture.manifestId,
          fixture.rootPageId,
          fixture.shardKey,
          fixture.snapshotId,
        ]
      )
    );
    await expectSqlStateAtSavepoint(client, 'stale_shard_cas', '40001', () =>
      client.query(
        `UPDATE public.backstage_notion_shard_heads
         SET head_generation = head_generation + 1
         WHERE universe_id = $1 AND shard_key = $2`,
        [fixture.universeId, fixture.shardKey]
      )
    );

    const active = await client.query<{
      active_manifest_id: string;
      verified_at: string;
    }>(
      `SELECT
         head.active_manifest_id::TEXT,
         member.verified_at::TEXT
       FROM public.backstage_notion_partitioned_universe_heads AS head
       JOIN public.backstage_notion_universe_manifest_shards AS member
         ON member.universe_id = head.universe_id
        AND member.manifest_id = head.active_manifest_id
       WHERE head.universe_id = $1`,
      [fixture.universeId]
    );
    expect(active.rows[0]?.active_manifest_id).toBe(fixture.manifestId);
    expect(new Date(active.rows[0]?.verified_at ?? '').toISOString()).toBe(
      fixture.verifiedAt
    );
  });

  test('rotates an active shard atomically and reassigns roots without deleting LKG history', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'atomic-rotation');
    const configurationId = randomUUID();
    const configurationGeneration = 'generation-atomic-rotation-b';
    const configurationHash = fingerprint('configuration:atomic-rotation-b');
    const partitionVersionId = randomUUID();
    const rootPageId = randomUUID();
    const pageVersionId = randomUUID();
    const snapshotId = randomUUID();
    const sourceEditedAt = '2026-08-24T13:00:00.000Z';
    const driftVerifiedAt = '2026-08-24T13:01:00.000Z';
    const verifiedAt = '2026-08-24T13:02:00.000Z';

    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_versions (
         id, universe_id, configuration_generation, configuration_hash, shard_count
       ) VALUES ($1::UUID, $2, $3, $4, 1)`,
      [
        configurationId,
        fixture.universeId,
        configurationGeneration,
        configurationHash,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_versions (
         id,
         universe_id,
         shard_key,
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
       ) VALUES (
         $1::UUID, $2, $3, $4::UUID,
         'Rotated Canon', 'hot', TRUE,
         '["current"]'::JSONB, '["canon"]'::JSONB,
         8, 16, 4, 10000, $5
       )`,
      [
        partitionVersionId,
        fixture.universeId,
        fixture.shardKey,
        rootPageId,
        fingerprint('partition:atomic-rotation-b'),
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_members (
         universe_id,
         partition_configuration_version_id,
         configuration_generation,
         shard_key,
         partition_version_id,
         root_page_id
       ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID)`,
      [
        fixture.universeId,
        configurationId,
        configurationGeneration,
        fixture.shardKey,
        partitionVersionId,
        rootPageId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_partition_configuration_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, configurationId]
    );
    await client.query(
      `UPDATE public.backstage_notion_partitioned_universe_heads
       SET
         desired_configuration_version_id = $2::UUID,
         desired_configuration_generation = $3,
         desired_configuration_hash = $4,
         head_generation = head_generation + 1
       WHERE universe_id = $1`,
      [
        fixture.universeId,
        configurationId,
        configurationGeneration,
        configurationHash,
      ]
    );

    const beforeRotation = await client.query<{
      active_snapshot_id: string;
      active_manifest_id: string;
    }>(
      `SELECT
         shard_head.active_snapshot_id::TEXT,
         universe_head.active_manifest_id::TEXT
       FROM public.backstage_notion_shard_heads AS shard_head
       JOIN public.backstage_notion_partitioned_universe_heads AS universe_head
         ON universe_head.universe_id = shard_head.universe_id
       WHERE shard_head.universe_id = $1 AND shard_head.shard_key = $2`,
      [fixture.universeId, fixture.shardKey]
    );
    expect(beforeRotation.rows).toEqual([{
      active_snapshot_id: fixture.snapshotId,
      active_manifest_id: fixture.manifestId,
    }]);
    await expectSqlStateAtSavepoint(client, 'atomic_rotation_clear_lkg', '55000', () =>
      client.query(
        `UPDATE public.backstage_notion_shard_heads
         SET
           current_partition_version_id = $3::UUID,
           root_page_id = $4::UUID,
           active_snapshot_id = NULL,
           head_generation = head_generation + 1,
           snapshot_generation = snapshot_generation + 1
         WHERE universe_id = $1 AND shard_key = $2`,
        [fixture.universeId, fixture.shardKey, partitionVersionId, rootPageId]
      )
    );

    await client.query(
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
       ) VALUES ($1::UUID, $2, $3::UUID, $4, 1, 1, 'canon', 5, 1)`,
      [pageVersionId, fixture.universeId, rootPageId, fingerprint('page:atomic-rotation-b')]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_page_version_chunks (
         universe_id,
         page_version_id,
         ordinal,
         chunk_version_id,
         heading_path,
         scope_heading_path_key,
         heading_occurrence_path
       ) VALUES (
         $1, $2::UUID, 0, $3::UUID,
         '["Canon"]'::JSONB, $4::JSONB, '[0]'::JSONB
       )`,
      [
        fixture.universeId,
        pageVersionId,
        fixture.chunkVersionId,
        JSON.stringify([scopeKey('Canon')]),
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_page_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, pageVersionId]
    );
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
         $1::UUID, $2, $3, $4::UUID, $5::UUID, $6,
         'pg18-test-model', 1, 2, 1, 1, 1, 5, 0, $7::TIMESTAMPTZ, 2
       )`,
      [
        snapshotId,
        fixture.universeId,
        fixture.shardKey,
        partitionVersionId,
        rootPageId,
        fingerprint('snapshot:atomic-rotation-b'),
        sourceEditedAt,
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
       ) VALUES (
         $1, $2, $3::UUID, $4::UUID, $5::UUID, NULL,
         'Rotated Canon', 'https://www.notion.so/rotated-canon',
         $6::TIMESTAMPTZ, 0, $7::JSONB, '["Rotated Canon"]'::JSONB, $8, $9::JSONB
       )`,
      [
        fixture.universeId,
        fixture.shardKey,
        snapshotId,
        rootPageId,
        pageVersionId,
        sourceEditedAt,
        JSON.stringify([rootPageId]),
        scopeKey('Rotated Canon'),
        JSON.stringify([scopeKey('Rotated Canon')]),
      ]
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
       ) VALUES (
         $1, $2, $3::UUID, $4::UUID, $5::UUID, 0, $6::UUID,
         'pg18-test-model', 1, 'general'
       )`,
      [
        fixture.universeId,
        fixture.shardKey,
        snapshotId,
        rootPageId,
        pageVersionId,
        fixture.chunkVersionId,
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
       ) VALUES
         ($1, $2, $3::UUID, 0, 'source_drift', $4, $5::TIMESTAMPTZ),
         ($1, $2, $3::UUID, 1, 'completeness', $6, $7::TIMESTAMPTZ)`,
      [
        fixture.universeId,
        fixture.shardKey,
        snapshotId,
        fingerprint('drift:atomic-rotation-b'),
        driftVerifiedAt,
        fingerprint('complete:atomic-rotation-b'),
        verifiedAt,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_shard_snapshots
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
      [fixture.universeId, fixture.shardKey, snapshotId]
    );
    await client.query(
      `UPDATE public.backstage_notion_shard_heads
       SET
         current_partition_version_id = $3::UUID,
         root_page_id = $4::UUID,
         active_snapshot_id = $5::UUID,
         head_generation = head_generation + 1,
         snapshot_generation = snapshot_generation + 1,
         last_verified_at = $6::TIMESTAMPTZ
       WHERE universe_id = $1 AND shard_key = $2`,
      [
        fixture.universeId,
        fixture.shardKey,
        partitionVersionId,
        rootPageId,
        snapshotId,
        verifiedAt,
      ]
    );

    const reassignedShardKey = 'hot/atomic-rotation-reassigned';
    const reassignedPartitionVersionId = randomUUID();
    const reassignedConfigurationId = randomUUID();
    const reassignedGeneration = 'generation-atomic-rotation-c';
    const reassignedHash = fingerprint('configuration:atomic-rotation-c');
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_versions (
         id, universe_id, configuration_generation, configuration_hash, shard_count
       ) VALUES ($1::UUID, $2, $3, $4, 1)`,
      [
        reassignedConfigurationId,
        fixture.universeId,
        reassignedGeneration,
        reassignedHash,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_identities (universe_id, shard_key)
       VALUES ($1, $2)`,
      [fixture.universeId, reassignedShardKey]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_versions (
         id,
         universe_id,
         shard_key,
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
       ) VALUES (
         $1::UUID, $2, $3, $4::UUID,
         'Reassigned Canon', 'hot', TRUE,
         '["current"]'::JSONB, '["canon"]'::JSONB,
         8, 16, 4, 10000, $5
       )`,
      [
        reassignedPartitionVersionId,
        fixture.universeId,
        reassignedShardKey,
        rootPageId,
        fingerprint('partition:atomic-rotation-c'),
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_members (
         universe_id,
         partition_configuration_version_id,
         configuration_generation,
         shard_key,
         partition_version_id,
         root_page_id
       ) VALUES ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID)`,
      [
        fixture.universeId,
        reassignedConfigurationId,
        reassignedGeneration,
        reassignedShardKey,
        reassignedPartitionVersionId,
        rootPageId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_partition_configuration_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, reassignedConfigurationId]
    );
    await client.query(
      `UPDATE public.backstage_notion_partitioned_universe_heads
       SET
         desired_configuration_version_id = $2::UUID,
         desired_configuration_generation = $3,
         desired_configuration_hash = $4,
         head_generation = head_generation + 1
       WHERE universe_id = $1`,
      [
        fixture.universeId,
        reassignedConfigurationId,
        reassignedGeneration,
        reassignedHash,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_shard_heads (
         universe_id, shard_key, current_partition_version_id, root_page_id
       ) VALUES ($1, $2, $3::UUID, $4::UUID)`,
      [
        fixture.universeId,
        reassignedShardKey,
        reassignedPartitionVersionId,
        rootPageId,
      ]
    );

    const retained = await client.query<{
      active_manifest_id: string;
      old_snapshot_state: string;
      new_snapshot_state: string;
      duplicate_historical_root_heads: string;
    }>(
      `SELECT
         universe_head.active_manifest_id::TEXT,
         old_snapshot.state AS old_snapshot_state,
         new_snapshot.state AS new_snapshot_state,
         (
           SELECT pg_catalog.count(*)::TEXT
           FROM public.backstage_notion_shard_heads AS retained_head
           WHERE retained_head.universe_id = universe_head.universe_id
             AND retained_head.root_page_id = $4::UUID
         ) AS duplicate_historical_root_heads
       FROM public.backstage_notion_partitioned_universe_heads AS universe_head
       JOIN public.backstage_notion_shard_snapshots AS old_snapshot
         ON old_snapshot.universe_id = universe_head.universe_id
        AND old_snapshot.id = $2::UUID
       JOIN public.backstage_notion_shard_snapshots AS new_snapshot
         ON new_snapshot.universe_id = universe_head.universe_id
        AND new_snapshot.id = $3::UUID
       WHERE universe_head.universe_id = $1`,
      [fixture.universeId, fixture.snapshotId, snapshotId, rootPageId]
    );
    expect(retained.rows).toEqual([{
      active_manifest_id: fixture.manifestId,
      old_snapshot_state: 'sealed',
      new_snapshot_state: 'sealed',
      duplicate_historical_root_heads: '2',
    }]);
  });

  test('runs repository registration, leases, shard activation, and manifest publication as one real cycle', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'repository-cycle');
    const rootPageId = randomUUID();
    const parsed = parseBackstageNotionPartitionConfiguration(JSON.stringify({
      version: 1,
      generation: 'generation-repository-cycle-b',
      universes: [{
        universeId: fixture.universeId,
        shards: [{
          shardKey: fixture.shardKey,
          rootPageId,
          displayName: 'Repository Rotated Canon',
          retrievalTier: 'hot',
          required: true,
          scopeTags: ['current'],
          categoryTags: ['canon'],
          capacity: {
            maxPages: 8,
            maxChunks: 16,
            maxDepth: 4,
            maxContentCodePoints: 10_000,
          },
        }],
      }],
    }));
    if (parsed.status !== 'valid') {
      throw new Error('Repository-cycle partition configuration is invalid.');
    }
    const universe = parsed.universes[0]!;
    const definition = universe.shards[0]!;
    const repository = new PostgresBackstageNotionPartitionRepository(
      createSavepointRepositoryPool(client)
    );
    const previousHead = await repository.loadUniverseHead(fixture.universeId);
    expect(previousHead).not.toBeNull();
    const registration = await repository.registerConfiguration({
      configurationGeneration: parsed.generation,
      configurationHash: parsed.semanticDigest,
      universe,
      expectedUniverseHead: previousHead,
    });
    const registeredState = await repository.loadUniverseSynchronizationState(
      fixture.universeId,
      registration.configurationVersionId
    );
    expect(registeredState?.shards[0]).toMatchObject({
      partitionVersionId: registration.definitions[0]?.partitionVersionId,
      rootPageId,
      expectedHead: {
        currentPartitionVersionId: fixture.partitionVersionId,
        activeSnapshotId: fixture.snapshotId,
      },
      activeSnapshot: {
        snapshotId: fixture.snapshotId,
        partitionVersionId: fixture.partitionVersionId,
      },
    });

    const shardLease = await repository.acquireShardLease(
      fixture.universeId,
      fixture.shardKey,
      'repository-cycle-holder',
      5_000
    );
    expect(shardLease).not.toBeNull();
    await expect(repository.acquireShardLease(
      fixture.universeId,
      fixture.shardKey,
      'repository-cycle-holder',
      5_000
    )).resolves.toBeNull();
    await expect(repository.releaseShardLease(
      fixture.universeId,
      fixture.shardKey,
      shardLease!
    )).resolves.toBe(true);

    const providerLease = await repository.acquireProviderLease(
      'notion',
      'repository-cycle',
      'repository-cycle-holder',
      5_000,
      0
    );
    expect(providerLease).not.toBeNull();
    await expect(repository.acquireProviderLease(
      'notion',
      'repository-cycle',
      'repository-cycle-holder',
      5_000,
      0
    )).resolves.toBeNull();
    await expect(repository.releaseProviderLease(
      'notion',
      'repository-cycle',
      providerLease!
    )).resolves.toBe(true);

    const sourceLastEditedAt = '2026-08-24T14:00:00.000Z';
    const page = inspectBackstageNotionRagPage({
      universeId: fixture.universeId,
      pageId: rootPageId,
      parentPageId: null,
      title: definition.displayName,
      path: [definition.displayName],
      markdown: '# Repository Rotated Canon\n\nCurrent canon.',
      sourceLastEditedAt,
    });
    const metadata = Object.freeze({
      pageId: rootPageId,
      parentPageId: null,
      inTrash: false,
      lastEditedAt: new Date(sourceLastEditedAt),
    });
    const capture = Object.freeze({
      captureMode: 'full_hierarchy_content_scan' as const,
      pages: Object.freeze([Object.freeze({ page, metadata })]),
      completeness: Object.freeze({
        truncatedPageCount: 0,
        unsupportedBlockCount: 0,
        ambiguousChildReferenceCount: 0,
      }),
      capturedAt: new Date('2026-08-24T14:01:00.000Z'),
    });
    const syncResult = await syncBackstageNotionPartitionConfiguration(parsed, {
      repository,
      embeddingModel: 'pg18-repository-cycle-model',
      embeddingDimension: 2,
      embedBatch: async (inputs, signal) => {
        if (signal.aborted) {
          throw signal.reason;
        }
        return inputs.map(() => Object.freeze([3, 4]));
      },
      captureFullHierarchy: async () => capture,
      verifyFullHierarchy: async () => Object.freeze({
        verificationMode: 'full_metadata_second_pass' as const,
        pages: Object.freeze([metadata]),
        verifiedAt: new Date('2026-08-24T14:02:00.000Z'),
      }),
      holderId: 'repository-cycle-sync',
      concurrency: 1,
      shardLeaseTtlMs: 5_000,
      providerLeaseTtlMs: 5_000,
      providerPollMs: 1,
      notionRequestDelayMs: 0,
      embeddingRequestDelayMs: 0,
    });
    expect(syncResult.universes[0]).toMatchObject({
      universeId: fixture.universeId,
      configurationVersionId: registration.configurationVersionId,
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 0,
      shardResults: [{
        status: 'fresh',
        leaseReleaseVerified: true,
        shardKey: fixture.shardKey,
        pageCount: 1,
      }],
    });

    const published = await client.query<{
      active_manifest_id: string;
      active_snapshot_id: string;
      current_partition_version_id: string;
      old_manifest_state: string;
      old_snapshot_state: string;
      new_manifest_state: string;
      new_snapshot_state: string;
    }>(
      `SELECT
         universe_head.active_manifest_id::TEXT,
         shard_head.active_snapshot_id::TEXT,
         shard_head.current_partition_version_id::TEXT,
         old_manifest.state AS old_manifest_state,
         old_snapshot.state AS old_snapshot_state,
         new_manifest.state AS new_manifest_state,
         new_snapshot.state AS new_snapshot_state
       FROM public.backstage_notion_partitioned_universe_heads AS universe_head
       JOIN public.backstage_notion_shard_heads AS shard_head
         ON shard_head.universe_id = universe_head.universe_id
        AND shard_head.shard_key = $2
       JOIN public.backstage_notion_universe_manifests AS old_manifest
         ON old_manifest.universe_id = universe_head.universe_id
        AND old_manifest.id = $3::UUID
       JOIN public.backstage_notion_shard_snapshots AS old_snapshot
         ON old_snapshot.universe_id = universe_head.universe_id
        AND old_snapshot.shard_key = shard_head.shard_key
        AND old_snapshot.id = $4::UUID
       JOIN public.backstage_notion_universe_manifests AS new_manifest
         ON new_manifest.universe_id = universe_head.universe_id
        AND new_manifest.id = universe_head.active_manifest_id
       JOIN public.backstage_notion_shard_snapshots AS new_snapshot
         ON new_snapshot.universe_id = shard_head.universe_id
        AND new_snapshot.shard_key = shard_head.shard_key
        AND new_snapshot.id = shard_head.active_snapshot_id
       WHERE universe_head.universe_id = $1`,
      [
        fixture.universeId,
        fixture.shardKey,
        fixture.manifestId,
        fixture.snapshotId,
      ]
    );
    expect(published.rows[0]).toMatchObject({
      active_manifest_id: syncResult.universes[0]?.manifestId,
      current_partition_version_id: registration.definitions[0]?.partitionVersionId,
      old_manifest_state: 'sealed',
      old_snapshot_state: 'sealed',
      new_manifest_state: 'sealed',
      new_snapshot_state: 'sealed',
    });
    expect(published.rows[0]?.active_snapshot_id).not.toBe(fixture.snapshotId);

    const reassigned = parseBackstageNotionPartitionConfiguration(JSON.stringify({
      version: 1,
      generation: 'generation-repository-cycle-c',
      universes: [{
        universeId: fixture.universeId,
        shards: [{
          shardKey: 'hot/repository-cycle-reassigned',
          rootPageId,
          displayName: 'Reassigned Repository Canon',
          retrievalTier: 'hot',
          required: true,
          scopeTags: ['current'],
          categoryTags: ['canon'],
          capacity: {
            maxPages: 8,
            maxChunks: 16,
            maxDepth: 4,
            maxContentCodePoints: 10_000,
          },
        }],
      }],
    }));
    if (reassigned.status !== 'valid') {
      throw new Error('Repository-cycle reassignment configuration is invalid.');
    }
    const currentHead = await repository.loadUniverseHead(fixture.universeId);
    expect(currentHead).not.toBeNull();
    await expect(repository.registerConfiguration({
      configurationGeneration: reassigned.generation,
      configurationHash: reassigned.semanticDigest,
      universe: reassigned.universes[0]!,
      expectedUniverseHead: currentHead,
    })).resolves.toMatchObject({ reused: false });
    const historicalRootOwners = await client.query<{ count: string }>(
      `SELECT pg_catalog.count(*)::TEXT AS count
       FROM public.backstage_notion_shard_heads
       WHERE universe_id = $1 AND root_page_id = $2::UUID`,
      [fixture.universeId, rootPageId]
    );
    expect(historicalRootOwners.rows).toEqual([{ count: '2' }]);
  }, 60_000);

  test('publishes required canon while atomically omitting an overlapping optional archive', async () => {
    await client.query('BEGIN');
    const optionalPartition: OptionalFixturePartition = {
      shardKey: 'archive/ownership-isolation',
      partitionVersionId: randomUUID(),
      rootPageId: randomUUID(),
      semanticHash: fingerprint('partition:ownership-isolation-archive'),
    };
    const fixture = await insertSealedFixture(
      client,
      'ownership-isolation',
      optionalPartition
    );
    const optionalSnapshotId = await insertOptionalOverlapSnapshot(
      client,
      fixture,
      optionalPartition
    );
    const repository = new PostgresBackstageNotionPartitionRepository(
      createSavepointRepositoryPool(client)
    );
    const universeHead = await repository.loadUniverseHead(fixture.universeId);
    if (!universeHead) {
      throw new Error('Ownership-isolation universe head is unavailable.');
    }
    const manifestId = randomUUID();
    const activated = await repository.activateUniverseManifest({
      manifestId,
      universeId: fixture.universeId,
      configurationVersionId: fixture.configurationId,
      configurationGeneration: fixture.configurationGeneration,
      configurationHash: fixture.configurationHash,
      indexFormatVersion: 1,
      expectedUniverseHead: universeHead,
      members: [{
        shardKey: fixture.shardKey,
        partitionVersionId: fixture.partitionVersionId,
        snapshotId: fixture.snapshotId,
        decision: 'fresh',
        verifiedAt: new Date(fixture.verifiedAt),
        expectedHead: {
          headGeneration: '1',
          snapshotGeneration: '1',
          currentPartitionVersionId: fixture.partitionVersionId,
          activeSnapshotId: fixture.snapshotId,
        },
      }, {
        shardKey: optionalPartition.shardKey,
        partitionVersionId: optionalPartition.partitionVersionId,
        snapshotId: optionalSnapshotId,
        decision: 'fresh',
        verifiedAt: new Date(fixture.verifiedAt),
        expectedHead: {
          headGeneration: '1',
          snapshotGeneration: '1',
          currentPartitionVersionId: optionalPartition.partitionVersionId,
          activeSnapshotId: optionalSnapshotId,
        },
      }],
      omissions: [],
    });

    expect(activated).toMatchObject({
      manifestId,
      memberCount: 1,
      omissionCount: 1,
      pageCount: 1,
      chunkCount: 1,
    });
    const manifest = await client.query<{
      active_manifest_id: string;
      member_count: string;
      omission_count: string;
      page_count: string;
      chunk_count: string;
      member_shards: string[];
      omitted_shards: string[];
      omission_reason: string;
      ownership_count: string;
      old_manifest_state: string;
    }>(
      `SELECT
         head.active_manifest_id::TEXT,
         manifest.member_count::TEXT,
         manifest.omission_count::TEXT,
         manifest.page_count::TEXT,
         manifest.chunk_count::TEXT,
         ARRAY(
           SELECT member.shard_key
           FROM public.backstage_notion_universe_manifest_shards AS member
           WHERE member.universe_id = manifest.universe_id
             AND member.manifest_id = manifest.id
           ORDER BY member.shard_key
         ) AS member_shards,
         ARRAY(
           SELECT omission.shard_key
           FROM public.backstage_notion_universe_manifest_omissions AS omission
           WHERE omission.universe_id = manifest.universe_id
             AND omission.manifest_id = manifest.id
           ORDER BY omission.shard_key
         ) AS omitted_shards,
         (
           SELECT omission.safe_reason_code
           FROM public.backstage_notion_universe_manifest_omissions AS omission
           WHERE omission.universe_id = manifest.universe_id
             AND omission.manifest_id = manifest.id
           LIMIT 1
         ) AS omission_reason,
         (
           SELECT pg_catalog.count(*)::TEXT
           FROM public.backstage_notion_manifest_page_ownership AS ownership
           WHERE ownership.universe_id = manifest.universe_id
             AND ownership.manifest_id = manifest.id
         ) AS ownership_count,
         old_manifest.state AS old_manifest_state
       FROM public.backstage_notion_partitioned_universe_heads AS head
       JOIN public.backstage_notion_universe_manifests AS manifest
         ON manifest.universe_id = head.universe_id
        AND manifest.id = head.active_manifest_id
       JOIN public.backstage_notion_universe_manifests AS old_manifest
         ON old_manifest.universe_id = head.universe_id
        AND old_manifest.id = $3::UUID
       WHERE head.universe_id = $1 AND manifest.id = $2::UUID`,
      [fixture.universeId, manifestId, fixture.manifestId]
    );
    expect(manifest.rows).toEqual([{
      active_manifest_id: manifestId,
      member_count: '1',
      omission_count: '1',
      page_count: '1',
      chunk_count: '1',
      member_shards: [fixture.shardKey],
      omitted_shards: [optionalPartition.shardKey],
      omission_reason: 'SHARD_OWNERSHIP_CONFLICT',
      ownership_count: '1',
      old_manifest_state: 'sealed',
    }]);
  }, 60_000);

  test('omits a changed optional definition without moving its historical last-known-good head', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'optional-rotation');
    const configurationId = randomUUID();
    const configurationGeneration = 'generation-optional-rotation-b';
    const configurationHash = fingerprint('configuration:optional-rotation-b');
    const optionalPartitionVersionId = randomUUID();
    const optionalChangedRootPageId = randomUUID();
    const requiredShardKey = 'hot/optional-rotation-b';
    const requiredPartitionVersionId = randomUUID();
    const requiredRootPageId = randomUUID();
    const requiredPageVersionId = randomUUID();
    const requiredSnapshotId = randomUUID();
    const manifestId = randomUUID();
    const rejectedManifestId = randomUUID();
    const sourceEditedAt = '2026-08-24T13:00:00.000Z';
    const driftVerifiedAt = '2026-08-24T13:01:00.000Z';
    const verifiedAt = '2026-08-24T13:02:00.000Z';

    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_versions (
         id,
         universe_id,
         configuration_generation,
         configuration_hash,
         shard_count
       ) VALUES ($1::UUID, $2, $3, $4, 2)`,
      [
        configurationId,
        fixture.universeId,
        configurationGeneration,
        configurationHash,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_identities (
         universe_id,
         shard_key
       ) VALUES ($1, $2)`,
      [fixture.universeId, requiredShardKey]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_versions (
         id,
         universe_id,
         shard_key,
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
       ) VALUES
         (
           $1::UUID, $2, $3, $4::UUID,
           'Changed Optional Archive', 'archive', FALSE,
           '["archive"]'::JSONB, '["historical"]'::JSONB,
           8, 16, 4, 10000, $5
         ),
         (
           $6::UUID, $2, $7, $8::UUID,
           'Required Current Canon', 'hot', TRUE,
           '["current"]'::JSONB, '["canon"]'::JSONB,
           8, 16, 4, 10000, $9
         )`,
      [
        optionalPartitionVersionId,
        fixture.universeId,
        fixture.shardKey,
        optionalChangedRootPageId,
        fingerprint('partition:optional-rotation-b'),
        requiredPartitionVersionId,
        requiredShardKey,
        requiredRootPageId,
        fingerprint('partition:required-optional-rotation-b'),
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_members (
         universe_id,
         partition_configuration_version_id,
         configuration_generation,
         shard_key,
         partition_version_id,
         root_page_id
       ) VALUES
         ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID),
         ($1, $2::UUID, $3, $7, $8::UUID, $9::UUID)`,
      [
        fixture.universeId,
        configurationId,
        configurationGeneration,
        fixture.shardKey,
        optionalPartitionVersionId,
        optionalChangedRootPageId,
        requiredShardKey,
        requiredPartitionVersionId,
        requiredRootPageId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_partition_configuration_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, configurationId]
    );

    await client.query(
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
       ) VALUES ($1::UUID, $2, $3::UUID, $4, 1, 1, 'canon', 5, 1)`,
      [
        requiredPageVersionId,
        fixture.universeId,
        requiredRootPageId,
        fingerprint('page:required-optional-rotation-b'),
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_page_version_chunks (
         universe_id,
         page_version_id,
         ordinal,
         chunk_version_id,
         heading_path,
         scope_heading_path_key,
         heading_occurrence_path
       ) VALUES (
         $1,
         $2::UUID,
         0,
         $3::UUID,
         '["Canon"]'::JSONB,
         $4::JSONB,
         '[0]'::JSONB
       )`,
      [
        fixture.universeId,
        requiredPageVersionId,
        fixture.chunkVersionId,
        JSON.stringify([scopeKey('Canon')]),
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_page_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, requiredPageVersionId]
    );
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
         $1::UUID, $2, $3, $4::UUID, $5::UUID, $6,
         'pg18-test-model', 1, 2, 1, 1, 1, 5, 0, $7::TIMESTAMPTZ, 2
       )`,
      [
        requiredSnapshotId,
        fixture.universeId,
        requiredShardKey,
        requiredPartitionVersionId,
        requiredRootPageId,
        fingerprint('snapshot:required-optional-rotation-b'),
        sourceEditedAt,
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
       ) VALUES (
         $1, $2, $3::UUID, $4::UUID, $5::UUID, NULL,
         'Required Root', 'https://www.notion.so/required-root',
         $6::TIMESTAMPTZ, 0, $7::JSONB,
         $8::JSONB, $9, $10::JSONB
       )`,
      [
        fixture.universeId,
        requiredShardKey,
        requiredSnapshotId,
        requiredRootPageId,
        requiredPageVersionId,
        sourceEditedAt,
        JSON.stringify([requiredRootPageId]),
        JSON.stringify(['Required Root']),
        scopeKey('Required Root'),
        JSON.stringify([scopeKey('Required Root')]),
      ]
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
       ) VALUES (
         $1, $2, $3::UUID, $4::UUID, $5::UUID, 0, $6::UUID,
         'pg18-test-model', 1, 'general'
       )`,
      [
        fixture.universeId,
        requiredShardKey,
        requiredSnapshotId,
        requiredRootPageId,
        requiredPageVersionId,
        fixture.chunkVersionId,
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
       ) VALUES
         ($1, $2, $3::UUID, 0, 'source_drift', $4, $5::TIMESTAMPTZ),
         ($1, $2, $3::UUID, 1, 'completeness', $6, $7::TIMESTAMPTZ)`,
      [
        fixture.universeId,
        requiredShardKey,
        requiredSnapshotId,
        fingerprint('drift:required-optional-rotation-b'),
        driftVerifiedAt,
        fingerprint('complete:required-optional-rotation-b'),
        verifiedAt,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_shard_snapshots
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND shard_key = $2 AND id = $3::UUID`,
      [fixture.universeId, requiredShardKey, requiredSnapshotId]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_shard_heads (
         universe_id,
         shard_key,
         current_partition_version_id,
         root_page_id,
         active_snapshot_id,
         head_generation,
         snapshot_generation,
         last_verified_at
       ) VALUES ($1, $2, $3::UUID, $4::UUID, $5::UUID, 1, 1, $6::TIMESTAMPTZ)`,
      [
        fixture.universeId,
        requiredShardKey,
        requiredPartitionVersionId,
        requiredRootPageId,
        requiredSnapshotId,
        verifiedAt,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_partitioned_universe_heads
       SET
         desired_configuration_version_id = $2::UUID,
         desired_configuration_generation = $3,
         desired_configuration_hash = $4,
         head_generation = head_generation + 1
       WHERE universe_id = $1`,
      [
        fixture.universeId,
        configurationId,
        configurationGeneration,
        configurationHash,
      ]
    );

    const insertManifestCandidate = async (
      candidateManifestId: string,
      omissionPartitionVersionId: string
    ): Promise<void> => {
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
           $1::UUID, $2, $3::UUID, $4, $5,
           'pg18-test-model', 1, 2, 1, 1, 1, 1, 1
         )`,
        [
          candidateManifestId,
          fixture.universeId,
          configurationId,
          configurationGeneration,
          configurationHash,
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
         ) VALUES (
           $1, $2::UUID, $3, $4::UUID, $5::UUID, 'fresh', TRUE, $6::TIMESTAMPTZ
         )`,
        [
          fixture.universeId,
          candidateManifestId,
          requiredShardKey,
          requiredPartitionVersionId,
          requiredSnapshotId,
          verifiedAt,
        ]
      );
      await client.query(
        `INSERT INTO public.backstage_notion_universe_manifest_omissions (
           universe_id,
           manifest_id,
           shard_key,
           partition_version_id,
           decision,
           safe_reason_code
         ) VALUES (
           $1, $2::UUID, $3, $4::UUID, 'optional_unavailable', 'SOURCE_UNAVAILABLE'
         )`,
        [
          fixture.universeId,
          candidateManifestId,
          fixture.shardKey,
          omissionPartitionVersionId,
        ]
      );
      await client.query(
        `INSERT INTO public.backstage_notion_manifest_page_ownership (
           universe_id,
           manifest_id,
           page_id,
           shard_key,
           shard_snapshot_id
         ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::UUID)`,
        [
          fixture.universeId,
          candidateManifestId,
          requiredRootPageId,
          requiredShardKey,
          requiredSnapshotId,
        ]
      );
    };

    await expectSqlStateAtSavepoint(
      client,
      'optional_rotation_old_definition_omission',
      '23514',
      async () => {
        await insertManifestCandidate(rejectedManifestId, fixture.partitionVersionId);
        await client.query(
          `UPDATE public.backstage_notion_universe_manifests
           SET state = 'sealed', sealed_at = clock_timestamp()
           WHERE universe_id = $1 AND id = $2::UUID`,
          [fixture.universeId, rejectedManifestId]
        );
      }
    );

    await insertManifestCandidate(manifestId, optionalPartitionVersionId);
    await client.query(
      `UPDATE public.backstage_notion_universe_manifests
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, manifestId]
    );
    await client.query(
      `UPDATE public.backstage_notion_partitioned_universe_heads
       SET
         active_manifest_id = $2::UUID,
         active_configuration_version_id = $3::UUID,
         head_generation = head_generation + 1,
         manifest_generation = manifest_generation + 1,
         last_verified_at = $4::TIMESTAMPTZ
       WHERE universe_id = $1`,
      [fixture.universeId, manifestId, configurationId, verifiedAt]
    );

    const retainedHistory = await client.query<{
      active_manifest_id: string;
      optional_head_partition_version_id: string;
      optional_head_snapshot_id: string;
      old_manifest_state: string;
      new_manifest_state: string;
    }>(
      `SELECT
         universe_head.active_manifest_id::TEXT,
         optional_head.current_partition_version_id::TEXT AS optional_head_partition_version_id,
         optional_head.active_snapshot_id::TEXT AS optional_head_snapshot_id,
         old_manifest.state AS old_manifest_state,
         new_manifest.state AS new_manifest_state
       FROM public.backstage_notion_partitioned_universe_heads AS universe_head
       JOIN public.backstage_notion_shard_heads AS optional_head
         ON optional_head.universe_id = universe_head.universe_id
        AND optional_head.shard_key = $2
       JOIN public.backstage_notion_universe_manifests AS old_manifest
         ON old_manifest.universe_id = universe_head.universe_id
        AND old_manifest.id = $3::UUID
       JOIN public.backstage_notion_universe_manifests AS new_manifest
         ON new_manifest.universe_id = universe_head.universe_id
        AND new_manifest.id = universe_head.active_manifest_id
       WHERE universe_head.universe_id = $1`,
      [fixture.universeId, fixture.shardKey, fixture.manifestId]
    );
    expect(retainedHistory.rows).toEqual([{
      active_manifest_id: manifestId,
      optional_head_partition_version_id: fixture.partitionVersionId,
      optional_head_snapshot_id: fixture.snapshotId,
      old_manifest_state: 'sealed',
      new_manifest_state: 'sealed',
    }]);
  });

  test('reuses an unchanged current definition and snapshot when only the archive definition changes', async () => {
    await client.query('BEGIN');
    const archiveShardKey = 'archive/semantic-reuse';
    const previousArchivePartitionVersionId = randomUUID();
    const previousArchiveRootPageId = randomUUID();
    const fixture = await insertSealedFixture(client, 'semantic-reuse', {
      shardKey: archiveShardKey,
      partitionVersionId: previousArchivePartitionVersionId,
      rootPageId: previousArchiveRootPageId,
      semanticHash: fingerprint('partition:semantic-reuse-archive-a'),
    });
    const configurationId = randomUUID();
    const configurationGeneration = 'generation-semantic-reuse-b';
    const configurationHash = fingerprint('configuration:semantic-reuse-b');
    const archivePartitionVersionId = randomUUID();
    const archiveRootPageId = randomUUID();
    const manifestId = randomUUID();

    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_versions (
         id,
         universe_id,
         configuration_generation,
         configuration_hash,
         shard_count
       ) VALUES ($1::UUID, $2, $3, $4, 2)`,
      [
        configurationId,
        fixture.universeId,
        configurationGeneration,
        configurationHash,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_versions (
         id,
         universe_id,
         shard_key,
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
       ) VALUES (
         $1::UUID, $2, $3, $4::UUID,
         'Archive Lane', 'archive', FALSE,
         '["archive"]'::JSONB, '["historical"]'::JSONB,
         8, 16, 4, 10000, $5
       )`,
      [
        archivePartitionVersionId,
        fixture.universeId,
        archiveShardKey,
        archiveRootPageId,
        fingerprint('partition:semantic-reuse-archive'),
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_members (
         universe_id,
         partition_configuration_version_id,
         configuration_generation,
         shard_key,
         partition_version_id,
         root_page_id
       ) VALUES
         ($1, $2::UUID, $3, $4, $5::UUID, $6::UUID),
         ($1, $2::UUID, $3, $7, $8::UUID, $9::UUID)`,
      [
        fixture.universeId,
        configurationId,
        configurationGeneration,
        fixture.shardKey,
        fixture.partitionVersionId,
        fixture.rootPageId,
        archiveShardKey,
        archivePartitionVersionId,
        archiveRootPageId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_partition_configuration_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, configurationId]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_shard_heads (
         universe_id,
         shard_key,
         current_partition_version_id,
         root_page_id
       ) VALUES ($1, $2, $3::UUID, $4::UUID)`,
      [
        fixture.universeId,
        archiveShardKey,
        archivePartitionVersionId,
        archiveRootPageId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_partitioned_universe_heads
       SET
         desired_configuration_version_id = $2::UUID,
         desired_configuration_generation = $3,
         desired_configuration_hash = $4,
         head_generation = head_generation + 1
       WHERE universe_id = $1`,
      [
        fixture.universeId,
        configurationId,
        configurationGeneration,
        configurationHash,
      ]
    );

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
         $1::UUID, $2, $3::UUID, $4, $5,
         'pg18-test-model', 1, 2, 1, 1, 1, 1, 1
       )`,
      [
        manifestId,
        fixture.universeId,
        configurationId,
        configurationGeneration,
        configurationHash,
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
       ) VALUES (
         $1, $2::UUID, $3, $4::UUID, $5::UUID,
         'retained_last_known_good', TRUE, $6::TIMESTAMPTZ
       )`,
      [
        fixture.universeId,
        manifestId,
        fixture.shardKey,
        fixture.partitionVersionId,
        fixture.snapshotId,
        fixture.verifiedAt,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_universe_manifest_omissions (
         universe_id,
         manifest_id,
         shard_key,
         partition_version_id,
         decision,
         safe_reason_code
       ) VALUES (
         $1, $2::UUID, $3, $4::UUID,
         'optional_unavailable', 'ARCHIVE_NOT_SYNCHRONIZED'
       )`,
      [
        fixture.universeId,
        manifestId,
        archiveShardKey,
        archivePartitionVersionId,
      ]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_manifest_page_ownership (
         universe_id,
         manifest_id,
         page_id,
         shard_key,
         shard_snapshot_id
       ) VALUES ($1, $2::UUID, $3::UUID, $4, $5::UUID)`,
      [
        fixture.universeId,
        manifestId,
        fixture.rootPageId,
        fixture.shardKey,
        fixture.snapshotId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_universe_manifests
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, manifestId]
    );
    await client.query(
      `UPDATE public.backstage_notion_partitioned_universe_heads
       SET
         active_manifest_id = $2::UUID,
         active_configuration_version_id = $3::UUID,
         head_generation = head_generation + 1,
         manifest_generation = manifest_generation + 1,
         last_verified_at = $4::TIMESTAMPTZ
       WHERE universe_id = $1`,
      [fixture.universeId, manifestId, configurationId, fixture.verifiedAt]
    );

    const reused = await client.query<{
      active_manifest_id: string;
      current_partition_version_id: string;
      active_snapshot_id: string;
      head_generation: string;
      snapshot_generation: string;
      configuration_reuse_count: string;
      old_manifest_state: string;
      old_configuration_state: string;
      old_configuration_member_count: string;
      archive_configuration_version_count: string;
      archive_active_snapshot_id: string | null;
    }>(
      `SELECT
         universe_head.active_manifest_id::TEXT,
         current_head.current_partition_version_id::TEXT,
         current_head.active_snapshot_id::TEXT,
         current_head.head_generation::TEXT,
         current_head.snapshot_generation::TEXT,
         (
           SELECT pg_catalog.count(*)::TEXT
           FROM public.backstage_notion_partition_configuration_members AS membership
           WHERE membership.universe_id = current_head.universe_id
             AND membership.shard_key = current_head.shard_key
             AND membership.partition_version_id = current_head.current_partition_version_id
         ) AS configuration_reuse_count,
         old_manifest.state AS old_manifest_state,
         old_configuration.state AS old_configuration_state,
         (
           SELECT pg_catalog.count(*)::TEXT
           FROM public.backstage_notion_partition_configuration_members AS old_membership
           WHERE old_membership.universe_id = current_head.universe_id
             AND old_membership.partition_configuration_version_id = $5::UUID
         ) AS old_configuration_member_count,
         (
           SELECT pg_catalog.count(DISTINCT archive_membership.partition_version_id)::TEXT
           FROM public.backstage_notion_partition_configuration_members AS archive_membership
           WHERE archive_membership.universe_id = current_head.universe_id
             AND archive_membership.shard_key = $3
         ) AS archive_configuration_version_count,
         archive_head.active_snapshot_id::TEXT AS archive_active_snapshot_id
       FROM public.backstage_notion_partitioned_universe_heads AS universe_head
       JOIN public.backstage_notion_shard_heads AS current_head
         ON current_head.universe_id = universe_head.universe_id
        AND current_head.shard_key = $2
       JOIN public.backstage_notion_shard_heads AS archive_head
         ON archive_head.universe_id = universe_head.universe_id
        AND archive_head.shard_key = $3
       JOIN public.backstage_notion_universe_manifests AS old_manifest
         ON old_manifest.universe_id = universe_head.universe_id
        AND old_manifest.id = $4::UUID
       JOIN public.backstage_notion_partition_configuration_versions AS old_configuration
         ON old_configuration.universe_id = universe_head.universe_id
        AND old_configuration.id = $5::UUID
       WHERE universe_head.universe_id = $1`,
      [
        fixture.universeId,
        fixture.shardKey,
        archiveShardKey,
        fixture.manifestId,
        fixture.configurationId,
      ]
    );
    expect(reused.rows).toEqual([{
      active_manifest_id: manifestId,
      current_partition_version_id: fixture.partitionVersionId,
      active_snapshot_id: fixture.snapshotId,
      head_generation: '1',
      snapshot_generation: '1',
      configuration_reuse_count: '2',
      old_manifest_state: 'sealed',
      old_configuration_state: 'sealed',
      old_configuration_member_count: '2',
      archive_configuration_version_count: '2',
      archive_active_snapshot_id: null,
    }]);
  });

  test('compares active monolith and partition heads with bounded identity-only samples', async () => {
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE public.backstage_notion_universe_heads
       ADD COLUMN active_snapshot_id UUID`
    );
    await client.query(
      `CREATE TABLE public.backstage_notion_snapshots (
         id UUID PRIMARY KEY,
         universe_id TEXT NOT NULL,
         page_count INTEGER NOT NULL,
         chunk_count INTEGER NOT NULL
       )`
    );
    await client.query(
      `CREATE TABLE public.backstage_notion_snapshot_pages (
         universe_id TEXT NOT NULL,
         snapshot_id UUID NOT NULL,
         page_id TEXT NOT NULL,
         PRIMARY KEY (snapshot_id, page_id)
       )`
    );
    const fixture = await insertSealedFixture(client, 'shadow-coverage');
    const firstLegacySnapshotId = randomUUID();
    const secondLegacySnapshotId = randomUUID();
    const monolithOnlyPageId = randomUUID();
    const secondMonolithOnlyPageId = randomUUID();
    await client.query(
      `INSERT INTO public.backstage_notion_snapshots (
         id, universe_id, page_count, chunk_count
       ) VALUES
         ($1::UUID, $3, 2, 4),
         ($2::UUID, $3, 1, 2)`,
      [firstLegacySnapshotId, secondLegacySnapshotId, fixture.universeId]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_snapshot_pages (
         universe_id, snapshot_id, page_id
       ) VALUES
         ($1, $2::UUID, $3),
         ($1, $2::UUID, $4),
         ($1, $5::UUID, $6)`,
      [
        fixture.universeId,
        firstLegacySnapshotId,
        fixture.rootPageId,
        monolithOnlyPageId,
        secondLegacySnapshotId,
        secondMonolithOnlyPageId,
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_universe_heads
       SET active_snapshot_id = $2::UUID
       WHERE universe_id = $1`,
      [fixture.universeId, firstLegacySnapshotId]
    );

    const repository = new PostgresBackstageNotionPartitionRepository(
      createSavepointRepositoryPool(client)
    );
    await expect(repository.loadShadowCoverage(fixture.universeId, 1)).resolves
      .toMatchObject({
        monolithSnapshotId: firstLegacySnapshotId,
        partitionManifestId: fixture.manifestId,
        monolithPageCount: 2,
        monolithChunkCount: 4,
        partitionPageCount: 1,
        partitionChunkCount: 1,
        sharedPageCount: 1,
        monolithOnlyPageCount: 1,
        partitionOnlyPageCount: 0,
        monolithOnlyPageIds: [monolithOnlyPageId],
        partitionOnlyPageIds: [],
      });

    await client.query(
      `UPDATE public.backstage_notion_universe_heads
       SET active_snapshot_id = $2::UUID
       WHERE universe_id = $1`,
      [fixture.universeId, secondLegacySnapshotId]
    );
    await expect(repository.loadShadowCoverage(fixture.universeId, 0)).resolves
      .toMatchObject({
        monolithSnapshotId: secondLegacySnapshotId,
        partitionManifestId: fixture.manifestId,
        sharedPageCount: 0,
        monolithOnlyPageCount: 1,
        partitionOnlyPageCount: 1,
        monolithOnlyPageIds: [],
        partitionOnlyPageIds: [],
      });
  });

  test('preserves repeated heading occurrences and resolves manifest scope without content loads', async () => {
    await client.query('BEGIN');
    const fixture = await insertSealedFixture(client, 'scope-retrieval');
    const repeatedPageVersionId = randomUUID();
    const headingKey = scopeKey('History');

    await client.query(
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
       ) VALUES ($1::UUID, $2, $3::UUID, $4, 1, 1, 'history', 7, 2)`,
      [
        repeatedPageVersionId,
        fixture.universeId,
        fixture.rootPageId,
        fingerprint('page:scope-retrieval-repeated-headings'),
      ]
    );

    await expectSqlStateAtSavepoint(
      client,
      'fractional_heading_occurrence',
      '23514',
      () => client.query(
        `INSERT INTO public.backstage_notion_page_version_chunks (
           universe_id,
           page_version_id,
           ordinal,
           chunk_version_id,
           heading_path,
           scope_heading_path_key,
           heading_occurrence_path
         ) VALUES (
           $1, $2::UUID, 0, $3::UUID,
           '["History"]'::JSONB, $4::JSONB, '[1.5]'::JSONB
         )`,
        [
          fixture.universeId,
          repeatedPageVersionId,
          fixture.chunkVersionId,
          JSON.stringify([headingKey]),
        ]
      )
    );

    await client.query(
      `INSERT INTO public.backstage_notion_page_version_chunks (
         universe_id,
         page_version_id,
         ordinal,
         chunk_version_id,
         heading_path,
         scope_heading_path_key,
         heading_occurrence_path
       ) VALUES
         (
           $1, $2::UUID, 0, $3::UUID,
           '["History"]'::JSONB, $4::JSONB, '[0]'::JSONB
         ),
         (
           $1, $2::UUID, 1, $3::UUID,
           '["History"]'::JSONB, $4::JSONB, '[1]'::JSONB
         )`,
      [
        fixture.universeId,
        repeatedPageVersionId,
        fixture.chunkVersionId,
        JSON.stringify([headingKey]),
      ]
    );
    await client.query(
      `UPDATE public.backstage_notion_page_versions
       SET state = 'sealed', sealed_at = clock_timestamp()
       WHERE universe_id = $1 AND id = $2::UUID`,
      [fixture.universeId, repeatedPageVersionId]
    );

    const occurrences = await client.query<{
      heading_occurrence_path: number[];
      ordinal: number;
      scope_heading_path_key: string[];
    }>(
      `SELECT ordinal, scope_heading_path_key, heading_occurrence_path
       FROM public.backstage_notion_page_version_chunks
       WHERE universe_id = $1
         AND page_version_id = $2::UUID
         AND scope_heading_path_key = $3::JSONB
       ORDER BY heading_occurrence_path, ordinal`,
      [
        fixture.universeId,
        repeatedPageVersionId,
        JSON.stringify([headingKey]),
      ]
    );
    expect(occurrences.rows).toEqual([
      {
        heading_occurrence_path: [0],
        ordinal: 0,
        scope_heading_path_key: [headingKey],
      },
      {
        heading_occurrence_path: [1],
        ordinal: 1,
        scope_heading_path_key: [headingKey],
      },
    ]);
    await expectSqlStateAtSavepoint(
      client,
      'sealed_heading_occurrence_update',
      '55000',
      () => client.query(
        `UPDATE public.backstage_notion_page_version_chunks
         SET heading_occurrence_path = '[2]'::JSONB
         WHERE universe_id = $1
           AND page_version_id = $2::UUID
           AND ordinal = 0`,
        [fixture.universeId, repeatedPageVersionId]
      )
    );

    const normalizedTitleKey = scopeKey('  CANON \t ROOT  ');
    const normalizedPathKey = JSON.stringify([normalizedTitleKey]);
    const scoped = await client.query<{
      manifest_id: string;
      page_id: string;
      scope_path: string[];
      shard_key: string;
      shard_snapshot_id: string;
    }>(
      `SELECT
         member.manifest_id::TEXT,
         member.shard_key,
         member.shard_snapshot_id::TEXT,
         page.page_id::TEXT,
         page.scope_path
       FROM public.backstage_notion_partitioned_universe_heads AS head
       JOIN public.backstage_notion_universe_manifest_shards AS member
         ON member.universe_id = head.universe_id
        AND member.manifest_id = head.active_manifest_id
       JOIN public.backstage_notion_shard_snapshot_pages AS page
         ON page.universe_id = member.universe_id
        AND page.shard_key = member.shard_key
        AND page.shard_snapshot_id = member.shard_snapshot_id
       WHERE head.universe_id = $1
         AND page.scope_title_key = $2
         AND page.scope_path_key = $3::JSONB`,
      [fixture.universeId, normalizedTitleKey, normalizedPathKey]
    );
    expect(scoped.rows).toEqual([{
      manifest_id: fixture.manifestId,
      page_id: fixture.rootPageId,
      scope_path: ['Canon Root'],
      shard_key: fixture.shardKey,
      shard_snapshot_id: fixture.snapshotId,
    }]);

    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await client.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT page.page_id
       FROM public.backstage_notion_partitioned_universe_heads AS head
       JOIN public.backstage_notion_universe_manifest_shards AS member
         ON member.universe_id = head.universe_id
        AND member.manifest_id = head.active_manifest_id
       JOIN public.backstage_notion_shard_snapshot_pages AS page
         ON page.universe_id = member.universe_id
        AND page.shard_key = member.shard_key
        AND page.shard_snapshot_id = member.shard_snapshot_id
       WHERE head.universe_id = $1
         AND page.scope_title_key = $2
         AND page.scope_path_key = $3::JSONB`,
      [fixture.universeId, normalizedTitleKey, normalizedPathKey]
    );
    const serializedPlan = JSON.stringify(plan.rows);
    expect(serializedPlan).toMatch(
      /idx_backstage_notion_shard_snapshot_pages_scope_(?:title|path)/u
    );
    expect(serializedPlan).not.toContain('backstage_notion_page_versions');
    expect(serializedPlan).not.toContain('backstage_notion_chunk_versions');
    expect(serializedPlan).not.toContain('backstage_notion_chunk_embeddings');

    const repository = new PostgresBackstageNotionPartitionRepository(
      createSavepointRepositoryPool(client)
    );
    const originalRoutingState = await repository.loadActiveManifestRoutingState(
      fixture.universeId
    );
    expect(originalRoutingState).toMatchObject({
        universeId: fixture.universeId,
        manifestId: fixture.manifestId,
        manifestGeneration: '1',
        configurationVersionId: fixture.configurationId,
        configurationCurrent: true,
        embeddingModel: 'pg18-test-model',
        embeddingVersion: 1,
        embeddingDimension: 2,
        indexFormatVersion: 1,
        pageCount: 1,
        chunkCount: 1,
        members: [{
          shardKey: fixture.shardKey,
          partitionVersionId: fixture.partitionVersionId,
          snapshotId: fixture.snapshotId,
          retrievalTier: 'hot',
          required: true,
          decision: 'fresh',
          pageCount: 1,
          chunkCount: 1,
          scopeTags: ['current'],
          categoryTags: ['canon'],
        }],
        omissions: [],
      });
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      fixture.manifestId,
      {
        pageTitleKey: normalizedTitleKey,
        pagePathKey: [scopeKey('Backstage'), normalizedTitleKey],
        scopeKind: 'page',
      }
    )).resolves.toEqual({
      status: 'resolved',
      manifestId: fixture.manifestId,
      shardKey: fixture.shardKey,
      partitionVersionId: fixture.partitionVersionId,
      snapshotId: fixture.snapshotId,
      pageId: fixture.rootPageId,
      pageTitle: 'Canon Root',
      pagePath: ['Canon Root'],
      scopeKind: 'page',
      scopeChunkCount: 1,
      scopePageCount: 1,
    });

    const hierarchy = await activateScopeHierarchyFixture(client, fixture);
    await expect(repository.loadActiveManifestRoutingState(fixture.universeId))
      .resolves.toMatchObject({
        manifestId: hierarchy.manifestId,
        manifestGeneration: '2',
        pageCount: 4,
        chunkCount: 1,
        members: [{
          shardKey: fixture.shardKey,
          snapshotId: hierarchy.snapshotId,
          pageCount: 4,
          chunkCount: 1,
        }],
      });

    // A request that pinned immutable manifest A remains coherent after B wins
    // the active head; it never mixes B's snapshot into A's routing tuples.
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      originalRoutingState!.manifestId,
      {
        pageTitleKey: normalizedTitleKey,
        pagePathKey: null,
        scopeKind: 'page',
      }
    )).resolves.toMatchObject({
      status: 'resolved',
      manifestId: fixture.manifestId,
      snapshotId: fixture.snapshotId,
      pageTitle: 'Canon Root',
    });

    const navigationTitleKey = scopeKey('Navigation Root');
    const longNavigationPath = [
      ...Array.from({ length: 100 }, (_, index) => scopeKey(`Ancestor ${index}`)),
      navigationTitleKey,
    ];
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      hierarchy.manifestId,
      {
        pageTitleKey: navigationTitleKey,
        pagePathKey: longNavigationPath,
        scopeKind: 'page',
      }
    )).resolves.toEqual({ status: 'not_found' });
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      hierarchy.manifestId,
      {
        pageTitleKey: navigationTitleKey,
        pagePathKey: longNavigationPath,
        scopeKind: 'subtree',
      }
    )).resolves.toEqual({
      status: 'resolved',
      manifestId: hierarchy.manifestId,
      shardKey: fixture.shardKey,
      partitionVersionId: fixture.partitionVersionId,
      snapshotId: hierarchy.snapshotId,
      pageId: fixture.rootPageId,
      pageTitle: 'Navigation Root',
      pagePath: ['Navigation Root'],
      scopeKind: 'subtree',
      scopeChunkCount: 1,
      scopePageCount: 1,
    });
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      hierarchy.manifestId,
      {
        pageTitleKey: scopeKey('Content Child'),
        pagePathKey: null,
        scopeKind: 'page',
      }
    )).resolves.toMatchObject({
      status: 'resolved',
      pageId: hierarchy.contentPageId,
      scopeChunkCount: 1,
      scopePageCount: 1,
    });
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      hierarchy.manifestId,
      {
        pageTitleKey: scopeKey('Blank Child'),
        pagePathKey: null,
        scopeKind: 'page',
      }
    )).resolves.toEqual({ status: 'not_found' });
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      hierarchy.manifestId,
      {
        pageTitleKey: scopeKey('Blank Child'),
        pagePathKey: null,
        scopeKind: 'subtree',
      }
    )).resolves.toEqual({ status: 'ambiguous' });
    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      hierarchy.manifestId,
      {
        pageTitleKey: scopeKey('Blank Child'),
        pagePathKey: [scopeKey('Navigation Root'), scopeKey('Blank Child')],
        scopeKind: 'subtree',
      }
    )).resolves.toEqual({ status: 'not_found' });

    await expect(repository.resolveManifestScopeOwner(
      fixture.universeId,
      randomUUID(),
      {
        pageTitleKey: normalizedTitleKey,
        pagePathKey: null,
        scopeKind: 'page',
      }
    )).resolves.toEqual({ status: 'invalid' });
  });

  test('empty rollback succeeds and both migration paths reinstall cleanly', async () => {
    await client.query(rollbackMigration);

    const removed = await client.query<{ installed: boolean }>(
      `SELECT to_regclass('public.backstage_notion_partition_versions') IS NOT NULL AS installed`
    );
    expect(removed.rows).toEqual([{ installed: false }]);
    const preservedLegacyFunction = await client.query<{ installed: boolean }>(
      `SELECT to_regprocedure(
         'public.backstage_notion_reject_immutable_mutation()'
       ) IS NOT NULL AS installed`
    );
    expect(preservedLegacyFunction.rows).toEqual([{ installed: true }]);

    await client.query(forwardMigration);
    await client.query(runtimeSql);
    const restored = await client.query<{ installed: boolean }>(
      `SELECT to_regclass('public.backstage_notion_partition_versions') IS NOT NULL AS installed`
    );
    expect(restored.rows).toEqual([{ installed: true }]);
  }, 60_000);

  test('populated rollback refuses atomically and preserves the installed schema', async () => {
    await client.query('BEGIN');
    const universeId = 'partition-pg18-rollback-refusal';
    await client.query(
      `INSERT INTO public.backstage_notion_universe_heads (universe_id)
       VALUES ($1)`,
      [universeId]
    );
    await client.query(
      `INSERT INTO public.backstage_notion_partition_configuration_versions (
         id,
         universe_id,
         configuration_generation,
         configuration_hash,
         shard_count
       ) VALUES ($1::UUID, $2, 'rollback-generation', $3, 1)`,
      [randomUUID(), universeId, fingerprint('rollback-configuration')]
    );

    try {
      await client.query(rollbackMigration);
      throw new Error('Expected populated rollback to be rejected.');
    } catch (error: unknown) {
      expect(errorCode(error)).toBe('55000');
    }
    await client.query('ROLLBACK');

    const preserved = await client.query<{ installed: boolean }>(
      `SELECT to_regclass('public.backstage_notion_partition_versions') IS NOT NULL AS installed`
    );
    expect(preserved.rows).toEqual([{ installed: true }]);
  }, 60_000);
});
