import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import {
  GamingSourceCanonicalHashCollisionError,
  PostgresGamingSourceRepository,
  type PersistGamingSourceRevisionInput
} from '../src/core/db/repositories/gamingSourceRepository.js';

const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const REVISION_ID = '20000000-0000-4000-8000-000000000001';
const RECORD_ID = '30000000-0000-4000-8000-000000000001';
const FETCHED_AT = '2026-08-08T12:00:00.000Z';

interface QueryRecord {
  sql: string;
  values: unknown[];
}

interface MockQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function result(rows: Array<Record<string, unknown>> = []): MockQueryResult {
  return { rows, rowCount: rows.length };
}

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SOURCE_ID,
    game_key: 'destiny 2',
    game_name: 'Destiny 2',
    canonical_url: 'https://example.com/guide',
    canonical_url_hash: createHash('sha256')
      .update('https://example.com/guide')
      .digest('hex'),
    public_url: 'https://example.com/guide',
    host: 'example.com',
    source_type: 'curated',
    trust_score: 0.8,
    priority: 4,
    status: 'active',
    last_checked_at: FETCHED_AT,
    last_success_at: FETCHED_AT,
    next_refresh_at: null,
    last_error_code: null,
    created_at: FETCHED_AT,
    updated_at: FETCHED_AT,
    ...overrides
  };
}

function persistInput(
  overrides: Partial<PersistGamingSourceRevisionInput> = {}
): PersistGamingSourceRevisionInput {
  return {
    gameKey: 'Destiny 2',
    gameName: 'Destiny 2',
    canonicalUrl: 'https://example.com/guide',
    publicUrl: 'https://example.com/guide',
    sourceType: 'curated',
    trustScore: 0.8,
    priority: 4,
    contentHash: 'a'.repeat(64),
    cleanedContent: 'A bounded, cleaned guide body.',
    etag: '"guide-v1"',
    fetchedAt: FETCHED_AT,
    patch: '8.0.0',
    extractor: 'gaming-html',
    extractorVersion: '1.0.0',
    normalizerSchemaVersion: 'gaming-knowledge-v1',
    provenance: { discovery: 'supplied' },
    extractionMetrics: { chars: 30 },
    records: [
      {
        recordType: 'guide',
        semanticKey: 'hunter:solar:guide',
        payloadHash: 'b'.repeat(64),
        title: 'Solar Hunter Guide',
        searchText: 'Solar Hunter guide for patch 8.0.0',
        normalized: { class: 'Hunter', subclass: 'Solar' }
      }
    ],
    ...overrides
  };
}

class GamingRepositoryHarness {
  readonly queries: QueryRecord[] = [];
  readonly release = jest.fn();
  readonly connect = jest.fn(async () => this.client);
  readonly query = jest.fn(async (sql: string, values: unknown[] = []) =>
    this.dispatch(sql, values)
  );

  readonly client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) =>
      this.dispatch(sql, values)
    ),
    release: this.release
  } as unknown as PoolClient;

  readonly pool = {
    connect: this.connect,
    query: this.query
  } as unknown as Pool;

  constructor(
    private readonly handler: (
      sql: string,
      values: unknown[]
    ) => MockQueryResult | Promise<MockQueryResult>
  ) {}

  private async dispatch(rawSql: string, values: unknown[]): Promise<MockQueryResult> {
    const sql = normalizeSql(rawSql);
    this.queries.push({ sql, values });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return result();
    }
    return this.handler(sql, values);
  }
}

