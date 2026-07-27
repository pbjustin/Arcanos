import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';

const TEST_DATABASE_ENV = 'DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString =
  process.env[TEST_DATABASE_ENV]?.trim() ?? '';

interface DisposableDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function decodeConnectionComponent(
  value: string,
  component: string
): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(
      `${TEST_DATABASE_ENV} contains an invalid encoded ${component}.`
    );
  }

  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error(
      `${TEST_DATABASE_ENV} must include a non-empty ${component} without control characters.`
    );
  }

  return decoded;
}

function validateDisposableConnectionString(
  value: string
): DisposableDatabaseConfig {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${TEST_DATABASE_ENV} must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `${TEST_DATABASE_ENV} must use postgres:// or postgresql://.`
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `${TEST_DATABASE_ENV} must not include query parameters or a fragment.`
    );
  }

  const loopbackHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]'
  ]);
  const host = parsed.hostname.toLowerCase();
  if (!loopbackHosts.has(host)) {
    throw new Error(`${TEST_DATABASE_ENV} must target a loopback host.`);
  }
  if (!parsed.port || !/^\d+$/u.test(parsed.port)) {
    throw new Error(
      `${TEST_DATABASE_ENV} must include an explicit numeric port.`
    );
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${TEST_DATABASE_ENV} must include a valid TCP port.`);
  }

  let databasePath: string;
  try {
    databasePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(
      `${TEST_DATABASE_ENV} contains an invalid encoded database.`
    );
  }
  if (databasePath !== `/${EXPECTED_DATABASE_NAME}`) {
    throw new Error(
      `${TEST_DATABASE_ENV} must target disposable database ${EXPECTED_DATABASE_NAME}.`
    );
  }

  return {
    host,
    port,
    database: databasePath.slice(1),
    user: decodeConnectionComponent(parsed.username, 'username'),
    password: decodeConnectionComponent(parsed.password, 'password')
  };
}

const databaseConfig = configuredConnectionString
  ? validateDisposableConnectionString(configuredConnectionString)
  : null;
const describeWithDatabase = databaseConfig ? describe : describe.skip;
const schemaName =
  `dag_snapshot_generation_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const forwardMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260727_dag_run_snapshot_generation_v1.sql'
  ),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260727_dag_run_snapshot_generation_v1.rollback.sql'
  ),
  'utf8'
);

describe('disposable DAG snapshot database connection guard', () => {
  test('returns decoded fields for only the exact loopback database', () => {
    expect(
      validateDisposableConnectionString(
        'postgresql://audit%2Duser:p%40ss@127.0.0.1:55432/arcanos_audit_pg18_20260727'
      )
    ).toEqual({
      host: '127.0.0.1',
      port: 55_432,
      database: EXPECTED_DATABASE_NAME,
      user: 'audit-user',
      password: 'p@ss'
    });
  });

  test.each([
    '?host=198.51.100.10',
    '?%68ost=198.51.100.10',
    '?port=5432',
    '?%70ort=5432',
    '#host=198.51.100.10'
  ])('rejects URL overrides and fragments: %s', suffix => {
    expect(() =>
      validateDisposableConnectionString(
        `postgresql://audit:secret@127.0.0.1:55432/${EXPECTED_DATABASE_NAME}${suffix}`
      )
    ).toThrow('must not include query parameters or a fragment');
  });

  test.each([
    `postgresql://audit:secret@127.0.0.1/${EXPECTED_DATABASE_NAME}`,
    `postgresql://audit:secret@db.example.test:55432/${EXPECTED_DATABASE_NAME}`,
    'postgresql://audit:secret@127.0.0.1:55432/postgres',
    `postgresql://127.0.0.1:55432/${EXPECTED_DATABASE_NAME}`,
    `postgresql://audit@127.0.0.1:55432/${EXPECTED_DATABASE_NAME}`
  ])('rejects an unsafe or incomplete target: %s', value => {
    expect(() => validateDisposableConnectionString(value)).toThrow();
  });
});

