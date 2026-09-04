import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { Client, Pool } from 'pg';

import {
  PostgresBackstageBookerRepository,
  type BackstageCanonBeatAppendInput,
  type BackstageCanonStorylineUpsertInput
} from '../../src/core/db/repositories/backstageBookerRepository.js';
import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
  PostgresBackstageNotionRagRepository,
  type ActivateBackstageNotionSnapshotInput,
  type BackstageNotionSyncLease,
} from '../../src/core/db/repositories/backstageNotionRagRepository.js';
import {
  PostgresBackstageNotionSyncStatusRepository,
} from '../../src/core/db/repositories/backstageNotionSyncStatusRepository.js';
import { TABLE_DEFINITIONS } from '../../src/core/db/schema.js';
import { readBackstageStorylineSummary } from '../../src/services/backstageUniverseRead.js';
import { BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION } from '../../src/shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '../../src/shared/backstage/backstageNotionScopeIndex.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL';
const configuredConnectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredConnectionString) {
  assertDisposablePostgresTestDatabaseUrl(
    configuredConnectionString,
    TEST_DATABASE_ENV
  );
}

const universeScopeForwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260814_backstage_universe_scope_v1.sql'),
  'utf8'
);
const canonForwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260814_backstage_canon_storyline_v1.sql'),
  'utf8'
);
const canonRollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260814_backstage_canon_storyline_v1.rollback.sql'
  ),
  'utf8'
);
const notionRagForwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260819_backstage_notion_rag_v1.sql'),
  'utf8'
);
const notionRagRollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260819_backstage_notion_rag_v1.rollback.sql'
  ),
  'utf8'
);
const notionRagIndexVersionFenceMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260819_backstage_notion_rag_v2_index_version_fence.sql'
  ),
  'utf8'
);
const notionRagIndexVersionFenceRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260819_backstage_notion_rag_v2_index_version_fence.rollback.sql'
  ),
  'utf8'
);
const notionRagSnapshotCapacityMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260829_backstage_notion_rag_v3_snapshot_capacity.sql'
  ),
  'utf8'
);
const notionRagSnapshotCapacityRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260829_backstage_notion_rag_v3_snapshot_capacity.rollback.sql'
  ),
  'utf8'
);
const notionRagSyncStatusMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260829_backstage_notion_rag_v4_sync_status.sql'
  ),
  'utf8'
);
const notionRagSyncStatusRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260829_backstage_notion_rag_v4_sync_status.rollback.sql'
  ),
  'utf8'
);
const notionRagCandidateSearchMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260902_backstage_notion_rag_candidate_search_v1.sql'
  ),
  'utf8'
);
const notionRagCandidateSearchRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260902_backstage_notion_rag_candidate_search_v1.rollback.sql'
  ),
  'utf8'
);
const notionRagSnapshotCapacityRollbackBegin =
  notionRagSnapshotCapacityRollback.indexOf('\nBEGIN;');
const notionRagSnapshotCapacityRollbackCommit =
  notionRagSnapshotCapacityRollback.lastIndexOf('\nCOMMIT;');
if (
  notionRagSnapshotCapacityRollbackBegin < 0
  || notionRagSnapshotCapacityRollbackCommit
    <= notionRagSnapshotCapacityRollbackBegin
) {
  throw new Error('Backstage Notion V3 rollback is missing its transaction wrapper.');
}
const notionRagSnapshotCapacityRollbackBody = notionRagSnapshotCapacityRollback
  .slice(
    notionRagSnapshotCapacityRollbackBegin + '\nBEGIN;'.length,
    notionRagSnapshotCapacityRollbackCommit
  )
  .trim();
const canonTransactionalPhaseStart = canonForwardMigration.indexOf('\nBEGIN;');
if (canonTransactionalPhaseStart < 0) {
  throw new Error('Backstage canon migration is missing its transactional phase.');
}
const canonConcurrentIndexPhase = canonForwardMigration
  .slice(0, canonTransactionalPhaseStart)
  .trim();
const canonTransactionalPhase = canonForwardMigration
  .slice(canonTransactionalPhaseStart)
  .trim();
const runtimeCanonVerifier = TABLE_DEFINITIONS.find(sql =>
  sql.includes(
    '-- CREATE ... IF NOT EXISTS is intentionally paired with an exact catalog'
  )
);
if (!runtimeCanonVerifier) {
  throw new Error('Runtime Backstage canon catalog verifier is missing.');
}

async function applyCanonForwardMigration(client: Client): Promise<void> {
  await client.query(canonConcurrentIndexPhase);
  await client.query(canonTransactionalPhase);
}

const ownedTableNames = [
  'backstage_notion_authority_epoch',
  'backstage_notion_latest_sync_attempts',
  'backstage_notion_snapshot_chunk_search',
  'backstage_notion_snapshot_chunks',
  'backstage_notion_snapshot_pages',
  'backstage_notion_snapshots',
  'backstage_notion_sync_leases',
  'backstage_notion_universe_heads',
  'backstage_canon_heads',
  'backstage_canon_revisions',
  'backstage_events',
  'backstage_story_beats',
  'backstage_storyline_canon_beats',
  'backstage_storyline_participants',
  'backstage_storyline_threads',
  'backstage_storylines',
  'backstage_wrestlers'
] as const;
const phaseTwoTables = [
  'backstage_canon_heads',
  'backstage_canon_revisions',
  'backstage_storyline_canon_beats',
  'backstage_storyline_participants',
  'backstage_storyline_threads'
] as const;
const notionRagTables = [
  'backstage_notion_authority_epoch',
  'backstage_notion_latest_sync_attempts',
  'backstage_notion_snapshot_chunk_search',
  'backstage_notion_snapshot_chunks',
  'backstage_notion_snapshot_pages',
  'backstage_notion_snapshots',
  'backstage_notion_sync_leases',
  'backstage_notion_universe_heads'
] as const;
const baseTables = [
  'backstage_events',
  'backstage_story_beats',
  'backstage_storylines',
  'backstage_wrestlers'
] as const;

const describeWithDatabase = configuredConnectionString ? describe : describe.skip;
const universeA = 'canon-pg18-a';
const universeB = 'canon-pg18-b';
const eventAId = randomUUID();
const eventBId = randomUUID();

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

