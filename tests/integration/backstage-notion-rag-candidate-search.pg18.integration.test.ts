import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client, Pool, type QueryResult } from 'pg';

import {
  isBackstageNotionCandidateQueryTimeoutError,
  PostgresBackstageNotionRagRepository,
  type BackstageNotionSnapshotCandidateSearch,
} from '../../src/core/db/repositories/backstageNotionRagRepository.js';
import { PostgresBackstageNotionSyncStatusRepository } from '../../src/core/db/repositories/backstageNotionSyncStatusRepository.js';
import { runWithBackstageNotionEnrichmentAuthorization } from '../../src/services/backstageNotionEnrichmentAuthorization.js';
import {
  retrieveBackstageNotionBookingRagContext,
  retrieveBackstageNotionRagContext,
} from '../../src/services/backstageNotionRag.js';
import { syncBackstageNotionAuthorityRoot } from '../../src/services/backstageNotionSync.js';
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from '../../src/services/openai/embeddings.js';
import { BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME } from '../../src/shared/backstage/backstageNotionContextCore.js';
import { BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION } from '../../src/shared/backstage/backstageNotionRagCore.js';
import { BACKSTAGE_NOTION_RAG_INDEX_FORMAT } from '../../src/shared/backstage/backstageNotionScopeIndex.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl,
} from './postgresTestDatabase.js';

const execFileAsync = promisify(execFile);
const TEST_DATABASE_ENV = 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL';
const BACKFILL_DATABASE_ENV = 'BACKSTAGE_NOTION_CANDIDATE_BACKFILL_DATABASE_URL';
const configuredConnectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredConnectionString) {
  assertDisposablePostgresTestDatabaseUrl(configuredConnectionString, TEST_DATABASE_ENV);
}
const describeWithDatabase = configuredConnectionString ? describe : describe.skip;

const readMigration = (name: string): string => readFileSync(
  join(process.cwd(), 'migrations', name),
  'utf8'
);
const universeScopeForwardMigration = readMigration(
  '20260814_backstage_universe_scope_v1.sql'
);
const canonForwardMigration = readMigration(
  '20260814_backstage_canon_storyline_v1.sql'
);
const canonRollbackMigration = readMigration(
  '20260814_backstage_canon_storyline_v1.rollback.sql'
);
const notionRagForwardMigration = readMigration(
  '20260819_backstage_notion_rag_v1.sql'
);
const notionRagRollbackMigration = readMigration(
  '20260819_backstage_notion_rag_v1.rollback.sql'
);
const notionRagV2Migration = readMigration(
  '20260819_backstage_notion_rag_v2_index_version_fence.sql'
);
const notionRagV2Rollback = readMigration(
  '20260819_backstage_notion_rag_v2_index_version_fence.rollback.sql'
);
const notionRagV3Migration = readMigration(
  '20260829_backstage_notion_rag_v3_snapshot_capacity.sql'
);
const notionRagV3Rollback = readMigration(
  '20260829_backstage_notion_rag_v3_snapshot_capacity.rollback.sql'
);
const syncStatusMigration = readMigration(
  '20260829_backstage_notion_rag_v4_sync_status.sql'
);
const syncStatusRollback = readMigration(
  '20260829_backstage_notion_rag_v4_sync_status.rollback.sql'
);
const candidateSearchMigration = readMigration(
  '20260902_backstage_notion_rag_candidate_search_v1.sql'
);
const candidateSearchRollback = readMigration(
  '20260902_backstage_notion_rag_candidate_search_v1.rollback.sql'
);

const canonTransactionStart = canonForwardMigration.indexOf('\nBEGIN;');
if (canonTransactionStart < 0) {
  throw new Error('Backstage canon migration is missing its transaction phase.');
}
const canonConcurrentPhase = canonForwardMigration.slice(0, canonTransactionStart).trim();
const canonTransactionalPhase = canonForwardMigration.slice(canonTransactionStart).trim();

const embeddingDimension = 1_536;
const embeddingModel = DEFAULT_OPENAI_EMBEDDING_MODEL;
const resultLimit = 128;

type CapturedQuery = Readonly<{
  text: string;
  values: readonly unknown[];
}>;

type PlanNode = Readonly<Record<string, unknown>> & Readonly<{
  Plans?: readonly PlanNode[];
}>;

type PlanEnvelope = Readonly<{
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}>;

type BenchmarkPlan = Readonly<{
  planningTimeMs: number;
  executionTimeMs: number;
  actualRows: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  sharedDirtiedBlocks: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  rowsScannedActual: number;
  rowsScoredActual: number;
  dominantNodes: readonly Readonly<{
    nodeType: string;
    actualRows: number;
    loops: number;
    totalTimeMs: number;
    detail: string | null;
  }>[];
}>;

type CorpusFixture = Readonly<{
  universeId: string;
  snapshotId: string;
  rootPageId: string;
  count: number;
  queryEmbedding: readonly number[];
}>;

type BackfillReport = Readonly<{
  completed?: boolean;
  targetDigest?: string;
  batchCount?: number;
  insertedCount?: number;
  chunkCount?: number;
  maxBatchDurationMs?: number;
  durationMs?: number;
}>;

type BackfillExecution = Readonly<{
  succeeded: boolean;
  stdout: string;
  stderr: string;
  report: BackfillReport | null;
}>;

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function expectedBackfillTargetDigest(
  fixture: CorpusFixture,
  expectedChunks = fixture.count
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'backstage-notion-candidate-backfill-target/v1',
      fixture.universeId,
      fixture.snapshotId,
      expectedChunks,
    ]), 'utf8')
    .digest('hex');
}

