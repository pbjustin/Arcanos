import { createHash } from 'node:crypto';

import { describe, expect, jest, test } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import {
  BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_EXACT_SCAN_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_LEXICAL_POOL_SIZE,
  BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS,
  BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_SEMANTIC_POOL_PER_SHARD,
  PostgresBackstageNotionPartitionRepository,
  type RankBackstageNotionPartitionCandidatesInput,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';

const UNIVERSE_ID = 'my-universe-2k26';
const MANIFEST_ID = '11111111-1111-4111-8111-111111111111';
const CONFIGURATION_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const CONFIGURATION_HASH = 'a'.repeat(64);
const SHARD_KEY = 'raw/2026';
const PARTITION_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const PAGE_ID = '55555555-5555-4555-8555-555555555555';
const PAGE_VERSION_ID = '66666666-6666-4666-8666-666666666666';
const CHUNK_VERSION_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_SHARD_KEY = 'archive/raw/2025';
const SECOND_PARTITION_VERSION_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_SNAPSHOT_ID = '99999999-9999-4999-8999-999999999999';
const SECOND_PAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_PAGE_VERSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_CHUNK_VERSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONTENT_HASH = createHash('sha256').update('canon', 'utf8').digest('hex');
const SOURCE_EDITED_AT = new Date('2026-08-24T12:00:00.000Z');

interface QueryRecord {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface MockQueryResult {
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number;
}

function result(rows: Array<Record<string, unknown>> = []): MockQueryResult {
  return { rows, rowCount: rows.length };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

class CandidateSearchHarness {
  readonly queries: QueryRecord[] = [];
  readonly release = jest.fn();
  readonly connect = jest.fn(async () => this.client);

  readonly client = {
    query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
      const normalized = normalizeSql(sql);
      this.queries.push({ sql: normalized, values });
      if (
        normalized === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
        || normalized === 'COMMIT'
        || normalized === 'ROLLBACK'
        || normalized.startsWith('SET LOCAL lock_timeout')
      ) {
        if (normalized === 'ROLLBACK' && this.rollbackError) {
          throw this.rollbackError;
        }
        return result();
      }
      if (!normalized.startsWith('WITH RECURSIVE requested_shards AS MATERIALIZED')) {
        throw new Error(`Unexpected query: ${normalized}`);
      }
      if (this.queryError) {
        throw this.queryError;
      }
      return result(this.rows);
    }),
    release: this.release,
  } as unknown as PoolClient;

  readonly pool = { connect: this.connect } as unknown as Pool;

  constructor(
    readonly rows: Array<Record<string, unknown>>,
    private readonly queryError?: Error,
    private readonly rollbackError?: Error
  ) {}
}

function searchInput(
  overrides: Partial<RankBackstageNotionPartitionCandidatesInput> = {}
): RankBackstageNotionPartitionCandidatesInput {
  return {
    universeId: UNIVERSE_ID,
    manifestId: MANIFEST_ID,
    configurationVersionId: CONFIGURATION_VERSION_ID,
    configurationHash: CONFIGURATION_HASH,
    embeddingModel: 'text-embedding-test',
    embeddingVersion: 1,
    embeddingDimension: 2,
    indexFormatVersion: 1,
    shards: [{
      shardKey: SHARD_KEY,
      partitionVersionId: PARTITION_VERSION_ID,
      snapshotId: SNAPSHOT_ID,
    }],
    queryText: 'Canon booking? CANON',
    queryEmbedding: [3, 4],
    limit: 12,
    ...overrides,
  };
}

function candidateRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    record_kind: 'candidate',
    manifest_id: MANIFEST_ID,
    search_strategy: 'exact_float8_hybrid_v1',
    exhaustive: true,
    selected_shard_count: '1',
    selected_chunk_count: '1',
    candidate_pool_count: '1',
    candidate_shard_count: '1',
    invalid_embedding_count: '0',
    shard_key: SHARD_KEY,
    partition_version_id: PARTITION_VERSION_ID,
    shard_snapshot_id: SNAPSHOT_ID,
    page_id: PAGE_ID,
    page_version_id: PAGE_VERSION_ID,
    page_title: 'Canon Root',
    page_path: ['Canon Root'],
    canonical_url: 'https://www.notion.so/canon-root',
    source_last_edited_at: SOURCE_EDITED_AT,
    ordinal: '0',
    chunk_version_id: CHUNK_VERSION_ID,
    content_hash: CONTENT_HASH,
    content_code_points: '5',
    content: 'canon',
    heading_path: ['Canon'],
    heading_occurrence_path: [0],
    category: 'general',
    semantic_score: '1',
    lexical_score: '0.5',
    score: '1.06',
    ...overrides,
  };
}

