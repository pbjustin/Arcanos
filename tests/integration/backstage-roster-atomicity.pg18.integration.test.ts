import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';

import { applyBackstageRosterMutation } from '../../src/core/db/repositories/backstageRosterRepository.js';
import { CONDITIONAL_MEMORY_UPSERT_SQL } from '../../src/core/db/repositories/memoryRepository.js';
import { createVersionedMemoryEnvelope } from '../../src/services/safety/memoryEnvelope.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString = process.env[TEST_DATABASE_ENV]?.trim() ?? '';

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
    throw new Error(`${TEST_DATABASE_ENV} contains an invalid encoded ${component}.`);
  }

  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error(
      `${TEST_DATABASE_ENV} must include a non-empty ${component} without control characters.`
    );
  }
  return decoded;
}

function validateDisposableConnectionString(value: string): DisposableDatabaseConfig {
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
    throw new Error(`${TEST_DATABASE_ENV} must not include query parameters or a fragment.`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(host)) {
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
const schemaName = `backstage_roster_atomicity_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;

async function waitForBlockedAdvisoryLock(
  observer: Client,
  blockedPid: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ granted: boolean }>(
      `SELECT granted
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND pid = $1`,
      [blockedPid]
    );
    if (result.rows.some(row => row.granted === false)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Second roster connection did not block on the advisory lock.');
}

describe('disposable Backstage roster database connection guard', () => {
  test('accepts only the exact loopback disposable database', () => {
    expect(validateDisposableConnectionString(
      'postgresql://audit%2Duser:p%40ss@127.0.0.1:55432/arcanos_audit_pg18_20260727'
    )).toEqual({
      host: '127.0.0.1',
      port: 55_432,
      database: EXPECTED_DATABASE_NAME,
      user: 'audit-user',
      password: 'p@ss'
    });
  });

  test.each([
    `postgresql://audit:secret@127.0.0.1/${EXPECTED_DATABASE_NAME}`,
    `postgresql://audit:secret@db.example.test:55432/${EXPECTED_DATABASE_NAME}`,
    'postgresql://audit:secret@127.0.0.1:55432/postgres',
    `postgresql://audit:secret@127.0.0.1:55432/${EXPECTED_DATABASE_NAME}?host=example.test`,
    `postgresql://127.0.0.1:55432/${EXPECTED_DATABASE_NAME}`
  ])('rejects an unsafe or incomplete target: %s', value => {
    expect(() => validateDisposableConnectionString(value)).toThrow();
  });
});

describeWithDatabase('Backstage roster atomicity on PostgreSQL 18', () => {
  let first: Client;
  let second: Client;
  let observer: Client;

  beforeAll(async () => {
    if (!databaseConfig) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
    }
    first = new Client({ ...databaseConfig, ssl: false, application_name: 'backstage-roster-first' });
    second = new Client({ ...databaseConfig, ssl: false, application_name: 'backstage-roster-second' });
    observer = new Client({ ...databaseConfig, ssl: false, application_name: 'backstage-roster-observer' });
    await Promise.all([first.connect(), second.connect(), observer.connect()]);

    const versionResult = await observer.query<{ server_version_num: string }>(
      `SELECT current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(versionResult.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);
    await observer.query(`CREATE SCHEMA ${quotedSchema}`);
    await observer.query(
      `CREATE TABLE ${quotedSchema}.backstage_wrestlers (
         id BIGSERIAL PRIMARY KEY,
         name TEXT UNIQUE NOT NULL,
         overall INTEGER NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await observer.query(
      `CREATE TABLE ${quotedSchema}.memory (
         id BIGSERIAL PRIMARY KEY,
         key VARCHAR(255) UNIQUE NOT NULL,
         value JSONB NOT NULL,
         expires_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    await Promise.all([
      first.query(`SET search_path TO ${quotedSchema}, public`),
      second.query(`SET search_path TO ${quotedSchema}, public`)
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([
      first?.query('ROLLBACK'),
      second?.query('ROLLBACK')
    ]);
    if (observer) {
      await observer.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
    await Promise.allSettled([first?.end(), second?.end(), observer?.end()]);
  }, 30_000);

  test('serializes two real mutation connections and returns the complete committed roster', async () => {
    const firstWrestler = { name: 'Atomic First', overall: 91 };
    const secondWrestler = { name: 'Atomic Second', overall: 92 };
    let firstTransactionOpen = false;
    let secondTransactionOpen = false;
    let secondMutation: Promise<Awaited<ReturnType<typeof applyBackstageRosterMutation>>> | null = null;

    try {
      await first.query('BEGIN');
      firstTransactionOpen = true;
      await second.query('BEGIN');
      secondTransactionOpen = true;

      const firstResult = await applyBackstageRosterMutation(first, [firstWrestler]);
      const secondPidResult = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const secondPid = secondPidResult.rows[0]?.pid;
      expect(Number.isInteger(secondPid)).toBe(true);

      secondMutation = applyBackstageRosterMutation(second, [secondWrestler]);
      void secondMutation.catch(() => undefined);
      await waitForBlockedAdvisoryLock(observer, secondPid!);

      await first.query('COMMIT');
      firstTransactionOpen = false;
      const secondResult = await secondMutation;
      await second.query('COMMIT');
      secondTransactionOpen = false;

      expect(firstResult.roster).toEqual([firstWrestler]);
      expect(secondResult.roster).toEqual([firstWrestler, secondWrestler]);
      expect(BigInt(secondResult.revision)).toBeGreaterThan(BigInt(firstResult.revision));
    } finally {
      if (firstTransactionOpen) {
        await first.query('ROLLBACK');
      }
      if (secondMutation) {
        await secondMutation.catch(() => undefined);
      }
      if (secondTransactionOpen) {
        await second.query('ROLLBACK');
      }
    }
  }, 15_000);

  test('rejects a delayed older latest-snapshot publication in PostgreSQL', async () => {
    const key = 'backstage-roster:latest';
    const newerPayload = {
      roster: [{ name: 'Snapshot Newer', overall: 92 }],
      source: 'database',
      revision: '110'
    };
    const olderPayload = {
      roster: [{ name: 'Snapshot Older', overall: 91 }],
      source: 'database',
      revision: '109'
    };

    const newerWrite = await first.query(
      CONDITIONAL_MEMORY_UPSERT_SQL,
      [
        key,
        JSON.stringify(createVersionedMemoryEnvelope(newerPayload, { prefix: 'db-memory' })),
        null,
        newerPayload.revision
      ]
    );
    const delayedOlderWrite = await second.query(
      CONDITIONAL_MEMORY_UPSERT_SQL,
      [
        key,
        JSON.stringify(createVersionedMemoryEnvelope(olderPayload, { prefix: 'db-memory' })),
        null,
        olderPayload.revision
      ]
    );

    expect(newerWrite.rowCount).toBe(1);
    expect(delayedOlderWrite.rowCount).toBe(0);

    const stored = await observer.query<{ value: { payload?: unknown } }>(
      `SELECT value FROM ${quotedSchema}.memory WHERE key = $1`,
      [key]
    );
    expect(stored.rows[0]?.value.payload).toEqual(newerPayload);
  });
});