async function runBackfill(
  fixture: CorpusFixture,
  expectedChunks = fixture.count,
  batchSize = 128
): Promise<BackfillExecution> {
  try {
    const execution = await execFileAsync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'backstage-notion-candidate-search-backfill.mjs'),
        '--universe-id',
        fixture.universeId,
        '--snapshot-id',
        fixture.snapshotId,
        '--expected-chunks',
        String(expectedChunks),
        '--batch-size',
        String(batchSize),
        '--execute',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          [BACKFILL_DATABASE_ENV]: configuredConnectionString,
        },
        timeout: 300_000,
        maxBuffer: 1_048_576,
      }
    );
    const stdout = String(execution.stdout);
    const stderr = String(execution.stderr);
    return {
      succeeded: true,
      stdout,
      stderr,
      report: JSON.parse(stdout.trim()) as BackfillReport,
    };
  } catch (error) {
    if (typeof error !== 'object' || error === null) {
      throw error;
    }
    const details = error as { stdout?: unknown; stderr?: unknown };
    return {
      succeeded: false,
      stdout: details.stdout === undefined ? '' : String(details.stdout),
      stderr: details.stderr === undefined ? '' : String(details.stderr),
      report: null,
    };
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function flattenPlan(root: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = [root];
  for (const child of root.Plans ?? []) {
    nodes.push(...flattenPlan(child));
  }
  return nodes;
}

function summarizePlan(plan: PlanEnvelope): BenchmarkPlan {
  const nodes = flattenPlan(plan.Plan);
  const actualRowsForNamedNode = (pattern: RegExp): number => Math.max(
    0,
    ...nodes
      .filter(node => pattern.test([
        node['Subplan Name'],
        node['CTE Name'],
      ].filter(value => typeof value === 'string').join(' ')))
      .map(node => finiteNumber(node['Actual Rows']) * finiteNumber(node['Actual Loops']))
  );
  return {
    planningTimeMs: finiteNumber(plan['Planning Time']),
    executionTimeMs: finiteNumber(plan['Execution Time']),
    actualRows: finiteNumber(plan.Plan['Actual Rows']),
    sharedHitBlocks: finiteNumber(plan.Plan['Shared Hit Blocks']),
    sharedReadBlocks: finiteNumber(plan.Plan['Shared Read Blocks']),
    sharedDirtiedBlocks: finiteNumber(plan.Plan['Shared Dirtied Blocks']),
    tempReadBlocks: finiteNumber(plan.Plan['Temp Read Blocks']),
    tempWrittenBlocks: finiteNumber(plan.Plan['Temp Written Blocks']),
    rowsScannedActual: actualRowsForNamedNode(/eligible_chunk/iu),
    rowsScoredActual: actualRowsForNamedNode(/scored_candidate/iu),
    dominantNodes: nodes
      .map(node => ({
        nodeType: typeof node['Node Type'] === 'string' ? node['Node Type'] : 'unknown',
        actualRows: finiteNumber(node['Actual Rows']),
        loops: finiteNumber(node['Actual Loops']),
        totalTimeMs: finiteNumber(node['Actual Total Time']),
        detail: [node['Subplan Name'], node['CTE Name'], node['Relation Name']]
          .find(value => typeof value === 'string') as string | undefined ?? null,
      }))
      .sort((left, right) => right.totalTimeMs - left.totalTimeMs)
      .slice(0, 8),
  };
}

function isCandidateSql(text: string): boolean {
  return text.includes('limited_candidates AS MATERIALIZED')
    && text.includes('candidate_pool AS MATERIALIZED');
}

function createCapturedPool(
  pool: Pool,
  forceLegacy: boolean,
  capture: { value: CapturedQuery | null }
): Pool {
  let injectedUndefinedTable = false;
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (
          textOrConfig: string | { text: string; values?: readonly unknown[] },
          values?: readonly unknown[]
        ): Promise<QueryResult> => {
          const text = typeof textOrConfig === 'string'
            ? textOrConfig
            : textOrConfig.text;
          const queryValues = typeof textOrConfig === 'string'
            ? (values ?? [])
            : (textOrConfig.values ?? []);
          if (isCandidateSql(text)) {
            capture.value = { text, values: [...queryValues] };
            if (
              forceLegacy
              && !injectedUndefinedTable
              && text.includes('backstage_notion_snapshot_chunk_search AS search')
            ) {
              injectedUndefinedTable = true;
              throw Object.assign(new Error('synthetic undefined sidecar'), { code: '42P01' });
            }
          }
          return client.query(textOrConfig as never, values as never);
        },
        release: (discard?: boolean | Error) => client.release(discard),
      };
    },
  } as unknown as Pool;
}

async function explainCapturedQuery(
  client: Client,
  captured: CapturedQuery
): Promise<BenchmarkPlan> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(
      `SELECT
         set_config('lock_timeout', '1s', TRUE),
         set_config('statement_timeout', '60s', TRUE),
         set_config('idle_in_transaction_session_timeout', '60s', TRUE),
         set_config('work_mem', '8MB', TRUE),
         set_config('temp_file_limit', '256MB', TRUE)`
    );
    const explained = await client.query<{ 'QUERY PLAN': PlanEnvelope[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured.text}`,
      [...captured.values]
    );
    const envelope = explained.rows[0]?.['QUERY PLAN']?.[0];
    if (!envelope) {
      throw new Error('Candidate EXPLAIN did not return a JSON plan.');
    }
    await client.query('COMMIT');
    return summarizePlan(envelope);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function insertCorpus(
  client: Client,
  count: number,
  label: string,
  populateSidecar: boolean
): Promise<CorpusFixture> {
  const universeId = `candidate-pg18-${label}-${randomUUID().slice(0, 8)}`;
  const snapshotId = randomUUID();
  const pageIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const pageTitles = ['Raw Authority', 'SmackDown Authority', 'NXT Authority', 'General Authority'];
  const queryEmbedding = Array.from({ length: embeddingDimension }, (_unused, index) => (
    index === 0 ? 1 : index === 1 ? 0.5 : ((index % 17) - 8) / 1_000
  ));
  const embeddingJson = JSON.stringify(queryEmbedding);

  await client.query(
    `INSERT INTO public.backstage_notion_universe_heads (universe_id)
     VALUES ($1)`,
    [universeId]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_snapshots (
       id, universe_id, root_page_id, manifest_hash, embedding_model,
       page_count, chunk_count, sync_holder_id
     ) VALUES ($1::UUID, $2, $3, $4, $5, 4, $6, 'candidate-pg18-fixture')`,
    [
      snapshotId,
      universeId,
      pageIds[0],
      fingerprint(`manifest:${label}:${count}`),
      embeddingModel,
      count,
    ]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_snapshot_pages (
       snapshot_id, universe_id, page_id, parent_page_id, title,
       content_hash, markdown, depth, path, metadata
     )
     SELECT
       $1::UUID,
       $2,
       page.page_id,
       NULL::TEXT,
       page.title,
       md5(page.title) || md5('page:' || page.title),
       '# ' || page.title,
       0,
       jsonb_build_array(page.title),
       jsonb_build_object('indexFormat', $5::TEXT)
     FROM unnest($3::TEXT[], $4::TEXT[]) AS page(page_id, title)`,
    [snapshotId, universeId, pageIds, pageTitles, BACKSTAGE_NOTION_RAG_INDEX_FORMAT]
  );
  await client.query(
    `WITH source AS MATERIALIZED (
       SELECT
         sequence,
         (($1::UUID::TEXT || ':' || sequence::TEXT)) AS identity,
         (($1::UUID::TEXT || ':hash:' || sequence::TEXT)) AS hash_identity,
         ((sequence - 1) % 4) + 1 AS brand_position,
         ((sequence - 1) / 4)::INTEGER AS ordinal
       FROM generate_series(1, $6::INTEGER) AS generated(sequence)
     ), shaped AS MATERIALIZED (
       SELECT
         source.*,
         ($3::TEXT[])[source.brand_position] AS page_id,
         ($4::TEXT[])[source.brand_position] AS page_title,
         CASE source.brand_position
           WHEN 1 THEN 'Raw championship continuity booking candidate '
           WHEN 2 THEN 'SmackDown championship continuity booking candidate '
           WHEN 3 THEN 'NXT championship continuity booking candidate '
           ELSE 'General continuity booking candidate '
         END || source.sequence::TEXT AS content
       FROM source
     ), canonical AS MATERIALIZED (
       SELECT
         shaped.*,
         encode(digest(shaped.content, 'sha256'), 'hex') AS content_hash
       FROM shaped
     )
     INSERT INTO public.backstage_notion_snapshot_chunks (
       id, snapshot_id, universe_id, page_id, ordinal, content_hash,
       content, code_points, embedding_model, embedding, heading_path, metadata
     )
     SELECT
       encode(digest(
         '{"format":"backstage-notion-rag-chunk-v1","pageId":"'
           || canonical.page_id
           || '","ordinal":'
           || canonical.ordinal::TEXT
           || ',"contentHash":"'
           || canonical.content_hash
           || '"}',
         'sha256'
       ), 'hex'),
       $1::UUID,
       $2,
       canonical.page_id,
       canonical.ordinal,
       canonical.content_hash,
       canonical.content,
       char_length(canonical.content),
       $5,
       jsonb_set(
         $7::JSONB,
         '{0}',
         to_jsonb(1::DOUBLE PRECISION + ((canonical.sequence % 29) * 0.0001))
       ),
       '[]'::JSONB,
       jsonb_build_object(
         'headingOccurrencePath', '[]'::JSONB,
         'headingIndexVersion', $8::INTEGER,
         'sourceHash', canonical.content_hash,
         'sourceLastEditedAt', NULL,
         'category', lower(split_part(canonical.page_title, ' ', 1))
       )
     FROM canonical`,
    [
      snapshotId,
      universeId,
      pageIds,
      pageTitles,
      embeddingModel,
      count,
      embeddingJson,
      BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
    ]
  );

  if (populateSidecar) {
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
         cardinality(material.native_embedding),
         public.backstage_notion_candidate_embedding_norm(material.native_embedding),
         material.native_embedding,
         public.backstage_notion_candidate_search_vector(
           chunk.content,
           page.title,
           page.path,
           chunk.heading_path,
           chunk.metadata ->> 'category'
         ),
         public.backstage_notion_candidate_brand_mask(
           page.title,
           page.path,
           chunk.heading_path,
           chunk.metadata ->> 'category'
         )
       FROM public.backstage_notion_snapshot_chunks AS chunk
       INNER JOIN public.backstage_notion_snapshot_pages AS page
         ON page.universe_id = chunk.universe_id
        AND page.snapshot_id = chunk.snapshot_id
        AND page.page_id = chunk.page_id
       CROSS JOIN LATERAL (
         SELECT public.backstage_notion_candidate_embedding_from_jsonb(
           chunk.embedding
         ) AS native_embedding
       ) AS material
       WHERE chunk.universe_id = $1
         AND chunk.snapshot_id = $2::UUID`,
      [universeId, snapshotId]
    );
  }

  await client.query(
    `UPDATE public.backstage_notion_universe_heads
     SET authority = 'notion',
         active_snapshot_id = $2::UUID,
         activated_at = clock_timestamp(),
         last_verified_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE universe_id = $1`,
    [universeId, snapshotId]
  );

  return {
    universeId,
    snapshotId,
    rootPageId: pageIds[0],
    count,
    queryEmbedding,
  };
}

