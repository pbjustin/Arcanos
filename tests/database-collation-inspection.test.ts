import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';

type DatabaseCollationRow = {
  configured_version: string | null;
  actual_version: string | null;
};

const queryMock =
  jest.fn<(text: string) => Promise<{ rows: DatabaseCollationRow[] }>>();
let databaseAvailable = true;

jest.unstable_mockModule('../src/core/db/client.js', () => ({
  getPool: () =>
    databaseAvailable
      ? ({ query: queryMock } as unknown as Pool)
      : null
}));

const {
  inspectDatabaseCollation,
  refreshDatabaseCollation
} = await import('../src/core/db/schema.js');

beforeEach(() => {
  databaseAvailable = true;
  queryMock.mockReset();
});

describe('passive database collation inspection', () => {
  it('reports an unavailable database without issuing a query', async () => {
    databaseAvailable = false;

    await expect(inspectDatabaseCollation()).resolves.toBe(
      'database_unavailable'
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('uses one fixed read-only catalog query and reports a current version', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        configured_version: '2.36',
        actual_version: '2.36'
      }]
    });

    await expect(inspectDatabaseCollation()).resolves.toBe('current');

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(expect.any(String));
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toContain(
      'pg_database_collation_actual_version(oid) AS actual_version'
    );
    expect(sql).toContain('WHERE datname = current_database()');
    expect(sql).not.toMatch(/\b(?:ALTER|REINDEX|REFRESH)\b/iu);
    expect(queryMock.mock.calls[0]).toHaveLength(1);
  });

  it.each([
    {
      configured_version: null,
      actual_version: '2.37'
    },
    {
      configured_version: '2.36',
      actual_version: null
    }
  ])(
    'reports unavailable version metadata for $configured_version / $actual_version',
    async row => {
      queryMock.mockResolvedValue({ rows: [row] });

      await expect(inspectDatabaseCollation()).resolves.toBe(
        'version_unavailable'
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
    }
  );

  it('reports a missing current-database catalog row as unavailable', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await expect(inspectDatabaseCollation()).resolves.toBe(
      'database_unavailable'
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('warns with both versions and operator guidance without mutating on mismatch', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    queryMock.mockResolvedValue({
      rows: [{
        configured_version: '2.36',
        actual_version: '2.37'
      }]
    });

    await expect(inspectDatabaseCollation()).resolves.toBe('mismatch');

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('configured="2.36", actual="2.37"')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('operator-controlled collation maintenance')
    );
  });

  it('redacts and bounds catalog version metadata before logging it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sensitiveVersion =
      'postgresql://database-user:database-password@database.example/db';
    queryMock.mockResolvedValue({
      rows: [{
        configured_version: sensitiveVersion,
        actual_version: `2.${'7'.repeat(200)}`
      }]
    });

    await expect(inspectDatabaseCollation()).resolves.toBe('mismatch');

    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('configured="[REDACTED]"');
    expect(message).not.toContain('database-password');
    expect(message).not.toContain('7'.repeat(129));
    expect(message).not.toContain('\n');
  });

  it('contains inspection failures and returns a bounded failure status', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sensitiveError =
      'postgresql://database-user:database-password@database.example/db';
    queryMock.mockRejectedValue(new Error(sensitiveError));

    await expect(inspectDatabaseCollation()).resolves.toBe(
      'inspection_failed'
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[🔌 DB] Collation inspection failed; startup will continue without this diagnostic.'
    );
    expect(String(warn.mock.calls[0][0])).not.toContain(sensitiveError);
  });

  it('keeps the deprecated refresh wrapper passive', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        configured_version: '2.36',
        actual_version: '2.36'
      }]
    });

    await expect(refreshDatabaseCollation()).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(expect.any(String));
  });

  it('uses the accurately named inspector during schema startup', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'core', 'db', 'index.ts'),
      'utf8'
    );

    expect(source).toContain(
      "import { inspectDatabaseCollation, initializeTables } from './schema.js';"
    );
    expect(source).toContain('await inspectDatabaseCollation();');
    expect(source).not.toContain('await refreshDatabaseCollation();');
  });
});
