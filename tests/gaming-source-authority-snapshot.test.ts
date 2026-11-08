import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

let connected = false;
const getPool = jest.fn<() => Pool | null>();
jest.unstable_mockModule('../src/core/db/client.js', () => ({ getPool, isDatabaseConnected: () => connected }));
const { readGamingSourceAuthoritySnapshot, GamingSourceRepositoryUnavailableError } =
  await import('../src/core/db/repositories/gamingSourceRepository.js');
const settings = ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'];
let previous: Array<[string, string | undefined]>;
const input = { gameKey: 'portal-2', canonicalUrl: 'https://guides.example.org/exact/guide?edition=base' };
function configuredConnection() {
  connected = true;
  process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:9/synthetic';
}
beforeEach(() => {
  previous = settings.map(name => [name, process.env[name]]);
  for (const name of settings) delete process.env[name];
  connected = false; getPool.mockReset();
  getPool.mockImplementation(() => { throw new Error('Unconfigured snapshot must not acquire a pool.'); });
});
afterEach(() => {
  for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});

describe('server-owned Gaming cache authority snapshots', () => {
  it('preserves unconfigured live operation without a pool or query', async () => {
    expect(await readGamingSourceAuthoritySnapshot(input)).toEqual({ status: 'unconfigured' });
    expect(getPool).not.toHaveBeenCalled();
  });

  it('keeps an explicitly unconfigured instance database-free even when connection status is mocked true', async () => {
    connected = true;
    expect(await readGamingSourceAuthoritySnapshot(input)).toEqual({ status: 'unconfigured' });
    expect(getPool).not.toHaveBeenCalled();
  });

  it('treats blank and normalized absent settings like the existing database client', async () => {
    process.env.DATABASE_URL = ' undefined '; process.env.DATABASE_PRIVATE_URL = 'null'; process.env.PGHOST = ' ';
    expect(await readGamingSourceAuthoritySnapshot(input)).toEqual({ status: 'unconfigured' });
    expect(getPool).not.toHaveBeenCalled();
  });

  it.each(settings)('does not downgrade unavailable or partial %s configuration to no database', async setting => {
    process.env[setting] = 'synthetic-configuration';
    await expect(readGamingSourceAuthoritySnapshot(input)).rejects.toBeInstanceOf(GamingSourceRepositoryUnavailableError);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('uses the existing exact canonical URL/hash/game count and bounded transaction', async () => {
    configuredConnection();
    const query = jest.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.startsWith('SELECT COUNT(*)')
      ? [{ restricted_revision_count: '2', requires_reassessment: true }] : [] }));
    const release = jest.fn();
    const connect = jest.fn(async () => ({ query, release }));
    getPool.mockReturnValue({ connect } as unknown as Pool);
    expect(await readGamingSourceAuthoritySnapshot(input)).toEqual({ status: 'available', restrictedRevisionCount: 2, requiresReassessment: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('canonical_url_hash = $2 AND source.canonical_url = $3'),
      [[input.gameKey], createHash('sha256').update(input.canonicalUrl).digest('hex'), input.canonicalUrl]);
    expect(query).toHaveBeenCalledWith("SELECT set_config('statement_timeout', $1, true)", ['1000ms']);
    expect(query.mock.calls[0][0]).toBe('BEGIN'); expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('requires reassessment for any persisted revision without a current grant, even at restriction count zero', async () => {
    configuredConnection();
    const query = jest.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT COUNT(*)')
      ? [{ restricted_revision_count: '0', requires_reassessment: true }] : [] }));
    getPool.mockReturnValue({ connect: async () => ({ query, release: jest.fn() }) } as unknown as Pool);
    expect(await readGamingSourceAuthoritySnapshot(input)).toEqual({ status: 'available',
      restrictedRevisionCount: 0, requiresReassessment: true });
    // The SQL boundary must observe history itself, including legacy rows whose
    // optional classification/approval metadata is absent or obsolete.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('COUNT(*) > 0 AS requires_reassessment'), expect.any(Array));
  });

  it('aggregates a bounded deduplicated exact key collection in one query without expanding related games', async () => {
    configuredConnection();
    const query = jest.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.startsWith('SELECT COUNT(*)')
      ? [{ restricted_revision_count: '0', requires_reassessment: false }] : [] }));
    const connect = jest.fn(async () => ({ query, release: jest.fn() }));
    getPool.mockReturnValue({ connect } as unknown as Pool);
    const gameKeys = Array.from({ length: 35 }, (_, index) => `exact-source-${index}`);
    const source = { ...input, gameKeys: [input.gameKey, ...gameKeys] };
    expect(await readGamingSourceAuthoritySnapshot(source)).toEqual({ status: 'available', restrictedRevisionCount: 0, requiresReassessment: false });
    expect(connect).toHaveBeenCalledTimes(1);
    const statement = query.mock.calls.find(([sql]) => sql.startsWith('SELECT COUNT(*)'))!;
    expect(statement[0]).toContain('source.game_key = ANY($1::text[])');
    expect(statement[1]).toEqual([[input.gameKey, ...gameKeys], createHash('sha256').update(input.canonicalUrl).digest('hex'), input.canonicalUrl]);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT COUNT(*)'))).toHaveLength(1);
  });

  it('rejects a configured key collection beyond the 36-key bound before SQL', async () => {
    configuredConnection(); getPool.mockReturnValue({ connect: jest.fn() } as unknown as Pool);
    await expect(readGamingSourceAuthoritySnapshot({ ...input,
      gameKeys: Array.from({ length: 36 }, (_, index) => `other-source-${index}`) })).rejects.toThrow('at most 36');
    expect(getPool.mock.results[0].value?.connect).not.toHaveBeenCalled();
  });

  it('deduplicates repeated primary keys before the bounded lookup', async () => {
    configuredConnection();
    const query = jest.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.startsWith('SELECT COUNT(*)')
      ? [{ restricted_revision_count: '0', requires_reassessment: false }] : [] }));
    getPool.mockReturnValue({ connect: async () => ({ query, release: jest.fn() }) } as unknown as Pool);
    await readGamingSourceAuthoritySnapshot({ ...input, gameKeys: [input.gameKey, input.gameKey] });
    expect(query.mock.calls.find(([sql]) => sql.startsWith('SELECT COUNT(*)'))?.[1]?.[0]).toEqual([input.gameKey]);
  });

  it('cancels a late pool waiter before any transaction or SQL can start', async () => {
    configuredConnection();
    const waiter = Promise.withResolvers<any>();
    const query = jest.fn(); const release = jest.fn();
    getPool.mockReturnValue({ connect: () => waiter.promise } as unknown as Pool);
    await expect(readGamingSourceAuthoritySnapshot(input, { queryTimeoutMs: 15 })).rejects.toMatchObject({ name: 'TimeoutError' });
    waiter.resolve({ query, release });
    await new Promise<void>(done => setImmediate(done));
    expect(query).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves caller cancellation even with no configured database', async () => {
    const reason = new Error('owner cancelled');
    await expect(readGamingSourceAuthoritySnapshot(input, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('propagates a configured query failure rather than claiming an available zero epoch', async () => {
    configuredConnection();
    const failure = new Error('Synthetic authority read unavailable');
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT COUNT(*)')) throw failure;
      return { rows: [] };
    });
    const release = jest.fn();
    getPool.mockReturnValue({ connect: async () => ({ query, release }) } as unknown as Pool);
    await expect(readGamingSourceAuthoritySnapshot(input)).rejects.toBe(failure);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(release).toHaveBeenCalledTimes(1);
  });

  it('preserves caller cancellation during a configured pool wait', async () => {
    configuredConnection();
    const waiter = Promise.withResolvers<any>();
    const query = jest.fn(); const release = jest.fn(); const controller = new AbortController();
    getPool.mockReturnValue({ connect: () => waiter.promise } as unknown as Pool);
    const pending = readGamingSourceAuthoritySnapshot(input, { signal: controller.signal });
    const reason = new Error('owner cancelled pending authority read'); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    waiter.resolve({ query, release }); await new Promise<void>(done => setImmediate(done));
    expect(query).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });
});