async function insertLegacyActiveCorpus(
  client: Client,
  count: number,
  label: string
): Promise<CorpusFixture> {
  await client.query(candidateSearchRollback);
  try {
    return await insertCorpus(client, count, label, false);
  } finally {
    await client.query(candidateSearchMigration);
  }
}

async function insertFirstDerivedSidecarRow(
  client: Client,
  fixture: CorpusFixture,
  input: Readonly<{
    embeddingNorm?: string | null;
    corruptSearchVector?: boolean;
  }> = {}
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
       COALESCE(
         $3::DOUBLE PRECISION,
         public.backstage_notion_candidate_embedding_norm(material.native_embedding)
       ),
       material.native_embedding,
       CASE
         WHEN $4::BOOLEAN THEN pg_catalog.to_tsvector(
           'simple'::pg_catalog.regconfig,
           'deliberately mismatched search material'
         )
         ELSE public.backstage_notion_candidate_search_vector(
           chunk.content,
           page.title,
           page.path,
           chunk.heading_path,
           chunk.metadata ->> 'category'
         )
       END,
       public.backstage_notion_candidate_brand_mask(
         page.title,
         page.path,
         chunk.heading_path,
         chunk.metadata ->> 'category'
       )
     FROM public.backstage_notion_snapshot_chunks AS chunk
     INNER JOIN public.backstage_notion_snapshot_pages AS page
       ON page.universe_id = chunk.universe_id
      AND page.snapshot_id = chunk.snapshot_id
      AND page.page_id = chunk.page_id
     CROSS JOIN LATERAL (
       SELECT public.backstage_notion_candidate_embedding_from_jsonb(
         chunk.embedding
       ) AS native_embedding
     ) AS material
     WHERE chunk.universe_id = $1
       AND chunk.snapshot_id = $2::UUID
     ORDER BY chunk.id COLLATE "C"
     LIMIT 1`,
    [
      fixture.universeId,
      fixture.snapshotId,
      input.embeddingNorm ?? null,
      input.corruptSearchVector ?? false,
    ]
  );
}

async function cloneCompleteSnapshot(
  client: Client,
  fixture: CorpusFixture,
  populateSidecar = true
): Promise<string> {
  const replacementSnapshotId = randomUUID();
  await client.query(
    `INSERT INTO public.backstage_notion_snapshots (
       id, universe_id, root_page_id, manifest_hash, embedding_model,
       page_count, chunk_count, source_max_edited_at, sync_holder_id
     )
     SELECT
       $3::UUID,
       snapshot.universe_id,
       snapshot.root_page_id,
       $4,
       snapshot.embedding_model,
       snapshot.page_count,
       snapshot.chunk_count,
       snapshot.source_max_edited_at,
       'candidate-pg18-head-rotation'
     FROM public.backstage_notion_snapshots AS snapshot
     WHERE snapshot.universe_id = $1
       AND snapshot.id = $2::UUID`,
    [
      fixture.universeId,
      fixture.snapshotId,
      replacementSnapshotId,
      fingerprint(`replacement:${fixture.snapshotId}`),
    ]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_snapshot_pages (
       snapshot_id, universe_id, page_id, parent_page_id, title,
       canonical_url, content_hash, markdown, source_last_edited_at,
       depth, path, metadata
     )
     SELECT
       $3::UUID,
       page.universe_id,
       page.page_id,
       page.parent_page_id,
       page.title,
       page.canonical_url,
       page.content_hash,
       page.markdown,
       page.source_last_edited_at,
       page.depth,
       page.path,
       page.metadata
     FROM public.backstage_notion_snapshot_pages AS page
     WHERE page.universe_id = $1
       AND page.snapshot_id = $2::UUID`,
    [fixture.universeId, fixture.snapshotId, replacementSnapshotId]
  );
  await client.query(
    `INSERT INTO public.backstage_notion_snapshot_chunks (
       id, snapshot_id, universe_id, page_id, ordinal, content_hash,
       content, code_points, embedding_model, embedding, heading_path, metadata
     )
     SELECT
       chunk.id,
       $3::UUID,
       chunk.universe_id,
       chunk.page_id,
       chunk.ordinal,
       chunk.content_hash,
       chunk.content,
       chunk.code_points,
       chunk.embedding_model,
       chunk.embedding,
       chunk.heading_path,
       chunk.metadata
     FROM public.backstage_notion_snapshot_chunks AS chunk
     WHERE chunk.universe_id = $1
       AND chunk.snapshot_id = $2::UUID`,
    [fixture.universeId, fixture.snapshotId, replacementSnapshotId]
  );
  if (populateSidecar) {
    await client.query(
      `INSERT INTO public.backstage_notion_snapshot_chunk_search (
         universe_id, snapshot_id, chunk_id, page_id, ordinal,
         embedding_model, embedding_dimension, embedding_norm, embedding,
         search_vector, booking_brand_mask
       )
       SELECT
         search.universe_id,
         $3::UUID,
         search.chunk_id,
         search.page_id,
         search.ordinal,
         search.embedding_model,
         search.embedding_dimension,
         search.embedding_norm,
         search.embedding,
         search.search_vector,
         search.booking_brand_mask
       FROM public.backstage_notion_snapshot_chunk_search AS search
       WHERE search.universe_id = $1
         AND search.snapshot_id = $2::UUID`,
      [fixture.universeId, fixture.snapshotId, replacementSnapshotId]
    );
  }
  return replacementSnapshotId;
}

async function waitForBackfillFinalHeadLock(
  client: Client,
  executionPromise: Promise<BackfillExecution>
): Promise<void> {
  const deadlineAtMs = Date.now() + 5_000;
  let completedExecution: BackfillExecution | null = null;
  void executionPromise.then(execution => {
    completedExecution = execution;
  });
  while (Date.now() < deadlineAtMs) {
    await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
    const activity = await client.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_stat_activity AS activity
         WHERE activity.datname = pg_catalog.current_database()
           AND activity.pid <> pg_catalog.pg_backend_pid()
           AND activity.wait_event_type = 'Lock'
           AND activity.query LIKE '%backstage_notion_universe_heads%'
       ) AS waiting`
    );
    if (activity.rows[0]?.waiting === true) {
      return;
    }
    if (completedExecution !== null) {
      throw new Error(
        `Backfill exited before final authority-head lock: ${completedExecution.stderr.trim()}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Backfill did not reach its bounded final authority-head lock.');
}

