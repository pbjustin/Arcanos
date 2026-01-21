import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const poolSpy = jest.fn(() => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  on: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('pg', () => ({
  __esModule: true,
  default: { Pool: poolSpy },
  Pool: poolSpy
}));

const deleteEnvKeys = () => {
  const keys = ['DATABASE_URL', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'];
  keys.forEach(key => delete process.env[key]);
};

describe('initializeDatabase env handling', () => {
  beforeEach(() => {
    jest.resetModules();
    poolSpy.mockClear();
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
});