describeWithDatabase(
  'DAG snapshot generation fencing on PostgreSQL 18',
  () => {
    let client: Client;

    beforeAll(async () => {
      if (!databaseConfig) {
        throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
      }
      client = new Client({
        ...databaseConfig,
        ssl: false,
        application_name: 'arcanos-dag-snapshot-generation-pg18-test'
      });
      await client.connect();
      const versionResult = await client.query<{
        server_version_num: string;
      }>(
        `SELECT current_setting('server_version_num') AS server_version_num`
      );
      expect(
        Number(versionResult.rows[0]?.server_version_num)
      ).toBeGreaterThanOrEqual(180_000);

      await client.query(`CREATE SCHEMA ${quotedSchema}`);
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      await client.query(
        `CREATE TABLE dag_runs (
           run_id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           template TEXT NOT NULL,
           status VARCHAR(50) NOT NULL,
           planner_node_id TEXT,
           root_node_id TEXT,
           snapshot JSONB NOT NULL,
           created_at TIMESTAMPTZ NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL
         )`
      );
      await client.query(forwardMigration);
      await client.query(forwardMigration);
    }, 30_000);

    afterAll(async () => {
      try {
        await client.query('RESET search_path');
        await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      } finally {
        await client.end();
      }
    }, 30_000);

    test('installs the exact validated BIGINT contract', async () => {
      const columnResult = await client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'dag_runs'
           AND column_name = 'snapshot_generation'`,
        [schemaName]
      );
      expect(columnResult.rows[0]).toMatchObject({
        data_type: 'bigint',
        is_nullable: 'NO'
      });
      expect(columnResult.rows[0]?.column_default).toMatch(/^0(?::|$)/u);

      const constraintResult = await client.query<{
        convalidated: boolean;
        definition: string;
      }>(
        `SELECT
           convalidated,
           pg_get_constraintdef(oid, false) AS definition
         FROM pg_constraint
         WHERE conrelid = 'dag_runs'::regclass
           AND conname = 'dag_runs_snapshot_generation_nonnegative'`
      );
      expect(constraintResult.rows[0]?.convalidated).toBe(true);
      expect(constraintResult.rows[0]?.definition).toContain(
        'snapshot_generation >= 0'
      );
    });

    test('accepts only successively higher snapshot generations', async () => {
      const runId = `dag-${randomUUID()}`;
      await client.query(
        `INSERT INTO dag_runs (
           run_id,
           session_id,
           template,
           status,
           snapshot,
           created_at,
           updated_at
         )
         VALUES ($1, 'session', 'trinity-core', 'complete', '{}', NOW(), NOW())`,
        [runId]
      );

      const applyGeneration = (generation: string) =>
        client.query(
          `INSERT INTO dag_runs (
             run_id,
             session_id,
             template,
             status,
             snapshot_generation,
             snapshot,
             created_at,
             updated_at
           )
           VALUES (
             $1,
             'session',
             'trinity-core',
             'complete',
             $2::bigint,
             '{}',
             NOW(),
             NOW()
           )
           ON CONFLICT (run_id)
           DO UPDATE SET
             snapshot_generation = EXCLUDED.snapshot_generation,
             updated_at = EXCLUDED.updated_at
           WHERE dag_runs.snapshot_generation <
             EXCLUDED.snapshot_generation
           RETURNING snapshot_generation::text`,
          [runId, generation]
        );

      expect((await applyGeneration('1')).rows[0]?.snapshot_generation).toBe(
        '1'
      );
      expect((await applyGeneration('1')).rowCount).toBe(0);
      expect((await applyGeneration('2')).rows[0]?.snapshot_generation).toBe(
        '2'
      );
    });

    test('resumes an exact partial NOT VALID constraint', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `ALTER TABLE dag_runs
           DROP CONSTRAINT dag_runs_snapshot_generation_nonnegative`
        );
        await client.query(
          `ALTER TABLE dag_runs
           ADD CONSTRAINT dag_runs_snapshot_generation_nonnegative
           CHECK (snapshot_generation >= 0) NOT VALID`
        );
        await client.query(forwardMigration);
        const result = await client.query<{ convalidated: boolean }>(
          `SELECT convalidated
           FROM pg_constraint
           WHERE conrelid = 'dag_runs'::regclass
             AND conname = 'dag_runs_snapshot_generation_nonnegative'`
        );
        expect(result.rows[0]?.convalidated).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    test('fails forward on wrong column or named constraint drift', async () => {
      await client.query('BEGIN');
      try {
        await client.query('DROP TABLE dag_runs');
        await client.query(
          `CREATE TABLE dag_runs (
             run_id TEXT PRIMARY KEY,
             status TEXT NOT NULL,
             snapshot_generation TEXT
           )`
        );
        await expect(client.query(forwardMigration)).rejects.toMatchObject({
          code: '42804'
        });
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(
          `ALTER TABLE dag_runs
           DROP CONSTRAINT dag_runs_snapshot_generation_nonnegative`
        );
        await client.query(
          `ALTER TABLE dag_runs
           ADD CONSTRAINT dag_runs_snapshot_generation_nonnegative
           CHECK (snapshot_generation <= 100) NOT VALID`
        );
        await expect(client.query(forwardMigration)).rejects.toMatchObject({
          code: '42804'
        });
      } finally {
        await client.query('ROLLBACK');
      }
    });

    test.each([
      ['missing constraint', async () => {
        await client.query(
          `ALTER TABLE dag_runs
           DROP CONSTRAINT dag_runs_snapshot_generation_nonnegative`
        );
      }],
      ['unvalidated constraint', async () => {
        await client.query(
          `ALTER TABLE dag_runs
           DROP CONSTRAINT dag_runs_snapshot_generation_nonnegative`
        );
        await client.query(
          `ALTER TABLE dag_runs
           ADD CONSTRAINT dag_runs_snapshot_generation_nonnegative
           CHECK (snapshot_generation >= 0) NOT VALID`
        );
      }],
      ['nullable column', async () => {
        await client.query(
          `ALTER TABLE dag_runs
           ALTER COLUMN snapshot_generation DROP NOT NULL`
        );
      }],
      ['wrong default', async () => {
        await client.query(
          `ALTER TABLE dag_runs
           ALTER COLUMN snapshot_generation SET DEFAULT 1`
        );
      }]
    ])('rollback fails closed on %s', async (_label, arrange) => {
      await client.query('BEGIN');
      try {
        await arrange();
        await expect(client.query(rollbackMigration)).rejects.toMatchObject({
          code: '42804'
        });
      } finally {
        await client.query('ROLLBACK');
      }
    });

    test('rollback refuses unknown or nonterminal rows', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO dag_runs (
             run_id,
             session_id,
             template,
             status,
             snapshot_generation,
             snapshot,
             created_at,
             updated_at
           )
           VALUES (
             $1,
             'session',
             'trinity-core',
             'paused',
             1,
             '{}',
             NOW(),
             NOW()
           )`,
          [`active-${randomUUID()}`]
        );
        await expect(client.query(rollbackMigration)).rejects.toMatchObject({
          code: '55000'
        });
      } finally {
        await client.query('ROLLBACK');
      }
    });

    test('rollback succeeds for known terminal rows only', async () => {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE dag_runs
           SET status = 'complete'`
        );
        await client.query(rollbackMigration);
        const columnResult = await client.query(
          `SELECT 1
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'dag_runs'
             AND column_name = 'snapshot_generation'`,
          [schemaName]
        );
        expect(columnResult.rowCount).toBe(0);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  }
);