function candidateInput(
  fixture: CorpusFixture,
  scope: 'generic' | 'raw' | 'smackdown' | 'nxt'
) {
  const scopeQuery = scope === 'generic'
    ? 'championship continuity booking'
    : `${scope === 'smackdown' ? 'SmackDown' : scope.toUpperCase()} championship continuity`;
  return {
    universeId: fixture.universeId,
    snapshotId: fixture.snapshotId,
    selector: {
      scopeKind: 'all' as const,
      pageId: null,
      sectionOccurrencePath: null,
    },
    expectedScopeChunkCount: fixture.count,
    embeddingModel,
    queryText: scopeQuery,
    queryEmbedding: fixture.queryEmbedding,
    limit: resultLimit,
    allowedBookingBrands: scope === 'generic' ? null : [scope] as const,
    remainingOperationBudgetMs: 15_500,
  };
}

async function benchmarkRank(input: {
  observer: Client;
  pool: Pool;
  fixture: CorpusFixture;
  scope: 'generic' | 'raw' | 'smackdown' | 'nxt';
  strategy: 'legacy' | 'native';
}): Promise<{
  result: BackstageNotionSnapshotCandidateSearch | null;
  timedOut: boolean;
  metrics: Readonly<Record<string, unknown>>;
}> {
  const capture: { value: CapturedQuery | null } = { value: null };
  const repository = new PostgresBackstageNotionRagRepository(
    createCapturedPool(input.pool, input.strategy === 'legacy', capture)
  );
  const startedAtMs = Date.now();
  let result: BackstageNotionSnapshotCandidateSearch | null = null;
  let timedOut = false;
  let timeoutClassification: string | null = null;
  try {
    result = await repository.rankSnapshotCandidates({
      ...candidateInput(input.fixture, input.scope),
      remainingOperationBudgetMs: input.strategy === 'legacy' ? 5_500 : 15_500,
    });
  } catch (error) {
    if (!isBackstageNotionCandidateQueryTimeoutError(error)) {
      throw error;
    }
    timedOut = true;
    timeoutClassification = error.classification;
  }
  const repositoryTotalDurationMs = Date.now() - startedAtMs;
  if (!capture.value) {
    throw new Error('Candidate benchmark did not capture the executed SQL.');
  }
  const plan = await explainCapturedQuery(input.observer, capture.value);
  const metrics = {
    protocol: 'backstage-notion-candidate-benchmark/v1',
    corpusChunks: input.fixture.count,
    embeddingDimension,
    scope: input.scope,
    strategy: input.strategy,
    timedOut,
    timeoutClassification,
    candidateSqlDurationMs: result?.queryDurationMs ?? null,
    candidateSqlTimeoutMs: result?.queryTimeoutMs ?? 15_000,
    repositoryTotalDurationMs,
    planningTimeMs: plan.planningTimeMs,
    explainExecutionTimeMs: plan.executionTimeMs,
    sharedHitBlocks: plan.sharedHitBlocks,
    sharedReadBlocks: plan.sharedReadBlocks,
    sharedDirtiedBlocks: plan.sharedDirtiedBlocks,
    tempReadBlocks: plan.tempReadBlocks,
    tempWrittenBlocks: plan.tempWrittenBlocks,
    planActualRows: plan.actualRows,
    rowsScannedActual: plan.rowsScannedActual,
    rowsScoredActual: plan.rowsScoredActual,
    scopeChunkCount: result?.scopeChunkCount ?? input.fixture.count,
    candidatePoolCount: result?.candidatePoolCount ?? null,
    semanticCandidateCount: result?.semanticCandidateCount ?? null,
    lexicalCandidateCount: result?.lexicalCandidateCount ?? null,
    mergedCandidateCount: result?.mergedCandidateCount ?? null,
    returnedCandidateCount: result?.candidates.length ?? null,
    dominantNodes: plan.dominantNodes,
  };
  process.stdout.write(`CANDIDATE_BENCHMARK ${JSON.stringify(metrics)}\n`);
  return { result, timedOut, metrics };
}

async function benchmarkContinuityRetrieval(
  pool: Pool,
  fixture: CorpusFixture
): Promise<void> {
  const repository = new PostgresBackstageNotionRagRepository(pool);
  const startedAtMs = Date.now();
  const retrieval = await runWithBackstageNotionEnrichmentAuthorization(
    true,
    () => retrieveBackstageNotionRagContext(
      fixture.universeId,
      'championship continuity booking',
      {
        repository,
        syncStatusRepository: {
          loadLatestSyncAttempt: async () => null,
        },
        resolveAuthorityRoot: () => ({
          universeId: fixture.universeId,
          rootPageId: fixture.rootPageId,
          displayName: 'Candidate benchmark authority',
        }),
        embedQuery: async () => [...fixture.queryEmbedding],
        remainingOperationBudgetMs: () => 15_500,
        now: () => new Date(),
        maximumStalenessMs: 60 * 60 * 1_000,
      }
    )
  );
  const continuityRetrievalDurationMs = Date.now() - startedAtMs;
  expect(retrieval.coverage.selectedChunks).toBeGreaterThan(0);
  expect(retrieval.coverage.selectedChunks).toBeLessThanOrEqual(16);
  expect(retrieval.chunkCount).toBe(retrieval.citations.length);
  expect(retrieval.chunkCount).toBeLessThanOrEqual(16);
  process.stdout.write(`CONTINUITY_RETRIEVAL_BENCHMARK ${JSON.stringify({
    protocol: 'backstage-notion-continuity-retrieval-benchmark/v1',
    corpusChunks: fixture.count,
    embeddingDimension,
    continuityRetrievalDurationMs,
    scopeChunkCount: retrieval.coverage.scopeChunks,
    selectedChunkCount: retrieval.coverage.selectedChunks,
    returnedChunkCount: retrieval.chunkCount,
    promptCodePoints: Array.from(retrieval.prompt).length,
    promptTruncated: retrieval.coverage.promptTruncated,
  })}\n`);
}

async function resetNotionRows(client: Client): Promise<void> {
  await client.query(
    `TRUNCATE TABLE
       public.backstage_notion_snapshot_chunk_search,
       public.backstage_notion_snapshot_chunks,
       public.backstage_notion_snapshot_pages,
       public.backstage_notion_sync_leases,
       public.backstage_notion_snapshots,
       public.backstage_notion_universe_heads
     RESTART IDENTITY CASCADE`
  );
  await client.query(
    `UPDATE public.backstage_notion_authority_epoch
     SET epoch = 0, updated_at = clock_timestamp()
     WHERE singleton = TRUE`
  );
}

