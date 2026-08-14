import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';

import { applyBackstageRosterMutation } from '../../src/core/db/repositories/backstageRosterRepository.js';
import { CONDITIONAL_MEMORY_UPSERT_SQL } from '../../src/core/db/repositories/memoryRepository.js';
import { createVersionedMemoryEnvelope } from '../../src/services/safety/memoryEnvelope.js';
import { resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString =
  resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
const universeScopeForwardMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260814_backstage_universe_scope_v1.sql'
  ),
  'utf8'
);
const universeScopeRollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260814_backstage_universe_scope_v1.rollback.sql'
  ),
  'utf8'
);

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

async function waitForBlockedTableLock(
  observer: Client,
  blockedPid: number,
  schema: string,
  table: string
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ granted: boolean }>(
      `SELECT held_lock.granted
       FROM pg_locks AS held_lock
       INNER JOIN pg_class AS relation
         ON relation.oid = held_lock.relation
       INNER JOIN pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE held_lock.locktype = 'relation'
         AND held_lock.pid = $1
         AND held_lock.mode = 'AccessExclusiveLock'
         AND namespace.nspname = $2
         AND relation.relname = $3`,
      [blockedPid, schema, table]
    );
    if (result.rows.some(row => row.granted === false)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Migration did not block on ${schema}.${table} as expected.`);
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
         universe_id TEXT NOT NULL DEFAULT 'legacy',
         name TEXT NOT NULL,
         overall INTEGER NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (universe_id, name)
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

  test('rejects a fail-open universe check that reuses the canonical name', async () => {
    const driftSchema = `backstage_universe_drift_${randomUUID().replaceAll('-', '')}`;
    const quotedDriftSchema = `"${driftSchema}"`;

    try {
      await observer.query(`CREATE SCHEMA ${quotedDriftSchema}`);
      await observer.query(
        `CREATE TABLE ${quotedDriftSchema}.backstage_events (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           universe_id TEXT,
           data JSONB NOT NULL,
           created_at TIMESTAMPTZ DEFAULT NOW(),
           CONSTRAINT ck_backstage_events_universe_id CHECK (
             TRUE OR universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
           )
         )`
      );
      await observer.query(`SET search_path TO ${quotedDriftSchema}, public`);

      const driftFailure = await observer.query(universeScopeForwardMigration).then(
        () => null,
        (error: unknown) => error
      );
      expect(driftFailure).toMatchObject({ code: '42804' });
    } finally {
      await Promise.allSettled([observer.query('ROLLBACK')]);
      await observer.query(`SET search_path TO ${quotedSchema}, public`);
      await observer.query(`DROP SCHEMA IF EXISTS ${quotedDriftSchema} CASCADE`);
    }
  }, 15_000);

  test('activates universe scope without deadlocking the context-read lock order', async () => {
    const migrationSchema = `backstage_universe_migration_${randomUUID().replaceAll('-', '')}`;
    const quotedMigrationSchema = `"${migrationSchema}"`;
    let migration: Promise<unknown> | null = null;

    try {
      await observer.query(`CREATE SCHEMA ${quotedMigrationSchema}`);
      await observer.query(
        `CREATE TABLE ${quotedMigrationSchema}.backstage_wrestlers (
           id SERIAL PRIMARY KEY,
           name TEXT UNIQUE NOT NULL,
           overall INTEGER NOT NULL,
           created_at TIMESTAMPTZ DEFAULT NOW(),
           updated_at TIMESTAMPTZ DEFAULT NOW()
         )`
      );
      await observer.query(
        `CREATE TABLE ${quotedMigrationSchema}.backstage_events (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           data JSONB NOT NULL,
           created_at TIMESTAMPTZ DEFAULT NOW()
         )`
      );
      await observer.query(
        `CREATE TABLE ${quotedMigrationSchema}.backstage_story_beats (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           data JSONB NOT NULL,
           created_at TIMESTAMPTZ DEFAULT NOW()
         )`
      );
      await observer.query(
        `CREATE TABLE ${quotedMigrationSchema}.backstage_storylines (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           story_key TEXT UNIQUE NOT NULL,
           storyline TEXT NOT NULL,
           created_at TIMESTAMPTZ DEFAULT NOW(),
           updated_at TIMESTAMPTZ DEFAULT NOW()
         )`
      );
      await observer.query(
        `INSERT INTO ${quotedMigrationSchema}.backstage_wrestlers (name, overall)
         VALUES ('Legacy Wrestler', 81)`
      );
      await observer.query(
        `INSERT INTO ${quotedMigrationSchema}.backstage_events (data)
         VALUES ('{"name":"Legacy Event"}'::JSONB)`
      );
      await observer.query(
        `INSERT INTO ${quotedMigrationSchema}.backstage_story_beats (data)
         VALUES ('{"beat":"Legacy Beat"}'::JSONB)`
      );
      await observer.query(
        `INSERT INTO ${quotedMigrationSchema}.backstage_storylines (story_key, storyline)
         VALUES ('legacy-story', 'Legacy storyline')`
      );
      await Promise.all([
        first.query(`SET search_path TO ${quotedMigrationSchema}, public`),
        second.query(`SET search_path TO ${quotedMigrationSchema}, public`)
      ]);

      await first.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await first.query("SET LOCAL lock_timeout = '5s'");
      await first.query('SELECT id FROM backstage_wrestlers');

      const migrationPidResult = await second.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid'
      );
      const migrationPid = migrationPidResult.rows[0]?.pid;
      expect(Number.isInteger(migrationPid)).toBe(true);
      migration = second.query(universeScopeForwardMigration);
      void migration.catch(() => undefined);

      await waitForBlockedTableLock(
        observer,
        migrationPid!,
        migrationSchema,
        'backstage_wrestlers'
      );

      await first.query('SELECT id FROM backstage_events');
      await first.query('SELECT id FROM backstage_story_beats');
      await first.query('SELECT id FROM backstage_storylines');
      await first.query('COMMIT');
      await migration;

      await second.query(universeScopeForwardMigration);

      const backfilledRows = await second.query<{
        table_name: string;
        universe_id: string;
      }>(
        `SELECT 'backstage_events' AS table_name, universe_id
         FROM backstage_events
         UNION ALL
         SELECT 'backstage_story_beats' AS table_name, universe_id
         FROM backstage_story_beats
         UNION ALL
         SELECT 'backstage_storylines' AS table_name, universe_id
         FROM backstage_storylines
         UNION ALL
         SELECT 'backstage_wrestlers' AS table_name, universe_id
         FROM backstage_wrestlers
         ORDER BY table_name`
      );
      expect(backfilledRows.rows).toEqual([
        { table_name: 'backstage_events', universe_id: 'legacy' },
        { table_name: 'backstage_story_beats', universe_id: 'legacy' },
        { table_name: 'backstage_storylines', universe_id: 'legacy' },
        { table_name: 'backstage_wrestlers', universe_id: 'legacy' }
      ]);

      await second.query(
        `INSERT INTO backstage_wrestlers (universe_id, name, overall)
         VALUES
           ('universe-a', 'Scoped Twin', 82),
           ('universe-b', 'Scoped Twin', 93)`
      );
      await second.query(
        `INSERT INTO backstage_storylines (universe_id, story_key, storyline)
         VALUES
           ('universe-a', 'shared-scope', 'Universe A storyline'),
           ('universe-b', 'shared-scope', 'Universe B storyline')`
      );

      const scopedIdentity = await second.query<{
        entity: string;
        universe_count: string;
        row_count: string;
      }>(
        `SELECT
           'storyline' AS entity,
           COUNT(DISTINCT universe_id)::TEXT AS universe_count,
           COUNT(*)::TEXT AS row_count
         FROM backstage_storylines
         WHERE story_key = 'shared-scope'
         UNION ALL
         SELECT
           'wrestler' AS entity,
           COUNT(DISTINCT universe_id)::TEXT AS universe_count,
           COUNT(*)::TEXT AS row_count
         FROM backstage_wrestlers
         WHERE name = 'Scoped Twin'
         ORDER BY entity`
      );
      expect(scopedIdentity.rows).toEqual([
        { entity: 'storyline', universe_count: '2', row_count: '2' },
        { entity: 'wrestler', universe_count: '2', row_count: '2' }
      ]);

      const constraints = await observer.query<{ conname: string }>(
        `SELECT constraint_row.conname
         FROM pg_constraint AS constraint_row
         INNER JOIN pg_class AS relation
           ON relation.oid = constraint_row.conrelid
         INNER JOIN pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1
           AND constraint_row.conname IN (
             'backstage_wrestlers_name_key',
             'backstage_storylines_story_key_key',
             'uq_backstage_wrestlers_universe_name',
             'uq_backstage_storylines_universe_story_key'
           )
         ORDER BY constraint_row.conname`,
        [migrationSchema]
      );
      expect(constraints.rows.map(row => row.conname)).toEqual([
        'uq_backstage_storylines_universe_story_key',
        'uq_backstage_wrestlers_universe_name'
      ]);

      const guardedRollbackFailure = await second
        .query(universeScopeRollbackMigration)
        .then(
          () => null,
          async (error: unknown) => {
            await second.query('ROLLBACK');
            return error;
          }
        );
      expect(guardedRollbackFailure).toMatchObject({ code: '55000' });

      await second.query(
        `DELETE FROM backstage_wrestlers WHERE universe_id <> 'legacy';
         DELETE FROM backstage_events WHERE universe_id <> 'legacy';
         DELETE FROM backstage_story_beats WHERE universe_id <> 'legacy';
         DELETE FROM backstage_storylines WHERE universe_id <> 'legacy'`
      );
      await second.query(universeScopeRollbackMigration);

      const rolledBackConstraints = await observer.query<{ conname: string }>(
        `SELECT constraint_row.conname
         FROM pg_constraint AS constraint_row
         INNER JOIN pg_class AS relation
           ON relation.oid = constraint_row.conrelid
         INNER JOIN pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1
           AND constraint_row.conname IN (
             'backstage_wrestlers_name_key',
             'backstage_storylines_story_key_key',
             'uq_backstage_wrestlers_universe_name',
             'uq_backstage_storylines_universe_story_key'
           )
         ORDER BY constraint_row.conname`,
        [migrationSchema]
      );
      expect(rolledBackConstraints.rows.map(row => row.conname)).toEqual([
        'backstage_storylines_story_key_key',
        'backstage_wrestlers_name_key'
      ]);

      const removedUniverseColumns = await observer.query<{
        table_name: string;
      }>(
        `SELECT table_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = ANY($2::TEXT[])
           AND column_name = 'universe_id'
         ORDER BY table_name`,
        [
          migrationSchema,
          [
            'backstage_events',
            'backstage_wrestlers',
            'backstage_storylines',
            'backstage_story_beats'
          ]
        ]
      );
      expect(removedUniverseColumns.rows).toEqual([]);

      const preservedLegacyRows = await second.query<{
        events: string;
        story_beats: string;
        storylines: string;
        wrestlers: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::TEXT FROM backstage_events) AS events,
           (SELECT COUNT(*)::TEXT FROM backstage_story_beats) AS story_beats,
           (SELECT COUNT(*)::TEXT FROM backstage_storylines) AS storylines,
           (SELECT COUNT(*)::TEXT FROM backstage_wrestlers) AS wrestlers`
      );
      expect(preservedLegacyRows.rows[0]).toEqual({
        events: '1',
        story_beats: '1',
        storylines: '1',
        wrestlers: '1'
      });
    } finally {
      await Promise.allSettled([
        first.query('ROLLBACK'),
        second.query('ROLLBACK')
      ]);
      await migration?.catch(() => undefined);
      await Promise.allSettled([
        first.query(`SET search_path TO ${quotedSchema}, public`),
        second.query(`SET search_path TO ${quotedSchema}, public`)
      ]);
      await observer.query(`DROP SCHEMA IF EXISTS ${quotedMigrationSchema} CASCADE`);
    }
  }, 30_000);
});
