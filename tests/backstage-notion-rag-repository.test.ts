import { createHash } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';

import {
  BackstageNotionSyncLeaseError,
  PostgresBackstageNotionRagRepository,
  type ActivateBackstageNotionSnapshotInput
} from '../src/core/db/repositories/backstageNotionRagRepository.js';

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
  return {
    query: (sql: string, values: unknown[] = []) => query(sql, values)
  } as unknown as Pool;
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
        path: ROOT_PATH
      },
      {
        pageId: CHILD_PAGE_ID,
        parentPageId: ROOT_PAGE_ID,
        title: CHILD_TITLE,
        contentHash: CHILD_SOURCE_HASH,
        markdown: CHILD_MARKDOWN,
        sourceLastEditedAt: NOW,
        depth: 1,
        path: CHILD_PATH
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
        headingPath: []
      },
      {
        chunkId: CHUNK_ID,
        pageId: CHILD_PAGE_ID,
        ordinal: 0,
        contentHash: CHUNK_CONTENT_HASH,
        content: CHUNK_CONTENT,
        codePoints: Array.from(CHUNK_CONTENT).length,
        embedding: [0.25, -0.5],
        headingPath: ['Kayfabe']
      }
    ]
  };
}

describe('PostgresBackstageNotionRagRepository', () => {
  it('loads the persisted authority head without loading pages or chunks', async () => {
    let observedSql = '';
    let observedValues: unknown[] = [];
    const pool = createPool(async (rawSql, values) => {
      observedSql = normalizeSql(rawSql);
      observedValues = values;
      return {
        rows: [{
          universe_id: UNIVERSE_ID,
          authority: 'notion',
          active_snapshot_id: SNAPSHOT_ID,
          root_page_id: ROOT_PAGE_ID
        }],
        rowCount: 1
      };
    });
    const repository = new PostgresBackstageNotionRagRepository(pool);

    await expect(repository.loadAuthorityHead(` ${UNIVERSE_ID} `)).resolves.toEqual({
      universeId: UNIVERSE_ID,
      authority: 'notion',
      activeSnapshotId: SNAPSHOT_ID,
      rootPageId: ROOT_PAGE_ID
    });
    expect(observedSql).toContain('FROM backstage_notion_universe_heads AS head');
    expect(observedSql).toContain('LEFT JOIN backstage_notion_snapshots AS snapshot');
    expect(observedSql).toContain('snapshot.universe_id = head.universe_id');
    expect(observedSql).toContain('snapshot.id = head.active_snapshot_id');
    expect(observedSql).not.toContain('backstage_notion_snapshot_pages');
    expect(observedSql).not.toContain('backstage_notion_snapshot_chunks');
    expect(observedValues).toEqual([UNIVERSE_ID]);
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

    await expect(repository.releaseSyncLease(
      UNIVERSE_ID,
      'sync-worker-1',
      lease!.leaseToken
    )).resolves.toBe(true);
    expect(commands[2].sql).toContain('AND lease_token = $3::UUID');
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
    expect(commands.indexOf(authorityHeadFence!)).toBeLessThan(commands.indexOf(activation!));
    expect(releasedWith).toBe(false);
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

    await expect(repository.activateSnapshot(validSnapshotInput())).rejects.toThrow(
      'Backstage Notion authority epoch could not be advanced.'
    );
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