describeWithDatabase('Backstage Notion candidate search on PostgreSQL 18', () => {
  let observer: Client;
  let pool: Pool;
  let ownsInstallation = false;
  let ownsSyncStatusInstallation = false;

  beforeAll(async () => {
    if (!configuredConnectionString) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
    }
    observer = new Client({
      connectionString: configuredConnectionString,
      ssl: false,
      application_name: 'backstage-notion-candidate-pg18-observer',
    });
    await observer.connect();
    await observer.query('SET search_path TO public, pg_catalog');
    const target = await observer.query<{
      current_database: string;
      server_version_num: string;
    }>(
      `SELECT current_database(),
              current_setting('server_version_num') AS server_version_num`
    );
    expect(target.rows[0]?.current_database).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(target.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);
    await observer.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');

    const installation = await observer.query<{ table_count: string }>(
      `SELECT COUNT(*) AS table_count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])`,
      [[
        'backstage_events',
        'backstage_canon_heads',
        'backstage_notion_universe_heads',
        'backstage_notion_snapshot_chunk_search',
      ]]
    );
    const tableCount = Number(installation.rows[0]?.table_count ?? 0);
    if (tableCount === 0) {
      ownsInstallation = true;
      await observer.query(universeScopeForwardMigration);
      await observer.query(canonConcurrentPhase);
      await observer.query(canonTransactionalPhase);
      await observer.query(notionRagForwardMigration);
      await observer.query(notionRagV2Migration);
      await observer.query(notionRagV3Migration);
      await observer.query(candidateSearchMigration);
    } else if (tableCount !== 4) {
      throw new Error('Candidate PG18 test database contains a partial Backstage installation.');
    } else {
      await observer.query(candidateSearchMigration);
    }
    const syncStatusInstallation = await observer.query<{ relation: string | null }>(
      `SELECT to_regclass('public.backstage_notion_latest_sync_attempts')::TEXT AS relation`
    );
    if (syncStatusInstallation.rows[0]?.relation === null) {
      await observer.query(syncStatusMigration);
      ownsSyncStatusInstallation = true;
    }
    pool = new Pool({
      connectionString: configuredConnectionString,
      ssl: false,
      max: 4,
      options: '-c search_path=public,pg_catalog',
      application_name: 'backstage-notion-candidate-pg18-repository',
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await pool?.end();
      if (observer) {
        await observer.query('ROLLBACK').catch(() => undefined);
        await resetNotionRows(observer);
        if (ownsSyncStatusInstallation) {
          await observer.query(syncStatusRollback);
        }
        if (ownsInstallation) {
          await observer.query(candidateSearchRollback);
          await observer.query(notionRagV3Rollback);
          await observer.query(notionRagV2Rollback);
          await observer.query(notionRagRollbackMigration);
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
          await observer.query(
            `DROP TABLE IF EXISTS
               public.backstage_story_beats,
               public.backstage_storylines,
               public.backstage_events,
               public.backstage_wrestlers`
          );
        }
      }
    } finally {
      await observer?.end();
    }
  }, 120_000);

  test('synchronizes database-parent authority through PostgreSQL activation and continuity', async () => {
    await resetNotionRows(observer);
    const root = {
      universeId: `database-parent-pg18-${randomUUID().slice(0, 8)}`,
      rootPageId: randomUUID(),
      displayName: 'Synthetic continuity authority',
      initialMinimumPageCount: 2,
    };
    const [sourceId, alternateSourceId] = [randomUUID(), randomUUID()].sort();
    const otherDatabaseId = randomUUID();
    const members = [randomUUID(), randomUUID()].sort();
    const titleParts = [...Array.from({ length: 25 }, () => 'a'), ' complete title'];
    const timestamp = new Date().toISOString();
    const annotation = {
      bold: false, italic: false, strikethrough: false,
      underline: false, code: false, color: 'default',
    };
    const textItem = (content: string) => ({
      type: 'text', text: { content, link: null },
      annotations: annotation, plain_text: content, href: null,
    });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json' },
    });
    let failureMode: 'none' | 'incomplete' | 'drift' | 'wrong-database-parent' | 'membership-drift'
      | 'missing-text' | 'missing-mention' | 'missing-equation' = 'none';
    let membershipMoved = false;
    let databaseReads = 0;
    let titleReads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.notion.com');
      expect(init?.method).toBe(url.pathname.endsWith('/query') ? 'POST' : 'GET');
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('notion-version')).toBe('2026-03-11');
      expect(headers.get('authorization')).toBe(`Bearer ntn_${'s'.repeat(48)}`);
      if (url.pathname === `/v1/pages/${root.rootPageId}`) {
        expect(url.search).toBe('');
        return json({
          object: 'error', status: 400, code: 'validation_error',
          message: 'Synthetic database root requires database metadata.',
        }, 400);
      }
      if (url.pathname === `/v1/databases/${root.rootPageId}`) {
        expect(url.search).toBe('');
        databaseReads += 1;
        return json({
          object: 'database', id: root.rootPageId,
          parent: { type: 'workspace', workspace: true },
          title: [{ plain_text: 'Synthetic database' }],
          last_edited_time: timestamp, in_trash: false,
          data_sources: [
            { id: sourceId, name: 'Synthetic source' },
            { id: alternateSourceId, name: 'Alternate synthetic source' },
          ],
        });
      }
      if ([sourceId, alternateSourceId].some(id => url.pathname === `/v1/data_sources/${id}/query`)) {
        expect([...url.searchParams]).toEqual([['filter_properties[]', 'title']]);
        expect(headers.get('content-type')).toBe('application/json');
        expect(JSON.parse(String(init?.body))).toEqual({ page_size: 10 });
        const moveMember = membershipMoved || (failureMode === 'membership-drift' && databaseReads === 2);
        const queriedMembers = url.pathname === `/v1/data_sources/${sourceId}/query`
          ? moveMember ? members.slice(1) : members
          : moveMember ? members.slice(0, 1) : [];
        return json({
          object: 'list', type: 'page_or_data_source', page_or_data_source: {},
          results: queriedMembers.map(id => ({ object: 'page', id })),
          has_more: false, next_cursor: null, request_status: { type: 'complete' },
        });
      }
      const member = members.find(id => url.pathname.startsWith(`/v1/pages/${id}`));
      if (!member) {
        throw new Error('Unexpected synthetic Notion fixture request.');
      }
      if (url.pathname.endsWith('/properties/title')) {
        expect(member).toBe(members[0]);
        titleReads += 1;
        const continuation = url.searchParams.has('start_cursor');
        expect([...url.searchParams]).toEqual([
          ['page_size', '100'],
          ...(continuation ? [['start_cursor', 'synthetic-title-page-2']] : []),
        ]);
        expect(titleReads).toBeLessThanOrEqual(4);
        const currentParts = failureMode === 'drift' && titleReads >= 3
          ? ['Changed complete synthetic title']
          : titleParts;
        const parts = continuation ? currentParts.slice(25) : currentParts.slice(0, 25);
        const hasMore = failureMode === 'incomplete' || (!continuation && currentParts.length > 25);
        const cursor = hasMore && failureMode !== 'incomplete' ? 'synthetic-title-page-2' : null;
        const nextUrl = cursor === null ? null : new URL(url.pathname, url.origin);
        nextUrl?.searchParams.set('page_size', '100');
        if (cursor !== null) nextUrl?.searchParams.set('start_cursor', cursor);
        return json({
          object: 'list', type: 'property_item',
          results: parts.map(part => ({
            object: 'property_item', id: 'title', type: 'title',
            title: failureMode.startsWith('missing-')
              ? { type: failureMode.slice('missing-'.length), plain_text: part }
              : textItem(part),
          })),
          has_more: hasMore, next_cursor: cursor,
          property_item: { id: 'title', type: 'title', title: {}, next_url: nextUrl?.toString() ?? null },
        });
      }
      if (url.pathname.endsWith('/markdown')) {
        expect([...url.searchParams]).toEqual([['include_transcript', 'false']]);
        return json({
          object: 'page_markdown', id: member,
          markdown: `# Synthetic continuity\n\nSynthetic championship record ${members.indexOf(member) + 1}.`,
          truncated: false, unknown_block_ids: [],
        });
      }
      expect(url.pathname).toBe(`/v1/pages/${member}`);
      expect([...url.searchParams]).toEqual([['filter_properties[]', 'title']]);
      return json({
        object: 'page', id: member,
        parent: member === members[0]
          ? { type: 'database_id', database_id: failureMode === 'wrong-database-parent' ? otherDatabaseId : root.rootPageId }
          : { type: 'data_source_id', data_source_id: sourceId, database_id: root.rootPageId },
        properties: {
          'Synthetic display label': member === members[0]
            ? { id: 'title', type: 'title', title: titleParts.slice(0, 25).map(part => ({
                type: 'mention', mention: { type: 'page', page: { id: members[1] } },
                annotations: annotation, plain_text: part, href: `https://www.notion.so/${members[1]!.replaceAll('-', '')}`,
              })) }
            : { id: 'title', type: 'title', title: [textItem('Second synthetic member')] },
        },
        last_edited_time: timestamp, in_trash: false,
      });
    };
    const repository = new PostgresBackstageNotionRagRepository(pool);
    const syncStatusRepository = new PostgresBackstageNotionSyncStatusRepository(pool);
    const embedding = Array.from({ length: embeddingDimension }, (_, index) => index === 0 ? 1 : 0);
    const dependencies = {
      repository, syncStatusRepository, fetchImpl,
      embedBatch: async (inputs: readonly string[]) => inputs.map(() => [...embedding]),
      readEnvironment: (name: string) => name === BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME
        ? `ntn_${'s'.repeat(48)}` : undefined,
      holderId: 'synthetic-database-parent-pg18', requestSpacingMs: 0,
      retryBaseDelayMs: 0, fetchTimeoutMs: 1_000, cycleTimeoutMs: 15_000,
    };
    const retrievalDependencies = {
      repository, syncStatusRepository, resolveAuthorityRoot: () => root,
      embedQuery: async () => [...embedding],
      remainingOperationBudgetMs: () => 15_500,
    };
    const readContinuity = () => runWithBackstageNotionEnrichmentAuthorization(true, () => (
      retrieveBackstageNotionRagContext(root.universeId, {
        query: 'Read the synthetic championship continuity.', retrievalMode: 'complete_scope',
      }, retrievalDependencies)
    ));

    await expect(readContinuity()).rejects.toMatchObject({ code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' });
    const activated = await syncBackstageNotionAuthorityRoot(root, dependencies);
    expect(activated).toMatchObject({ status: 'activated', pageCount: 3, chunkCount: 2 });
    expect(titleReads).toBe(4);
    let inventory = await repository.loadActiveInventory(root.universeId);
    expect(inventory?.snapshot.id).toBe(activated.snapshotId);
    expect(inventory?.snapshot.manifestHash).toBe(activated.manifestHash);
    expect(inventory?.snapshot.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(inventory?.pages).toHaveLength(3);
    expect(inventory?.pages.find(page => page.pageId === root.rootPageId)).toMatchObject({
      parentPageId: null, canonicalUrl: null,
      metadata: { sourceObjectType: 'database', chunkCount: 0 },
    });
    for (const [index, pageId] of members.entries()) {
      expect(inventory?.pages.find(page => page.pageId === pageId)).toMatchObject({
        parentPageId: root.rootPageId,
        title: index === 0 ? titleParts.join('') : 'Second synthetic member',
        canonicalUrl: `https://www.notion.so/${pageId.replaceAll('-', '')}`,
        sourceLastEditedAt: new Date(timestamp), depth: 1,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        metadata: { sourceObjectType: 'page', chunkCount: 1 },
      });
    }
    expect(await syncStatusRepository.loadLatestSyncAttempt(root.universeId)).toMatchObject({
      outcome: 'activated', candidateSnapshotCreated: true,
      candidateSnapshotValidated: true, candidateSnapshotActivated: true,
      activatedSnapshotId: activated.snapshotId,
    });
    const complete = await readContinuity();
    expect(complete).toMatchObject({ snapshotId: activated.snapshotId, snapshotStatus: 'current_complete', chunkCount: 2 });
    expect(complete.coverage).toMatchObject({ status: 'complete', selectedChunks: 2 });
    expect(complete.citations.map(citation => citation.pageId).sort()).toEqual(members);
    expect(complete.citations.find(citation => citation.pageId === members[0])?.pageTitle).toBe(titleParts.join(''));
    expect(complete.prompt).toContain('Synthetic championship record 1.');
    expect(complete.prompt).toContain('Synthetic championship record 2.');

    const verifyUnchanged = async () => {
      failureMode = 'none';
      databaseReads = 0;
      titleReads = 0;
      const unchanged = await syncBackstageNotionAuthorityRoot(root, dependencies);
      expect(unchanged).toMatchObject({
        status: 'unchanged', snapshotId: activated.snapshotId, manifestHash: activated.manifestHash,
        pageCount: 3, chunkCount: 2,
      });
      expect(databaseReads).toBe(2);
      expect(titleReads).toBe(4);
      const verifiedInventory = await repository.loadActiveInventory(root.universeId);
      expect(verifiedInventory?.snapshot).toEqual(inventory?.snapshot);
      expect(verifiedInventory?.pages).toEqual(inventory?.pages);
      expect(verifiedInventory!.verifiedAt.getTime()).toBeGreaterThanOrEqual(inventory!.verifiedAt.getTime());
      inventory = verifiedInventory;
      expect(await syncStatusRepository.loadLatestSyncAttempt(root.universeId)).toMatchObject({
        outcome: 'unchanged', candidateSnapshotCreated: false, candidateSnapshotActivated: false,
        activatedSnapshotId: activated.snapshotId,
      });
      expect(await readContinuity()).toMatchObject({
        snapshotId: activated.snapshotId, snapshotStatus: 'current_complete', chunkCount: 2,
      });
      expect(await runWithBackstageNotionEnrichmentAuthorization(true, () => (
        retrieveBackstageNotionBookingRagContext(root.universeId, 'Synthetic booking', retrievalDependencies)
      ))).toMatchObject({ snapshotId: activated.snapshotId, snapshotStatus: 'current_complete' });
    };
    await verifyUnchanged();

    for (const mode of [
      'wrong-database-parent', 'membership-drift', 'incomplete', 'drift',
      'missing-text', 'missing-mention', 'missing-equation',
    ] as const) {
      failureMode = mode;
      databaseReads = 0;
      titleReads = 0;
      await expect(syncBackstageNotionAuthorityRoot(root, dependencies)).rejects.toMatchObject({
        code: mode === 'drift' || mode === 'membership-drift'
          ? 'BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT'
          : mode === 'wrong-database-parent'
            ? 'BACKSTAGE_NOTION_SYNC_INCOMPLETE' : 'BACKSTAGE_NOTION_SYNC_ROOT_FAILED',
        diagnostics: expect.objectContaining({ candidateSnapshotActivated: false }),
      });
      if (mode === 'wrong-database-parent') expect(titleReads).toBe(0);
      if (mode === 'membership-drift') expect(databaseReads).toBe(2);
      const retained = await repository.loadActiveInventory(root.universeId);
      expect(retained).toEqual(inventory);
      expect(await syncStatusRepository.loadLatestSyncAttempt(root.universeId)).toMatchObject({
        outcome: 'failed', candidateSnapshotActivated: false, activatedSnapshotId: null,
      });
      const continuity = await readContinuity();
      expect(continuity).toMatchObject({
        snapshotId: activated.snapshotId, snapshotStatus: 'last_known_good', chunkCount: 2,
      });
      await expect(runWithBackstageNotionEnrichmentAuthorization(true, () => (
        retrieveBackstageNotionBookingRagContext(root.universeId, 'Synthetic booking', retrievalDependencies)
      ))).rejects.toMatchObject({ code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' });
      const snapshotCount = await observer.query<{ count: string }>(
        'SELECT COUNT(*)::TEXT AS count FROM public.backstage_notion_snapshots WHERE universe_id = $1',
        [root.universeId]
      );
      expect(snapshotCount.rows).toEqual([{ count: '1' }]);
      await verifyUnchanged();
    }

    // Stable source membership changes require a new manifest even when provider
    // parent metadata, complete titles, timestamps, and page content are identical.
    membershipMoved = true;
    databaseReads = 0;
    titleReads = 0;
    const moved = await syncBackstageNotionAuthorityRoot(root, dependencies);
    expect(moved).toMatchObject({ status: 'activated', pageCount: 3, chunkCount: 2 });
    expect(moved.snapshotId).not.toBe(activated.snapshotId);
    expect(moved.manifestHash).not.toBe(activated.manifestHash);
    const movedInventory = await repository.loadActiveInventory(root.universeId);
    expect(movedInventory?.pages).toEqual(inventory?.pages);
    expect(movedInventory?.snapshot.manifestHash).toBe(moved.manifestHash);
    expect(await syncStatusRepository.loadLatestSyncAttempt(root.universeId)).toMatchObject({
      outcome: 'activated', candidateSnapshotActivated: true, activatedSnapshotId: moved.snapshotId,
    });
    expect(await readContinuity()).toMatchObject({
      snapshotId: moved.snapshotId, snapshotStatus: 'current_complete', chunkCount: 2,
    });
  }, 30_000);

  test('keeps rollback repeat-safe when the sidecar table is already absent', async () => {
    await resetNotionRows(observer);
    try {
      await observer.query(candidateSearchRollback);
      await expect(observer.query(candidateSearchRollback)).resolves.toBeDefined();
    } finally {
      await observer.query(candidateSearchMigration);
    }
    const restored = await observer.query<{ sidecar_table: string | null }>(
      `SELECT pg_catalog.to_regclass(
         'public.backstage_notion_snapshot_chunk_search'
       )::TEXT AS sidecar_table`
    );
    expect(restored.rows).toEqual([{
      sidecar_table: 'backstage_notion_snapshot_chunk_search',
    }]);
  }, 30_000);

  test('rejects a legacy canonical-only activation and retains the current head', async () => {
    await resetNotionRows(observer);
    const current = await insertCorpus(observer, 2, 'guard-current', true);
    const legacyCandidateSnapshotId = await cloneCompleteSnapshot(
      observer,
      current,
      false
    );

    await expect(observer.query(
      `UPDATE public.backstage_notion_universe_heads
       SET active_snapshot_id = $2::UUID,
           activated_at = clock_timestamp(),
           last_verified_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE universe_id = $1`,
      [current.universeId, legacyCandidateSnapshotId]
    )).rejects.toMatchObject({
      code: 'BN003',
      message: expect.stringContaining(
        'candidate-search sidecar is incomplete for snapshot activation'
      ),
    });

    const retained = await observer.query<{
      active_snapshot_id: string;
      legacy_sidecar_count: string;
    }>(
      `SELECT
         head.active_snapshot_id::TEXT,
         (SELECT COUNT(*)::TEXT
            FROM public.backstage_notion_snapshot_chunk_search AS search
            WHERE search.universe_id = $1
              AND search.snapshot_id = $2::UUID) AS legacy_sidecar_count
       FROM public.backstage_notion_universe_heads AS head
       WHERE head.universe_id = $1`,
      [current.universeId, legacyCandidateSnapshotId]
    );
    expect(retained.rows).toEqual([{
      active_snapshot_id: current.snapshotId,
      legacy_sidecar_count: '0',
    }]);
  }, 30_000);

  test('rejects non-finite persisted embedding norms at the PostgreSQL boundary', async () => {
    await resetNotionRows(observer);
    const fixture = await insertLegacyActiveCorpus(observer, 1, 'nonfinite-norm');

    for (const embeddingNorm of ['NaN', 'Infinity']) {
      await expect(insertFirstDerivedSidecarRow(observer, fixture, {
        embeddingNorm,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'ck_backstage_notion_snapshot_chunk_search_embedding',
      });
    }
    const retained = await observer.query<{ search_count: string }>(
      `SELECT COUNT(*)::TEXT AS search_count
       FROM public.backstage_notion_snapshot_chunk_search
       WHERE universe_id = $1
         AND snapshot_id = $2::UUID`,
      [fixture.universeId, fixture.snapshotId]
    );
    expect(retained.rows).toEqual([{ search_count: '0' }]);
  }, 30_000);

  test('fails closed when an idempotent backfill encounters mismatched derived material', async () => {
    await resetNotionRows(observer);
    const fixture = await insertLegacyActiveCorpus(observer, 4, 'invalid-partial-sidecar');
    await insertFirstDerivedSidecarRow(observer, fixture, {
      corruptSearchVector: true,
    });

    const execution = await runBackfill(fixture, fixture.count, 2);
    expect(execution.succeeded).toBe(false);
    expect(execution.stdout).not.toContain('"completed":true');
    expect(execution.stderr).toContain(
      'Candidate sidecar is incomplete: chunks=4 search=4 valid=3.'
    );
    const retained = await observer.query<{
      active_snapshot_id: string;
      chunk_count: string;
      search_count: string;
    }>(
      `SELECT
         head.active_snapshot_id::TEXT,
         (SELECT COUNT(*)::TEXT
            FROM public.backstage_notion_snapshot_chunks AS chunk
            WHERE chunk.universe_id = $1
              AND chunk.snapshot_id = $2::UUID) AS chunk_count,
         (SELECT COUNT(*)::TEXT
            FROM public.backstage_notion_snapshot_chunk_search AS search
            WHERE search.universe_id = $1
              AND search.snapshot_id = $2::UUID) AS search_count
       FROM public.backstage_notion_universe_heads AS head
       WHERE head.universe_id = $1`,
      [fixture.universeId, fixture.snapshotId]
    );
    expect(retained.rows).toEqual([{
      active_snapshot_id: fixture.snapshotId,
      chunk_count: '4',
      search_count: '4',
    }]);
  }, 30_000);

  test('rolls back a sidecar batch when its bounded statement deadline expires', async () => {
    await resetNotionRows(observer);
    const fixture = await insertLegacyActiveCorpus(observer, 1, 'backfill-timeout');
    await observer.query(
      `CREATE OR REPLACE FUNCTION public.backstage_notion_candidate_test_timeout()
       RETURNS TRIGGER
       LANGUAGE plpgsql
       SET search_path = pg_catalog, public
       AS $function$
       BEGIN
         PERFORM pg_catalog.pg_sleep(16);
         RETURN NULL;
       END;
       $function$;
       CREATE TRIGGER trg_backstage_notion_candidate_test_timeout
         BEFORE INSERT ON public.backstage_notion_snapshot_chunk_search
         FOR EACH STATEMENT
         EXECUTE FUNCTION public.backstage_notion_candidate_test_timeout();`
    );
    try {
      const execution = await runBackfill(fixture, fixture.count, 1);
      expect(execution.succeeded).toBe(false);
      expect(execution.stdout).not.toContain('"completed":true');
      expect(execution.stderr).toContain(
        'canceling statement due to statement timeout'
      );
      const retained = await observer.query<{
        active_snapshot_id: string;
        chunk_count: string;
        search_count: string;
      }>(
        `SELECT
           head.active_snapshot_id::TEXT,
           (SELECT COUNT(*)::TEXT
              FROM public.backstage_notion_snapshot_chunks AS chunk
              WHERE chunk.universe_id = $1
                AND chunk.snapshot_id = $2::UUID) AS chunk_count,
           (SELECT COUNT(*)::TEXT
              FROM public.backstage_notion_snapshot_chunk_search AS search
              WHERE search.universe_id = $1
                AND search.snapshot_id = $2::UUID) AS search_count
         FROM public.backstage_notion_universe_heads AS head
         WHERE head.universe_id = $1`,
        [fixture.universeId, fixture.snapshotId]
      );
      expect(retained.rows).toEqual([{
        active_snapshot_id: fixture.snapshotId,
        chunk_count: '1',
        search_count: '0',
      }]);
    } finally {
      await observer.query(
        `DROP TRIGGER IF EXISTS trg_backstage_notion_candidate_test_timeout
           ON public.backstage_notion_snapshot_chunk_search;
         DROP FUNCTION IF EXISTS public.backstage_notion_candidate_test_timeout();`
      );
    }
  }, 30_000);

  test('does not report completion when the active authority head rotates at final verification', async () => {
    await resetNotionRows(observer);
    const fixture = await insertCorpus(observer, 4, 'backfill-head-rotation', true);
    const replacementSnapshotId = await cloneCompleteSnapshot(observer, fixture);
    let transactionOpen = false;
    let executionPromise: Promise<BackfillExecution> | null = null;
    try {
      await observer.query('BEGIN');
      transactionOpen = true;
      await observer.query(
        `SELECT universe_id
         FROM public.backstage_notion_universe_heads
         WHERE universe_id = $1
         FOR UPDATE`,
        [fixture.universeId]
      );
      executionPromise = runBackfill(fixture, fixture.count, 2);
      await waitForBackfillFinalHeadLock(observer, executionPromise);
      await observer.query(
        `UPDATE public.backstage_notion_universe_heads
         SET active_snapshot_id = $2::UUID,
             activated_at = clock_timestamp(),
             last_verified_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE universe_id = $1`,
        [fixture.universeId, replacementSnapshotId]
      );
      await observer.query('COMMIT');
      transactionOpen = false;

      const execution = await executionPromise;
      expect(execution.succeeded).toBe(false);
      expect(execution.stdout).not.toContain('"completed":true');
      expect(execution.stderr).toContain(
        'The exact active Notion snapshot and expected chunk count were not confirmed.'
      );
      const retained = await observer.query<{
        active_snapshot_id: string;
        target_search_count: string;
        replacement_search_count: string;
      }>(
        `SELECT
           head.active_snapshot_id::TEXT,
           (SELECT COUNT(*)::TEXT
              FROM public.backstage_notion_snapshot_chunk_search AS search
              WHERE search.universe_id = $1
                AND search.snapshot_id = $2::UUID) AS target_search_count,
           (SELECT COUNT(*)::TEXT
              FROM public.backstage_notion_snapshot_chunk_search AS search
              WHERE search.universe_id = $1
                AND search.snapshot_id = $3::UUID) AS replacement_search_count
         FROM public.backstage_notion_universe_heads AS head
         WHERE head.universe_id = $1`,
        [fixture.universeId, fixture.snapshotId, replacementSnapshotId]
      );
      expect(retained.rows).toEqual([{
        active_snapshot_id: replacementSnapshotId,
        target_search_count: '4',
        replacement_search_count: '4',
      }]);
    } finally {
      if (transactionOpen) {
        await observer.query('ROLLBACK').catch(() => undefined);
      }
      if (executionPromise) {
        await executionPromise;
      }
    }
  }, 30_000);

  test('ranks exact 2,751 and 4,096 chunk corpora with bounded native search', async () => {
    for (const count of [2_751, 4_096]) {
      await resetNotionRows(observer);
      const populateSidecar = count === 2_751;
      const fixture = populateSidecar
        ? await insertCorpus(observer, count, 'production-scale', true)
        : await insertLegacyActiveCorpus(observer, count, 'supported-ceiling');

      if (!populateSidecar) {
        const backfillStartedAtMs = Date.now();
        const execution = await runBackfill(fixture, count, 128);
        const backfill = execution.report;
        expect(execution.succeeded).toBe(true);
        expect(execution.stderr).toBe('');
        if (!backfill) {
          throw new Error('Successful candidate backfill did not return its report.');
        }
        expect(backfill).toMatchObject({
          completed: true,
          targetDigest: expectedBackfillTargetDigest(fixture, count),
          batchCount: 32,
          insertedCount: count,
          chunkCount: count,
        });
        expect(backfill.maxBatchDurationMs).toBeGreaterThan(0);
        expect(backfill.maxBatchDurationMs).toBeLessThan(15_000);
        expect(execution.stdout).not.toContain(fixture.universeId);
        expect(execution.stdout).not.toContain(fixture.snapshotId);
        process.stdout.write(`CANDIDATE_BACKFILL_BENCHMARK ${JSON.stringify({
          protocol: 'backstage-notion-candidate-backfill-benchmark/v1',
          corpusChunks: count,
          embeddingDimension,
          batchSize: 128,
          batchCount: backfill.batchCount,
          maxBatchDurationMs: backfill.maxBatchDurationMs,
          scriptDurationMs: backfill.durationMs,
          observedTotalDurationMs: Date.now() - backfillStartedAtMs,
        })}\n`);

        const repeated = await runBackfill(fixture, count, 128);
        expect(repeated.succeeded).toBe(true);
        expect(repeated.stderr).toBe('');
        expect(repeated.report).toMatchObject({
          completed: true,
          targetDigest: expectedBackfillTargetDigest(fixture, count),
          batchCount: 0,
          insertedCount: 0,
          chunkCount: count,
          maxBatchDurationMs: 0,
        });
        const completeCount = await observer.query<{ search_count: string }>(
          `SELECT COUNT(*)::TEXT AS search_count
           FROM public.backstage_notion_snapshot_chunk_search
           WHERE universe_id = $1
             AND snapshot_id = $2::UUID`,
          [fixture.universeId, fixture.snapshotId]
        );
        expect(completeCount.rows).toEqual([{ search_count: String(count) }]);
      }

      const malformed = await observer.query<{
        invalid_json_rejected: boolean;
        nonfinite_array_rejected: boolean;
      }>(
        `SELECT
           public.backstage_notion_candidate_embedding_from_jsonb(
             '[1, "invalid"]'::JSONB
           ) IS NULL AS invalid_json_rejected,
           public.backstage_notion_candidate_embedding_norm(
             ARRAY[1::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION]
           ) IS NULL AS nonfinite_array_rejected`
      );
      expect(malformed.rows[0]).toEqual({
        invalid_json_rejected: true,
        nonfinite_array_rejected: true,
      });

      const legacy = await benchmarkRank({
        observer,
        pool,
        fixture,
        scope: 'generic',
        strategy: 'legacy',
      });
      const native = await benchmarkRank({
        observer,
        pool,
        fixture,
        scope: 'generic',
        strategy: 'native',
      });
      expect(native.timedOut).toBe(false);
      expect(native.result).not.toBeNull();
      expect(native.result?.scopeChunkCount).toBe(count);
      expect(native.result?.candidatePoolCount).toBe(count);
      expect(native.result?.semanticCandidateCount).toBe(count);
      expect(native.result?.mergedCandidateCount).toBe(count);
      expect(native.result?.candidates).toHaveLength(resultLimit);
      const repeatedNative = await new PostgresBackstageNotionRagRepository(pool)
        .rankSnapshotCandidates(candidateInput(fixture, 'generic'));
      expect(repeatedNative.candidates.map(candidate => candidate.id)).toEqual(
        native.result?.candidates.map(candidate => candidate.id)
      );
      await benchmarkContinuityRetrieval(pool, fixture);
      if (!legacy.timedOut && legacy.result) {
        expect(legacy.result.candidates.map(candidate => candidate.id)).toEqual(
          native.result?.candidates.map(candidate => candidate.id)
        );
      }

      for (const scope of ['raw', 'smackdown', 'nxt'] as const) {
        const scoped = await benchmarkRank({
          observer,
          pool,
          fixture,
          scope,
          strategy: 'native',
        });
        expect(scoped.timedOut).toBe(false);
        expect(scoped.result?.scopeChunkCount).toBe(count);
        expect(scoped.result?.candidatePoolCount).toBeGreaterThan(0);
        expect(scoped.result?.candidatePoolCount).toBeLessThan(count);
        expect(scoped.result?.candidates).toHaveLength(resultLimit);
      }
    }
  }, 600_000);
});
