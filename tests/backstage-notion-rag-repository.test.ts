import { createHash } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';

import {
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT,
  BACKSTAGE_NOTION_SNAPSHOT_INSERT_BATCH_MAX_BYTES,
  BACKSTAGE_NOTION_SNAPSHOT_INSERT_BATCH_MAX_RECORDS,
  BackstageNotionSnapshotCommitUnknownError,
  BackstageNotionSnapshotDeadlineError,
  BackstageNotionSyncLeaseError,
  PostgresBackstageNotionRagRepository,
  type ActivateBackstageNotionSnapshotInput
} from '../src/core/db/repositories/backstageNotionRagRepository.js';
import { BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION } from '../src/shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '../src/shared/backstage/backstageNotionScopeIndex.js';

const UNIVERSE_ID = 'my-universe-2k26';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
const SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555';
const HASH_A = 'a'.repeat(64);
const NOW = new Date('2026-08-19T12:00:00.000Z');

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const ROOT_TITLE = 'WWE Universe Mode';
const ROOT_PATH = [ROOT_TITLE];
const ROOT_MARKDOWN = '# WWE Universe Mode';
const ROOT_SOURCE_HASH = hash(JSON.stringify({
  format: 'backstage-notion-rag-page-v1',
  universeId: UNIVERSE_ID,
  pageId: ROOT_PAGE_ID,
  parentPageId: null,
  title: ROOT_TITLE,
  path: ROOT_PATH,
  markdown: ROOT_MARKDOWN
}));
const CHILD_TITLE = 'Kayfabe';
const CHILD_PATH = [ROOT_TITLE, CHILD_TITLE];
const CHILD_MARKDOWN = '# Kayfabe';
const CHILD_SOURCE_HASH = hash(JSON.stringify({
  format: 'backstage-notion-rag-page-v1',
  universeId: UNIVERSE_ID,
  pageId: CHILD_PAGE_ID,
  parentPageId: ROOT_PAGE_ID,
  title: CHILD_TITLE,
  path: CHILD_PATH,
  markdown: CHILD_MARKDOWN
}));
const CHUNK_CONTENT = 'Kayfabe continuity is authoritative.';
const CHUNK_CONTENT_HASH = hash(CHUNK_CONTENT);
const CHUNK_ID = hash(JSON.stringify({
  format: 'backstage-notion-rag-chunk-v1',
  pageId: CHILD_PAGE_ID,
  ordinal: 0,
  contentHash: CHUNK_CONTENT_HASH
}));
const ROOT_CHUNK_CONTENT_HASH = hash(ROOT_MARKDOWN);
const ROOT_CHUNK_ID = hash(JSON.stringify({
  format: 'backstage-notion-rag-chunk-v1',
  pageId: ROOT_PAGE_ID,
  ordinal: 0,
  contentHash: ROOT_CHUNK_CONTENT_HASH
}));

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function createPool(
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
): Pool {
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      const normalized = normalizeSql(sql);
      if (
        normalized === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
        || normalized === 'COMMIT'
        || normalized === 'ROLLBACK'
        || normalized.startsWith('SET LOCAL lock_timeout')
        || normalized.startsWith("SELECT set_config('lock_timeout'")
        || normalized.startsWith('SELECT set_config(')
      ) {
        return { rows: [], rowCount: 0 };
      }
      return query(sql, values);
    },
    release: () => undefined,
  };
  return {
    query: (sql: string, values: unknown[] = []) => query(sql, values),
    connect: async () => client,
  } as unknown as Pool;
}

