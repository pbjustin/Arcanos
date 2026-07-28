import { describe, expect, it, jest } from '@jest/globals';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakePool {
  public readonly queryMock = jest.fn(async () => ({
    rows: [],
    rowCount: 0
  }));

  public readonly endMock = jest.fn<() => Promise<void>>(
    async () => undefined
  );

  public readonly onMock = jest.fn();

  constructor(_config: unknown) {}

  query(...args: unknown[]) {
    return this.queryMock(...args);
  }

  end(): Promise<void> {
    return this.endMock();
  }

  on(...args: unknown[]): this {
    this.onMock(...args);
    return this;
  }
}

const constructedPools: FakePool[] = [];

jest.unstable_mockModule('pg', () => ({
  default: {
    Pool: class extends FakePool {
      constructor(config: unknown) {
        super(config);
        constructedPools.push(this);
      }
    }
  }
}));

const {
  closePoolIfCurrent,
  getPool,
  initializeDatabase,
  isDatabaseConnected
} = await import('../src/core/db/client.js');

const databaseEnvironmentKeys = [
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGUSER'
] as const;

describe('database pool identity-safe close', () => {
  it('ends captured pools without clearing replacements installed before or during close', async () => {
    const originalEnvironment = Object.fromEntries(
      databaseEnvironmentKeys.map(key => [key, process.env[key]])
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      for (const key of databaseEnvironmentKeys) {
        delete process.env[key];
      }
      const localDatabaseUrl = new URL(
        'postgresql://127.0.0.1:5432/test-db'
      );
      localDatabaseUrl.username = 'test-user';
      localDatabaseUrl.password = 'test-password';
      process.env.DATABASE_URL = localDatabaseUrl.toString();

      await expect(initializeDatabase('pool-a')).resolves.toBe(true);
      const poolA = constructedPools.at(-1);
      expect(poolA).toBeDefined();

      await expect(initializeDatabase('pool-b')).resolves.toBe(true);
      const poolB = constructedPools.at(-1);
      expect(poolB).toBeDefined();
      expect(poolB).not.toBe(poolA);

      await expect(
        closePoolIfCurrent(poolA as unknown as import('pg').Pool)
      ).resolves.toBe(false);
      expect(poolA?.endMock).toHaveBeenCalledTimes(1);
      expect(poolB?.endMock).not.toHaveBeenCalled();
      expect(getPool()).toBe(poolB);
      expect(isDatabaseConnected()).toBe(true);

      const poolBEnd = deferred<void>();
      poolB?.endMock.mockImplementationOnce(() => poolBEnd.promise);
      const closingPoolB = closePoolIfCurrent(
        poolB as unknown as import('pg').Pool
      );

      await expect(initializeDatabase('pool-c')).resolves.toBe(true);
      const poolC = constructedPools.at(-1);
      expect(poolC).toBeDefined();
      expect(poolC).not.toBe(poolB);

      poolBEnd.resolve(undefined);
      await expect(closingPoolB).resolves.toBe(false);
      expect(poolB?.endMock).toHaveBeenCalledTimes(1);
      expect(poolC?.endMock).not.toHaveBeenCalled();
      expect(getPool()).toBe(poolC);
      expect(isDatabaseConnected()).toBe(true);

      poolB?.endMock.mockRejectedValueOnce(
        new Error('Called end on pool more than once')
      );
      await expect(
        closePoolIfCurrent(poolB as unknown as import('pg').Pool)
      ).resolves.toBe(false);
      expect(getPool()).toBe(poolC);
      expect(isDatabaseConnected()).toBe(true);
      expect(error).toHaveBeenCalledWith(
        '[🔌 DB] Failed to close pool:',
        expect.objectContaining({
          message: 'Called end on pool more than once'
        })
      );

      await expect(
        closePoolIfCurrent(poolC as unknown as import('pg').Pool)
      ).resolves.toBe(true);
      expect(poolC?.endMock).toHaveBeenCalledTimes(1);
      expect(getPool()).toBeNull();
      expect(isDatabaseConnected()).toBe(false);
      expect(log).toHaveBeenCalledWith('[🔌 DB] Connection pool closed');
    } finally {
      for (const key of databaseEnvironmentKeys) {
        const originalValue = originalEnvironment[key];
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }
  });
});