async function resetDisposableNotionRagState(client: Client): Promise<void> {
  await client.query(
    `TRUNCATE TABLE
       backstage_notion_latest_sync_attempts,
       backstage_notion_snapshot_chunk_search,
       backstage_notion_snapshot_chunks,
       backstage_notion_snapshot_pages,
       backstage_notion_sync_leases,
       backstage_notion_snapshots,
       backstage_notion_universe_heads
     RESTART IDENTITY CASCADE`
  );
  await client.query(
    `UPDATE backstage_notion_authority_epoch
     SET epoch = 0,
         updated_at = clock_timestamp()
     WHERE singleton = TRUE`
  );
}

async function populateNotionCandidateSearchSidecar(
  client: Client,
  universeId: string,
  snapshotId: string
): Promise<void> {
  await client.query(
    `INSERT INTO public.backstage_notion_snapshot_chunk_search (
       universe_id, snapshot_id, chunk_id, page_id, ordinal,
       embedding_model, embedding_dimension, embedding_norm, embedding,
       search_vector, booking_brand_mask
     )
     SELECT
       chunk.universe_id,
       chunk.snapshot_id,
       chunk.id,
       chunk.page_id,
       chunk.ordinal,
       chunk.embedding_model,
       pg_catalog.cardinality(material.native_embedding),
       public.backstage_notion_candidate_embedding_norm(material.native_embedding),
       material.native_embedding,
       public.backstage_notion_candidate_search_vector(
         chunk.content,
         page.title,
         page.path,
         chunk.heading_path,
         material.category
       ),
       public.backstage_notion_candidate_brand_mask(
         page.title,
         page.path,
         chunk.heading_path,
         material.category
       )
     FROM public.backstage_notion_snapshot_chunks AS chunk
     INNER JOIN public.backstage_notion_snapshot_pages AS page
       ON page.universe_id = chunk.universe_id
      AND page.snapshot_id = chunk.snapshot_id
      AND page.page_id = chunk.page_id
     CROSS JOIN LATERAL (
       SELECT
         public.backstage_notion_candidate_embedding_from_jsonb(
           chunk.embedding
         ) AS native_embedding,
         CASE
           WHEN jsonb_typeof(chunk.metadata -> 'category') = 'string'
             AND octet_length(convert_to(
               chunk.metadata ->> 'category', 'UTF8'
             )) <= 32
           THEN chunk.metadata ->> 'category'
           ELSE ''
         END AS category
     ) AS material
     WHERE chunk.universe_id = $1
       AND chunk.snapshot_id = $2::UUID`,
    [universeId, snapshotId]
  );
}

function notionSnapshotInput(input: {
  universeId: string;
  rootPageId: string;
  lease: Pick<BackstageNotionSyncLease, 'holderId' | 'leaseToken'>;
  label: string;
}): ActivateBackstageNotionSnapshotInput {
  const title = `Authority ${input.label}`;
  const path = [title];
  const markdown = `# ${title}`;
  const pageContentHash = fingerprint(JSON.stringify({
    format: 'backstage-notion-rag-page-v1',
    universeId: input.universeId,
    pageId: input.rootPageId,
    parentPageId: null,
    title,
    path,
    markdown,
  }));
  const chunkContent = `Synthetic authority chunk ${input.label}`;
  const chunkContentHash = fingerprint(chunkContent);
  return {
    universeId: input.universeId,
    rootPageId: input.rootPageId,
    manifestHash: fingerprint(`manifest:${input.label}`),
    embeddingModel: 'pg18-notion-lease-model',
    lease: input.lease,
    deadlineAtMs: Date.now() + 30_000,
    pages: [{
      pageId: input.rootPageId,
      parentPageId: null,
      title,
      canonicalUrl: `https://www.notion.so/${input.rootPageId.replaceAll('-', '')}`,
      contentHash: pageContentHash,
      markdown,
      depth: 0,
      path,
      metadata: {
        headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
        indexFormat: BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
        scopeTitleKey: normalizeBackstageNotionScopeKey(title),
        scopePathKey: normalizeBackstageNotionScopePath(path),
      },
    }],
    chunks: [{
      chunkId: fingerprint(JSON.stringify({
        format: 'backstage-notion-rag-chunk-v1',
        pageId: input.rootPageId,
        ordinal: 0,
        contentHash: chunkContentHash,
      })),
      pageId: input.rootPageId,
      ordinal: 0,
      contentHash: chunkContentHash,
      content: chunkContent,
      codePoints: Array.from(chunkContent).length,
      embedding: [1, 0],
      headingPath: [],
      metadata: {
        headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
        headingOccurrencePath: [],
        scopeHeadingPathKey: normalizeBackstageNotionScopePath([]),
      },
    }],
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function insertNotionIndexFenceSnapshot(input: {
  client: Client;
  universeId: string;
  rootPageId: string;
  indexFormats: readonly (string | null)[];
  expectedPageCount?: number;
  expectedChunkCount?: number;
}): Promise<string> {
  const snapshotId = randomUUID();
  await input.client.query(
    `INSERT INTO backstage_notion_snapshots (
       id,
       universe_id,
       root_page_id,
       manifest_hash,
       embedding_model,
       page_count,
       chunk_count,
       sync_holder_id
     ) VALUES ($1::UUID, $2, $3, $4, 'pg18-fence-model', $5, $6, 'pg18-fence')`,
    [
      snapshotId,
      input.universeId,
      input.rootPageId,
      fingerprint(`snapshot:${snapshotId}`),
      input.expectedPageCount ?? input.indexFormats.length,
      input.expectedChunkCount ?? 1,
    ]
  );
  let firstPageId: string | null = null;
  for (const [index, indexFormat] of input.indexFormats.entries()) {
    const pageId = randomUUID();
    firstPageId ??= pageId;
    await input.client.query(
      `INSERT INTO backstage_notion_snapshot_pages (
         snapshot_id,
         universe_id,
         page_id,
         title,
         content_hash,
         markdown,
         depth,
         path,
         metadata
       ) VALUES (
         $1::UUID,
         $2,
         $3,
         $4,
         $5,
         $6,
         0,
         $7::JSONB,
         $8::JSONB
       )`,
      [
        snapshotId,
        input.universeId,
        pageId,
        `Fence page ${index + 1}`,
        fingerprint(`page:${pageId}`),
        `# Fence page ${index + 1}`,
        JSON.stringify([`Fence page ${index + 1}`]),
        JSON.stringify(indexFormat === null ? {} : { indexFormat }),
      ]
    );
  }
  if (firstPageId) {
    const content = '# Fence chunk';
    await input.client.query(
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
       ) VALUES (
         $1,
         $2::UUID,
         $3,
         $4,
         0,
         $5,
         $6,
         $7,
         'pg18-fence-model',
         '[1]'::JSONB,
         '[]'::JSONB,
         '{}'::JSONB
       )`,
      [
        fingerprint(`chunk:${snapshotId}`),
        snapshotId,
        input.universeId,
        firstPageId,
        fingerprint(content),
        content,
        Array.from(content).length,
      ]
    );
    await populateNotionCandidateSearchSidecar(
      input.client,
      input.universeId,
      snapshotId
    );
  }
  return snapshotId;
}

function storylineInput(
  universeId: string,
  storyKey: string,
  participantNames: readonly string[],
  overrides: Partial<BackstageCanonStorylineUpsertInput> = {}
): BackstageCanonStorylineUpsertInput {
  const mutationId = randomUUID();
  return {
    universeId,
    mutationId,
    requestFingerprint: fingerprint(`storyline:${mutationId}`),
    storyKey,
    title: `Title for ${storyKey}`,
    summary: null,
    status: 'active',
    expectedVersion: 0,
    participantNames,
    ...overrides
  };
}

function beatInput(
  universeId: string,
  storyKey: string,
  expectedVersion: number,
  participantNames: readonly string[],
  overrides: Partial<BackstageCanonBeatAppendInput> = {}
): BackstageCanonBeatAppendInput {
  const mutationId = randomUUID();
  return {
    universeId,
    mutationId,
    requestFingerprint: fingerprint(`beat:${mutationId}`),
    storyKey,
    expectedVersion,
    kind: 'angle',
    summary: `Canon beat for ${storyKey}`,
    occurredAt: '2026-08-14T18:00:00.000Z',
    participantNames,
    ...overrides
  };
}

describe('disposable Backstage canon PostgreSQL connection guard', () => {
  test('accepts only an explicit loopback disposable database URL', () => {
    expect(() => assertDisposablePostgresTestDatabaseUrl(
      `postgresql://audit%2Duser:p%40ss@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`,
      TEST_DATABASE_ENV
    )).not.toThrow();
  });

  test.each([
    `postgresql://audit:secret@127.0.0.1/${POSTGRES_TEST_DATABASE_NAME}`,
    `postgresql://audit:secret@db.example.test:55432/${POSTGRES_TEST_DATABASE_NAME}`,
    'postgresql://audit:secret@127.0.0.1:55432/postgres',
    `postgresql://audit:secret@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?sslmode=require`,
    `postgresql://127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`
  ])('rejects an unsafe or incomplete target: %s', value => {
    expect(() => assertDisposablePostgresTestDatabaseUrl(
      value,
      TEST_DATABASE_ENV
    )).toThrow();
  });
});

