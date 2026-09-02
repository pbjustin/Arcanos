#!/usr/bin/env node

import process from 'node:process';

import pg from 'pg';

const { Client } = pg;

const DATABASE_ENV_NAME = 'BACKSTAGE_NOTION_CANDIDATE_BACKFILL_DATABASE_URL';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_BATCH_SIZE = 128;
const MAX_SNAPSHOT_CHUNKS = 4_096;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^[0-9]+$/u.test(value ?? '')) {
    throw new Error(`${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute') {
      execute = true;
      continue;
    }
    if (!['--universe-id', '--snapshot-id', '--expected-chunks', '--batch-size'].includes(token)) {
      throw new Error(`Unsupported argument: ${token ?? ''}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${token} requires a value.`);
    }
    if (values.has(token)) {
      throw new Error(`${token} may be provided only once.`);
    }
    values.set(token, value);
    index += 1;
  }

  const universeId = values.get('--universe-id')?.trim() ?? '';
  const snapshotId = values.get('--snapshot-id')?.trim().toLowerCase() ?? '';
  if (!UNIVERSE_ID_PATTERN.test(universeId)) {
    throw new Error('--universe-id must be an exact supported universe identifier.');
  }
  if (!UUID_PATTERN.test(snapshotId)) {
    throw new Error('--snapshot-id must be an exact canonical UUID.');
  }
  const expectedChunks = parseInteger(
    values.get('--expected-chunks'),
    '--expected-chunks',
    1,
    MAX_SNAPSHOT_CHUNKS
  );
  const batchSize = values.has('--batch-size')
    ? parseInteger(values.get('--batch-size'), '--batch-size', 1, MAX_BATCH_SIZE)
    : MAX_BATCH_SIZE;
  if (!execute) {
    throw new Error('--execute is required; this script never infers mutation authorization.');
  }
  return Object.freeze({ universeId, snapshotId, expectedChunks, batchSize });
}

async function configureBoundedTransaction(client) {
  await client.query('BEGIN');
  await client.query(
    `SELECT
       set_config('lock_timeout', '1s', TRUE),
       set_config('statement_timeout', '15s', TRUE),
       set_config('idle_in_transaction_session_timeout', '15s', TRUE)`
  );
}

async function loadTargetHeader(client, input, lockForVerification = false) {
  const result = await client.query(
    `SELECT snapshot.chunk_count
     FROM public.backstage_notion_universe_heads AS head
     INNER JOIN public.backstage_notion_snapshots AS snapshot
       ON snapshot.universe_id = head.universe_id
      AND snapshot.id = head.active_snapshot_id
     WHERE head.universe_id = $1
       AND head.authority = 'notion'
       AND head.active_snapshot_id = $2::UUID
       AND snapshot.chunk_count = $3::INTEGER
     ${lockForVerification ? 'FOR SHARE OF head' : ''}`,
    [input.universeId, input.snapshotId, input.expectedChunks]
  );
  if (result.rows.length !== 1) {
    throw new Error('The exact active Notion snapshot and expected chunk count were not confirmed.');
  }
}

async function backfillBatch(client, input, cursor) {
  const result = await client.query(
    `WITH target_chunks AS MATERIALIZED (
       SELECT
         chunk.id,
         chunk.snapshot_id,
         chunk.universe_id,
         chunk.page_id,
         chunk.ordinal,
         chunk.content,
         chunk.embedding_model,
         chunk.embedding,
         chunk.heading_path,
         chunk.metadata,
         page.title AS page_title,
         page.path AS page_path
       FROM public.backstage_notion_snapshot_chunks AS chunk
       INNER JOIN public.backstage_notion_snapshot_pages AS page
         ON page.universe_id = chunk.universe_id
        AND page.snapshot_id = chunk.snapshot_id
        AND page.page_id = chunk.page_id
       LEFT JOIN public.backstage_notion_snapshot_chunk_search AS existing
         ON existing.universe_id = chunk.universe_id
        AND existing.snapshot_id = chunk.snapshot_id
        AND existing.chunk_id = chunk.id
       WHERE chunk.universe_id = $1
         AND chunk.snapshot_id = $2::UUID
         AND chunk.id > $3
         AND existing.chunk_id IS NULL
       ORDER BY chunk.id COLLATE "C"
       LIMIT $4::INTEGER
     ), search_material AS MATERIALIZED (
       SELECT
         target.*,
         CASE
           WHEN pg_catalog.jsonb_typeof(target.metadata -> 'category') = 'string'
             AND pg_catalog.octet_length(pg_catalog.convert_to(
               target.metadata ->> 'category', 'UTF8'
             )) <= 32
           THEN target.metadata ->> 'category'
           ELSE ''
         END AS category,
         public.backstage_notion_candidate_embedding_from_jsonb(
           target.embedding
         ) AS native_embedding
       FROM target_chunks AS target
     ), inserted AS (
       INSERT INTO public.backstage_notion_snapshot_chunk_search (
         universe_id,
         snapshot_id,
         chunk_id,
         page_id,
         ordinal,
         embedding_model,
         embedding_dimension,
         embedding_norm,
         embedding,
         search_vector,
         booking_brand_mask
       )
       SELECT
         material.universe_id,
         material.snapshot_id,
         material.id,
         material.page_id,
         material.ordinal,
         material.embedding_model,
         pg_catalog.cardinality(material.native_embedding),
         public.backstage_notion_candidate_embedding_norm(material.native_embedding),
         material.native_embedding,
         public.backstage_notion_candidate_search_vector(
           material.content,
           material.page_title,
           material.page_path,
           material.heading_path,
           material.category
         ),
         public.backstage_notion_candidate_brand_mask(
           material.page_title,
           material.page_path,
           material.heading_path,
           material.category
         )
       FROM search_material AS material
       WHERE material.native_embedding IS NOT NULL
         AND public.backstage_notion_candidate_embedding_norm(
           material.native_embedding
         ) IS NOT NULL
       ON CONFLICT (snapshot_id, chunk_id) DO NOTHING
       RETURNING chunk_id
     )
     SELECT
       COALESCE(MAX(target.id), '') AS next_cursor,
       COUNT(target.id)::INTEGER AS target_count,
       (SELECT COUNT(*)::INTEGER FROM inserted) AS inserted_count
     FROM target_chunks AS target`,
    [input.universeId, input.snapshotId, cursor, input.batchSize]
  );
  const row = result.rows[0];
  return {
    nextCursor: typeof row?.next_cursor === 'string' ? row.next_cursor : '',
    targetCount: Number(row?.target_count ?? 0),
    insertedCount: Number(row?.inserted_count ?? 0),
  };
}

async function verifyCompleteSidecar(client, input) {
  const result = await client.query(
    `SELECT
       COUNT(chunk.id)::INTEGER AS chunk_count,
       COUNT(search.chunk_id)::INTEGER AS search_count,
       COUNT(search.chunk_id) FILTER (WHERE
         search.page_id = chunk.page_id
         AND search.ordinal = chunk.ordinal
         AND search.embedding_model = chunk.embedding_model
         AND search.embedding_dimension = pg_catalog.cardinality(search.embedding)
         AND search.embedding = public.backstage_notion_candidate_embedding_from_jsonb(
           chunk.embedding
         )
         AND search.embedding_norm > 0::DOUBLE PRECISION
         AND search.embedding_norm < 'Infinity'::DOUBLE PRECISION
         AND search.embedding_norm <> 'NaN'::DOUBLE PRECISION
         AND pg_catalog.abs(
           public.backstage_notion_candidate_embedding_norm(search.embedding)
             - search.embedding_norm
         ) <= GREATEST(
           1e-12::DOUBLE PRECISION,
           search.embedding_norm * 1e-9::DOUBLE PRECISION
         )
         AND search.search_vector = public.backstage_notion_candidate_search_vector(
           chunk.content,
           page.title,
           page.path,
           chunk.heading_path,
           CASE
             WHEN pg_catalog.jsonb_typeof(chunk.metadata -> 'category') = 'string'
               AND pg_catalog.octet_length(pg_catalog.convert_to(
                 chunk.metadata ->> 'category', 'UTF8'
               )) <= 32
             THEN chunk.metadata ->> 'category'
             ELSE ''
           END
         )
         AND search.booking_brand_mask = public.backstage_notion_candidate_brand_mask(
           page.title,
           page.path,
           chunk.heading_path,
           CASE
             WHEN pg_catalog.jsonb_typeof(chunk.metadata -> 'category') = 'string'
               AND pg_catalog.octet_length(pg_catalog.convert_to(
                 chunk.metadata ->> 'category', 'UTF8'
               )) <= 32
             THEN chunk.metadata ->> 'category'
             ELSE ''
           END
         )
       )::INTEGER AS valid_search_count
     FROM public.backstage_notion_snapshot_chunks AS chunk
     INNER JOIN public.backstage_notion_snapshot_pages AS page
       ON page.universe_id = chunk.universe_id
      AND page.snapshot_id = chunk.snapshot_id
      AND page.page_id = chunk.page_id
     LEFT JOIN public.backstage_notion_snapshot_chunk_search AS search
       ON search.universe_id = chunk.universe_id
      AND search.snapshot_id = chunk.snapshot_id
      AND search.chunk_id = chunk.id
     WHERE chunk.universe_id = $1
       AND chunk.snapshot_id = $2::UUID`,
    [input.universeId, input.snapshotId]
  );
  const row = result.rows[0];
  const counts = {
    chunkCount: Number(row?.chunk_count ?? -1),
    searchCount: Number(row?.search_count ?? -1),
    validSearchCount: Number(row?.valid_search_count ?? -1),
  };
  if (
    counts.chunkCount !== input.expectedChunks
    || counts.searchCount !== input.expectedChunks
    || counts.validSearchCount !== input.expectedChunks
  ) {
    throw new Error(
      `Candidate sidecar is incomplete: chunks=${counts.chunkCount} search=${counts.searchCount} valid=${counts.validSearchCount}.`
    );
  }
  return counts;
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const connectionString = process.env[DATABASE_ENV_NAME]?.trim();
  if (!connectionString) {
    throw new Error(`${DATABASE_ENV_NAME} is required.`);
  }
  const client = new Client({ connectionString, application_name: 'backstage-notion-candidate-backfill-v1' });
  const startedAtMs = Date.now();
  let insertedCount = 0;
  let batchCount = 0;
  let maxBatchDurationMs = 0;
  let cursor = '';
  await client.connect();
  try {
    await configureBoundedTransaction(client);
    try {
      await loadTargetHeader(client, input);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    for (;;) {
      const batchStartedAtMs = Date.now();
      await configureBoundedTransaction(client);
      let batch;
      try {
        batch = await backfillBatch(client, input, cursor);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      if (batch.targetCount === 0) {
        break;
      }
      maxBatchDurationMs = Math.max(
        maxBatchDurationMs,
        Date.now() - batchStartedAtMs
      );
      if (!batch.nextCursor || batch.nextCursor <= cursor) {
        throw new Error('Candidate backfill cursor did not advance.');
      }
      cursor = batch.nextCursor;
      insertedCount += batch.insertedCount;
      batchCount += 1;
    }
    await configureBoundedTransaction(client);
    let counts;
    try {
      // Hold a shared lock on the exact authority head through the final count
      // verification and commit. A concurrent activation cannot turn a stale
      // backfill into a misleading completed result between these checks.
      await loadTargetHeader(client, input, true);
      counts = await verifyCompleteSidecar(client, input);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    process.stdout.write(`${JSON.stringify({
      protocol: 'backstage-notion-candidate-backfill/v1',
      completed: true,
      batchCount,
      insertedCount,
      chunkCount: counts.chunkCount,
      maxBatchDurationMs,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    })}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch(error => {
  fail(error instanceof Error ? error.message : 'Candidate backfill failed.');
});