describe('PostgresGamingSourceRepository persistence', () => {
  test('creates one source revision and bulk-inserts de-duplicated records atomically', async () => {
    const harness = new GamingRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO gaming_sources')) {
        return result([sourceRow()]);
      }
      if (sql.startsWith('SELECT id FROM gaming_source_revisions')) {
        return result();
      }
      if (sql.startsWith('INSERT INTO gaming_source_revisions')) {
        return result([{ id: REVISION_ID }]);
      }
      if (sql.startsWith('UPDATE gaming_knowledge_records AS knowledge')) {
        return result();
      }
      if (sql.startsWith('INSERT INTO gaming_knowledge_records')) {
        return result([{ id: RECORD_ID }, { id: `${RECORD_ID.slice(0, -1)}2` }]);
      }
      throw new Error(`Unhandled query: ${sql}`);
    });
    const repository = new PostgresGamingSourceRepository(harness.pool);
    const duplicateRecord = persistInput().records[0];

    const persisted = await repository.persistGamingSourceRevision(
      persistInput({
        records: [
          duplicateRecord,
          duplicateRecord,
          {
            recordType: 'build',
            semanticKey: 'hunter:solar:build',
            payloadHash: 'c'.repeat(64),
            searchText: 'Solar Hunter build',
            normalized: { class: 'Hunter', subclass: 'Solar', type: 'build' }
          }
        ]
      })
    );

    expect(persisted).toEqual({
      sourceId: SOURCE_ID,
      revisionId: REVISION_ID,
      state: 'created',
      recordsCreated: 2,
      recordsUpdated: 0
    });
    expect(harness.queries[0]?.sql).toBe('BEGIN');
    expect(harness.queries.at(-1)?.sql).toBe('COMMIT');
    expect(harness.release).toHaveBeenCalledTimes(1);
    const recordInsert = harness.queries.find(query =>
      query.sql.startsWith('INSERT INTO gaming_knowledge_records')
    );
    expect(JSON.parse(String(recordInsert?.values[2]))).toHaveLength(2);
  });

  test('supersedes prior active records when an existing source gets a new revision', async () => {
    const harness = new GamingRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO gaming_sources')) {
        return result();
      }
      if (sql.includes('FROM gaming_sources') && sql.endsWith('FOR UPDATE')) {
        return result([sourceRow()]);
      }
      if (sql.startsWith('UPDATE gaming_sources')) {
        return result([sourceRow()]);
      }
      if (sql.startsWith('SELECT id FROM gaming_source_revisions')) {
        return result();
      }
      if (sql.startsWith('INSERT INTO gaming_source_revisions')) {
        return result([{ id: REVISION_ID }]);
      }
      if (sql.startsWith('UPDATE gaming_knowledge_records AS knowledge')) {
        return result([{ id: 'old-1' }, { id: 'old-2' }]);
      }
      if (sql.startsWith('INSERT INTO gaming_knowledge_records')) {
        return result([{ id: RECORD_ID }]);
      }
      throw new Error(`Unhandled query: ${sql}`);
    });

    await expect(
      new PostgresGamingSourceRepository(harness.pool)
        .persistGamingSourceRevision(persistInput({ contentHash: 'd'.repeat(64) }))
    ).resolves.toEqual({
      sourceId: SOURCE_ID,
      revisionId: REVISION_ID,
      state: 'updated',
      recordsCreated: 1,
      recordsUpdated: 2
    });
  });

  test('returns unchanged without replacing records for an existing revision identity', async () => {
    const harness = new GamingRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO gaming_sources')) {
        return result();
      }
      if (sql.includes('FROM gaming_sources') && sql.endsWith('FOR UPDATE')) {
        return result([sourceRow()]);
      }
      if (sql.startsWith('UPDATE gaming_sources')) {
        return result([sourceRow()]);
      }
      if (sql.startsWith('SELECT id FROM gaming_source_revisions')) {
        return result([{ id: REVISION_ID }]);
      }
      throw new Error(`Unhandled query: ${sql}`);
    });

    await expect(
      new PostgresGamingSourceRepository(harness.pool)
        .persistGamingSourceRevision(persistInput())
    ).resolves.toEqual({
      sourceId: SOURCE_ID,
      revisionId: REVISION_ID,
      state: 'unchanged',
      recordsCreated: 0,
      recordsUpdated: 0
    });
    expect(harness.queries.some(query =>
      query.sql.startsWith('UPDATE gaming_knowledge_records')
    )).toBe(false);
    expect(harness.queries.at(-1)?.sql).toBe('COMMIT');
  });

  test('rejects canonical hash collisions and rolls back without overwriting the source', async () => {
    const harness = new GamingRepositoryHarness((sql) => {
      if (sql.startsWith('INSERT INTO gaming_sources')) {
        return result();
      }
      if (sql.includes('FROM gaming_sources') && sql.endsWith('FOR UPDATE')) {
        return result([sourceRow({ canonical_url: 'https://collision.example/guide' })]);
      }
      throw new Error(`Unhandled query: ${sql}`);
    });

    await expect(
      new PostgresGamingSourceRepository(harness.pool)
        .persistGamingSourceRevision(persistInput())
    ).rejects.toBeInstanceOf(GamingSourceCanonicalHashCollisionError);
    expect(harness.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(harness.release).toHaveBeenCalledTimes(1);
  });

  test('rejects secret-bearing URLs before acquiring a database connection', async () => {
    const harness = new GamingRepositoryHarness(() => result());
    const repository = new PostgresGamingSourceRepository(harness.pool);

    await expect(repository.persistGamingSourceRevision(persistInput({
      canonicalUrl: 'https://example.com/guide?access_token=secret'
    }))).rejects.toThrow('sensitive query parameters');
    await expect(repository.persistGamingSourceRevision(persistInput({
      canonicalUrl: 'https://user:password@example.com/guide'
    }))).rejects.toThrow('must not contain credentials');
    expect(harness.connect).not.toHaveBeenCalled();
  });
});

