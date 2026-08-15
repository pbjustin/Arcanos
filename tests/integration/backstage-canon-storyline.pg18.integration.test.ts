import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { Client, Pool } from 'pg';

import {
  PostgresBackstageBookerRepository,
  type BackstageCanonBeatAppendInput,
  type BackstageCanonStorylineUpsertInput
} from '../../src/core/db/repositories/backstageBookerRepository.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL';
const configuredConnectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredConnectionString) {
  assertDisposablePostgresTestDatabaseUrl(
    configuredConnectionString,
    TEST_DATABASE_ENV
  );
}

const universeScopeForwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260814_backstage_universe_scope_v1.sql'),
  'utf8'
);
const canonForwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260814_backstage_canon_storyline_v1.sql'),
  'utf8'
);
const canonRollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260814_backstage_canon_storyline_v1.rollback.sql'
  ),
  'utf8'
);
const canonTransactionalPhaseStart = canonForwardMigration.indexOf('\nBEGIN;');
if (canonTransactionalPhaseStart < 0) {
  throw new Error('Backstage canon migration is missing its transactional phase.');
}
const canonConcurrentIndexPhase = canonForwardMigration
  .slice(0, canonTransactionalPhaseStart)
  .trim();
const canonTransactionalPhase = canonForwardMigration
  .slice(canonTransactionalPhaseStart)
  .trim();

async function applyCanonForwardMigration(client: Client): Promise<void> {
  await client.query(canonConcurrentIndexPhase);
  await client.query(canonTransactionalPhase);
}

const ownedTableNames = [
  'backstage_canon_heads',
  'backstage_canon_revisions',
  'backstage_events',
  'backstage_story_beats',
  'backstage_storyline_canon_beats',
  'backstage_storyline_participants',
  'backstage_storyline_threads',
  'backstage_storylines',
  'backstage_wrestlers'
] as const;
const phaseTwoTables = [
  'backstage_canon_heads',
  'backstage_canon_revisions',
  'backstage_storyline_canon_beats',
  'backstage_storyline_participants',
  'backstage_storyline_threads'
] as const;
const baseTables = [
  'backstage_events',
  'backstage_story_beats',
  'backstage_storylines',
  'backstage_wrestlers'
] as const;

const describeWithDatabase = configuredConnectionString ? describe : describe.skip;
const universeA = 'canon-pg18-a';
const universeB = 'canon-pg18-b';
const eventAId = randomUUID();
const eventBId = randomUUID();