describe('PostgresBackstageNotionPartitionRepository candidate search', () => {
  test('ranks one exact manifest selection in a bounded read-only transaction', async () => {
    const harness = new CandidateSearchHarness([candidateRow()]);
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    const ranked = await repository.rankManifestShardCandidates(searchInput());

    expect(ranked).toEqual({
      status: 'ready',
      searchVersion: 1,
      manifestId: MANIFEST_ID,
      strategy: 'exact_float8_hybrid_v1',
      exhaustive: true,
      selectedShardCount: 1,
      selectedChunkCount: 1,
      candidatePoolCount: 1,
      candidates: [{
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        snapshotId: SNAPSHOT_ID,
        pageId: PAGE_ID,
        pageVersionId: PAGE_VERSION_ID,
        pageTitle: 'Canon Root',
        pagePath: ['Canon Root'],
        canonicalUrl: 'https://www.notion.so/canon-root',
        sourceLastEditedAt: SOURCE_EDITED_AT,
        ordinal: 0,
        chunkVersionId: CHUNK_VERSION_ID,
        contentHash: CONTENT_HASH,
        contentCodePoints: 5,
        content: 'canon',
        headingPath: ['Canon'],
        headingOccurrencePath: [0],
        category: 'general',
        semanticScore: 1,
        lexicalScore: 0.5,
        score: 1.06,
      }],
    });
    expect(Object.isFrozen(ranked)).toBe(true);
    expect(ranked.status === 'ready' && Object.isFrozen(ranked.candidates)).toBe(true);
    expect(
      ranked.status === 'ready' && Object.isFrozen(ranked.candidates[0])
    ).toBe(true);
    expect(harness.queries.map(query => query.sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining("SET LOCAL lock_timeout = '1s'"),
      expect.stringContaining('WITH RECURSIVE requested_shards AS MATERIALIZED'),
      'COMMIT',
    ]);
    const search = harness.queries[2]!;
    expect(search.sql).toContain("authority_head.authority = 'notion'");
    expect(search.sql).toContain('manifest.id = $2::UUID');
    expect(search.sql).toContain('member.partition_version_id = requested.partition_version_id');
    expect(search.sql).toContain('member.shard_snapshot_id = requested.snapshot_id');
    expect(search.sql).toContain('ownership.manifest_id = $2::UUID');
    expect(search.sql).toContain('LIMIT $14::INTEGER');
    expect(search.sql).toContain('LIMIT $15::INTEGER');
    expect(search.sql).toContain('LIMIT $16::INTEGER');
    expect(search.sql).not.toContain('backstage_notion_partitioned_universe_heads');
    expect(search.sql).not.toContain('backstage_notion_shard_heads');
    expect(search.sql).toContain('semantic_candidate_keys AS MATERIALIZED');
    expect(search.sql).toContain('selected_embedding_integrity AS MATERIALIZED');
    expect(search.sql).toContain('LEFT JOIN public.backstage_notion_chunk_embeddings');
    expect(search.sql).toContain('similarity.raw_score DESC');
    expect(search.sql).toContain('semantic_score DESC NULLS LAST');
    expect(search.sql).toContain('lexical_score DESC NULLS LAST');
    expect(harness.queries[1]!.sql).toContain("SET LOCAL work_mem = '8MB'");
    expect(harness.queries[1]!.sql).toContain("SET LOCAL temp_file_limit = '256MB'");
    const finalProjection = search.sql.slice(
      search.sql.indexOf('search_rows AS MATERIALIZED')
    );
    expect(finalProjection).not.toContain('embedding.embedding');
    expect(search.values).toEqual([
      UNIVERSE_ID,
      MANIFEST_ID,
      CONFIGURATION_VERSION_ID,
      CONFIGURATION_HASH,
      'text-embedding-test',
      1,
      2,
      1,
      JSON.stringify([{
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        snapshotId: SNAPSHOT_ID,
      }]),
      '"canon" OR "booking"',
      [3, 4],
      5,
      BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_EXACT_SCAN_MAX_CHUNKS,
      BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_LEXICAL_POOL_SIZE,
      BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_SEMANTIC_POOL_PER_SHARD,
      12,
      1,
    ]);
    expect(harness.release).toHaveBeenCalledWith(false);
    if (ranked.status === 'ready') {
      expect(ranked.candidates[0]).not.toHaveProperty('embedding');
    }
  });

  test('supports more than 2,048 selected chunks through a deterministic bounded pool', async () => {
    const common = {
      search_strategy: 'bounded_float8_hybrid_v1',
      exhaustive: false,
      selected_shard_count: '2',
      selected_chunk_count: '3000',
      candidate_pool_count: '2',
      candidate_shard_count: '2',
    };
    const rows = [
      candidateRow(common),
      candidateRow({
        ...common,
        shard_key: SECOND_SHARD_KEY,
        partition_version_id: SECOND_PARTITION_VERSION_ID,
        shard_snapshot_id: SECOND_SNAPSHOT_ID,
        page_id: SECOND_PAGE_ID,
        page_version_id: SECOND_PAGE_VERSION_ID,
        page_title: 'Archive Root',
        page_path: ['Archive Root'],
        chunk_version_id: SECOND_CHUNK_VERSION_ID,
        semantic_score: '0.25',
        lexical_score: '0',
        score: '0.25',
      }),
    ];
    const harness = new CandidateSearchHarness(rows);
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.rankManifestShardCandidates(searchInput({
      shards: [
        {
          shardKey: SHARD_KEY,
          partitionVersionId: PARTITION_VERSION_ID,
          snapshotId: SNAPSHOT_ID,
        },
        {
          shardKey: SECOND_SHARD_KEY,
          partitionVersionId: SECOND_PARTITION_VERSION_ID,
          snapshotId: SECOND_SNAPSHOT_ID,
        },
      ],
    }))).resolves.toMatchObject({
      status: 'ready',
      strategy: 'bounded_float8_hybrid_v1',
      exhaustive: false,
      selectedShardCount: 2,
      selectedChunkCount: 3_000,
      candidatePoolCount: 2,
      candidates: [
        { shardKey: SHARD_KEY, score: 1.06 },
        { shardKey: SECOND_SHARD_KEY, score: 0.25 },
      ],
    });
    expect(JSON.parse(harness.queries[2]!.values[8] as string)).toEqual([
      {
        shardKey: SECOND_SHARD_KEY,
        partitionVersionId: SECOND_PARTITION_VERSION_ID,
        snapshotId: SECOND_SNAPSHOT_ID,
      },
      {
        shardKey: SHARD_KEY,
        partitionVersionId: PARTITION_VERSION_ID,
        snapshotId: SNAPSHOT_ID,
      },
    ]);
  });

  test('rejects malformed input before obtaining a database connection', async () => {
    const harness = new CandidateSearchHarness([]);
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);
    const duplicateShard = searchInput().shards[0]!;
    const invalidCalls = [
      () => repository.rankManifestShardCandidates(searchInput({ manifestId: 'invalid' })),
      () => repository.rankManifestShardCandidates(searchInput({ configurationHash: 'a' })),
      () => repository.rankManifestShardCandidates(searchInput({ shards: [] })),
      () => repository.rankManifestShardCandidates(searchInput({
        shards: [duplicateShard, duplicateShard],
      })),
      () => repository.rankManifestShardCandidates(searchInput({ queryText: '   ' })),
      () => repository.rankManifestShardCandidates(searchInput({ queryText: 'canon\u0000' })),
      () => repository.rankManifestShardCandidates(searchInput({
        queryText: 'a'.repeat(32_001),
      })),
      () => repository.rankManifestShardCandidates(searchInput({ queryEmbedding: [0, 0] })),
      () => repository.rankManifestShardCandidates(searchInput({ queryEmbedding: [3] })),
      () => repository.rankManifestShardCandidates(searchInput({
        queryEmbedding: [Number.NaN, 4],
      })),
      () => repository.rankManifestShardCandidates(searchInput({ limit: 0 })),
      () => repository.rankManifestShardCandidates(searchInput({
        limit: BACKSTAGE_NOTION_PARTITION_CANDIDATE_SEARCH_MAX_RESULTS + 1,
      })),
    ];

    for (const invalidCall of invalidCalls) {
      await expect(invalidCall()).rejects.toThrow();
    }
    expect(harness.connect).not.toHaveBeenCalled();
  });

  test('fails closed for missing fences and corrupt aggregate metadata', async () => {
    const missing = new PostgresBackstageNotionPartitionRepository(
      new CandidateSearchHarness([]).pool
    );
    await expect(missing.rankManifestShardCandidates(searchInput()))
      .resolves.toEqual({ status: 'invalid' });

    for (const overrides of [
      { manifest_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { invalid_embedding_count: '1' },
      { candidate_pool_count: '0' },
      { candidate_shard_count: '0' },
      { candidate_pool_count: '2' },
      { candidate_pool_count: '2', selected_chunk_count: '2' },
      { selected_chunk_count: '2049' },
      { exhaustive: false },
      { search_strategy: 'unknown' },
      { record_kind: 'header' },
    ]) {
      const repository = new PostgresBackstageNotionPartitionRepository(
        new CandidateSearchHarness([candidateRow(overrides)]).pool
      );
      await expect(repository.rankManifestShardCandidates(searchInput()))
        .resolves.toEqual({ status: 'invalid' });
    }
  });

  test('rejects forged, duplicated, malformed, and nondeterministic candidate rows', async () => {
    const cases: Array<Array<Record<string, unknown>>> = [
      [candidateRow({ shard_snapshot_id: SECOND_SNAPSHOT_ID })],
      [
        candidateRow({ candidate_pool_count: '2', selected_chunk_count: '2' }),
        candidateRow({ candidate_pool_count: '2', selected_chunk_count: '2' }),
      ],
      [candidateRow({ score: 'NaN' })],
      [candidateRow({ page_path: ['Wrong Root'] })],
      [candidateRow({ content_hash: 'd'.repeat(64) })],
      [candidateRow({ ordinal: '2048' })],
      [
        candidateRow({
          candidate_pool_count: '2',
          selected_chunk_count: '2',
          semantic_score: '0.5',
          lexical_score: '0.5',
          score: '0.56',
        }),
        candidateRow({
          candidate_pool_count: '2',
          selected_chunk_count: '2',
          page_id: SECOND_PAGE_ID,
          page_version_id: SECOND_PAGE_VERSION_ID,
          chunk_version_id: SECOND_CHUNK_VERSION_ID,
          semantic_score: '0.56',
          lexical_score: '0',
          score: '0.56',
        }),
      ],
    ];

    for (const rows of cases) {
      const repository = new PostgresBackstageNotionPartitionRepository(
        new CandidateSearchHarness(rows).pool
      );
      await expect(repository.rankManifestShardCandidates(searchInput()))
        .rejects.toThrow();
    }
  });

  test('rolls back query failures and discards a client when rollback also fails', async () => {
    const statementTimeout = Object.assign(new Error('statement timeout'), { code: '57014' });
    const recoverable = new CandidateSearchHarness([], statementTimeout);
    await expect(new PostgresBackstageNotionPartitionRepository(recoverable.pool)
      .rankManifestShardCandidates(searchInput())).rejects.toBe(statementTimeout);
    expect(recoverable.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(recoverable.release).toHaveBeenCalledWith(false);

    const rollbackFailure = new Error('rollback failed');
    const discarded = new CandidateSearchHarness([], statementTimeout, rollbackFailure);
    await expect(new PostgresBackstageNotionPartitionRepository(discarded.pool)
      .rankManifestShardCandidates(searchInput())).rejects.toBe(statementTimeout);
    expect(discarded.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(discarded.release).toHaveBeenCalledWith(true);
  });
});