describe('PostgresGamingSourceRepository reads', () => {
  test('returns source display metadata and its latest revision', async () => {
    const harness = new GamingRepositoryHarness((sql) => {
      if (sql.includes('LEFT JOIN LATERAL')) {
        return result([sourceRow({
          latest_revision_id: REVISION_ID,
          latest_content_hash: 'a'.repeat(64),
          latest_etag: '"guide-v1"',
          latest_last_modified: 'Sat, 08 Aug 2026 12:00:00 GMT',
          latest_fetched_at: FETCHED_AT,
          latest_published_at: null,
          latest_patch: '8.0.0',
          latest_extractor: 'gaming-html',
          latest_extractor_version: '1.0.0',
          latest_normalizer_schema_version: 'gaming-knowledge-v1'
        })]);
      }
      throw new Error(`Unhandled query: ${sql}`);
    });

    const source = await new PostgresGamingSourceRepository(harness.pool)
      .findGamingSourceById(SOURCE_ID);

    expect(source).toMatchObject({
      id: SOURCE_ID,
      gameKey: 'destiny 2',
      gameName: 'Destiny 2',
      sourceType: 'curated',
      latestRevision: {
        id: REVISION_ID,
        contentHash: 'a'.repeat(64),
        patch: '8.0.0'
      }
    });
    expect(source?.latestRevision?.fetchedAt).toEqual(new Date(FETCHED_AT));
  });

  test('queries only active source-attributed knowledge and maps provenance', async () => {
    const harness = new GamingRepositoryHarness((sql) => {
      if (sql.startsWith('WITH search_input AS')) {
        return result([{
          record_id: RECORD_ID,
          record_type: 'build',
          semantic_key: 'hunter:solar:build',
          payload_hash: 'b'.repeat(64),
          title: 'Solar Hunter Build',
          record_patch: '8.0.0',
          search_text: 'Solar Hunter build for patch 8.0.0',
          normalized: JSON.stringify({ class: 'Hunter', subclass: 'Solar' }),
          record_created_at: FETCHED_AT,
          source_id: SOURCE_ID,
          game_key: 'destiny 2',
          game_name: 'Destiny 2',
          canonical_url: 'https://example.com/guide',
          canonical_url_hash: 'c'.repeat(64),
          public_url: 'https://example.com/guide',
          host: 'example.com',
          source_type: 'curated',
          trust_score: '0.8',
          revision_id: REVISION_ID,
          content_hash: 'a'.repeat(64),
          fetched_at: FETCHED_AT,
          published_at: null,
          revision_patch: '8.0.0',
          extractor: 'gaming-html',
          extractor_version: '1.0.0',
          normalizer_schema_version: 'gaming-knowledge-v1',
          provenance: { discovery: 'supplied' },
          extraction_metrics: { chars: 30 },
          relevance: '0.75'
        }]);
      }
      throw new Error(`Unhandled query: ${sql}`);
    });
    const repository = new PostgresGamingSourceRepository(harness.pool);

    const records = await repository.queryActiveGamingKnowledge({
      gameKey: 'Destiny 2',
      query: 'solar hunter',
      mode: 'build',
      limit: 500
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordId: RECORD_ID,
      gameKey: 'destiny 2',
      gameName: 'Destiny 2',
      recordType: 'build',
      normalized: { class: 'Hunter', subclass: 'Solar' },
      provenance: { discovery: 'supplied' },
      relevance: 0.75
    });
    const query = harness.queries[0];
    expect(query?.sql).toContain("knowledge.status = 'active'");
    expect(query?.sql).toContain("source.status = 'active'");
    expect(query?.sql).toContain("to_tsvector('simple'::regconfig, knowledge.search_text)");
    expect(query?.values).toEqual(['destiny 2', 'solar hunter', 'build', 50]);
  });
});