describeWithDatabase('Backstage canon/storyline persistence on PostgreSQL 18', () => {
  let observer: Client;
  let pool: Pool;
  let repository: PostgresBackstageBookerRepository;
  let ownsInstallation = false;

  beforeAll(async () => {
    if (!configuredConnectionString) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
    }

    observer = new Client({
      connectionString: configuredConnectionString,
      ssl: false,
      application_name: 'backstage-canon-pg18-observer'
    });
    await observer.connect();
    await observer.query('SET search_path TO public, pg_catalog');

    const target = await observer.query<{
      current_database: string;
      server_version_num: string;
    }>(
      `SELECT
         current_database(),
         current_setting('server_version_num') AS server_version_num`
    );
    expect(target.rows[0]?.current_database).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(target.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);

    await observer.query(
      'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public'
    );
    const publicUuidFunction = await observer.query<{ installed: boolean }>(
      `SELECT to_regprocedure('public.gen_random_uuid()') IS NOT NULL AS installed`
    );
    expect(publicUuidFunction.rows[0]?.installed).toBe(true);

    const preexisting = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [ownedTableNames]
    );
    if (preexisting.rows.length > 0) {
      throw new Error(
        `${TEST_DATABASE_ENV} must not contain pre-existing Backstage tables: ${preexisting.rows
          .map(row => row.table_name)
          .join(', ')}`
      );
    }
    ownsInstallation = true;

    await observer.query(universeScopeForwardMigration);
    // The universe-scope migration intentionally preserves the historical
    // story-beat shape. loadContext reads the current runtime projection, so
    // this disposable fixture also needs the two runtime projection columns.
    await observer.query(
      `ALTER TABLE public.backstage_story_beats
         ADD COLUMN IF NOT EXISTS serialized_data TEXT;
       ALTER TABLE public.backstage_story_beats
         ADD COLUMN IF NOT EXISTS storage_sequence BIGINT;`
    );
    await applyCanonForwardMigration(observer);
    await observer.query(notionRagForwardMigration);
    await observer.query(notionRagIndexVersionFenceMigration);
    await observer.query(notionRagSnapshotCapacityMigration);
    await observer.query(notionRagSyncStatusMigration);
    await observer.query(notionRagCandidateSearchMigration);

    pool = new Pool({
      connectionString: configuredConnectionString,
      ssl: false,
      max: 4,
      options: '-c search_path=public,pg_catalog',
      application_name: 'backstage-canon-pg18-repository'
    });
    repository = new PostgresBackstageBookerRepository(pool);
  }, 60_000);

  beforeEach(async () => {
    await observer.query(
      `TRUNCATE TABLE
         backstage_storyline_canon_beats,
         backstage_storyline_participants,
         backstage_storyline_threads,
         backstage_canon_revisions,
         backstage_canon_heads,
         backstage_events,
         backstage_story_beats,
         backstage_storylines,
         backstage_wrestlers
       RESTART IDENTITY CASCADE`
    );
    await observer.query(
      `INSERT INTO backstage_wrestlers (universe_id, name, overall)
       VALUES
         ($1, 'Aster', 91),
         ($1, 'Shared', 89),
         ($2, 'Boreal', 92),
         ($2, 'Shared', 88)`,
      [universeA, universeB]
    );
    await observer.query(
      `INSERT INTO backstage_events (id, universe_id, data)
       VALUES
         ($1::UUID, $2, '{"name":"Universe A Event"}'::JSONB),
         ($3::UUID, $4, '{"name":"Universe B Event"}'::JSONB)`,
      [eventAId, universeA, eventBId, universeB]
    );
  });

  afterAll(async () => {
    try {
      await pool?.end();
      if (observer && ownsInstallation) {
        await observer.query('ROLLBACK');
        const notionRagTable = await observer.query<{ installed: boolean }>(
          `SELECT to_regclass('public.backstage_notion_universe_heads') IS NOT NULL AS installed`
        );
        if (notionRagTable.rows[0]?.installed) {
          await resetDisposableNotionRagState(observer);
          await observer.query(notionRagCandidateSearchRollback);
          await observer.query(notionRagSyncStatusRollback);
          await observer.query(notionRagSnapshotCapacityRollback);
          await observer.query(notionRagIndexVersionFenceRollback);
          await observer.query(notionRagRollbackMigration);
        }
        const canonTable = await observer.query<{ installed: boolean }>(
          `SELECT to_regclass('public.backstage_canon_heads') IS NOT NULL AS installed`
        );
        if (canonTable.rows[0]?.installed) {
          await observer.query(
            `TRUNCATE TABLE
               public.backstage_storyline_canon_beats,
               public.backstage_storyline_participants,
               public.backstage_storyline_threads,
               public.backstage_canon_revisions,
               public.backstage_canon_heads
             CASCADE`
          );
          await observer.query(canonRollbackMigration);
        }
        await observer.query(
          `DROP TABLE IF EXISTS
             public.backstage_story_beats,
             public.backstage_storylines,
             public.backstage_events,
             public.backstage_wrestlers`
        );
      }
    } finally {
      await observer?.end();
    }
  }, 60_000);

  test('applies the Phase 1, Phase 2, and Notion RAG migrations idempotently', async () => {
    await observer.query(universeScopeForwardMigration);
    await applyCanonForwardMigration(observer);
    await observer.query(notionRagForwardMigration);
    await observer.query(notionRagIndexVersionFenceMigration);
    await observer.query(notionRagSnapshotCapacityMigration);
    await observer.query(notionRagSyncStatusMigration);
    await observer.query(notionRagCandidateSearchMigration);

    const tables = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [[...phaseTwoTables, ...notionRagTables]]
    );
    expect(tables.rows.map(row => row.table_name)).toEqual([
      ...phaseTwoTables,
      ...notionRagTables
    ].sort());

    const constraints = await observer.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE conname IN (
         'uq_backstage_events_universe_id',
         'fk_backstage_storyline_participants_wrestler',
         'fk_backstage_storyline_canon_beats_event',
         'fk_backstage_storyline_canon_beats_supersedes'
       )
       ORDER BY conname`
    );
    expect(constraints.rows.map(row => row.conname)).toEqual([
      'fk_backstage_storyline_canon_beats_event',
      'fk_backstage_storyline_canon_beats_supersedes',
      'fk_backstage_storyline_participants_wrestler',
      'uq_backstage_events_universe_id'
    ]);

    const indexFenceTrigger = await observer.query<{ installed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_trigger
         WHERE tgrelid = 'public.backstage_notion_universe_heads'::REGCLASS
           AND tgname = 'trg_backstage_notion_index_version_fence'
           AND tgenabled = 'O'
           AND NOT tgisinternal
       ) AS installed`
    );
    expect(indexFenceTrigger.rows).toEqual([{ installed: true }]);
  }, 60_000);

  test('database-fences mixed, partial, and lower Notion index activations', async () => {
    const universeId = 'notion-index-fence-pg18';
    const rootPageId = randomUUID();
    const activate = async (snapshotId: string): Promise<void> => {
      await observer.query(
        `UPDATE backstage_notion_universe_heads
         SET authority = 'notion',
             active_snapshot_id = $2::UUID,
             activated_at = clock_timestamp(),
             last_verified_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE universe_id = $1`,
        [universeId, snapshotId]
      );
    };
    const expectActivationError = async (
      snapshotId: string,
      expectedCode: string
    ): Promise<void> => {
      await observer.query('SAVEPOINT index_fence_attempt');
      try {
        await activate(snapshotId);
        throw new Error('Expected snapshot activation to be rejected.');
      } catch (error: unknown) {
        await observer.query('ROLLBACK TO SAVEPOINT index_fence_attempt');
        expect(errorCode(error)).toBe(expectedCode);
      } finally {
        await observer.query('RELEASE SAVEPOINT index_fence_attempt');
      }
    };

    await observer.query('BEGIN');
    try {
      await observer.query(
        `INSERT INTO backstage_notion_universe_heads (universe_id)
         VALUES ($1)`,
        [universeId]
      );

      const legacySnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [null],
      });
      await activate(legacySnapshot);

      const currentSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [BACKSTAGE_NOTION_RAG_INDEX_FORMAT],
      });
      await activate(currentSnapshot);

      const sameVersionSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [BACKSTAGE_NOTION_RAG_INDEX_FORMAT],
      });
      await activate(sameVersionSnapshot);

      const lowerSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: ['backstage-notion-rag-index-v4'],
      });
      await expectActivationError(lowerSnapshot, 'BN002');

      const unmarkedSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [null],
      });
      await expectActivationError(unmarkedSnapshot, 'BN002');

      const mixedSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [BACKSTAGE_NOTION_RAG_INDEX_FORMAT, null],
      });
      await expectActivationError(mixedSnapshot, 'BN002');

      const partialSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [BACKSTAGE_NOTION_RAG_INDEX_FORMAT],
        expectedPageCount: 2,
      });
      await expectActivationError(partialSnapshot, 'BN002');

      const partialChunkSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId,
        indexFormats: [BACKSTAGE_NOTION_RAG_INDEX_FORMAT],
        expectedChunkCount: 2,
      });
      await expectActivationError(partialChunkSnapshot, 'BN003');

      const replacementRootSnapshot = await insertNotionIndexFenceSnapshot({
        client: observer,
        universeId,
        rootPageId: randomUUID(),
        indexFormats: [BACKSTAGE_NOTION_RAG_INDEX_FORMAT],
      });
      await expectActivationError(replacementRootSnapshot, 'BN001');

      const active = await observer.query<{ active_snapshot_id: string }>(
        `SELECT active_snapshot_id::TEXT
         FROM backstage_notion_universe_heads
         WHERE universe_id = $1`,
        [universeId]
      );
      expect(active.rows).toEqual([{ active_snapshot_id: sameVersionSnapshot }]);
    } finally {
      await observer.query('ROLLBACK');
    }
  }, 30_000);

  test('fences live and stale Notion leases across real expiry and promotion', async () => {
    const notionRepository = new PostgresBackstageNotionRagRepository(pool);
    const syncStatusRepository = new PostgresBackstageNotionSyncStatusRepository(
      pool
    );
    const universeId = 'notion-lease-takeover-pg18';
    const rootPageId = randomUUID();
    const wrongRootPageId = randomUUID();
    const holderSeed = 'pg18-notion-seed';
    const holderA = 'pg18-notion-holder-a';
    const holderB = 'pg18-notion-holder-b';
    const staleManifest = fingerprint('manifest:stale-a');
    const wrongRootManifest = fingerprint('manifest:wrong-root-b');

    try {
      await observer.query(
        `INSERT INTO backstage_notion_universe_heads (universe_id)
         VALUES ($1)`,
        [universeId]
      );
      const seedLease = await notionRepository.acquireSyncLease(
        universeId,
        holderSeed,
        5_000
      );
      expect(seedLease).not.toBeNull();
      const prior = await notionRepository.activateSnapshot(notionSnapshotInput({
        universeId,
        rootPageId,
        lease: seedLease!,
        label: 'prior',
      }));
      await expect(notionRepository.releaseSyncLease(
        universeId,
        seedLease!.holderId,
        seedLease!.leaseToken
      )).resolves.toBe(true);

      const leaseA = await notionRepository.acquireSyncLease(
        universeId,
        holderA,
        1_000
      );
      expect(leaseA).not.toBeNull();
      const attemptA = await syncStatusRepository.beginSyncAttempt({
        universeId,
        lease: leaseA!,
      });
      await expect(syncStatusRepository.loadMonolithAuthorityOperationalState({
        universeId,
        configuredRootPageId: rootPageId,
        expectedEmbeddingModel: 'pg18-notion-lease-model',
      })).resolves.toMatchObject({
        durableAuthority: 'notion',
        durableRootPresent: true,
        configuredRootMatchesDurable: true,
        activeSnapshotPresent: true,
        activeSnapshotPageCount: 1,
        activeSnapshotChunkCount: 1,
        activeSnapshotReadable: true,
        syncInProgress: true,
        latestSyncAttempt: {
          outcome: 'running',
          successfulSnapshotMatchesActive: null,
        },
      });
      await expect(notionRepository.acquireSyncLease(
        universeId,
        holderB,
        5_000
      )).resolves.toBeNull();
      const liveLease = await observer.query<{
        holder_id: string;
        lease_token: string;
        live: boolean;
      }>(
        `SELECT
           holder_id,
           lease_token::TEXT,
           expires_at > clock_timestamp() AS live
         FROM backstage_notion_sync_leases
         WHERE universe_id = $1`,
        [universeId]
      );
      expect(liveLease.rows).toEqual([{
        holder_id: holderA,
        lease_token: leaseA!.leaseToken,
        live: true,
      }]);

      await observer.query(
        `SELECT pg_sleep(
           (
             GREATEST(
               0,
               EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))
             ) + 0.050
           )::DOUBLE PRECISION
         )
         FROM backstage_notion_sync_leases
         WHERE universe_id = $1`,
        [universeId]
      );
      const expired = await observer.query<{ expired: boolean }>(
        `SELECT expires_at <= clock_timestamp() AS expired
         FROM backstage_notion_sync_leases
         WHERE universe_id = $1`,
        [universeId]
      );
      expect(expired.rows).toEqual([{ expired: true }]);

      const leaseB = await notionRepository.acquireSyncLease(
        universeId,
        holderB,
        5_000
      );
      expect(leaseB).not.toBeNull();
      expect(leaseB!.leaseToken).not.toBe(leaseA!.leaseToken);
      const attemptB = await syncStatusRepository.beginSyncAttempt({
        universeId,
        lease: leaseB!,
      });
      expect(BigInt(attemptB.generation)).toBe(BigInt(attemptA.generation) + 1n);
      await expect(syncStatusRepository.completeSyncAttempt({
        universeId,
        attemptId: attemptA.attemptId,
        generation: attemptA.generation,
        outcome: 'failed',
        failurePhase: 'lease',
        failureReason: 'lease_lost',
        pagesDiscovered: 0,
        pagesFetched: 0,
        blocksFetched: 0,
        chunksProduced: 0,
        chunksEmbedded: 0,
        candidateSnapshotCreated: false,
        candidateSnapshotValidated: false,
        candidateSnapshotActivated: false,
        activatedSnapshotId: null,
      })).resolves.toBeNull();

      const staleInput = notionSnapshotInput({
        universeId,
        rootPageId,
        lease: leaseA!,
        label: 'stale-a',
      });
      expect(staleInput.manifestHash).toBe(staleManifest);
      await expect(notionRepository.activateSnapshot(staleInput)).rejects.toMatchObject({
        name: 'BackstageNotionSyncLeaseError',
      });

      const wrongRootInput = notionSnapshotInput({
        universeId,
        rootPageId: wrongRootPageId,
        lease: leaseB!,
        label: 'wrong-root-b',
      });
      expect(wrongRootInput.manifestHash).toBe(wrongRootManifest);
      await expect(notionRepository.activateSnapshot(wrongRootInput)).rejects.toMatchObject({
        name: 'BackstageNotionSnapshotWriteError',
        phase: 'activation',
      });

      const retainedHead = await observer.query<{ active_snapshot_id: string }>(
        `SELECT active_snapshot_id::TEXT
         FROM backstage_notion_universe_heads
         WHERE universe_id = $1`,
        [universeId]
      );
      expect(retainedHead.rows).toEqual([{ active_snapshot_id: prior.id }]);
      await expect(notionRepository.loadActiveSnapshot(
        universeId,
        BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT
      )).resolves.toMatchObject({
        snapshot: { id: prior.id, chunkCount: 1 },
        chunks: [{ content: 'Synthetic authority chunk prior' }],
      });
      const failedCandidates = await observer.query<{ manifest_hash: string }>(
        `SELECT manifest_hash
         FROM backstage_notion_snapshots
         WHERE universe_id = $1
           AND manifest_hash = ANY($2::TEXT[])`,
        [universeId, [staleManifest, wrongRootManifest]]
      );
      expect(failedCandidates.rows).toEqual([]);

      const promoted = await notionRepository.activateSnapshot(notionSnapshotInput({
        universeId,
        rootPageId,
        lease: leaseB!,
        label: 'promoted-b',
      }));
      await expect(syncStatusRepository.completeSyncAttempt({
        universeId,
        attemptId: attemptB.attemptId,
        generation: attemptB.generation,
        outcome: 'activated',
        failurePhase: null,
        failureReason: null,
        pagesDiscovered: 1,
        pagesFetched: 1,
        blocksFetched: 1,
        chunksProduced: 1,
        chunksEmbedded: 1,
        candidateSnapshotCreated: true,
        candidateSnapshotValidated: true,
        candidateSnapshotActivated: true,
        activatedSnapshotId: promoted.id,
      })).resolves.toMatchObject({
        outcome: 'activated',
        activatedSnapshotId: promoted.id,
      });
      await expect(notionRepository.releaseSyncLease(
        universeId,
        leaseB!.holderId,
        leaseB!.leaseToken
      )).resolves.toBe(true);
      await expect(syncStatusRepository.loadMonolithAuthorityOperationalState({
        universeId,
        configuredRootPageId: rootPageId,
        expectedEmbeddingModel: 'pg18-notion-lease-model',
      })).resolves.toMatchObject({
        durableAuthority: 'notion',
        durableRootPresent: true,
        configuredRootMatchesDurable: true,
        activeSnapshotPresent: true,
        activeSnapshotPageCount: 1,
        activeSnapshotChunkCount: 1,
        activeSnapshotReadable: true,
        syncInProgress: false,
        latestSyncAttempt: {
          outcome: 'activated',
          successfulSnapshotMatchesActive: true,
          failurePhase: null,
          failureReason: null,
        },
      });
      const finalHead = await observer.query<{
        active_snapshot_id: string;
        sync_holder_id: string;
      }>(
        `SELECT
           head.active_snapshot_id::TEXT,
           snapshot.sync_holder_id
         FROM backstage_notion_universe_heads AS head
         INNER JOIN backstage_notion_snapshots AS snapshot
           ON snapshot.universe_id = head.universe_id
          AND snapshot.id = head.active_snapshot_id
         WHERE head.universe_id = $1`,
        [universeId]
      );
      expect(finalHead.rows).toEqual([{
        active_snapshot_id: promoted.id,
        sync_holder_id: holderB,
      }]);
      const committedSnapshots = await observer.query<{ snapshot_id: string }>(
        `SELECT id::TEXT AS snapshot_id
         FROM backstage_notion_snapshots
         WHERE universe_id = $1
         ORDER BY created_at, id`,
        [universeId]
      );
      expect(new Set(committedSnapshots.rows.map(row => row.snapshot_id))).toEqual(
        new Set([prior.id, promoted.id])
      );
    } finally {
      await resetDisposableNotionRagState(observer);
    }
  }, 30_000);

  test('activates 2,117 complete chunks and refuses a destructive V3 rollback', async () => {
    const universeId = 'notion-expanded-capacity-pg18';
    const rootPageId = randomUUID();
    const snapshotId = randomUUID();
    const pageId = rootPageId;

    await observer.query('BEGIN');
    try {
      await observer.query(
        `INSERT INTO backstage_notion_universe_heads (universe_id)
         VALUES ($1)`,
        [universeId]
      );
      await observer.query(
        `INSERT INTO backstage_notion_snapshots (
           id,
           universe_id,
           root_page_id,
           manifest_hash,
           embedding_model,
           page_count,
           chunk_count,
           sync_holder_id
         ) VALUES (
           $1::UUID,
           $2,
           $3,
           $4,
           'pg18-expanded-model',
           1,
           2117,
           'pg18-expanded'
         )`,
        [
          snapshotId,
          universeId,
          rootPageId,
          fingerprint(`expanded:${snapshotId}`),
        ]
      );
      await observer.query(
        `INSERT INTO backstage_notion_snapshot_pages (
           snapshot_id,
           universe_id,
           page_id,
           title,
           content_hash,
           markdown,
           depth,
           path,
           metadata
         ) VALUES (
           $1::UUID,
           $2,
           $3,
           'Expanded authority page',
           $4,
           '# Expanded authority page',
           0,
           '["Expanded authority page"]'::JSONB,
           jsonb_build_object('indexFormat', $5::TEXT)
         )`,
        [
          snapshotId,
          universeId,
          pageId,
          fingerprint(`expanded-page:${pageId}`),
          BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
        ]
      );
      await observer.query(
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
           encode(digest($1::TEXT || ':' || ordinal::TEXT, 'sha256'), 'hex'),
           $1::UUID,
           $2,
           $3,
           ordinal,
           encode(digest('content:' || ordinal::TEXT, 'sha256'), 'hex'),
           'Synthetic authoritative chunk ' || ordinal::TEXT,
           char_length('Synthetic authoritative chunk ' || ordinal::TEXT),
           'pg18-expanded-model',
           '[1]'::JSONB,
           '[]'::JSONB,
           '{}'::JSONB
         FROM generate_series(0, 2116) AS ordinal`,
        [snapshotId, universeId, pageId]
      );
      await populateNotionCandidateSearchSidecar(observer, universeId, snapshotId);
      await observer.query(
        `UPDATE backstage_notion_universe_heads
         SET authority = 'notion',
             active_snapshot_id = $2::UUID,
             activated_at = clock_timestamp(),
             last_verified_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE universe_id = $1`,
        [universeId, snapshotId]
      );

      const activated = await observer.query<{
        active_snapshot_id: string;
        chunk_count: string;
      }>(
        `SELECT
           head.active_snapshot_id::TEXT,
           COUNT(chunk.id)::TEXT AS chunk_count
         FROM backstage_notion_universe_heads AS head
         INNER JOIN backstage_notion_snapshot_chunks AS chunk
           ON chunk.universe_id = head.universe_id
          AND chunk.snapshot_id = head.active_snapshot_id
         WHERE head.universe_id = $1
         GROUP BY head.active_snapshot_id`,
        [universeId]
      );
      expect(activated.rows).toEqual([{
        active_snapshot_id: snapshotId,
        chunk_count: '2117',
      }]);

      await observer.query('SAVEPOINT expanded_v3_rollback_attempt');
      try {
        await observer.query(notionRagSnapshotCapacityRollbackBody);
        throw new Error('Expected expanded immutable history to block V3 rollback.');
      } catch (error: unknown) {
        await observer.query('ROLLBACK TO SAVEPOINT expanded_v3_rollback_attempt');
        expect(errorCode(error)).toBe('55000');
      } finally {
        await observer.query('RELEASE SAVEPOINT expanded_v3_rollback_attempt');
      }

      const retained = await observer.query<{ active_snapshot_id: string }>(
        `SELECT active_snapshot_id::TEXT
         FROM backstage_notion_universe_heads
         WHERE universe_id = $1`,
        [universeId]
      );
      expect(retained.rows).toEqual([{ active_snapshot_id: snapshotId }]);
    } finally {
      await observer.query('ROLLBACK');
    }
  }, 60_000);

  test('normalizes UUID defaults independently of the runtime search path', async () => {
    await observer.query(
      `ALTER TABLE public.backstage_storyline_threads
         ALTER COLUMN id SET DEFAULT public.gen_random_uuid();
       ALTER TABLE public.backstage_storyline_canon_beats
         ALTER COLUMN id SET DEFAULT public.gen_random_uuid();`
    );
    await observer.query('SET search_path TO "$user", public');

    try {
      await applyCanonForwardMigration(observer);
      await observer.query(runtimeCanonVerifier);
      await observer.query('SET search_path TO public, pg_catalog');

      const defaults = await observer.query<{
        table_name: string;
        default_expression: string;
      }>(
        `SELECT
           table_class.relname AS table_name,
           pg_get_expr(
             attribute_default.adbin,
             attribute_default.adrelid,
             false
           ) AS default_expression
         FROM pg_attrdef AS attribute_default
         INNER JOIN pg_class AS table_class
           ON table_class.oid = attribute_default.adrelid
         INNER JOIN pg_attribute AS attribute
           ON attribute.attrelid = attribute_default.adrelid
          AND attribute.attnum = attribute_default.adnum
         WHERE table_class.relnamespace = 'public'::REGNAMESPACE
           AND table_class.relname = ANY($1::TEXT[])
           AND attribute.attname = 'id'
         ORDER BY table_class.relname`,
        [[
          'backstage_storyline_canon_beats',
          'backstage_storyline_threads'
        ]]
      );
      expect(defaults.rows).toEqual([
        {
          table_name: 'backstage_storyline_canon_beats',
          default_expression: 'pg_catalog.gen_random_uuid()'
        },
        {
          table_name: 'backstage_storyline_threads',
          default_expression: 'pg_catalog.gen_random_uuid()'
        }
      ]);
    } finally {
      await observer.query('SET search_path TO public, pg_catalog');
    }
  }, 60_000);

  test('trims saved-storyline leading whitespace before applying the read projection cap', async () => {
    const trimStartWhitespace = (
      '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680'
      + '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A'
      + '\u2028\u2029\u202F\u205F\u3000\uFEFF'
    ).repeat(100);
    const meaningfulContent = 'N'.repeat(1_502);

    await repository.saveStoryline(
      universeA,
      'leading-whitespace',
      `${trimStartWhitespace}${meaningfulContent}`
    );

    const context = await repository.loadContext(universeA, {
      universeReadProjection: true
    });

    expect(context.storylines).toEqual([
      expect.objectContaining({
        storyKey: 'leading-whitespace',
        storyline: 'N'.repeat(1_501)
      })
    ]);
  });

  test('exact-reads and reconstructs a maximum canon summary through PostgreSQL', async () => {
    const storyKey = 'raw/day one?100% + 🎤';
    const summary = '🤼'.repeat(10_000);
    await repository.upsertStoryline(storylineInput(
      universeA,
      storyKey,
      [],
      { summary }
    ));

    const first = await readBackstageStorylineSummary(
      universeA,
      storyKey,
      {
        reader: repository,
        authorityResolver: async () => false,
      }
    );
    const second = await readBackstageStorylineSummary(
      universeA,
      storyKey,
      {
        reader: repository,
        authorityResolver: async () => false,
        offset: first.summaryPage.nextOffset!,
        expectedVersion: first.storyline.version,
      }
    );
    const third = await readBackstageStorylineSummary(
      universeA,
      storyKey,
      {
        reader: repository,
        authorityResolver: async () => false,
        offset: second.summaryPage.nextOffset!,
        expectedVersion: first.storyline.version,
      }
    );

    expect([
      first.summaryPage.text,
      second.summaryPage.text,
      third.summaryPage.text,
    ].join('')).toBe(summary);
    expect(third.summaryPage).toMatchObject({
      endCodePointExclusive: 10_000,
      totalCodePoints: 10_000,
      hasMore: false,
      nextOffset: null,
    });
  });

  test('serializes concurrent update CAS attempts without a revision gap', async () => {
    const created = await repository.upsertStoryline(
      storylineInput(universeA, 'concurrent-cas', ['Aster'])
    );
    expect(created.storyline.version).toBe(1);
    expect(created.revision).toBe('1');

    const firstUpdate = storylineInput(universeA, 'concurrent-cas', ['Aster'], {
      expectedVersion: 1,
      title: 'Concurrent winner one'
    });
    const secondUpdate = storylineInput(universeA, 'concurrent-cas', ['Aster'], {
      expectedVersion: 1,
      title: 'Concurrent winner two'
    });
    const attempts = await Promise.allSettled([
      repository.upsertStoryline(firstUpdate),
      repository.upsertStoryline(secondUpdate)
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.upsertStoryline>>> =>
        result.status === 'fulfilled'
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.storyline.version).toBe(2);
    expect(fulfilled[0]?.value.revision).toBe('2');
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]?.reason)).toBe(
      'BACKSTAGE_STORYLINE_VERSION_CONFLICT'
    );

    const stored = await observer.query<{
      head_revision: string;
      revisions: string[];
      thread_version: number;
    }>(
      `SELECT
         head.revision::TEXT AS head_revision,
         ARRAY(
           SELECT revision::TEXT
           FROM backstage_canon_revisions
           WHERE universe_id = $1
           ORDER BY revision
         ) AS revisions,
         thread.version AS thread_version
       FROM backstage_canon_heads AS head
       INNER JOIN backstage_storyline_threads AS thread
         ON thread.universe_id = head.universe_id
       WHERE head.universe_id = $1
         AND thread.story_key = 'concurrent-cas'`,
      [universeA]
    );
    expect(stored.rows).toEqual([{
      head_revision: '2',
      revisions: ['1', '2'],
      thread_version: 2
    }]);
  }, 15_000);

  test('replays exact mutations without duplicate beats or revision gaps', async () => {
    const createInput = storylineInput(universeA, 'idempotent-canon', ['Shared']);
    const created = await repository.upsertStoryline(createInput);
    const createReplay = await repository.upsertStoryline(createInput);

    expect(createReplay.replayed).toBe(true);
    expect(createReplay.revision).toBe(created.revision);
    expect(createReplay.storyline.id).toBe(created.storyline.id);

    const firstBeatInput = beatInput(
      universeA,
      'idempotent-canon',
      1,
      ['Shared'],
      { eventId: eventAId }
    );
    const firstBeat = await repository.appendCanonBeat(firstBeatInput);
    const beatReplay = await repository.appendCanonBeat(firstBeatInput);
    expect(beatReplay.replayed).toBe(true);
    expect(beatReplay.revision).toBe(firstBeat.revision);
    expect(beatReplay.beat.id).toBe(firstBeat.beat.id);

    const secondBeat = await repository.appendCanonBeat(
      beatInput(universeA, 'idempotent-canon', 2, ['Shared'], {
        eventId: eventAId,
        occurredAt: '2026-08-14T19:00:00.000Z'
      })
    );
    expect(secondBeat.beat.sequence).toBe(2);
    expect(secondBeat.revision).toBe('3');

    const stored = await observer.query<{
      head_revision: string;
      revisions: string[];
      sequences: number[];
    }>(
      `SELECT
         head.revision::TEXT AS head_revision,
         ARRAY(
           SELECT revision::TEXT
           FROM backstage_canon_revisions
           WHERE universe_id = $1
           ORDER BY revision
         ) AS revisions,
         ARRAY(
           SELECT sequence
           FROM backstage_storyline_canon_beats
           WHERE universe_id = $1
           ORDER BY sequence
         ) AS sequences
       FROM backstage_canon_heads AS head
       WHERE head.universe_id = $1`,
      [universeA]
    );
    expect(stored.rows).toEqual([{
      head_revision: '3',
      revisions: ['1', '2', '3'],
      sequences: [1, 2]
    }]);
  });

  test('rejects cross-universe roster, event, and supersede references', async () => {
    await expect(repository.upsertStoryline(
      storylineInput(universeB, 'wrong-roster-scope', ['Aster'])
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_REFERENCE_INVALID'
    });

    await repository.upsertStoryline(
      storylineInput(universeA, 'universe-a-thread', ['Shared'])
    );
    await repository.upsertStoryline(
      storylineInput(universeB, 'universe-b-thread', ['Shared'])
    );
    const universeABeat = await repository.appendCanonBeat(
      beatInput(universeA, 'universe-a-thread', 1, ['Shared'], {
        eventId: eventAId
      })
    );

    await expect(repository.appendCanonBeat(
      beatInput(universeB, 'universe-b-thread', 1, ['Shared'], {
        eventId: eventAId
      })
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_REFERENCE_INVALID'
    });
    await expect(repository.appendCanonBeat(
      beatInput(universeB, 'universe-b-thread', 1, ['Shared'], {
        supersedesBeatId: universeABeat.beat.id
      })
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_CANON_BEAT_CONFLICT'
    });

    const universeBState = await observer.query<{
      head_revision: string;
      thread_version: number;
      beat_count: string;
    }>(
      `SELECT
         head.revision::TEXT AS head_revision,
         thread.version AS thread_version,
         COUNT(beat.id)::TEXT AS beat_count
       FROM backstage_canon_heads AS head
       INNER JOIN backstage_storyline_threads AS thread
         ON thread.universe_id = head.universe_id
       LEFT JOIN backstage_storyline_canon_beats AS beat
         ON beat.universe_id = thread.universe_id
        AND beat.storyline_id = thread.id
       WHERE head.universe_id = $1
         AND thread.story_key = 'universe-b-thread'
       GROUP BY head.revision, thread.version`,
      [universeB]
    );
    expect(universeBState.rows).toEqual([{
      head_revision: '1',
      thread_version: 1,
      beat_count: '0'
    }]);
  });

  test('refuses populated rollback with 55000 and succeeds only after canon is empty', async () => {
    await repository.upsertStoryline(
      storylineInput(universeA, 'rollback-guard', ['Aster'])
    );

    try {
      await observer.query(canonRollbackMigration);
      throw new Error('Expected populated canon rollback to be refused.');
    } catch (error: unknown) {
      expect(errorCode(error)).toBe('55000');
    }
    await observer.query('ROLLBACK');

    const preserved = await observer.query<{ revision_count: string; thread_count: string }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM backstage_canon_revisions) AS revision_count,
         (SELECT COUNT(*)::TEXT FROM backstage_storyline_threads) AS thread_count`
    );
    expect(preserved.rows).toEqual([{ revision_count: '1', thread_count: '1' }]);

    await observer.query(
      `TRUNCATE TABLE
         backstage_storyline_canon_beats,
         backstage_storyline_participants,
         backstage_storyline_threads,
         backstage_canon_revisions,
         backstage_canon_heads
       CASCADE`
    );
    await resetDisposableNotionRagState(observer);
    await observer.query(notionRagCandidateSearchRollback);
    await observer.query(notionRagSyncStatusRollback);
    await observer.query(notionRagSnapshotCapacityRollback);
    await observer.query(notionRagIndexVersionFenceRollback);
    await observer.query(notionRagRollbackMigration);
    await observer.query(canonRollbackMigration);

    const removed = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [phaseTwoTables]
    );
    expect(removed.rows).toEqual([]);

    const retainedBaseTables = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [baseTables]
    );
    expect(retainedBaseTables.rows.map(row => row.table_name)).toEqual([
      ...baseTables
    ].sort());

    const retainedEventIdentity = await observer.query<{ retained: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint
         WHERE conrelid = 'public.backstage_events'::regclass
           AND conname = 'uq_backstage_events_universe_id'
       ) AS retained`
    );
    expect(retainedEventIdentity.rows).toEqual([{ retained: true }]);
  }, 30_000);
});
