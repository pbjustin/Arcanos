import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const poolSpy = jest.fn(() => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  on: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined)
}));

const mockDotenvConfig = jest.fn();

jest.mock('pg', () => ({
  __esModule: true,
  default: { Pool: poolSpy },
  Pool: poolSpy
}));

jest.mock('dotenv', () => ({
  __esModule: true,
  config: mockDotenvConfig,
  default: { config: mockDotenvConfig }
}));

const deleteEnvKeys = () => {
  const keys = ['DATABASE_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'];
  keys.forEach(key => delete process.env[key]);
};

describe('initializeDatabase env handling', () => {
  beforeEach(() => {
    jest.resetModules();
    poolSpy.mockClear();
    mockDotenvConfig.mockClear();
    deleteEnvKeys();
  });

  it('treats string "undefined" env values as missing and skips pool creation', async () => {
    process.env.DATABASE_URL = 'undefined';
    process.env.PGHOST = 'undefined';

    const { initializeDatabase } = await import('../src/db/client.js');
    const result = await initializeDatabase();

    expect(result).toBe(false);
    expect(poolSpy).not.toHaveBeenCalled();
  });

  it('builds a connection string when discrete PG vars are provided', async () => {
    process.env.PGUSER = 'demo';
    process.env.PGPASSWORD = 'secret';
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = '5432';
    process.env.PGDATABASE = 'arc';

    const { initializeDatabase } = await import('../src/db/client.js');
    const result = await initializeDatabase();

    expect(result).toBe(true);
    expect(poolSpy).toHaveBeenCalledTimes(1);
    const poolInstance = poolSpy.mock.results[0]?.value;
    expect(poolInstance?.query).toHaveBeenCalledWith('SELECT 1');
    expect(process.env.DATABASE_URL).toBe('postgresql://demo:secret@localhost:5432/arc');
  });

  it('falls back to DATABASE_PUBLIC_URL when the Railway private hostname is not resolvable', async () => {
    process.env.DATABASE_URL = 'postgresql://demo:secret@postgres-btrn.railway.internal:5432/arc?sslmode=no-verify';
    process.env.DATABASE_PUBLIC_URL = 'postgresql://demo:secret@public-proxy.rlwy.net:12345/arc?sslmode=no-verify';

    const privateDnsError = Object.assign(new Error('getaddrinfo ENOTFOUND postgres-btrn.railway.internal'), {
      code: 'ENOTFOUND'
    });
    const firstPool = {
      query: jest.fn().mockRejectedValue(privateDnsError),
      on: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined)
    };
    const secondPool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      on: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined)
    };
    poolSpy
      .mockImplementationOnce(() => firstPool)
      .mockImplementationOnce(() => secondPool);

    const { initializeDatabase } = await import('../src/db/client.js');
    const result = await initializeDatabase();

    expect(result).toBe(true);
    expect(poolSpy).toHaveBeenCalledTimes(2);
    expect(firstPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(firstPool.end).toHaveBeenCalledTimes(1);
    expect(secondPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(process.env.DATABASE_URL).toBe(process.env.DATABASE_PUBLIC_URL);
  });

  it('prefers DATABASE_PRIVATE_URL before the public DATABASE_URL when both are configured', async () => {
    process.env.DATABASE_PRIVATE_URL = 'postgresql://demo:secret@postgres-btrn.railway.internal:5432/arc?sslmode=no-verify';
    process.env.DATABASE_URL = 'postgresql://demo:secret@public-proxy.rlwy.net:12345/arc?sslmode=no-verify';

    const firstPool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      on: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined)
    };
    poolSpy.mockImplementationOnce(() => firstPool);

    const { initializeDatabase } = await import('../src/db/client.js');
    const result = await initializeDatabase();

    expect(result).toBe(true);
    expect(poolSpy).toHaveBeenCalledTimes(1);
    expect(poolSpy.mock.calls[0]?.[0]?.connectionString).toBe(process.env.DATABASE_PRIVATE_URL);
    expect(firstPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(process.env.DATABASE_URL).toBe(process.env.DATABASE_PRIVATE_URL);
  });
});