function commitAmbiguityHarness(
  outcome: 'candidate-active' | 'prior-active' | 'reconciliation-failed'
): {
  pool: Pool;
  writerReleasedWith: () => unknown;
  connectionCount: () => number;
} {
  let candidateSnapshotId = '';
  let writerRelease: unknown;
  let connections = 0;
  const writer = {
    query: async (rawSql: string, values: unknown[] = []) => {
      const sql = normalizeSql(rawSql);
      if (sql.startsWith('SELECT lease.universe_id')) {
        return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO backstage_notion_snapshots')) {
        candidateSnapshotId = String(values[0]);
        return {
          rows: [{
            snapshot_id: candidateSnapshotId,
            universe_id: UNIVERSE_ID,
            root_page_id: ROOT_PAGE_ID,
            manifest_hash: HASH_A,
            embedding_model: 'text-embedding-test',
            page_count: 2,
            chunk_count: 2,
            source_max_edited_at: NOW,
            sync_holder_id: 'sync-worker-1',
            snapshot_created_at: NOW,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('AS page_count') && sql.includes('AS chunk_count')) {
        return {
          rows: [{ page_count: '2', chunk_count: '2' }],
          rowCount: 1,
        };
      }
      if (sql === 'COMMIT') {
        throw new Error('PRIVATE-COMMIT-TRANSPORT');
      }
      return {
        rows: [],
        rowCount: sql.startsWith('UPDATE backstage_notion_authority_epoch')
          || sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
          ? 1
          : 0,
      };
    },
    release: (value?: unknown) => {
      writerRelease = value;
    },
  };
  const reader = {
    query: async (rawSql: string) => {
      const sql = normalizeSql(rawSql);
      if (sql.startsWith('SELECT active_snapshot_id')) {
        if (outcome === 'reconciliation-failed') {
          throw new Error('PRIVATE-RECONCILIATION-FAILURE');
        }
        return {
          rows: [{
            active_snapshot_id: outcome === 'candidate-active'
              ? candidateSnapshotId
              : SNAPSHOT_ID,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    pool: {
      connect: async () => {
        connections += 1;
        return connections === 1 ? writer : reader;
      },
    } as unknown as Pool,
    writerReleasedWith: () => writerRelease,
    connectionCount: () => connections,
  };
}

function pageScopeMetadata(title: string, path: readonly string[]) {
  return {
    headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
    indexFormat: BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
    scopeTitleKey: normalizeBackstageNotionScopeKey(title),
    scopePathKey: normalizeBackstageNotionScopePath(path),
  };
}

function chunkScopeMetadata(headingPath: readonly string[]) {
  return {
    headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
    headingOccurrencePath: headingPath.map((_segment, index) => index + 1),
    scopeHeadingPathKey: normalizeBackstageNotionScopePath(headingPath),
  };
}

function validSnapshotInput(): ActivateBackstageNotionSnapshotInput {
  return {
    universeId: UNIVERSE_ID,
    rootPageId: ROOT_PAGE_ID,
    manifestHash: HASH_A,
    embeddingModel: 'text-embedding-test',
    sourceMaxEditedAt: NOW,
    lease: {
      holderId: 'sync-worker-1',
      leaseToken: LEASE_TOKEN
    },
    pages: [
      {
        pageId: ROOT_PAGE_ID,
        parentPageId: null,
        title: ROOT_TITLE,
        canonicalUrl: 'https://www.notion.so/root',
        contentHash: ROOT_SOURCE_HASH,
        markdown: ROOT_MARKDOWN,
        sourceLastEditedAt: NOW,
        depth: 0,
        path: ROOT_PATH,
        metadata: pageScopeMetadata(ROOT_TITLE, ROOT_PATH)
      },
      {
        pageId: CHILD_PAGE_ID,
        parentPageId: ROOT_PAGE_ID,
        title: CHILD_TITLE,
        contentHash: CHILD_SOURCE_HASH,
        markdown: CHILD_MARKDOWN,
        sourceLastEditedAt: NOW,
        depth: 1,
        path: CHILD_PATH,
        metadata: pageScopeMetadata(CHILD_TITLE, CHILD_PATH)
      }
    ],
    chunks: [
      {
        chunkId: ROOT_CHUNK_ID,
        pageId: ROOT_PAGE_ID,
        ordinal: 0,
        contentHash: ROOT_CHUNK_CONTENT_HASH,
        content: ROOT_MARKDOWN,
        codePoints: Array.from(ROOT_MARKDOWN).length,
        embedding: [0.2, -0.4],
        headingPath: [],
        metadata: chunkScopeMetadata([])
      },
      {
        chunkId: CHUNK_ID,
        pageId: CHILD_PAGE_ID,
        ordinal: 0,
        contentHash: CHUNK_CONTENT_HASH,
        content: CHUNK_CONTENT,
        codePoints: Array.from(CHUNK_CONTENT).length,
        embedding: [0.25, -0.5],
        headingPath: ['Kayfabe'],
        metadata: chunkScopeMetadata(['Kayfabe'])
      }
    ]
  };
}

async function expectSnapshotValidationError(
  mutate: (input: ActivateBackstageNotionSnapshotInput) => void,
  message: string
): Promise<void> {
  let connected = false;
  const pool = {
    connect: async () => {
      connected = true;
      throw new Error('SENTINEL_CONNECT');
    }
  } as unknown as Pool;
  const repository = new PostgresBackstageNotionRagRepository(pool);
  const input = validSnapshotInput();
  mutate(input);

  await expect(repository.activateSnapshot(input)).rejects.toThrow(message);
  expect(connected).toBe(false);
}

function validPageScopeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    page_id: CHILD_PAGE_ID,
    page_title: CHILD_TITLE,
    page_path: CHILD_PATH,
    scope_chunk_count: '15',
    scope_page_count: '1',
    ...overrides
  };
}

function validSectionScopeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    section_occurrence_path: [1],
    section_path: ['Kayfabe'],
    scope_chunk_count: '13',
    ...overrides
  };
}

describe('PostgresBackstageNotionRagRepository', () => {
  it('rejects an expired snapshot deadline before opening a connection', async () => {
    let connected = false;
    const repository = new PostgresBackstageNotionRagRepository({
      connect: async () => {
        connected = true;
        throw new Error('SENTINEL_CONNECT');
      },
    } as unknown as Pool);
    const input = validSnapshotInput();
    input.deadlineAtMs = Date.now() - 1;

    await expect(repository.activateSnapshot(input)).rejects.toBeInstanceOf(
      BackstageNotionSnapshotDeadlineError
    );
    expect(connected).toBe(false);
  });

  it('reconciles a lost COMMIT response when the candidate is active', async () => {
    const harness = commitAmbiguityHarness('candidate-active');
    const repository = new PostgresBackstageNotionRagRepository(harness.pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).resolves.toMatchObject({
      universeId: UNIVERSE_ID,
      pageCount: 2,
      chunkCount: 2,
    });
    expect(harness.writerReleasedWith()).toBe(true);
    expect(harness.connectionCount()).toBe(2);
  });

  it('reports activation failure when reconciliation proves the prior head remains', async () => {
    const harness = commitAmbiguityHarness('prior-active');
    const repository = new PostgresBackstageNotionRagRepository(harness.pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toMatchObject({
      name: 'BackstageNotionSnapshotWriteError',
      phase: 'activation',
    });
    expect(harness.writerReleasedWith()).toBe(true);
    expect(harness.connectionCount()).toBe(2);
  });

  it('uses a sanitized commit-unknown error when reconciliation is unavailable', async () => {
    const harness = commitAmbiguityHarness('reconciliation-failed');
    const repository = new PostgresBackstageNotionRagRepository(harness.pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toBeInstanceOf(
      BackstageNotionSnapshotCommitUnknownError
    );
    expect(harness.writerReleasedWith()).toBe(true);
    expect(harness.connectionCount()).toBe(2);
  });
  it('loads the persisted authority head without loading pages or chunks', async () => {
    const observedQueries: Array<{ sql: string; values: unknown[] }> = [];
    let releasedWith: boolean | undefined;
    const client = {
      query: async (rawSql: string, values: unknown[] = []) => {
        const sql = normalizeSql(rawSql);
        observedQueries.push({ sql, values });
        if (sql.startsWith('SELECT head.universe_id')) {
          return {
            rows: [{
              universe_id: UNIVERSE_ID,
              authority: 'notion',
              active_snapshot_id: SNAPSHOT_ID,
              root_page_id: ROOT_PAGE_ID
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: (discard?: boolean) => {
        releasedWith = discard;
      },
    };
    const pool = createPool(async (rawSql, values) => {
      throw new Error(`Unexpected direct pool query: ${normalizeSql(rawSql)} ${values.length}`);
    });
    Object.assign(pool, { connect: async () => client });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.loadAuthorityHead(` ${UNIVERSE_ID} `)).resolves.toEqual({
      universeId: UNIVERSE_ID,
      authority: 'notion',
      activeSnapshotId: SNAPSHOT_ID,
      rootPageId: ROOT_PAGE_ID
    });
    expect(observedQueries.map(query => query.sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining("SET LOCAL lock_timeout = '1s'"),
      expect.stringContaining('FROM backstage_notion_universe_heads AS head'),
      'COMMIT',
    ]);
    const observedSelect = observedQueries[2]!;
    expect(observedSelect.sql).toContain('LEFT JOIN backstage_notion_snapshots AS snapshot');
    expect(observedSelect.sql).toContain('snapshot.universe_id = head.universe_id');
    expect(observedSelect.sql).toContain('snapshot.id = head.active_snapshot_id');
    expect(observedSelect.sql).not.toContain('backstage_notion_snapshot_pages');
    expect(observedSelect.sql).not.toContain('backstage_notion_snapshot_chunks');
    expect(observedSelect.values).toEqual([UNIVERSE_ID]);
    expect(releasedWith).toBe(false);
  });

  it('returns null for an absent authority head and validates persisted head invariants', async () => {
    const absentRepository = new PostgresBackstageNotionRagRepository(
      createPool(async () => ({ rows: [], rowCount: 0 }))
    );
    await expect(absentRepository.loadAuthorityHead(UNIVERSE_ID)).resolves.toBeNull();

    const postgresRepository = new PostgresBackstageNotionRagRepository(
      createPool(async () => ({
        rows: [{
          universe_id: UNIVERSE_ID,
          authority: 'postgres',
          active_snapshot_id: null,
          root_page_id: null
        }],
        rowCount: 1
      }))
    );
    await expect(postgresRepository.loadAuthorityHead(UNIVERSE_ID)).resolves.toEqual({
      universeId: UNIVERSE_ID,
      authority: 'postgres',
      activeSnapshotId: null,
      rootPageId: null
    });

    const invalidRepository = new PostgresBackstageNotionRagRepository(
      createPool(async () => ({
        rows: [{
          universe_id: UNIVERSE_ID,
          authority: 'notion',
          active_snapshot_id: SNAPSHOT_ID,
          root_page_id: null
        }],
        rowCount: 1
      }))
    );
    await expect(invalidRepository.loadAuthorityHead(UNIVERSE_ID)).rejects.toThrow(
      'incomplete active snapshot reference'
    );
  });

  it('acquires and releases a fenced, bounded synchronization lease', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const pool = createPool(async (rawSql, values) => {
      const sql = normalizeSql(rawSql);
      commands.push({ sql, values });
      if (sql.startsWith('INSERT INTO backstage_notion_sync_leases')) {
        return {
          rows: [{
            universe_id: UNIVERSE_ID,
            holder_id: 'sync-worker-1',
            lease_token: values[2],
            acquired_at: NOW,
            expires_at: new Date(NOW.getTime() + 60_000)
          }],
          rowCount: 1
        };
      }
      if (sql.startsWith('UPDATE backstage_notion_sync_leases')) {
        return {
          rows: [{
            universe_id: values[0],
            holder_id: values[1],
            lease_token: values[2],
            acquired_at: NOW,
            expires_at: new Date(NOW.getTime() + Number(values[3]))
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: sql.startsWith('DELETE FROM') ? 1 : 0 };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    const lease = await repository.acquireSyncLease(UNIVERSE_ID, 'sync-worker-1', 60_000);
    expect(lease?.universeId).toBe(UNIVERSE_ID);
    expect(commands[1].sql).toContain(
      "clock_timestamp() + ($4::BIGINT * INTERVAL '1 millisecond')"
    );
    expect(commands[1].sql).toContain(
      'backstage_notion_sync_leases.expires_at <= clock_timestamp()'
    );

    const renewed = await repository.renewSyncLease(
      UNIVERSE_ID,
      'sync-worker-1',
      lease!.leaseToken,
      60_000
    );
    expect(renewed?.leaseToken).toBe(lease?.leaseToken);
    expect(commands[2].sql).toContain('WHERE universe_id = $1');
    expect(commands[2].sql).toContain('AND holder_id = $2');
    expect(commands[2].sql).toContain('AND lease_token = $3::UUID');
    expect(commands[2].sql).toContain('AND expires_at > clock_timestamp()');
    expect(commands[2].values).toEqual([
      UNIVERSE_ID,
      'sync-worker-1',
      lease?.leaseToken,
      60_000
    ]);

    await expect(repository.releaseSyncLease(
      UNIVERSE_ID,
      'sync-worker-1',
      lease!.leaseToken
    )).resolves.toBe(true);
    expect(commands[3].sql).toContain('AND lease_token = $3::UUID');

    await expect(repository.renewSyncLease(
      UNIVERSE_ID,
      'sync-worker-1',
      lease!.leaseToken,
      999
    )).rejects.toThrow('ttlMs');
  });

  it('returns null when a synchronization lease renewal loses its token fence', async () => {
    const repository = new PostgresBackstageNotionRagRepository(
      createPool(async () => ({ rows: [], rowCount: 0 }))
    );

    await expect(repository.renewSyncLease(
      UNIVERSE_ID,
      'sync-worker-1',
      LEASE_TOKEN,
      60_000
    )).resolves.toBeNull();
  });

  it('activates a complete snapshot and authority head in one transaction', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    let releasedWith: unknown;
    const client = {
      query: async (rawSql: string, values: unknown[] = []) => {
        const sql = normalizeSql(rawSql);
        commands.push({ sql, values });
        if (sql.startsWith('SELECT lease.universe_id')) {
          return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO backstage_notion_snapshots')) {
          return {
            rows: [{
              snapshot_id: SNAPSHOT_ID,
              universe_id: UNIVERSE_ID,
              root_page_id: ROOT_PAGE_ID,
              manifest_hash: HASH_A,
              embedding_model: 'text-embedding-test',
              page_count: 2,
              chunk_count: 2,
              source_max_edited_at: NOW,
              sync_holder_id: 'sync-worker-1',
              snapshot_created_at: NOW
            }],
            rowCount: 1
          };
        }
        if (sql.includes('AS page_count') && sql.includes('AS chunk_count')) {
          return {
            rows: [{ page_count: '2', chunk_count: '2' }],
            rowCount: 1,
          };
        }
        return {
          rows: [],
          rowCount: sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
            || sql.startsWith('UPDATE backstage_notion_authority_epoch')
            ? 1
            : 0
        };
      },
      release: (cause?: unknown) => {
        releasedWith = cause;
      }
    };
    const pool = {
      connect: async () => client
    } as unknown as Pool;
    const repository = new PostgresBackstageNotionRagRepository(pool);

    const snapshot = await repository.activateSnapshot(validSnapshotInput());

    expect(snapshot.pageCount).toBe(2);
    expect(commands.map(command => command.sql)).toEqual(expect.arrayContaining([
      'BEGIN',
      'COMMIT'
    ]));
    const pageInsert = commands.find(command =>
      command.sql.startsWith('INSERT INTO backstage_notion_snapshot_pages')
    );
    const chunkInsert = commands.find(command =>
      command.sql.startsWith('INSERT INTO backstage_notion_snapshot_chunks')
    );
    const activation = commands.find(command =>
      command.sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
    );
    const inventoryValidation = commands.find(command =>
      command.sql.includes('AS page_count')
      && command.sql.includes('AS chunk_count')
    );
    const cutoverFence = commands.find(command =>
      command.sql.startsWith('LOCK TABLE backstage_wrestlers, backstage_events')
    );
    const epochFence = commands.find(command =>
      command.sql.startsWith('UPDATE backstage_notion_authority_epoch')
    );
    const authorityHeadFence = commands.find(command =>
      command.sql === 'LOCK TABLE backstage_notion_universe_heads IN ACCESS EXCLUSIVE MODE'
    );
    const leaseCheck = commands.find(command =>
      command.sql.startsWith('SELECT lease.universe_id')
    );
    expect(JSON.parse(String(pageInsert?.values[2]))).toHaveLength(2);
    expect(JSON.parse(String(chunkInsert?.values[3]))).toHaveLength(2);
    expect(activation?.sql).toContain("authority = 'notion'");
    expect(activation?.sql).toContain('active_snapshot_id = $2::UUID');
    expect(activation?.sql).toContain('last_verified_at = clock_timestamp()');
    expect(activation?.sql).toContain('lease.expires_at > clock_timestamp()');
    expect(activation?.sql).toContain("head.authority = 'postgres'");
    expect(activation?.sql).toContain('active_snapshot.root_page_id = $5');
    expect(activation?.values[4]).toBe(ROOT_PAGE_ID);
    expect(leaseCheck?.sql).toContain('FOR UPDATE OF lease');
    expect(leaseCheck?.sql).not.toContain('backstage_notion_universe_heads');
    expect(cutoverFence?.sql).toContain('IN SHARE ROW EXCLUSIVE MODE');
    expect(commands.indexOf(cutoverFence!)).toBeLessThan(commands.indexOf(epochFence!));
    expect(commands.indexOf(epochFence!)).toBeLessThan(commands.indexOf(authorityHeadFence!));
    expect(commands.indexOf(authorityHeadFence!)).toBeLessThan(commands.indexOf(pageInsert!));
    expect(commands.indexOf(chunkInsert!)).toBeLessThan(
      commands.indexOf(inventoryValidation!)
    );
    expect(commands.indexOf(inventoryValidation!)).toBeLessThan(
      commands.indexOf(activation!)
    );
    expect(commands.indexOf(authorityHeadFence!)).toBeLessThan(commands.indexOf(activation!));
    expect(releasedWith).toBe(false);
  });

  it('rolls back before page persistence when the candidate row is not returned', async () => {
    const commands: string[] = [];
    const client = {
      query: async (rawSql: string) => {
        const sql = normalizeSql(rawSql);
        commands.push(sql);
        if (sql.startsWith('SELECT lease.universe_id')) {
          return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
        }
        return {
          rows: [],
          rowCount: sql.startsWith('UPDATE backstage_notion_authority_epoch')
            ? 1
            : 0,
        };
      },
      release: () => undefined,
    };
    const repository = new PostgresBackstageNotionRagRepository({
      connect: async () => client,
    } as unknown as Pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toMatchObject({
      name: 'BackstageNotionSnapshotWriteError',
      phase: 'persistence',
    });
    expect(commands).toContain('ROLLBACK');
    expect(commands).not.toContain('COMMIT');
    expect(commands.some(sql => (
      sql.startsWith('INSERT INTO backstage_notion_snapshot_pages')
      || sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
    ))).toBe(false);
  });

  it.each([
    {
      phase: 'persistence',
      matches: (sql: string) => sql.startsWith(
        'INSERT INTO backstage_notion_snapshot_pages'
      ),
    },
    {
      phase: 'completeness_validation',
      matches: (sql: string) => (
        sql.includes('AS page_count') && sql.includes('AS chunk_count')
      ),
    },
    {
      phase: 'activation',
      matches: (sql: string) => sql.startsWith(
        'UPDATE backstage_notion_universe_heads AS head'
      ),
    },
  ] as const)(
    'maps a PostgreSQL timeout to the exact $phase phase and rolls back',
    async ({ phase, matches }) => {
      const commands: string[] = [];
      const client = {
        query: async (rawSql: string) => {
          const sql = normalizeSql(rawSql);
          commands.push(sql);
          if (matches(sql)) {
            throw Object.assign(new Error('PRIVATE-POSTGRES-TIMEOUT'), {
              code: '57014',
            });
          }
          if (sql.startsWith('SELECT lease.universe_id')) {
            return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO backstage_notion_snapshots')) {
            return {
              rows: [{
                snapshot_id: SNAPSHOT_ID,
                universe_id: UNIVERSE_ID,
                root_page_id: ROOT_PAGE_ID,
                manifest_hash: HASH_A,
                embedding_model: 'text-embedding-test',
                page_count: 2,
                chunk_count: 2,
                source_max_edited_at: NOW,
                sync_holder_id: 'sync-worker-1',
                snapshot_created_at: NOW,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes('AS page_count') && sql.includes('AS chunk_count')) {
            return {
              rows: [{ page_count: '2', chunk_count: '2' }],
              rowCount: 1,
            };
          }
          return {
            rows: [],
            rowCount: sql.startsWith('UPDATE backstage_notion_authority_epoch')
              || sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
              ? 1
              : 0,
          };
        },
        release: () => undefined,
      };
      const repository = new PostgresBackstageNotionRagRepository({
        connect: async () => client,
      } as unknown as Pool);

      await expect(repository.activateSnapshot(validSnapshotInput()))
        .rejects.toMatchObject({
          name: 'BackstageNotionSnapshotDeadlineError',
          phase,
        });
      expect(commands).toContain('ROLLBACK');
      expect(commands).not.toContain('COMMIT');
    }
  );

  it('persists a 2,117-chunk candidate in bounded batches before one head flip', async () => {
    const input = validSnapshotInput();
    input.pages = [input.pages[0]!];
    input.chunks = Array.from({ length: 2_117 }, (_unused, ordinal) => {
      const content = `synthetic-authority-chunk-${ordinal}`;
      const contentHash = hash(content);
      return {
        chunkId: hash(JSON.stringify({
          format: 'backstage-notion-rag-chunk-v1',
          pageId: ROOT_PAGE_ID,
          ordinal,
          contentHash,
        })),
        pageId: ROOT_PAGE_ID,
        ordinal,
        contentHash,
        content,
        codePoints: Array.from(content).length,
        embedding: [0.2, -0.4],
        headingPath: [],
        metadata: chunkScopeMetadata([]),
      };
    });
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: async (rawSql: string, values: unknown[] = []) => {
        const sql = normalizeSql(rawSql);
        commands.push({ sql, values });
        if (sql.startsWith('SELECT lease.universe_id')) {
          return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO backstage_notion_snapshots')) {
          return {
            rows: [{
              snapshot_id: SNAPSHOT_ID,
              universe_id: UNIVERSE_ID,
              root_page_id: ROOT_PAGE_ID,
              manifest_hash: HASH_A,
              embedding_model: 'text-embedding-test',
              page_count: 1,
              chunk_count: 2_117,
              source_max_edited_at: NOW,
              sync_holder_id: 'sync-worker-1',
              snapshot_created_at: NOW,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('AS page_count') && sql.includes('AS chunk_count')) {
          return {
            rows: [{ page_count: '1', chunk_count: '2117' }],
            rowCount: 1,
          };
        }
        return {
          rows: [],
          rowCount: sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
            || sql.startsWith('UPDATE backstage_notion_authority_epoch')
            ? 1
            : 0,
        };
      },
      release: () => undefined,
    };
    const repository = new PostgresBackstageNotionRagRepository({
      connect: async () => client,
    } as unknown as Pool);

    await expect(repository.activateSnapshot(input)).resolves.toMatchObject({
      pageCount: 1,
      chunkCount: 2_117,
    });

    const chunkInserts = commands.filter(command =>
      command.sql.startsWith('INSERT INTO backstage_notion_snapshot_chunks')
    );
    expect(chunkInserts).toHaveLength(Math.ceil(
      2_117 / BACKSTAGE_NOTION_SNAPSHOT_INSERT_BATCH_MAX_RECORDS
    ));
    const persistedChunks = chunkInserts.flatMap(command => {
      const serialized = String(command.values[3]);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
        BACKSTAGE_NOTION_SNAPSHOT_INSERT_BATCH_MAX_BYTES
      );
      const batch = JSON.parse(serialized) as Array<{ chunk_id: string }>;
      expect(batch.length).toBeLessThanOrEqual(
        BACKSTAGE_NOTION_SNAPSHOT_INSERT_BATCH_MAX_RECORDS
      );
      return batch;
    });
    expect(persistedChunks).toHaveLength(2_117);
    expect(new Set(persistedChunks.map(chunk => chunk.chunk_id)).size).toBe(2_117);
    expect(commands.filter(command => (
      command.sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
    ))).toHaveLength(1);
  });

  it('rolls back a persisted-count mismatch before activating the candidate', async () => {
    const commands: string[] = [];
    const client = {
      query: async (rawSql: string) => {
        const sql = normalizeSql(rawSql);
        commands.push(sql);
        if (sql.startsWith('SELECT lease.universe_id')) {
          return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO backstage_notion_snapshots')) {
          return {
            rows: [{
              snapshot_id: SNAPSHOT_ID,
              universe_id: UNIVERSE_ID,
              root_page_id: ROOT_PAGE_ID,
              manifest_hash: HASH_A,
              embedding_model: 'text-embedding-test',
              page_count: 2,
              chunk_count: 2,
              source_max_edited_at: NOW,
              sync_holder_id: 'sync-worker-1',
              snapshot_created_at: NOW,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('AS page_count') && sql.includes('AS chunk_count')) {
          return {
            rows: [{ page_count: '2', chunk_count: '1' }],
            rowCount: 1,
          };
        }
        return {
          rows: [],
          rowCount: sql.startsWith('UPDATE backstage_notion_authority_epoch') ? 1 : 0,
        };
      },
      release: () => undefined,
    };
    const repository = new PostgresBackstageNotionRagRepository({
      connect: async () => client,
    } as unknown as Pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toMatchObject({
      name: 'BackstageNotionSnapshotWriteError',
      phase: 'completeness_validation',
    });
    expect(commands).toContain('ROLLBACK');
    expect(commands.some(sql => (
      sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
    ))).toBe(false);
  });

  it('retains deterministic chunk IDs across distinct immutable snapshots', async () => {
    const chunkInserts: Array<{ snapshotId: string; chunkIds: string[] }> = [];
    const client = {
      query: async (rawSql: string, values: unknown[] = []) => {
        const sql = normalizeSql(rawSql);
        if (sql.startsWith('SELECT lease.universe_id')) {
          return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO backstage_notion_snapshots')) {
          return {
            rows: [{
              snapshot_id: values[0],
              universe_id: values[1],
              root_page_id: values[2],
              manifest_hash: values[3],
              embedding_model: values[4],
              page_count: values[5],
              chunk_count: values[6],
              source_max_edited_at: values[7],
              sync_holder_id: values[8],
              snapshot_created_at: NOW
            }],
            rowCount: 1
          };
        }
        if (sql.startsWith('INSERT INTO backstage_notion_snapshot_chunks')) {
          const chunks = JSON.parse(String(values[3])) as Array<{ chunk_id: string }>;
          chunkInserts.push({
            snapshotId: String(values[0]),
            chunkIds: chunks.map(chunk => chunk.chunk_id)
          });
        }
        if (sql.includes('AS page_count') && sql.includes('AS chunk_count')) {
          return {
            rows: [{ page_count: '2', chunk_count: '2' }],
            rowCount: 1,
          };
        }
        return {
          rows: [],
          rowCount: sql.startsWith('UPDATE backstage_notion_universe_heads AS head')
            || sql.startsWith('UPDATE backstage_notion_authority_epoch')
            ? 1
            : 0
        };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await repository.activateSnapshot(validSnapshotInput());
    await repository.activateSnapshot({
      ...validSnapshotInput(),
      manifestHash: 'b'.repeat(64)
    });

    expect(chunkInserts).toHaveLength(2);
    expect(chunkInserts[0]?.snapshotId).not.toBe(chunkInserts[1]?.snapshotId);
    expect(chunkInserts[0]?.chunkIds).toEqual([ROOT_CHUNK_ID, CHUNK_ID]);
    expect(chunkInserts[1]?.chunkIds).toEqual(chunkInserts[0]?.chunkIds);
  });

  it('rolls back without inserting when its fenced lease is no longer valid', async () => {
    const commands: string[] = [];
    const client = {
      query: async (rawSql: string) => {
        const sql = normalizeSql(rawSql);
        commands.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toBeInstanceOf(
      BackstageNotionSyncLeaseError
    );
    expect(commands).toContain('ROLLBACK');
    expect(commands.some(sql => sql.startsWith('INSERT INTO backstage_notion_snapshots'))).toBe(false);
  });

  it('fails closed before inserting when the authority epoch row is unavailable', async () => {
    const commands: string[] = [];
    const client = {
      query: async (rawSql: string) => {
        const sql = normalizeSql(rawSql);
        commands.push(sql);
        if (sql.startsWith('SELECT lease.universe_id')) {
          return { rows: [{ universe_id: UNIVERSE_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toMatchObject({
      name: 'BackstageNotionSnapshotWriteError',
      phase: 'persistence',
    });
    expect(commands).toContain('ROLLBACK');
    expect(commands.some(sql => sql.startsWith('INSERT INTO backstage_notion_snapshots'))).toBe(false);
  });

  it('rejects a forged content hash before opening a database transaction', async () => {
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        throw new Error('SENTINEL_CONNECT');
      }
    } as unknown as Pool;
    const repository = new PostgresBackstageNotionRagRepository(pool);
    const input = validSnapshotInput();
    input.chunks[0] = { ...input.chunks[0]!, contentHash: HASH_A };

    await expect(repository.activateSnapshot(input)).rejects.toThrow(
      'contentHash does not match its content'
    );
    expect(connected).toBe(false);
  });

  it('rejects snapshots larger than the shared retrievable chunk cap before connecting', async () => {
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        throw new Error('SENTINEL_CONNECT');
      }
    } as unknown as Pool;
    const repository = new PostgresBackstageNotionRagRepository(pool);
    const input = validSnapshotInput();
    input.chunks = Array.from(
      { length: BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT + 1 },
      () => input.chunks[0]!
    );

    await expect(repository.activateSnapshot(input)).rejects.toThrow(
      `chunks must contain 1-${BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT} records.`
    );
    expect(connected).toBe(false);
  });

  it('loads reusable embeddings only from the requested universe and model', async () => {
    let observedSql = '';
    let observedValues: unknown[] = [];
    const pool = createPool(async (rawSql, values) => {
      observedSql = normalizeSql(rawSql);
      observedValues = values;
      return {
        rows: [{ content_hash: HASH_A, embedding: [0.1, 0.2] }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    const embeddings = await repository.loadReusableEmbeddings(
      UNIVERSE_ID,
      'text-embedding-test',
      [HASH_A]
    );

    expect(embeddings.get(HASH_A)).toEqual([0.1, 0.2]);
    expect(observedSql).toContain('WHERE chunk.universe_id = $1');
    expect(observedSql).toContain('AND chunk.embedding_model = $2');
    expect(observedSql).toContain('chunk.content_hash = ANY($3::TEXT[])');
    expect(observedValues).toEqual([UNIVERSE_ID, 'text-embedding-test', [HASH_A]]);
  });

  it('loads chunks only through the requested universe active head', async () => {
    let observedSql = '';
    let observedValues: unknown[] = [];
    const activeRow = {
      authority: 'notion' as const,
      verified_at: NOW,
      snapshot_id: SNAPSHOT_ID,
      universe_id: UNIVERSE_ID,
      root_page_id: ROOT_PAGE_ID,
      manifest_hash: HASH_A,
      embedding_model: 'text-embedding-test',
      page_count: 1,
      chunk_count: 2,
      source_max_edited_at: NOW,
      sync_holder_id: 'sync-worker-1',
      snapshot_created_at: NOW,
      chunk_id: CHUNK_ID,
      page_id: ROOT_PAGE_ID,
      page_title: 'WWE Universe Mode',
      canonical_url: null,
      page_path: ['WWE Universe Mode'],
      ordinal: 0,
      content_hash: HASH_A,
      content: 'Current active context.',
      code_points: 23,
      chunk_embedding_model: 'text-embedding-test',
      embedding: [0.1, 0.2],
      heading_path: [],
      chunk_metadata: {}
    };
    const pool = createPool(async (rawSql, values) => {
      observedSql = normalizeSql(rawSql);
      observedValues = values;
      return { rows: [activeRow, { ...activeRow, ordinal: 1 }], rowCount: 2 };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    const active = await repository.loadActiveSnapshot(UNIVERSE_ID, 1);

    expect(active?.snapshot.id).toBe(SNAPSHOT_ID);
    expect(active?.verifiedAt).toEqual(NOW);
    expect(active?.chunks).toHaveLength(1);
    expect(active?.chunks[0]?.codePoints).toBe(23);
    expect(active?.truncated).toBe(true);
    expect(observedSql).toContain('snapshot.id = head.active_snapshot_id');
    expect(observedSql).toContain('chunk.snapshot_id = head.active_snapshot_id');
    expect(observedSql).toContain("head.authority = 'notion'");
    expect(observedValues).toEqual([UNIVERSE_ID, 2]);
  });

  it('loads a continuation snapshot header without joining chunk payloads', async () => {
    let observedSql = '';
    let observedValues: unknown[] = [];
    const pool = createPool(async (rawSql, values) => {
      observedSql = normalizeSql(rawSql);
      observedValues = values;
      return {
        rows: [{
          authority: 'notion',
          verified_at: NOW,
          snapshot_id: SNAPSHOT_ID,
          universe_id: UNIVERSE_ID,
          root_page_id: ROOT_PAGE_ID,
          manifest_hash: HASH_A,
          embedding_model: 'text-embedding-test',
          page_count: 2,
          chunk_count: 15,
          source_max_edited_at: NOW,
          sync_holder_id: 'sync-worker-1',
          snapshot_created_at: NOW
        }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.loadActiveSnapshotHeader(UNIVERSE_ID)).resolves.toEqual({
      authority: 'notion',
      verifiedAt: NOW,
      snapshot: expect.objectContaining({
        id: SNAPSHOT_ID,
        chunkCount: 15
      })
    });

    expect(observedSql).toContain('snapshot.id = head.active_snapshot_id');
    expect(observedSql).not.toContain('backstage_notion_snapshot_chunks');
    expect(observedSql).not.toContain('backstage_notion_snapshot_pages');
    expect(observedSql).not.toContain('content');
    expect(observedSql).not.toContain('metadata');
    expect(observedValues).toEqual([UNIVERSE_ID]);
  });

  it('returns null when the active continuation snapshot header is absent', async () => {
    const repository = new PostgresBackstageNotionRagRepository(
      createPool(async () => ({ rows: [], rowCount: 0 }))
    );

    await expect(repository.loadActiveSnapshotHeader(UNIVERSE_ID)).resolves.toBeNull();
  });

  it('rejects non-canonical persisted page and heading scope indexes before connecting', async () => {
    for (const [field, value] of [
      ['indexFormat', 'unsupported-index'],
      ['headingIndexVersion', BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION + 1],
      ['scopeTitleKey', HASH_A]
    ] as const) {
      await expectSnapshotValidationError((input) => {
        input.pages[0]!.metadata = {
          ...pageScopeMetadata(ROOT_TITLE, ROOT_PATH),
          [field]: value
        };
      }, 'does not describe the current Notion scope index');
    }

    for (const scopePathKey of [
      'not-an-array',
      [],
      [HASH_A]
    ]) {
      await expectSnapshotValidationError((input) => {
        input.pages[0]!.metadata = {
          ...pageScopeMetadata(ROOT_TITLE, ROOT_PATH),
          scopePathKey
        };
      }, 'does not match its normalized indexed source');
    }

    await expectSnapshotValidationError((input) => {
      input.chunks[0]!.metadata = {
        ...chunkScopeMetadata([]),
        headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION + 1
      };
    }, 'does not describe the current heading index');

    for (const headingOccurrencePath of [
      'not-an-array',
      [1]
    ]) {
      await expectSnapshotValidationError((input) => {
        input.chunks[0]!.metadata = {
          ...chunkScopeMetadata([]),
          headingOccurrencePath
        };
      }, 'headingOccurrencePath is invalid');
    }

    for (const occurrence of [
      1.5,
      0,
      BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT + 1
    ]) {
      await expectSnapshotValidationError((input) => {
        input.chunks[1]!.metadata = {
          ...chunkScopeMetadata(['Kayfabe']),
          headingOccurrencePath: [occurrence]
        };
      }, 'headingOccurrencePath is invalid');
    }
  });

  it('defaults an omitted chunk heading path before entering the transaction', async () => {
    let connected = false;
    const repository = new PostgresBackstageNotionRagRepository({
      connect: async () => {
        connected = true;
        throw new Error('SENTINEL_CONNECT');
      }
    } as unknown as Pool);
    const input = validSnapshotInput();
    delete input.chunks[0]!.headingPath;

    await expect(repository.activateSnapshot(input)).rejects.toThrow('SENTINEL_CONNECT');
    expect(connected).toBe(true);
  });

  it('rejects malformed bounded scope lookups before querying PostgreSQL', async () => {
    let queries = 0;
    const repository = new PostgresBackstageNotionRagRepository(createPool(async () => {
      queries += 1;
      throw new Error('SENTINEL_QUERY');
    }));
    const validLookup = {
      pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
      pagePathKey: null,
      sectionPathKey: null
    };
    const malformedLookups: Array<{ lookup: unknown; message: string }> = [
      { lookup: null, message: 'lookup must describe a bounded Notion scope' },
      { lookup: 42, message: 'lookup must describe a bounded Notion scope' },
      { lookup: [], message: 'lookup must describe a bounded Notion scope' },
      {
        lookup: { ...validLookup, pageTitleKey: 42 },
        message: 'pageTitleKey must be a canonical Notion scope-key digest'
      },
      {
        lookup: { ...validLookup, pageTitleKey: 'not-a-digest' },
        message: 'pageTitleKey must be a canonical Notion scope-key digest'
      },
      {
        lookup: { ...validLookup, pagePathKey: 'not-an-array' },
        message: 'pagePathKey must contain 1-101 scope keys'
      },
      {
        lookup: { ...validLookup, pagePathKey: [] },
        message: 'pagePathKey must contain 1-101 scope keys'
      },
      {
        lookup: { ...validLookup, pagePathKey: Array(102).fill(HASH_A) },
        message: 'pagePathKey must contain 1-101 scope keys'
      },
      {
        lookup: { ...validLookup, scopeKind: 'unsupported' },
        message: 'scopeKind must describe a page or section-free subtree scope'
      },
      {
        lookup: {
          ...validLookup,
          scopeKind: 'subtree',
          sectionPathKey: [HASH_A]
        },
        message: 'scopeKind must describe a page or section-free subtree scope'
      }
    ];

    for (const { lookup, message } of malformedLookups) {
      await expect(repository.resolveSnapshotScope(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        lookup as never
      )).rejects.toThrow(message);
    }
    expect(queries).toBe(0);
  });

  it('resolves a scoped snapshot with bounded aggregate and LIMIT-2 projections', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const pool = createPool(async (rawSql, values) => {
      const sql = normalizeSql(rawSql);
      commands.push({ sql, values });
      if (sql.includes('scope_integrity_valid')) {
        return { rows: [{ scope_integrity_valid: true }], rowCount: 1 };
      }
      if (sql.includes('title_matching_pages AS')) {
        return {
          rows: [{
            page_id: CHILD_PAGE_ID,
            page_title: CHILD_TITLE,
            page_path: CHILD_PATH,
            scope_chunk_count: '15',
            scope_page_count: '1'
          }],
          rowCount: 1
        };
      }
      return {
        rows: [{
          section_occurrence_path: [1],
          section_path: ['Kayfabe'],
          scope_chunk_count: '13'
        }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.resolveSnapshotScope(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
        pagePathKey: normalizeBackstageNotionScopePath(CHILD_PATH),
        sectionPathKey: normalizeBackstageNotionScopePath(['Kayfabe'])
      }
    )).resolves.toEqual({
      status: 'resolved',
      pageTitle: CHILD_TITLE,
      pagePath: CHILD_PATH,
      sectionPath: ['Kayfabe'],
      selector: {
        pageId: CHILD_PAGE_ID,
        scopeKind: 'page',
        sectionOccurrencePath: [1]
      },
      scopeChunkCount: 13,
      scopePageCount: 1
    });

    expect(commands).toHaveLength(3);
    const integrity = commands[0];
    const pages = commands[1];
    const sections = commands[2];
    expect(integrity?.sql).toContain('snapshot.id = $2::UUID');
    expect(integrity?.sql).toContain("!~ '^[0-9a-f]{64}$'");
    expect(integrity?.sql).toContain('scopeHeadingPathKey');
    expect(integrity?.sql).not.toMatch(/\bchunk\.content\b/u);
    expect(integrity?.sql).not.toMatch(/\bchunk\.embedding\b/u);
    expect(integrity?.sql).not.toContain('page.markdown');
    expect(integrity?.sql).not.toContain('page.metadata AS');
    expect(pages?.sql).toContain('LIMIT 2');
    expect(pages?.sql).toContain('COLLATE "C"');
    expect(pages?.sql).toContain("page.metadata -> 'scopePathKey' = to_jsonb($4::TEXT[])");
    expect(pages?.sql).not.toMatch(/\bchunk\.content\b/u);
    expect(pages?.sql).not.toMatch(/\bchunk\.embedding\b/u);
    expect(pages?.sql).not.toContain('page.markdown');
    expect(sections?.sql).toContain('LIMIT 2');
    expect(sections?.sql).toContain('scopeHeadingPathKey');
    expect(sections?.sql).toContain('cardinality($4::TEXT[])');
    expect(sections?.sql).not.toMatch(/\bchunk\.content\b/u);
    expect(sections?.sql).not.toMatch(/\bchunk\.embedding\b/u);
    expect(commands.flatMap(command => command.values).some(value => (
      typeof value === 'string' && value.length > 128
    ))).toBe(false);
  });

  it('resolves a blank subtree anchor through bounded recursive descendants', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const repository = new PostgresBackstageNotionRagRepository(createPool(
      async (rawSql, values) => {
        const sql = normalizeSql(rawSql);
        commands.push({ sql, values });
        if (sql.includes('scope_integrity_valid')) {
          return { rows: [{ scope_integrity_valid: true }], rowCount: 1 };
        }
        return {
          rows: [{
            page_id: CHILD_PAGE_ID,
            page_title: CHILD_TITLE,
            page_path: CHILD_PATH,
            scope_chunk_count: '4',
            scope_page_count: '2'
          }],
          rowCount: 1
        };
      }
    ));

    await expect(repository.resolveSnapshotScope(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
        pagePathKey: normalizeBackstageNotionScopePath(CHILD_PATH),
        sectionPathKey: null,
        scopeKind: 'subtree'
      }
    )).resolves.toEqual({
      status: 'resolved',
      pageTitle: CHILD_TITLE,
      pagePath: CHILD_PATH,
      sectionPath: null,
      selector: {
        pageId: CHILD_PAGE_ID,
        scopeKind: 'subtree',
        sectionOccurrencePath: null
      },
      scopeChunkCount: 4,
      scopePageCount: 2
    });

    expect(commands).toHaveLength(2);
    expect(commands[1]?.sql).toContain('WITH RECURSIVE title_matching_pages AS');
    expect(commands[1]?.sql).toContain('child.parent_page_id = scoped_page.scoped_page_id');
    expect(commands[1]?.sql).toContain('COUNT(DISTINCT scoped_chunk.page_id)');
    expect(commands[1]?.sql).toContain('ORDER BY page.page_id COLLATE "C" LIMIT 2');
    expect(commands[1]?.values).toEqual([
      UNIVERSE_ID,
      SNAPSHOT_ID,
      normalizeBackstageNotionScopeKey(CHILD_TITLE),
      normalizeBackstageNotionScopePath(CHILD_PATH),
      'subtree'
    ]);
  });

  it('reports an empty blank subtree as not found', async () => {
    const repository = new PostgresBackstageNotionRagRepository(createPool(
      async rawSql => {
        const sql = normalizeSql(rawSql);
        return sql.includes('scope_integrity_valid')
          ? { rows: [{ scope_integrity_valid: true }], rowCount: 1 }
          : {
              rows: [validPageScopeCandidate({
                scope_chunk_count: '0',
                scope_page_count: '0'
              })],
              rowCount: 1
            };
      }
    ));

    await expect(repository.resolveSnapshotScope(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
        pagePathKey: normalizeBackstageNotionScopePath(CHILD_PATH),
        sectionPathKey: null,
        scopeKind: 'subtree'
      }
    )).resolves.toEqual({ status: 'not_found' });
  });

  it('fails closed or reports bounded ambiguity without loading section rows', async () => {
    const pageCandidate = {
      page_id: CHILD_PAGE_ID,
      page_title: CHILD_TITLE,
      page_path: CHILD_PATH,
      scope_chunk_count: '1',
      scope_page_count: '1'
    };
    const run = async (integrityValid: boolean, pageRows: unknown[]) => {
      const commands: string[] = [];
      const repository = new PostgresBackstageNotionRagRepository(createPool(
        async (rawSql) => {
          const sql = normalizeSql(rawSql);
          commands.push(sql);
          return sql.includes('scope_integrity_valid')
            ? { rows: [{ scope_integrity_valid: integrityValid }], rowCount: 1 }
            : { rows: pageRows, rowCount: pageRows.length };
        }
      ));
      const result = await repository.resolveSnapshotScope(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        {
          pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
          pagePathKey: null,
          sectionPathKey: normalizeBackstageNotionScopePath(['Kayfabe'])
        }
      );
      return { commands, result };
    };

    await expect(run(false, [])).resolves.toMatchObject({
      commands: [expect.stringContaining('scope_integrity_valid')],
      result: { status: 'invalid' }
    });
    await expect(run(true, [
      pageCandidate,
      { ...pageCandidate, page_id: ROOT_PAGE_ID }
    ])).resolves.toMatchObject({
      commands: [
        expect.stringContaining('scope_integrity_valid'),
        expect.stringContaining('LIMIT 2')
      ],
      result: { status: 'ambiguous' }
    });
  });

  it('handles bounded page-scope absence, corruption, and page-only resolution', async () => {
    const resolvePageRows = async (
      pageRows: unknown[],
      sectionPathKey: readonly string[] | null = null
    ) => {
      const repository = new PostgresBackstageNotionRagRepository(createPool(
        async (rawSql) => {
          const sql = normalizeSql(rawSql);
          if (sql.includes('scope_integrity_valid')) {
            return { rows: [{ scope_integrity_valid: true }], rowCount: 1 };
          }
          if (sql.includes('title_matching_pages AS')) {
            return { rows: pageRows, rowCount: pageRows.length };
          }
          throw new Error('SENTINEL_UNEXPECTED_SECTION_QUERY');
        }
      ));
      return repository.resolveSnapshotScope(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        {
          pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
          pagePathKey: normalizeBackstageNotionScopePath(CHILD_PATH),
          sectionPathKey
        }
      );
    };

    await expect(resolvePageRows([])).resolves.toEqual({ status: 'not_found' });

    const sparsePageRows = Array<unknown>(1);
    await expect(resolvePageRows(sparsePageRows)).resolves.toEqual({ status: 'invalid' });

    await expect(resolvePageRows([
      validPageScopeCandidate({ scope_chunk_count: '0' })
    ])).resolves.toEqual({ status: 'invalid' });
    await expect(resolvePageRows([
      validPageScopeCandidate({
        scope_chunk_count: String(BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT + 1)
      })
    ])).resolves.toEqual({ status: 'invalid' });

    await expect(resolvePageRows([
      validPageScopeCandidate({ scope_chunk_count: '2' })
    ])).resolves.toEqual({
      status: 'resolved',
      pageTitle: CHILD_TITLE,
      pagePath: CHILD_PATH,
      sectionPath: null,
      selector: {
        pageId: CHILD_PAGE_ID,
        scopeKind: 'page',
        sectionOccurrencePath: null
      },
      scopeChunkCount: 2,
      scopePageCount: 1
    });

    for (const pagePath of [
      [],
      Array(102).fill('path-segment'),
      [' padded path segment ']
    ]) {
      await expect(resolvePageRows([
        validPageScopeCandidate({ page_path: pagePath })
      ])).rejects.toThrow(/page_path/u);
    }
  });

  it('handles bounded section-scope absence, ambiguity, corruption, and string counts', async () => {
    const resolveSectionRows = async (sectionRows: unknown[]) => {
      const repository = new PostgresBackstageNotionRagRepository(createPool(
        async (rawSql) => {
          const sql = normalizeSql(rawSql);
          if (sql.includes('scope_integrity_valid')) {
            return { rows: [{ scope_integrity_valid: true }], rowCount: 1 };
          }
          if (sql.includes('title_matching_pages AS')) {
            return { rows: [validPageScopeCandidate()], rowCount: 1 };
          }
          return { rows: sectionRows, rowCount: sectionRows.length };
        }
      ));
      return repository.resolveSnapshotScope(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        {
          pageTitleKey: normalizeBackstageNotionScopeKey(CHILD_TITLE),
          pagePathKey: normalizeBackstageNotionScopePath(CHILD_PATH),
          sectionPathKey: normalizeBackstageNotionScopePath(['Kayfabe'])
        }
      );
    };

    await expect(resolveSectionRows([])).resolves.toEqual({ status: 'not_found' });
    await expect(resolveSectionRows([
      validSectionScopeCandidate(),
      validSectionScopeCandidate({ section_occurrence_path: [2] })
    ])).resolves.toEqual({ status: 'ambiguous' });

    const sparseSectionRows = Array<unknown>(1);
    await expect(resolveSectionRows(sparseSectionRows)).resolves.toEqual({ status: 'invalid' });

    await expect(resolveSectionRows([
      validSectionScopeCandidate({ section_path: ['Kayfabe', 'Roster'] })
    ])).resolves.toEqual({ status: 'invalid' });

    await expect(resolveSectionRows([
      validSectionScopeCandidate({ section_occurrence_path: 'not-an-array' })
    ])).rejects.toThrow('section_occurrence_path escaped its expected length');
    await expect(resolveSectionRows([
      validSectionScopeCandidate({ section_occurrence_path: [1, 2] })
    ])).rejects.toThrow('section_occurrence_path escaped its expected length');

    await expect(resolveSectionRows([
      validSectionScopeCandidate({
        section_occurrence_path: ['1'],
        scope_chunk_count: '1'
      })
    ])).resolves.toEqual(expect.objectContaining({
      status: 'resolved',
      selector: {
        pageId: CHILD_PAGE_ID,
        scopeKind: 'page',
        sectionOccurrencePath: [1]
      },
      scopeChunkCount: 1,
      scopePageCount: 1
    }));

    await expect(resolveSectionRows([
      validSectionScopeCandidate({ scope_chunk_count: '0' })
    ])).resolves.toEqual({ status: 'invalid' });
    await expect(resolveSectionRows([
      validSectionScopeCandidate({ scope_chunk_count: '16' })
    ])).resolves.toEqual({ status: 'invalid' });
  });

  it('counts and pages an exact snapshot scope with code-point-stable SQL ordering', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const pool = createPool(async (rawSql, values) => {
      const sql = normalizeSql(rawSql);
      commands.push({ sql, values });
      if (sql.includes('COUNT(*) AS scope_chunk_count')) {
        return { rows: [{ scope_chunk_count: '15' }], rowCount: 1 };
      }
      return {
        rows: [{
          chunk_id: CHUNK_ID,
          page_id: CHILD_PAGE_ID,
          page_title: CHILD_TITLE,
          canonical_url: null,
          page_path: CHILD_PATH,
          ordinal: 0,
          content_hash: CHUNK_CONTENT_HASH,
          content: CHUNK_CONTENT,
          code_points: Array.from(CHUNK_CONTENT).length,
          chunk_embedding_model: 'text-embedding-test',
          heading_path: ['Kayfabe'],
          chunk_metadata: {
            category: 'kayfabe',
            headingOccurrencePath: [1, 2]
          }
        }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.loadSnapshotChunkPage(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: CHILD_PAGE_ID,
        scopeKind: 'page',
        sectionOccurrencePath: [1, 2]
      },
      null,
      12,
      12
    )).resolves.toEqual({
      scopeChunkCount: 15,
      chunks: [expect.objectContaining({
        id: CHUNK_ID,
        content: CHUNK_CONTENT,
        headingPath: ['Kayfabe']
      })]
    });

    expect(commands).toHaveLength(2);
    const count = commands[0];
    const page = commands[1];
    expect(count?.sql).toContain('chunk.snapshot_id = $2::UUID');
    expect(count?.sql).toContain('anchor.snapshot_id = $2::UUID');
    expect(count?.sql).toContain('unnest($5::INTEGER[]) WITH ORDINALITY');
    expect(count?.sql).not.toContain('chunk.content');
    expect(count?.sql).not.toMatch(/\bchunk\.embedding\b/u);
    expect(page?.sql).toContain('jsonb_array_elements_text(page.path) WITH ORDINALITY');
    expect(page?.sql).toContain('path_segment.value COLLATE "C"');
    expect(page?.sql).toContain('page.title COLLATE "C"');
    expect(page?.sql).not.toContain('page.path::TEXT');
    expect(page?.sql).toContain('LIMIT $6 OFFSET $7');
    expect(page?.sql).not.toMatch(/\bchunk\.embedding\b/u);
    expect(page?.sql).not.toContain('page.canonical_url');
    expect(page?.sql).toContain('jsonb_build_object(');
    expect(page?.sql).not.toContain('chunk.metadata AS chunk_metadata');
    expect(page?.values).toEqual([
      UNIVERSE_ID,
      SNAPSHOT_ID,
      CHILD_PAGE_ID,
      'page',
      [1, 2],
      12,
      12
    ]);
  });

  it('pages subtree chunks through the internal page-id recursive selector', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const repository = new PostgresBackstageNotionRagRepository(createPool(
      async (rawSql, values) => {
        const sql = normalizeSql(rawSql);
        commands.push({ sql, values });
        if (sql.includes('COUNT(*) AS scope_chunk_count')) {
          return { rows: [{ scope_chunk_count: '1' }], rowCount: 1 };
        }
        return {
          rows: [{
            chunk_id: CHUNK_ID,
            page_id: CHILD_PAGE_ID,
            page_title: CHILD_TITLE,
            page_path: CHILD_PATH,
            ordinal: 0,
            content_hash: CHUNK_CONTENT_HASH,
            content: CHUNK_CONTENT,
            code_points: Array.from(CHUNK_CONTENT).length,
            chunk_embedding_model: 'text-embedding-test',
            heading_path: [],
            chunk_metadata: {
              category: 'kayfabe',
              headingOccurrencePath: []
            }
          }],
          rowCount: 1
        };
      }
    ));

    await expect(repository.loadSnapshotChunkPage(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: ROOT_PAGE_ID,
        scopeKind: 'subtree',
        sectionOccurrencePath: null
      },
      null,
      0,
      12
    )).resolves.toMatchObject({ scopeChunkCount: 1, chunks: [{ id: CHUNK_ID }] });

    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.sql).toContain('WITH RECURSIVE scope_pages(page_id) AS');
      expect(command.sql).toContain('child.parent_page_id = parent.page_id');
      expect(command.values.slice(0, 5)).toEqual([
        UNIVERSE_ID,
        SNAPSHOT_ID,
        ROOT_PAGE_ID,
        'subtree',
        null
      ]);
    }
  });

  it('uses the signed immutable scope count to avoid rescanning continuation scope metadata', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const pool = createPool(async (rawSql, values) => {
      const sql = normalizeSql(rawSql);
      commands.push({ sql, values });
      return {
        rows: [{
          chunk_id: CHUNK_ID,
          page_id: CHILD_PAGE_ID,
          page_title: CHILD_TITLE,
          canonical_url: null,
          page_path: CHILD_PATH,
          ordinal: 0,
          content_hash: CHUNK_CONTENT_HASH,
          content: CHUNK_CONTENT,
          code_points: Array.from(CHUNK_CONTENT).length,
          chunk_embedding_model: 'text-embedding-test',
          heading_path: ['Kayfabe'],
          chunk_metadata: {
            category: 'kayfabe',
            headingOccurrencePath: [1]
          }
        }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    const page = await repository.loadSnapshotChunkPage(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: CHILD_PAGE_ID,
        scopeKind: 'page',
        sectionOccurrencePath: [1]
      },
      15,
      12,
      12
    );

    expect(page.scopeChunkCount).toBe(15);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.sql).not.toContain('COUNT(*) AS scope_chunk_count');
    expect(commands[0]?.sql).toContain('LIMIT $6 OFFSET $7');
    expect(commands[0]?.sql).toContain('chunk.content');
    expect(commands[0]?.sql).toContain('jsonb_build_object(');
    expect(commands[0]?.sql).not.toContain('chunk.metadata AS chunk_metadata');
    expect(commands[0]?.sql).not.toMatch(/\bchunk\.embedding\b/u);
  });

  it('rejects malformed snapshot chunk selectors before querying PostgreSQL', async () => {
    let queries = 0;
    const repository = new PostgresBackstageNotionRagRepository(createPool(async () => {
      queries += 1;
      throw new Error('SENTINEL_QUERY');
    }));
    const malformedSelectors = [
      null,
      42,
      [],
      { pageId: 42, scopeKind: 'page', sectionOccurrencePath: null },
      { pageId: CHILD_PAGE_ID, scopeKind: 'page', sectionOccurrencePath: 'not-an-array' },
      { pageId: null, scopeKind: 'all', sectionOccurrencePath: [1] },
      { pageId: CHILD_PAGE_ID, scopeKind: 'all', sectionOccurrencePath: null },
      { pageId: null, scopeKind: 'subtree', sectionOccurrencePath: null },
      { pageId: CHILD_PAGE_ID, scopeKind: 'subtree', sectionOccurrencePath: [1] }
    ];

    for (const selector of malformedSelectors) {
      await expect(repository.loadSnapshotChunkPage(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        selector as never,
        1,
        0,
        1
      )).rejects.toThrow('selector must describe a supported snapshot scope');
    }

    for (const sectionOccurrencePath of [
      [],
      Array(33).fill(1)
    ]) {
      await expect(repository.loadSnapshotChunkPage(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        { pageId: CHILD_PAGE_ID, scopeKind: 'page', sectionOccurrencePath },
        1,
        0,
        1
      )).rejects.toThrow('sectionOccurrencePath must contain 1-32 occurrences');
    }
    expect(queries).toBe(0);
  });

  it('fails closed on invalid snapshot scope counts and short-circuits empty pages', async () => {
    const loadWithCountRows = (
      rows: unknown[],
      offset = 0
    ) => {
      const repository = new PostgresBackstageNotionRagRepository(createPool(async () => ({
        rows,
        rowCount: rows.length
      })));
      return repository.loadSnapshotChunkPage(
        UNIVERSE_ID,
        SNAPSHOT_ID,
        { pageId: null, scopeKind: 'all', sectionOccurrencePath: null },
        null,
        offset,
        1
      );
    };

    await expect(loadWithCountRows([])).rejects.toThrow(
      'Snapshot scope chunk count escaped its supported bounds'
    );
    await expect(loadWithCountRows([{}])).rejects.toThrow(
      'Snapshot scope chunk count escaped its supported bounds'
    );
    await expect(loadWithCountRows([{
      scope_chunk_count: String(BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT + 1)
    }])).rejects.toThrow('Snapshot scope chunk count escaped its supported bounds');
    await expect(loadWithCountRows([{
      scope_chunk_count: '0'
    }])).resolves.toEqual({ scopeChunkCount: 0, chunks: [] });

    let queried = false;
    const offsetRepository = new PostgresBackstageNotionRagRepository(createPool(async () => {
      queried = true;
      throw new Error('SENTINEL_QUERY');
    }));
    await expect(offsetRepository.loadSnapshotChunkPage(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      { pageId: null, scopeKind: 'all', sectionOccurrencePath: null },
      3,
      3,
      1
    )).resolves.toEqual({ scopeChunkCount: 3, chunks: [] });
    expect(queried).toBe(false);
  });

  it('rejects a database page that exceeds the requested chunk limit', async () => {
    const repository = new PostgresBackstageNotionRagRepository(createPool(async () => ({
      rows: [{}, {}],
      rowCount: 2
    })));

    await expect(repository.loadSnapshotChunkPage(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      { pageId: CHILD_PAGE_ID, scopeKind: 'page', sectionOccurrencePath: null },
      2,
      0,
      1
    )).rejects.toThrow('Snapshot chunk page exceeded its requested limit');
  });

  it('reads and refreshes only the active manifest under a valid lease', async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const pool = createPool(async (rawSql, values) => {
      const sql = normalizeSql(rawSql);
      commands.push({ sql, values });
      if (sql.startsWith('UPDATE backstage_notion_universe_heads AS head')) {
        return { rows: [{ last_verified_at: NOW }], rowCount: 1 };
      }
      return {
        rows: [{
          authority: 'notion',
          verified_at: NOW,
          snapshot_id: SNAPSHOT_ID,
          universe_id: UNIVERSE_ID,
          root_page_id: ROOT_PAGE_ID,
          manifest_hash: HASH_A,
          embedding_model: 'text-embedding-test',
          page_count: 1,
          chunk_count: 1,
          source_max_edited_at: NOW,
          sync_holder_id: 'sync-worker-1',
          snapshot_created_at: NOW,
          page_id: ROOT_PAGE_ID,
          parent_page_id: null,
          title: 'WWE Universe Mode',
          canonical_url: null,
          content_hash: HASH_A,
          source_last_edited_at: NOW,
          depth: 0,
          path: ['WWE Universe Mode'],
          page_metadata: {}
        }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    const inventory = await repository.loadActiveInventory(UNIVERSE_ID);
    expect(inventory?.snapshot.manifestHash).toBe(HASH_A);
    expect(inventory?.verifiedAt).toEqual(NOW);
    expect(commands[0].sql).toContain('snapshot.id = head.active_snapshot_id');
    expect(commands[0].sql).toContain("head.authority = 'notion'");

    await expect(repository.markActiveSnapshotVerified(
      UNIVERSE_ID,
      HASH_A,
      { holderId: 'sync-worker-1', leaseToken: LEASE_TOKEN }
    )).resolves.toEqual(NOW);
    expect(commands[1].sql).toContain('snapshot.manifest_hash = $2');
    expect(commands[1].sql).toContain('lease.expires_at > clock_timestamp()');
  });
});