function fingerprint(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function storylineInput(
  universeId: string,
  storyKey: string,
  participantNames: readonly string[],
  overrides: Partial<BackstageCanonStorylineUpsertInput> = {}
): BackstageCanonStorylineUpsertInput {
  const mutationId = randomUUID();
  return {
    universeId,
    mutationId,
    requestFingerprint: fingerprint(`storyline:${mutationId}`),
    storyKey,
    title: `Title for ${storyKey}`,
    summary: null,
    status: 'active',
    expectedVersion: 0,
    participantNames,
    ...overrides
  };
}

function beatInput(
  universeId: string,
  storyKey: string,
  expectedVersion: number,
  participantNames: readonly string[],
  overrides: Partial<BackstageCanonBeatAppendInput> = {}
): BackstageCanonBeatAppendInput {
  const mutationId = randomUUID();
  return {
    universeId,
    mutationId,
    requestFingerprint: fingerprint(`beat:${mutationId}`),
    storyKey,
    expectedVersion,
    kind: 'angle',
    summary: `Canon beat for ${storyKey}`,
    occurredAt: '2026-08-14T18:00:00.000Z',
    participantNames,
    ...overrides
  };
}

describe('disposable Backstage canon PostgreSQL connection guard', () => {
  test('accepts only an explicit loopback disposable database URL', () => {
    expect(() => assertDisposablePostgresTestDatabaseUrl(
      `postgresql://audit%2Duser:p%40ss@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`,
      TEST_DATABASE_ENV
    )).not.toThrow();
  });

  test.each([
    `postgresql://audit:secret@127.0.0.1/${POSTGRES_TEST_DATABASE_NAME}`,
    `postgresql://audit:secret@db.example.test:55432/${POSTGRES_TEST_DATABASE_NAME}`,
    'postgresql://audit:secret@127.0.0.1:55432/postgres',
    `postgresql://audit:secret@127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}?sslmode=require`,
    `postgresql://127.0.0.1:55432/${POSTGRES_TEST_DATABASE_NAME}`
  ])('rejects an unsafe or incomplete target: %s', value => {
    expect(() => assertDisposablePostgresTestDatabaseUrl(
      value,
      TEST_DATABASE_ENV
    )).toThrow();
  });
});

describeWithDatabase('Backstage canon/storyline persistence on PostgreSQL 18', () => {
  let observer: Client;
  let pool: Pool;
  let repository: PostgresBackstageBookerRepository;
  let ownsInstallation = false;

  beforeAll(async () => {
    if (!configuredConnectionString) {
      throw new Error(`${TEST_DATABASE_ENV} is required for this suite.`);
    }

    observer = new Client({
      connectionString: configuredConnectionString,
      ssl: false,
      application_name: 'backstage-canon-pg18-observer'
    });
    await observer.connect();
    await observer.query('SET search_path TO public, pg_catalog');

    const target = await observer.query<{
      current_database: string;
      server_version_num: string;
    }>(
      `SELECT
         current_database(),
         current_setting('server_version_num') AS server_version_num`
    );
    expect(target.rows[0]?.current_database).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(target.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);

    const preexisting = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [ownedTableNames]
    );
    if (preexisting.rows.length > 0) {
      throw new Error(
        `${TEST_DATABASE_ENV} must not contain pre-existing Backstage tables: ${preexisting.rows
          .map(row => row.table_name)
          .join(', ')}`
      );
    }
    ownsInstallation = true;

    await observer.query(universeScopeForwardMigration);
    await applyCanonForwardMigration(observer);

    pool = new Pool({
      connectionString: configuredConnectionString,
      ssl: false,
      max: 4,
      options: '-c search_path=public,pg_catalog',
      application_name: 'backstage-canon-pg18-repository'
    });
    repository = new PostgresBackstageBookerRepository(pool);
  }, 60_000);

  beforeEach(async () => {
    await observer.query(
      `TRUNCATE TABLE
         backstage_storyline_canon_beats,
         backstage_storyline_participants,
         backstage_storyline_threads,
         backstage_canon_revisions,
         backstage_canon_heads,
         backstage_events,
         backstage_story_beats,
         backstage_storylines,
         backstage_wrestlers
       RESTART IDENTITY CASCADE`
    );
    await observer.query(
      `INSERT INTO backstage_wrestlers (universe_id, name, overall)
       VALUES
         ($1, 'Aster', 91),
         ($1, 'Shared', 89),
         ($2, 'Boreal', 92),
         ($2, 'Shared', 88)`,
      [universeA, universeB]
    );
    await observer.query(
      `INSERT INTO backstage_events (id, universe_id, data)
       VALUES
         ($1::UUID, $2, '{"name":"Universe A Event"}'::JSONB),
         ($3::UUID, $4, '{"name":"Universe B Event"}'::JSONB)`,
      [eventAId, universeA, eventBId, universeB]
    );
  });

  afterAll(async () => {
    await pool?.end();

    if (observer && ownsInstallation) {
      const canonTable = await observer.query<{ installed: boolean }>(
        `SELECT to_regclass('public.backstage_canon_heads') IS NOT NULL AS installed`
      );
      if (canonTable.rows[0]?.installed) {
        await observer.query(
          `TRUNCATE TABLE
             public.backstage_storyline_canon_beats,
             public.backstage_storyline_participants,
             public.backstage_storyline_threads,
             public.backstage_canon_revisions,
             public.backstage_canon_heads
           CASCADE`
        );
        await observer.query(canonRollbackMigration);
      }
      await observer.query(
        `DROP TABLE IF EXISTS
           public.backstage_story_beats,
           public.backstage_storylines,
           public.backstage_events,
           public.backstage_wrestlers`
      );
    }
    await observer?.end();
  }, 60_000);

  test('applies the Phase 1 and Phase 2 forward migrations idempotently', async () => {
    await observer.query(universeScopeForwardMigration);
    await applyCanonForwardMigration(observer);

    const tables = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [phaseTwoTables]
    );
    expect(tables.rows.map(row => row.table_name)).toEqual([...phaseTwoTables].sort());

    const constraints = await observer.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE conname IN (
         'uq_backstage_events_universe_id',
         'fk_backstage_storyline_participants_wrestler',
         'fk_backstage_storyline_canon_beats_event',
         'fk_backstage_storyline_canon_beats_supersedes'
       )
       ORDER BY conname`
    );
    expect(constraints.rows.map(row => row.conname)).toEqual([
      'fk_backstage_storyline_canon_beats_event',
      'fk_backstage_storyline_canon_beats_supersedes',
      'fk_backstage_storyline_participants_wrestler',
      'uq_backstage_events_universe_id'
    ]);
  }, 60_000);

  test('serializes concurrent update CAS attempts without a revision gap', async () => {
    const created = await repository.upsertStoryline(
      storylineInput(universeA, 'concurrent-cas', ['Aster'])
    );
    expect(created.storyline.version).toBe(1);
    expect(created.revision).toBe('1');

    const firstUpdate = storylineInput(universeA, 'concurrent-cas', ['Aster'], {
      expectedVersion: 1,
      title: 'Concurrent winner one'
    });
    const secondUpdate = storylineInput(universeA, 'concurrent-cas', ['Aster'], {
      expectedVersion: 1,
      title: 'Concurrent winner two'
    });
    const attempts = await Promise.allSettled([
      repository.upsertStoryline(firstUpdate),
      repository.upsertStoryline(secondUpdate)
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.upsertStoryline>>> =>
        result.status === 'fulfilled'
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.storyline.version).toBe(2);
    expect(fulfilled[0]?.value.revision).toBe('2');
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]?.reason)).toBe(
      'BACKSTAGE_STORYLINE_VERSION_CONFLICT'
    );

    const stored = await observer.query<{
      head_revision: string;
      revisions: string[];
      thread_version: number;
    }>(
      `SELECT
         head.revision::TEXT AS head_revision,
         ARRAY(
           SELECT revision::TEXT
           FROM backstage_canon_revisions
           WHERE universe_id = $1
           ORDER BY revision
         ) AS revisions,
         thread.version AS thread_version
       FROM backstage_canon_heads AS head
       INNER JOIN backstage_storyline_threads AS thread
         ON thread.universe_id = head.universe_id
       WHERE head.universe_id = $1
         AND thread.story_key = 'concurrent-cas'`,
      [universeA]
    );
    expect(stored.rows).toEqual([{
      head_revision: '2',
      revisions: ['1', '2'],
      thread_version: 2
    }]);
  }, 15_000);

  test('replays exact mutations without duplicate beats or revision gaps', async () => {
    const createInput = storylineInput(universeA, 'idempotent-canon', ['Shared']);
    const created = await repository.upsertStoryline(createInput);
    const createReplay = await repository.upsertStoryline(createInput);

    expect(createReplay.replayed).toBe(true);
    expect(createReplay.revision).toBe(created.revision);
    expect(createReplay.storyline.id).toBe(created.storyline.id);

    const firstBeatInput = beatInput(
      universeA,
      'idempotent-canon',
      1,
      ['Shared'],
      { eventId: eventAId }
    );
    const firstBeat = await repository.appendCanonBeat(firstBeatInput);
    const beatReplay = await repository.appendCanonBeat(firstBeatInput);
    expect(beatReplay.replayed).toBe(true);
    expect(beatReplay.revision).toBe(firstBeat.revision);
    expect(beatReplay.beat.id).toBe(firstBeat.beat.id);

    const secondBeat = await repository.appendCanonBeat(
      beatInput(universeA, 'idempotent-canon', 2, ['Shared'], {
        eventId: eventAId,
        occurredAt: '2026-08-14T19:00:00.000Z'
      })
    );
    expect(secondBeat.beat.sequence).toBe(2);
    expect(secondBeat.revision).toBe('3');

    const stored = await observer.query<{
      head_revision: string;
      revisions: string[];
      sequences: number[];
    }>(
      `SELECT
         head.revision::TEXT AS head_revision,
         ARRAY(
           SELECT revision::TEXT
           FROM backstage_canon_revisions
           WHERE universe_id = $1
           ORDER BY revision
         ) AS revisions,
         ARRAY(
           SELECT sequence
           FROM backstage_storyline_canon_beats
           WHERE universe_id = $1
           ORDER BY sequence
         ) AS sequences
       FROM backstage_canon_heads AS head
       WHERE head.universe_id = $1`,
      [universeA]
    );
    expect(stored.rows).toEqual([{
      head_revision: '3',
      revisions: ['1', '2', '3'],
      sequences: [1, 2]
    }]);
  });

  test('rejects cross-universe roster, event, and supersede references', async () => {
    await expect(repository.upsertStoryline(
      storylineInput(universeB, 'wrong-roster-scope', ['Aster'])
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_REFERENCE_INVALID'
    });

    await repository.upsertStoryline(
      storylineInput(universeA, 'universe-a-thread', ['Shared'])
    );
    await repository.upsertStoryline(
      storylineInput(universeB, 'universe-b-thread', ['Shared'])
    );
    const universeABeat = await repository.appendCanonBeat(
      beatInput(universeA, 'universe-a-thread', 1, ['Shared'], {
        eventId: eventAId
      })
    );

    await expect(repository.appendCanonBeat(
      beatInput(universeB, 'universe-b-thread', 1, ['Shared'], {
        eventId: eventAId
      })
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_REFERENCE_INVALID'
    });
    await expect(repository.appendCanonBeat(
      beatInput(universeB, 'universe-b-thread', 1, ['Shared'], {
        supersedesBeatId: universeABeat.beat.id
      })
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_CANON_BEAT_CONFLICT'
    });

    const universeBState = await observer.query<{
      head_revision: string;
      thread_version: number;
      beat_count: string;
    }>(
      `SELECT
         head.revision::TEXT AS head_revision,
         thread.version AS thread_version,
         COUNT(beat.id)::TEXT AS beat_count
       FROM backstage_canon_heads AS head
       INNER JOIN backstage_storyline_threads AS thread
         ON thread.universe_id = head.universe_id
       LEFT JOIN backstage_storyline_canon_beats AS beat
         ON beat.universe_id = thread.universe_id
        AND beat.storyline_id = thread.id
       WHERE head.universe_id = $1
         AND thread.story_key = 'universe-b-thread'
       GROUP BY head.revision, thread.version`,
      [universeB]
    );
    expect(universeBState.rows).toEqual([{
      head_revision: '1',
      thread_version: 1,
      beat_count: '0'
    }]);
  });

  test('refuses populated rollback with 55000 and succeeds only after canon is empty', async () => {
    await repository.upsertStoryline(
      storylineInput(universeA, 'rollback-guard', ['Aster'])
    );

    try {
      await observer.query(canonRollbackMigration);
      throw new Error('Expected populated canon rollback to be refused.');
    } catch (error: unknown) {
      expect(errorCode(error)).toBe('55000');
    }
    await observer.query('ROLLBACK');

    const preserved = await observer.query<{ revision_count: string; thread_count: string }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM backstage_canon_revisions) AS revision_count,
         (SELECT COUNT(*)::TEXT FROM backstage_storyline_threads) AS thread_count`
    );
    expect(preserved.rows).toEqual([{ revision_count: '1', thread_count: '1' }]);

    await observer.query(
      `TRUNCATE TABLE
         backstage_storyline_canon_beats,
         backstage_storyline_participants,
         backstage_storyline_threads,
         backstage_canon_revisions,
         backstage_canon_heads
       CASCADE`
    );
    await observer.query(canonRollbackMigration);

    const removed = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [phaseTwoTables]
    );
    expect(removed.rows).toEqual([]);

    const retainedBaseTables = await observer.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::TEXT[])
       ORDER BY table_name`,
      [baseTables]
    );
    expect(retainedBaseTables.rows.map(row => row.table_name)).toEqual([
      ...baseTables
    ].sort());

    const retainedEventIdentity = await observer.query<{ retained: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_constraint
         WHERE conrelid = 'public.backstage_events'::regclass
           AND conname = 'uq_backstage_events_universe_id'
       ) AS retained`
    );
    expect(retainedEventIdentity.rows).toEqual([{ retained: true }]);
  }, 30_000);
});
