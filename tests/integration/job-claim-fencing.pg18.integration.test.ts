import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';
import { resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString =
  resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);

interface DisposableDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function decodeConnectionComponent(value: string, component: string): string {
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
    throw new Error(`${TEST_DATABASE_ENV} must use postgres:// or postgresql://.`);
  }

  if (parsed.search || parsed.hash) {
    throw new Error(
      `${TEST_DATABASE_ENV} must not include query parameters or a fragment.`
    );
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const host = parsed.hostname.toLowerCase();
  if (!loopbackHosts.has(host)) {
    throw new Error(`${TEST_DATABASE_ENV} must target a loopback host.`);
  }

  if (!parsed.port || !/^\d+$/u.test(parsed.port)) {
    throw new Error(`${TEST_DATABASE_ENV} must include an explicit numeric port.`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${TEST_DATABASE_ENV} must include a valid TCP port.`);
  }

  let databasePath: string;
  try {
    databasePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`${TEST_DATABASE_ENV} contains an invalid encoded database.`);
  }
  if (databasePath !== `/${EXPECTED_DATABASE_NAME}`) {
    throw new Error(
      `${TEST_DATABASE_ENV} must target disposable database ${EXPECTED_DATABASE_NAME}.`
    );
  }
  const databaseName = databasePath.slice(1);

  return {
    host,
    port,
    database: databaseName,
    user: decodeConnectionComponent(parsed.username, 'username'),
    password: decodeConnectionComponent(parsed.password, 'password')
  };
}

const databaseConfig = configuredConnectionString
  ? validateDisposableConnectionString(configuredConnectionString)
  : null;
const describeWithDatabase = databaseConfig ? describe : describe.skip;
const schemaName = `job_claim_fencing_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const forwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260727_job_claim_generation_v1.sql'),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260727_job_claim_generation_v1.rollback.sql'
  ),
  'utf8'
);

describe('disposable PostgreSQL connection guard', () => {
  test('returns decoded explicit fields for the exact loopback database', () => {
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

describeWithDatabase('generic job claim fencing on PostgreSQL 18', () => {
  let client: Client;

  beforeAll(async () => {
    if (!databaseConfig) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this test suite.`);
    }
    client = new Client({
      ...databaseConfig,
      ssl: false,
      application_name: 'arcanos-job-claim-fencing-pg18-test'
    });
    await client.connect();
    const versionResult = await client.query<{
      server_version_num: string;
    }>(
      `SELECT current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(versionResult.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
      180_000
    );

    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await client.query(
      `CREATE TABLE job_data (
         id TEXT PRIMARY KEY,
         worker_id TEXT NOT NULL,
         job_type TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         input JSONB NOT NULL DEFAULT '{}'::jsonb,
         last_worker_id TEXT,
         lease_expires_at TIMESTAMPTZ,
         cancel_requested_at TIMESTAMPTZ,
         cancel_reason TEXT
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

  test('installs the exact BIGINT/default/not-null/validated-check contract', async () => {
    const columnResult = await client.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'job_data'
         AND column_name = 'claim_generation'`,
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
      `SELECT convalidated, pg_get_constraintdef(oid, false) AS definition
       FROM pg_constraint
       WHERE conrelid = 'job_data'::regclass
         AND conname = 'job_data_claim_generation_nonnegative'`
    );
    expect(constraintResult.rows[0]).toMatchObject({
      convalidated: true
    });
    expect(constraintResult.rows[0]?.definition).toContain(
      'claim_generation >= 0'
    );
  });

  test('increments claims and rejects stale-owner heartbeat and terminal writes', async () => {
    const jobId = `job-${randomUUID()}`;
    const inserted = await client.query<{ claim_generation: string }>(
      `INSERT INTO job_data (id, worker_id, job_type, status)
       VALUES ($1, 'queue', 'ask', 'pending')
       RETURNING claim_generation::text`,
      [jobId]
    );
    expect(inserted.rows[0]?.claim_generation).toBe('0');

    const firstClaim = await client.query<{ claim_generation: string }>(
      `UPDATE job_data
       SET
         status = 'running',
         last_worker_id = 'worker-a',
         lease_expires_at = NOW() + INTERVAL '1 minute',
         claim_generation = claim_generation + 1
       WHERE id = $1
         AND status = 'pending'
       RETURNING claim_generation::text`,
      [jobId]
    );
    expect(firstClaim.rows[0]?.claim_generation).toBe('1');

    await client.query(
      `UPDATE job_data
       SET status = 'pending', lease_expires_at = NULL
       WHERE id = $1`,
      [jobId]
    );
    const secondClaim = await client.query<{ claim_generation: string }>(
      `UPDATE job_data
       SET
         status = 'running',
         last_worker_id = 'worker-b',
         lease_expires_at = NOW() + INTERVAL '1 minute',
         claim_generation = claim_generation + 1
       WHERE id = $1
         AND status = 'pending'
       RETURNING claim_generation::text`,
      [jobId]
    );
    expect(secondClaim.rows[0]?.claim_generation).toBe('2');

    const staleHeartbeat = await client.query(
      `UPDATE job_data
       SET lease_expires_at = NOW() + INTERVAL '1 minute'
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = 'worker-a'
         AND claim_generation = 1
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= NOW()
       RETURNING id`,
      [jobId]
    );
    expect(staleHeartbeat.rowCount).toBe(0);

    const staleTerminal = await client.query(
      `UPDATE job_data
       SET status = 'failed'
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = 'worker-a'
         AND claim_generation = 1
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= NOW()
       RETURNING id`,
      [jobId]
    );
    expect(staleTerminal.rowCount).toBe(0);

    const currentTerminal = await client.query(
      `UPDATE job_data
       SET status = 'completed', lease_expires_at = NULL
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = 'worker-b'
         AND claim_generation = 2
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= NOW()
       RETURNING id`,
      [jobId]
    );
    expect(currentTerminal.rowCount).toBe(1);
  });

  test('lets cancellation win exact-fence terminal, retry, and provider-deferral races', async () => {
    const jobId = `job-cancel-race-${randomUUID()}`;
    await client.query(
      `INSERT INTO job_data (
         id,
         worker_id,
         job_type,
         status,
         last_worker_id,
         lease_expires_at,
         claim_generation,
         cancel_requested_at,
         cancel_reason
       )
       VALUES (
         $1,
         'queue',
         'gpt',
         'running',
         'worker-current',
         NOW() + INTERVAL '1 minute',
         4,
         NOW(),
         'stop requested'
       )`,
      [jobId]
    );

    for (const terminalStatus of ['completed', 'failed']) {
      const nonCancellationTerminal = await client.query(
        `UPDATE job_data
         SET status = $2
         WHERE id = $1
           AND status = 'running'
           AND last_worker_id = 'worker-current'
           AND claim_generation = 4
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= NOW()
           AND (
             $2 = 'cancelled'
             OR cancel_requested_at IS NULL
           )
         RETURNING id`,
        [jobId, terminalStatus]
      );
      expect(nonCancellationTerminal.rowCount).toBe(0);
    }

    const attemptRequeue = () =>
      client.query(
        `UPDATE job_data
         SET status = 'pending'
         WHERE id = $1
           AND status = 'running'
           AND last_worker_id = 'worker-current'
           AND claim_generation = 4
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= NOW()
           AND cancel_requested_at IS NULL
         RETURNING id`,
        [jobId]
      );
    const retry = await attemptRequeue();
    expect(retry.rowCount).toBe(0);
    const providerDeferral = await attemptRequeue();
    expect(providerDeferral.rowCount).toBe(0);

    const staleCancellation = await client.query(
      `UPDATE job_data
       SET status = 'cancelled', lease_expires_at = NULL
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = 'worker-stale'
         AND claim_generation = 3
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= NOW()
       RETURNING id`,
      [jobId]
    );
    expect(staleCancellation.rowCount).toBe(0);

    const exactCancellation = await client.query(
      `UPDATE job_data
       SET status = 'cancelled', lease_expires_at = NULL
       WHERE id = $1
         AND status = 'running'
         AND last_worker_id = 'worker-current'
         AND claim_generation = 4
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= NOW()
         AND (
           'cancelled' = 'cancelled'
           OR cancel_requested_at IS NULL
         )
       RETURNING id`,
      [jobId]
    );
    expect(exactCancellation.rowCount).toBe(1);
  });

  test('fails closed on a wrong pre-existing column type', async () => {
    await client.query('BEGIN');
    try {
      await client.query('DROP TABLE job_data');
      await client.query(
        `CREATE TABLE job_data (
           id TEXT PRIMARY KEY,
           worker_id TEXT NOT NULL,
           job_type TEXT NOT NULL,
           status TEXT NOT NULL,
           claim_generation TEXT,
           input JSONB NOT NULL DEFAULT '{}'::jsonb
         )`
      );
      await expect(client.query(forwardMigration)).rejects.toMatchObject({
        code: '42804'
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('resumes and validates an exact partial NOT VALID constraint', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `ALTER TABLE job_data
         DROP CONSTRAINT job_data_claim_generation_nonnegative`
      );
      await client.query(
        `ALTER TABLE job_data
         ADD CONSTRAINT job_data_claim_generation_nonnegative
         CHECK (claim_generation >= 0) NOT VALID`
      );
      await client.query(forwardMigration);

      const constraintResult = await client.query<{ convalidated: boolean }>(
        `SELECT convalidated
         FROM pg_constraint
         WHERE conrelid = 'job_data'::regclass
           AND conname = 'job_data_claim_generation_nonnegative'`
      );
      expect(constraintResult.rows[0]?.convalidated).toBe(true);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('validates an exact NOT VALID constraint and rejects negative data', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `ALTER TABLE job_data
         DROP CONSTRAINT job_data_claim_generation_nonnegative`
      );
      await client.query(
        `INSERT INTO job_data (
           id,
           worker_id,
           job_type,
           status,
           claim_generation
         )
         VALUES ('negative-generation', 'queue', 'ask', 'pending', -1)`
      );
      await client.query(
        `ALTER TABLE job_data
         ADD CONSTRAINT job_data_claim_generation_nonnegative
         CHECK (claim_generation >= 0) NOT VALID`
      );
      await expect(client.query(forwardMigration)).rejects.toMatchObject({
        code: '23514'
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('rejects a wrong existing constraint with the expected name', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `ALTER TABLE job_data
         DROP CONSTRAINT job_data_claim_generation_nonnegative`
      );
      await client.query(
        `ALTER TABLE job_data
         ADD CONSTRAINT job_data_claim_generation_nonnegative
         CHECK (claim_generation <= 100) NOT VALID`
      );
      await expect(client.query(forwardMigration)).rejects.toMatchObject({
        code: '42804'
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('rollback rejects a drifted claim-generation column type', async () => {
    await client.query('BEGIN');
    try {
      await client.query('DROP TABLE job_data');
      await client.query(
        `CREATE TABLE job_data (
           id TEXT PRIMARY KEY,
           worker_id TEXT NOT NULL,
           job_type TEXT NOT NULL,
           status TEXT NOT NULL,
           claim_generation TEXT,
           input JSONB NOT NULL DEFAULT '{}'::jsonb
         )`
      );
      await expect(client.query(rollbackMigration)).rejects.toMatchObject({
        code: '42804'
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('rollback rejects a drifted constraint with the expected name', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `ALTER TABLE job_data
         DROP CONSTRAINT job_data_claim_generation_nonnegative`
      );
      await client.query(
        `ALTER TABLE job_data
         ADD CONSTRAINT job_data_claim_generation_nonnegative
         CHECK (claim_generation <= 100) NOT VALID`
      );
      await expect(client.query(rollbackMigration)).rejects.toMatchObject({
        code: '42804'
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('rollback treats a running NULL job type as unsafe', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `ALTER TABLE job_data
         ALTER COLUMN job_type DROP NOT NULL`
      );
      await client.query('DELETE FROM job_data');
      await client.query(
        `INSERT INTO job_data (id, worker_id, job_type, status)
         VALUES ('unknown-running', 'queue', NULL, 'running')`
      );
      await expect(client.query(rollbackMigration)).rejects.toMatchObject({
        code: '55000'
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('rollback refuses generic running jobs but permits local-agent-only running rows', async () => {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM job_data');
      await client.query(
        `INSERT INTO job_data (id, worker_id, job_type, status)
         VALUES ('generic-running', 'queue', 'ask', 'running')`
      );
      await expect(client.query(rollbackMigration)).rejects.toMatchObject({
        code: '55000'
      });
    } finally {
      await client.query('ROLLBACK');
    }

    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM job_data');
      await client.query(
        `INSERT INTO job_data (id, worker_id, job_type, status)
         VALUES ('local-running', 'device', 'local-agent', 'running')`
      );
      await client.query(rollbackMigration);
      const columnResult = await client.query<{ column_exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'job_data'
             AND column_name = 'claim_generation'
         ) AS column_exists`,
        [schemaName]
      );
      expect(columnResult.rows[0]?.column_exists).toBe(false);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
