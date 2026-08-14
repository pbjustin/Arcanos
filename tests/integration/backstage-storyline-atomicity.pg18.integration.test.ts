import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { Client, type Pool } from 'pg';

import { PostgresBackstageBookerRepository } from '../../src/core/db/repositories/backstageBookerRepository.js';
import { applyBackstageStorylineMutation } from '../../src/core/db/repositories/backstageStorylineRepository.js';
import { TABLE_DEFINITIONS } from '../../src/core/db/schema.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS
} from '../../src/shared/backstage/backstageStoryline.js';
import { resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_STORYLINE_ATOMICITY_TEST_DATABASE_URL';
const EXPECTED_DATABASE_NAME = 'arcanos_audit_pg18_20260727';
const configuredConnectionString =
  resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);

const forwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260805_backstage_storyline_serialized_data.sql'),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260805_backstage_storyline_serialized_data.rollback.sql'
  ),
  'utf8'
);
const runtimeStorylineStartIndex = TABLE_DEFINITIONS.findIndex(sql =>
  sql.includes('CREATE TABLE IF NOT EXISTS backstage_story_beats')
);
const runtimeStorylineEndIndex = TABLE_DEFINITIONS.findIndex(
  (sql, index) =>
    index >= runtimeStorylineStartIndex
    && sql.includes(
      'VALIDATE CONSTRAINT backstage_story_beats_serialized_data_contract'
    )
);
const runtimeStorylineDefinitions = TABLE_DEFINITIONS.slice(
  runtimeStorylineStartIndex,
  runtimeStorylineEndIndex + 1
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
const schemaName = `backstage_storyline_atomicity_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;

function payloadAtSerializedUtf8Bytes(totalBytes: number): Record<string, unknown> {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ text: '' }), 'utf8');
  const contentBytes = totalBytes - envelopeBytes;
  const emojiCount = Math.floor(contentBytes / 4);
  const asciiCount = contentBytes - (emojiCount * 4);
  const payload = {
    text: `${'😀'.repeat(emojiCount)}${'x'.repeat(asciiCount)}`
  };

  expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(totalBytes);
  return payload;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

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
  throw new Error('Second storyline connection did not block on the advisory lock.');
}

async function waitForBlockedStorylineTableWrite(
  observer: Client,
  blockedPid: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ granted: boolean }>(
      `SELECT granted
       FROM pg_locks
       WHERE locktype = 'relation'
         AND relation = 'backstage_story_beats'::regclass
         AND mode = 'RowExclusiveLock'
         AND pid = $1`,
      [blockedPid]
    );
    if (result.rows.some(row => row.granted === false)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Legacy storyline writer did not block on the table writer fence.');
}

async function createLegacyStoryBeatTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE backstage_story_beats (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       data JSONB NOT NULL,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );
}

async function withIsolatedStorylineSchema(
  observer: Client,
  restoreSchema: string,
  prefix: string,
  task: () => Promise<void>
): Promise<void> {
  const isolatedSchemaName = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const quotedIsolatedSchema = `"${isolatedSchemaName}"`;

  try {
    await observer.query(`CREATE SCHEMA ${quotedIsolatedSchema}`);
    await observer.query(`SET search_path TO ${quotedIsolatedSchema}, public`);
    await task();
  } finally {
    await observer.query(`SET search_path TO ${restoreSchema}, public`);
    await observer.query(`DROP SCHEMA IF EXISTS ${quotedIsolatedSchema} CASCADE`);
  }
}

describe('disposable Backstage storyline database connection guard', () => {
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

describeWithDatabase('Backstage storyline lifecycle on PostgreSQL 18', () => {
  let first: Client;
  let second: Client;
  let observer: Client;
  let secondPid: number;

  beforeAll(async () => {
    if (!databaseConfig) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
    }

    first = new Client({
      ...databaseConfig,
      ssl: false,
      application_name: 'backstage-storyline-first'
    });
    second = new Client({
      ...databaseConfig,
      ssl: false,
      application_name: 'backstage-storyline-second'
    });
    observer = new Client({
      ...databaseConfig,
      ssl: false,
      application_name: 'backstage-storyline-observer'
    });
    await Promise.all([first.connect(), second.connect(), observer.connect()]);

    const versionResult = await observer.query<{ server_version_num: string }>(
      `SELECT current_setting('server_version_num') AS server_version_num`
    );
    expect(Number(versionResult.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);

    await observer.query(`CREATE SCHEMA ${quotedSchema}`);
    await Promise.all([
      first.query(`SET search_path TO ${quotedSchema}, public`),
      second.query(`SET search_path TO ${quotedSchema}, public`),
      observer.query(`SET search_path TO ${quotedSchema}, public`)
    ]);
    await observer.query(
      `CREATE TABLE backstage_story_beats (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         universe_id TEXT NOT NULL DEFAULT 'legacy',
         data JSONB NOT NULL,
         created_at TIMESTAMPTZ DEFAULT NOW()
       )`
    );
    await observer.query(forwardMigration);
    await observer.query(
      `CREATE TABLE backstage_wrestlers (
         universe_id TEXT NOT NULL,
         name TEXT NOT NULL
       )`
    );
    await observer.query(
      `CREATE TABLE backstage_storylines (
         universe_id TEXT NOT NULL,
         story_key TEXT NOT NULL
       )`
    );

    const pidResult = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    secondPid = pidResult.rows[0]?.pid ?? 0;
    expect(Number.isInteger(secondPid) && secondPid > 0).toBe(true);
  }, 30_000);

  beforeEach(async () => {
    await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')]);
    await Promise.all([
      first.query(`SET search_path TO ${quotedSchema}, public`),
      second.query(`SET search_path TO ${quotedSchema}, public`),
      observer.query(`SET search_path TO ${quotedSchema}, public`)
    ]);
    await observer.query('TRUNCATE TABLE backstage_story_beats');
  });

  afterAll(async () => {
    await Promise.allSettled([first?.query('ROLLBACK'), second?.query('ROLLBACK')]);
    if (observer) {
      await observer.query('SET search_path TO public');
      await observer.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
    await Promise.allSettled([first?.end(), second?.end(), observer?.end()]);
  }, 30_000);

  test('applies the forward migration twice without duplicating its storage contract', async () => {
    await withIsolatedStorylineSchema(
      observer,
      quotedSchema,
      'backstage_storyline_forward_twice',
      async () => {
        await createLegacyStoryBeatTable(observer);
        await observer.query(forwardMigration);
        await observer.query(forwardMigration);

        const columns = await observer.query<{
          column_name: string;
          data_type: string;
        }>(
          `SELECT column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'backstage_story_beats'
             AND column_name IN ('serialized_data', 'storage_sequence')
           ORDER BY column_name`
        );
        expect(columns.rows).toEqual([
          { column_name: 'serialized_data', data_type: 'text' },
          { column_name: 'storage_sequence', data_type: 'bigint' }
        ]);

        const constraint = await observer.query<{
          constraint_count: string;
          validated_count: string;
        }>(
          `SELECT
             COUNT(*)::TEXT AS constraint_count,
             COUNT(*) FILTER (WHERE convalidated)::TEXT AS validated_count
           FROM pg_constraint
           WHERE conrelid = 'backstage_story_beats'::regclass
             AND conname = 'backstage_story_beats_serialized_data_contract'`
        );
        expect(constraint.rows[0]).toEqual({
          constraint_count: '1',
          validated_count: '1'
        });
      }
    );
  });

  test('executes the focused runtime TABLE_DEFINITIONS contract on PostgreSQL 18', async () => {
    expect(runtimeStorylineStartIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeStorylineEndIndex).toBeGreaterThan(runtimeStorylineStartIndex);

    await withIsolatedStorylineSchema(
      observer,
      quotedSchema,
      'backstage_storyline_runtime_schema',
      async () => {
        for (const definition of runtimeStorylineDefinitions) {
          await observer.query(definition);
        }
        for (const definition of runtimeStorylineDefinitions) {
          await observer.query(definition);
        }

        await expect(observer.query(
          `INSERT INTO backstage_story_beats (
             data,
             serialized_data,
             storage_sequence,
             created_at
           )
           VALUES ('{}'::JSONB, '{"runtime":true}', 1, NOW())`
        )).resolves.toMatchObject({ rowCount: 1 });

        const constraint = await observer.query<{ convalidated: boolean }>(
          `SELECT convalidated
           FROM pg_constraint
           WHERE conrelid = 'backstage_story_beats'::regclass
             AND conname = 'backstage_story_beats_serialized_data_contract'`
        );
        expect(constraint.rows).toEqual([{ convalidated: true }]);
      }
    );
  });

  test('fails closed when only the reserved verifier constraint name exists', async () => {
    await withIsolatedStorylineSchema(
      observer,
      quotedSchema,
      'backstage_storyline_reserved_verifier',
      async () => {
        await createLegacyStoryBeatTable(observer);
        await observer.query(
          `ALTER TABLE backstage_story_beats
             ADD CONSTRAINT backstage_story_beats_serialized_data_contract_expected
             CHECK (TRUE)`
        );

        try {
          await observer.query(forwardMigration);
          throw new Error('Expected the migration to reject the reserved verifier name.');
        } catch (error: unknown) {
          expect(errorCode(error)).toBe('42804');
        }
      }
    );
  });

  test('refuses rollback after authoritative storyline content is populated', async () => {
    await withIsolatedStorylineSchema(
      observer,
      quotedSchema,
      'backstage_storyline_populated_rollback',
      async () => {
        await createLegacyStoryBeatTable(observer);
        await observer.query(forwardMigration);
        await observer.query(
          `INSERT INTO backstage_story_beats (
             data,
             serialized_data,
             storage_sequence,
             created_at
           )
           VALUES ('{}'::JSONB, '{"canonical":true}', 1, NOW())`
        );

        try {
          await observer.query(rollbackMigration);
          throw new Error('Expected rollback to refuse populated authoritative storage.');
        } catch (error: unknown) {
          expect(errorCode(error)).toBe('55000');
        }

        const preserved = await observer.query<{
          serialized_data: string;
          storage_sequence: string;
        }>(
          `SELECT serialized_data, storage_sequence::TEXT AS storage_sequence
           FROM backstage_story_beats`
        );
        expect(preserved.rows).toEqual([{
          serialized_data: '{"canonical":true}',
          storage_sequence: '1'
        }]);
      }
    );
  });

  test('rolls back a verified empty storyline installation without touching the base table', async () => {
    await withIsolatedStorylineSchema(
      observer,
      quotedSchema,
      'backstage_storyline_empty_rollback',
      async () => {
        await createLegacyStoryBeatTable(observer);
        await observer.query(forwardMigration);
        await observer.query(rollbackMigration);

        const table = await observer.query<{ table_name: string }>(
          `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = current_schema()
             AND table_name = 'backstage_story_beats'`
        );
        expect(table.rows).toEqual([{ table_name: 'backstage_story_beats' }]);

        const storageColumns = await observer.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'backstage_story_beats'
             AND column_name IN ('serialized_data', 'storage_sequence')`
        );
        expect(storageColumns.rows).toEqual([]);

        const baseColumns = await observer.query<{ column_name: string }>(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'backstage_story_beats'
           ORDER BY ordinal_position`
        );
        expect(baseColumns.rows.map(row => row.column_name)).toEqual([
          'id',
          'data',
          'created_at'
        ]);
      }
    );
  });

  test('serializes concurrent writers even when callers begin at repeatable read', async () => {
    const firstBeat = { sequence: 1, title: 'Opening beat' };
    const secondBeat = { sequence: 2, title: 'Answering beat' };
    let firstTransactionOpen = false;
    let secondTransactionOpen = false;
    let secondMutation: Promise<Awaited<ReturnType<typeof applyBackstageStorylineMutation>>> | null = null;

    try {
      await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      firstTransactionOpen = true;
      await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      secondTransactionOpen = true;

      const firstResult = await applyBackstageStorylineMutation(
        first,
        JSON.stringify(firstBeat)
      );
      secondMutation = applyBackstageStorylineMutation(
        second,
        JSON.stringify(secondBeat)
      );
      void secondMutation.catch(() => undefined);
      await waitForBlockedAdvisoryLock(observer, secondPid);

      await first.query('COMMIT');
      firstTransactionOpen = false;
      const secondResult = await secondMutation;
      await second.query('COMMIT');
      secondTransactionOpen = false;

      expect(firstResult.retainedBeats).toEqual([firstBeat]);
      expect(secondResult.retainedBeats).toEqual([firstBeat, secondBeat]);
      expect(BigInt(secondResult.revision)).toBeGreaterThan(BigInt(firstResult.revision));

      const stored = await observer.query<{ serialized_data: string }>(
        `SELECT serialized_data
         FROM backstage_story_beats
         ORDER BY storage_sequence ASC, id ASC`
      );
      expect(stored.rows.map(row => JSON.parse(row.serialized_data))).toEqual([
        firstBeat,
        secondBeat
      ]);
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

  test('persists a non-legacy beat after the in-transaction activation check', async () => {
    const repository = new PostgresBackstageBookerRepository({
      connect: async () => ({
        query: first.query.bind(first),
        release: () => undefined
      })
    } as unknown as Pool);

    const result = await repository.trackStoryline('universe-a', {
      beat: 'Activated universe beat'
    });

    expect(result.retainedBeats).toEqual([{ beat: 'Activated universe beat' }]);
    await expect(observer.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
       FROM backstage_story_beats
       WHERE universe_id = 'universe-a'`
    )).resolves.toMatchObject({ rows: [{ count: '1' }] });
  });

  test('fences mixed-version writers and retains legacy beats after authoritative state', async () => {
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (let sequence = 1; sequence <= 98; sequence += 1) {
      const offset = parameters.length;
      values.push(
        `($${offset + 1}::UUID, '{}'::JSONB, $${offset + 2}::TEXT, $${offset + 3}::BIGINT, NOW())`
      );
      parameters.push(
        sequence === 1
          ? 'ffffffff-ffff-4fff-bfff-ffffffffffff'
          : `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
        JSON.stringify({ sequence }),
        sequence
      );
    }
    await observer.query(
      `INSERT INTO backstage_story_beats (
         id,
         data,
         serialized_data,
         storage_sequence,
         created_at
       )
       VALUES ${values.join(', ')}`,
      parameters
    );

    const beat99 = { sequence: 99 };
    const legacyBeat = { sequence: 'legacy' };
    const beat100 = { sequence: 100 };
    let firstTransactionOpen = false;
    let legacyInsert: Promise<unknown> | null = null;

    try {
      await first.query('BEGIN');
      firstTransactionOpen = true;
      const firstResult = await applyBackstageStorylineMutation(
        first,
        JSON.stringify(beat99)
      );

      legacyInsert = second.query(
        `INSERT INTO backstage_story_beats (id, data, created_at)
         VALUES (
           '00000000-0000-4000-8000-000000000000'::UUID,
           $1::JSONB,
           clock_timestamp()
         )`,
        [JSON.stringify(legacyBeat)]
      );
      void legacyInsert.catch(() => undefined);
      await waitForBlockedStorylineTableWrite(observer, secondPid);

      await first.query('COMMIT');
      firstTransactionOpen = false;
      await legacyInsert;

      expect(firstResult.retainedBeats.map(beat => beat.sequence)).toEqual(
        Array.from({ length: 99 }, (_unused, index) => index + 1)
      );

      await first.query('BEGIN');
      firstTransactionOpen = true;
      const finalResult = await applyBackstageStorylineMutation(
        first,
        JSON.stringify(beat100)
      );
      await first.query('COMMIT');
      firstTransactionOpen = false;

      expect(finalResult.retainedBeats.map(beat => beat.sequence)).toEqual([
        ...Array.from({ length: 98 }, (_unused, index) => index + 2),
        'legacy',
        100
      ]);

      const stored = await observer.query<{
        serialized_data: string;
        storage_sequence: string;
      }>(
        `SELECT
           beat.serialized_data,
           beat.storage_sequence::TEXT AS storage_sequence
         FROM backstage_story_beats AS beat
         ORDER BY beat.storage_sequence ASC, beat.id ASC`
      );
      expect(stored.rows.map(row => row.storage_sequence)).toEqual(
        Array.from({ length: 100 }, (_unused, index) => String(index + 1))
      );
      expect(stored.rows.map(row => JSON.parse(row.serialized_data).sequence)).toEqual(
        finalResult.retainedBeats.map(beat => beat.sequence)
      );
    } finally {
      if (firstTransactionOpen) {
        await first.query('ROLLBACK');
      }
      if (legacyInsert) {
        await legacyInsert.catch(() => undefined);
      }
    }
  }, 15_000);

  test('retains the deterministic newest 100 across 101 tied timestamps', async () => {
    const tiedTimestampResult = await observer.query<{ tied_at: Date }>(
      `SELECT clock_timestamp() + INTERVAL '1 day' AS tied_at`
    );
    const tiedAt = tiedTimestampResult.rows[0]?.tied_at;
    expect(tiedAt).toBeInstanceOf(Date);

    const values: string[] = [];
    const parameters: unknown[] = [];
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      const offset = parameters.length;
      values.push(
        `($${offset + 1}::UUID, '{}'::JSONB, $${offset + 2}::TEXT, $${offset + 3}::BIGINT, $${offset + 4}::TIMESTAMPTZ)`
      );
      parameters.push(
        `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
        JSON.stringify({ sequence }),
        sequence,
        tiedAt
      );
    }
    await observer.query(
      `INSERT INTO backstage_story_beats (
         id,
         data,
         serialized_data,
         storage_sequence,
         created_at
       )
       VALUES ${values.join(', ')}`,
      parameters
    );

    await first.query('BEGIN');
    const acceptedBeat = { sequence: 102, title: 'Newest accepted beat' };
    const result = await applyBackstageStorylineMutation(
      first,
      JSON.stringify(acceptedBeat)
    );
    await first.query('COMMIT');

    expect(result.retainedBeats).toHaveLength(BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS);
    expect(result.retainedBeats.map(beat => beat.sequence)).toEqual(
      Array.from({ length: 100 }, (_unused, index) => index + 3)
    );
    expect(result.retainedBeats.at(-1)).toEqual(acceptedBeat);

    const stored = await observer.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM backstage_story_beats`
    );
    expect(stored.rows[0]?.count).toBe('100');
  }, 15_000);

  test('compacts duplicate BIGINT extremes before appending without overflow', async () => {
    await observer.query(
      `INSERT INTO backstage_story_beats (
         id,
         data,
         serialized_data,
         storage_sequence,
         created_at
       )
       VALUES
         (
           '00000000-0000-4000-8000-000000000003'::UUID,
           '{}'::JSONB,
           '{"order":"ordinary"}',
           1,
           NOW()
         ),
         (
           '00000000-0000-4000-8000-000000000001'::UUID,
           '{}'::JSONB,
           '{"order":"extreme-a"}',
           9223372036854775807,
           '294276-12-31 23:59:59.999999+00'::TIMESTAMPTZ
         ),
         (
           '00000000-0000-4000-8000-000000000002'::UUID,
           '{}'::JSONB,
           '{"order":"extreme-b"}',
           9223372036854775807,
           '294276-12-31 23:59:59.999999+00'::TIMESTAMPTZ
         )`
    );

    await first.query('BEGIN');
    const acceptedBeat = { order: 'accepted' };
    const result = await applyBackstageStorylineMutation(
      first,
      JSON.stringify(acceptedBeat)
    );
    await first.query('COMMIT');

    expect(result.retainedBeats).toEqual([
      { order: 'ordinary' },
      { order: 'extreme-a' },
      { order: 'extreme-b' },
      acceptedBeat
    ]);
    const stored = await observer.query<{
      serialized_data: string;
      storage_sequence: string;
    }>(
      `SELECT
         beat.serialized_data,
         beat.storage_sequence::TEXT AS storage_sequence
       FROM backstage_story_beats AS beat
       ORDER BY beat.storage_sequence ASC, beat.id ASC`
    );
    expect(stored.rows.map(row => row.storage_sequence)).toEqual(['1', '2', '3', '4']);
    expect(stored.rows.map(row => JSON.parse(row.serialized_data))).toEqual(
      result.retainedBeats
    );
  });

  test('retains an old canonical beat while it remains within the newest 100', async () => {
    const oldBeat = { era: 'territory-days' };
    await observer.query(
      `INSERT INTO backstage_story_beats (
         data,
         serialized_data,
         storage_sequence,
         created_at
       )
       VALUES ('{}'::JSONB, $1::TEXT, 1, '1900-01-01 00:00:00+00'::TIMESTAMPTZ)`,
      [JSON.stringify(oldBeat)]
    );

    await first.query('BEGIN');
    const acceptedBeat = { era: 'current' };
    const result = await applyBackstageStorylineMutation(
      first,
      JSON.stringify(acceptedBeat)
    );
    await first.query('COMMIT');

    expect(result.retainedBeats).toEqual([oldBeat, acceptedBeat]);
  });

  test('admits only bounded finite legacy objects during the first mutation', async () => {
    await observer.query(
      `INSERT INTO backstage_story_beats (data, serialized_data, created_at)
       VALUES
         ('{"legacy":"valid"}'::JSONB, NULL, NOW()),
         ('["legacy-array"]'::JSONB, NULL, NOW()),
         (jsonb_build_object('oversized', repeat('x', 17000)), NULL, NOW()),
         ('{"legacy":"infinite"}'::JSONB, NULL, 'infinity'::TIMESTAMPTZ),
         ('{"legacy":"missing-time"}'::JSONB, NULL, NULL)`
    );

    await first.query('BEGIN');
    const acceptedBeat = { current: 'accepted' };
    const result = await applyBackstageStorylineMutation(
      first,
      JSON.stringify(acceptedBeat)
    );
    await first.query('COMMIT');

    expect(result.retainedBeats).toEqual([
      { legacy: 'valid' },
      acceptedBeat
    ]);
    const contained = await observer.query<{
      row_count: string;
      null_serializations: string;
      null_sequences: string;
      nonfinite_timestamps: string;
    }>(
      `SELECT
         COUNT(*)::TEXT AS row_count,
         COUNT(*) FILTER (WHERE serialized_data IS NULL)::TEXT AS null_serializations,
         COUNT(*) FILTER (WHERE storage_sequence IS NULL)::TEXT AS null_sequences,
         COUNT(*) FILTER (
           WHERE created_at IS NULL OR NOT isfinite(created_at)
         )::TEXT AS nonfinite_timestamps
       FROM backstage_story_beats`
    );
    expect(contained.rows[0]).toEqual({
      row_count: '2',
      null_serializations: '0',
      null_sequences: '0',
      nonfinite_timestamps: '0'
    });
  });

  test('accepts exact bounded object text and Unicode escapes without a JSONB cast', async () => {
    const exactBoundPayload = payloadAtSerializedUtf8Bytes(BACKSTAGE_STORYLINE_MAX_BYTES);
    const unicodePayload = {
      nul: '\u0000',
      loneHighSurrogate: '\ud800',
      emoji: '😀'
    };

    await first.query('BEGIN');
    await applyBackstageStorylineMutation(first, JSON.stringify(exactBoundPayload));
    await first.query('COMMIT');

    await first.query('BEGIN');
    const unicodeResult = await applyBackstageStorylineMutation(
      first,
      JSON.stringify(unicodePayload)
    );
    await first.query('COMMIT');

    expect(unicodeResult.retainedBeats).toEqual([exactBoundPayload, unicodePayload]);
    const stored = await observer.query<{ serialized_data: string; data: unknown }>(
      `SELECT serialized_data, data
       FROM backstage_story_beats
       ORDER BY storage_sequence DESC, id DESC
       LIMIT 1`
    );
    expect(stored.rows[0]?.serialized_data).toBe(JSON.stringify(unicodePayload));
    expect(stored.rows[0]?.data).toEqual({});
  });

  test.each([
    ['a root array', '[]', 'NOW()'],
    ['invalid JSON', '{', 'NOW()'],
    [
      'one byte above the limit',
      JSON.stringify(payloadAtSerializedUtf8Bytes(BACKSTAGE_STORYLINE_MAX_BYTES + 1)),
      'NOW()'
    ],
    ['an infinite timestamp', '{"valid":true}', "'infinity'::TIMESTAMPTZ"],
    ['a missing timestamp', '{"valid":true}', 'NULL']
  ])('rejects %s at the database contract', async (_label, serializedData, timestampSql) => {
    try {
      await observer.query(
        `INSERT INTO backstage_story_beats (
           data,
           serialized_data,
           storage_sequence,
           created_at
         )
         VALUES ('{}'::JSONB, $1::TEXT, 1, ${timestampSql})`,
        [serializedData]
      );
      throw new Error('Expected the storyline constraint to reject the row.');
    } catch (error: unknown) {
      expect(errorCode(error)).toBe('23514');
    }
  });

  test.each([
    ['missing serialized text', null, '1'],
    ['missing storage sequence', '{"valid":true}', 'NULL']
  ])(
    'rejects authoritative storage with %s',
    async (_label, serializedData, storageSequenceSql) => {
      try {
        await observer.query(
          `INSERT INTO backstage_story_beats (
             data,
             serialized_data,
             storage_sequence,
             created_at
           )
           VALUES ('{}'::JSONB, $1::TEXT, ${storageSequenceSql}, NOW())`,
          [serializedData]
        );
        throw new Error('Expected the storyline constraint to reject the partial-null row.');
      } catch (error: unknown) {
        expect(errorCode(error)).toBe('23514');
      }
    }
  );

  test('fails closed when the reserved constraint name has a different expression', async () => {
    const wrongSchemaName = `backstage_storyline_wrong_${randomUUID().replaceAll('-', '')}`;
    const quotedWrongSchema = `"${wrongSchemaName}"`;

    try {
      await observer.query(`CREATE SCHEMA ${quotedWrongSchema}`);
      await observer.query(`SET search_path TO ${quotedWrongSchema}, public`);
      await observer.query(
        `CREATE TABLE backstage_story_beats (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           data JSONB NOT NULL,
           serialized_data TEXT,
           storage_sequence BIGINT,
           created_at TIMESTAMPTZ DEFAULT NOW(),
           CONSTRAINT backstage_story_beats_serialized_data_contract
             CHECK (
               (serialized_data IS NULL AND storage_sequence IS NULL)
               OR char_length(serialized_data) < 64
             )
         )`
      );

      try {
        await observer.query(forwardMigration);
        throw new Error('Expected the migration to reject the foreign constraint expression.');
      } catch (error: unknown) {
        expect(errorCode(error)).toBe('42804');
      }
    } finally {
      await observer.query(`SET search_path TO ${quotedSchema}, public`);
      await observer.query(`DROP SCHEMA IF EXISTS ${quotedWrongSchema} CASCADE`);
    }
  });
});
