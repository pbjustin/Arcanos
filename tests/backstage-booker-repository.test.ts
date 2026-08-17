import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';

import {
  BackstageCanonDomainError,
  BackstageBookerCommitUnknownError,
  BackstageBookerRepositoryUnavailableError,
  BackstageBookerUniverseScopeNotActivatedError,
  BackstageBookerWriteError,
  isBackstageCanonDomainError,
  isBackstageBookerUniverseScopeNotActivatedError,
  PostgresBackstageBookerRepository,
  resolveBackstageCanonDomainErrorHttpStatus
} from '../src/core/db/repositories/backstageBookerRepository.js';

interface HarnessEvent {
  id: string;
  universe_id: string;
  data: Record<string, unknown>;
  created_at: string;
}

interface HarnessWrestler {
  universe_id: string;
  name: string;
  overall: number;
  updated_at: string;
}

interface HarnessStoryBeat {
  id: string;
  universe_id: string;
  data: Record<string, unknown>;
  serialized_data: string | null;
  storage_sequence: number | null;
  created_at: string;
}

interface HarnessStoryline {
  id: string;
  universe_id: string;
  story_key: string;
  storyline: string;
  created_at: string;
  updated_at: string;
}

interface HarnessSnapshot {
  events: HarnessEvent[];
  wrestlers: HarnessWrestler[];
  storyBeats: HarnessStoryBeat[];
  storylines: HarnessStoryline[];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

class BackstageRepositoryHarness {
  events: HarnessEvent[] = [];
  wrestlers: HarnessWrestler[] = [];
  storyBeats: HarnessStoryBeat[] = [];
  storylines: HarnessStoryline[] = [];
  commands: string[] = [];
  commandValues: unknown[][] = [];
  releaseCount = 0;
  releaseCauses: unknown[] = [];
  failConnect = false;
  failCommit = false;
  failRollback = false;
  failRosterAfterFirstMutation = false;
  legacyGlobalConstraintsPresent = false;
  invalidActivationResult = false;
  private snapshot: HarnessSnapshot | null = null;
  private sequence = 0;

  readonly pool = {
    connect: async () => {
      if (this.failConnect) {
        throw new Error('SENTINEL_CONNECT_FAILURE');
      }
      return {
        query: async (sql: string, values: unknown[] = []) => this.query(sql, values),
        release: (cause?: unknown) => {
          this.releaseCount += 1;
          this.releaseCauses.push(cause);
        }
      };
    },
    query: async (sql: string, values: unknown[] = []) => this.query(sql, values)
  } as unknown as Pool;

  private cloneRows<T>(rows: T[]): T[] {
    return JSON.parse(JSON.stringify(rows)) as T[];
  }

  private result<T>(rows: T[] = []) {
    return { rows, rowCount: rows.length };
  }

  private timestamp(): string {
    this.sequence += 1;
    return new Date(Date.UTC(2026, 7, 14, 12, 0, this.sequence)).toISOString();
  }

  private uuid(): string {
    this.sequence += 1;
    return `10000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`;
  }

  async query(rawSql: string, values: unknown[] = []) {
    const sql = normalizeSql(rawSql);
    this.commands.push(sql);
    this.commandValues.push(values);

    if (sql === 'BEGIN' || sql.startsWith('BEGIN TRANSACTION')) {
      this.snapshot = {
        events: this.cloneRows(this.events),
        wrestlers: this.cloneRows(this.wrestlers),
        storyBeats: this.cloneRows(this.storyBeats),
        storylines: this.cloneRows(this.storylines)
      };
      return this.result();
    }
    if (sql === 'COMMIT') {
      this.snapshot = null;
      if (this.failCommit) {
        this.failCommit = false;
        throw new Error('SENTINEL_COMMIT_FAILURE');
      }
      return this.result();
    }
    if (sql === 'ROLLBACK') {
      if (this.failRollback) {
        this.failRollback = false;
        throw new Error('SENTINEL_ROLLBACK_FAILURE');
      }
      if (this.snapshot) {
        this.events = this.cloneRows(this.snapshot.events);
        this.wrestlers = this.cloneRows(this.snapshot.wrestlers);
        this.storyBeats = this.cloneRows(this.snapshot.storyBeats);
        this.storylines = this.cloneRows(this.snapshot.storylines);
      }
      this.snapshot = null;
      return this.result();
    }
    if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
      return this.result();
    }
    if (sql === "SELECT set_config('statement_timeout', $1, TRUE)") {
      return this.result([{ set_config: values[0] }]);
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) {
      return this.result([{}]);
    }
    if (
      sql.includes("conname = 'backstage_wrestlers_name_key'")
      && sql.includes("conname = 'backstage_storylines_story_key_key'")
    ) {
      if (this.invalidActivationResult) {
        return this.result();
      }
      return this.result([{
        activated: !this.legacyGlobalConstraintsPresent
      }]);
    }
    if (sql.startsWith('SELECT txid_current()::TEXT AS revision')) {
      this.sequence += 1;
      return this.result([{ revision: String(this.sequence) }]);
    }
    if (sql === 'LOCK TABLE backstage_story_beats IN SHARE ROW EXCLUSIVE MODE') {
      return this.result();
    }
    if (sql.startsWith('INSERT INTO backstage_events')) {
      const row: HarnessEvent = {
        id: String(values[0]),
        universe_id: String(values[1]),
        data: JSON.parse(String(values[2])) as Record<string, unknown>,
        created_at: this.timestamp()
      };
      this.events.push(row);
      return this.result([row]);
    }
    if (sql.startsWith('INSERT INTO backstage_wrestlers')) {
      const universeId = String(values[0]);
      const names = values[1] as string[];
      const ratings = values[2] as number[];
      for (let index = 0; index < names.length; index += 1) {
        const existing = this.wrestlers.find(row =>
          row.universe_id === universeId && row.name === names[index]
        );
        if (existing) {
          existing.overall = ratings[index];
          existing.updated_at = this.timestamp();
        } else {
          this.wrestlers.push({
            universe_id: universeId,
            name: names[index],
            overall: ratings[index],
            updated_at: this.timestamp()
          });
        }
        if (this.failRosterAfterFirstMutation && index === 0) {
          this.failRosterAfterFirstMutation = false;
          throw new Error('SENTINEL_ROSTER_FAILURE');
        }
      }
      return this.result();
    }
    if (
      sql.startsWith('SELECT name, overall, updated_at FROM backstage_wrestlers')
      || sql.startsWith('SELECT name, overall FROM backstage_wrestlers')
    ) {
      const universeId = String(values[0]);
      const rows = this.wrestlers
        .filter(row => row.universe_id === universeId)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(row => ({ ...row }));
      return this.result(rows);
    }
    if (sql.startsWith('WITH newest_legacy AS MATERIALIZED')) {
      return this.result();
    }
    if (sql.startsWith('DELETE FROM backstage_story_beats')) {
      const universeId = String(values.at(-1));
      this.storyBeats = this.storyBeats.filter(row =>
        row.universe_id !== universeId || row.serialized_data !== null
      );
      return this.result();
    }
    if (
      sql.startsWith('WITH expired AS MATERIALIZED')
      || sql.startsWith('WITH ordered AS MATERIALIZED')
    ) {
      return this.result();
    }
    if (sql.startsWith('INSERT INTO backstage_story_beats')) {
      const serializedData = String(values[0]);
      const universeId = String(values[1]);
      const row: HarnessStoryBeat = {
        id: this.uuid(),
        universe_id: universeId,
        data: {},
        serialized_data: serializedData,
        storage_sequence:
          this.storyBeats.filter(beat => beat.universe_id === universeId).length + 1,
        created_at: this.timestamp()
      };
      this.storyBeats.push(row);
      return this.result([{ id: row.id }]);
    }
    if (
      sql.includes('SELECT recent.serialized_data')
      && sql.includes('FROM backstage_story_beats')
    ) {
      const universeId = String(values[2]);
      const rows = this.storyBeats
        .filter(row => row.universe_id === universeId)
        .sort((left, right) =>
          (left.storage_sequence ?? 0) - (right.storage_sequence ?? 0)
        )
        .map(row => ({ serialized_data: row.serialized_data }));
      return this.result(rows);
    }
    if (sql.includes('FROM backstage_story_beats')) {
      const universeRows = this.storyBeats.filter(
        row => row.universe_id === String(values[0])
      );
      const authoritative = universeRows
        .filter(row => row.serialized_data !== null)
        .sort((left, right) =>
          (left.storage_sequence ?? 0) - (right.storage_sequence ?? 0)
        )
        .slice(-5);
      const legacySlots = 5 - authoritative.length;
      const legacy = legacySlots > 0
        ? universeRows
            .filter(row => row.serialized_data === null)
            .sort((left, right) => left.created_at.localeCompare(right.created_at))
            .slice(-legacySlots)
        : [];
      const rows = [...authoritative, ...legacy].map(row => ({ ...row }));
      return this.result(rows);
    }
    if (sql.startsWith('INSERT INTO backstage_storylines')) {
      const universeId = String(values[0]);
      const storyKey = String(values[1]);
      const now = this.timestamp();
      let row = this.storylines.find(storyline =>
        storyline.universe_id === universeId && storyline.story_key === storyKey
      );
      if (row) {
        row.storyline = String(values[2]);
        row.updated_at = now;
      } else {
        row = {
          id: this.uuid(),
          universe_id: universeId,
          story_key: storyKey,
          storyline: String(values[2]),
          created_at: now,
          updated_at: now
        };
        this.storylines.push(row);
      }
      return this.result([{ ...row }]);
    }
    if (sql.startsWith('SELECT id, universe_id, story_key, storyline, created_at, updated_at FROM backstage_storylines')) {
      const rows = this.storylines
        .filter(row => row.universe_id === String(values[0]))
        .map(row => ({ ...row }));
      return this.result(rows);
    }
    if (sql.startsWith('SELECT id, universe_id, data, created_at FROM backstage_events')) {
      const rows = this.events
        .filter(row => row.universe_id === String(values[0]))
        .map(row => ({ ...row }));
      return this.result(rows);
    }
    if (sql.startsWith('SELECT revision::TEXT AS revision FROM backstage_canon_heads')) {
      return this.result();
    }
    if (sql.includes('jsonb_agg(participant.wrestler_name ORDER BY participant.sort_order)')) {
      return this.result();
    }
    if (sql.startsWith('SELECT recent.* FROM ( SELECT beat.id')) {
      return this.result();
    }

    throw new Error(`Unhandled Backstage repository query: ${sql}`);
  }
}

describe('PostgresBackstageBookerRepository', () => {
  it('isolates identical wrestler and storyline keys across universes', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.updateRoster('universe-a', [{ name: 'Alex Star', overall: 82 }]);
    await repository.updateRoster('universe-b', [{ name: 'Alex Star', overall: 94 }]);
    await repository.saveStoryline('universe-a', 'world-title', 'Alex chases the champion.');
    await repository.saveStoryline('universe-b', 'world-title', 'Alex already holds the championship.');
    await repository.trackStoryline('universe-a', { beat: 'Contract signing' });
    await repository.trackStoryline('universe-a', { beat: 'Backstage confrontation' });
    await repository.trackStoryline('universe-a', { beat: 'Open challenge' });
    await repository.trackStoryline('universe-a', { beat: 'Title match' });
    await repository.trackStoryline('universe-a', { beat: 'Post-match attack' });
    await repository.trackStoryline('universe-a', { beat: 'Rematch demanded' });
    await repository.trackStoryline('universe-b', { beat: 'Victory celebration' });
    harness.storyBeats.push({
      id: '10000000-0000-4000-8000-999999999999',
      universe_id: 'universe-a',
      data: { beat: 'Newer legacy projection' },
      serialized_data: null,
      storage_sequence: null,
      created_at: '2026-08-14T23:59:59.000Z'
    });

    await expect(repository.loadRoster('universe-a')).resolves.toMatchObject([
      { name: 'Alex Star', overall: 82 }
    ]);
    await expect(repository.loadRoster('universe-b')).resolves.toMatchObject([
      { name: 'Alex Star', overall: 94 }
    ]);

    const contextA = await repository.loadContext('universe-a');
    const contextB = await repository.loadContext('universe-b');
    expect(contextA.storylines.map(storyline => storyline.storyline)).toEqual([
      'Alex chases the champion.'
    ]);
    expect(contextB.storylines.map(storyline => storyline.storyline)).toEqual([
      'Alex already holds the championship.'
    ]);
    expect(contextA.storyBeats.map(beat => beat.data)).toEqual([
      { beat: 'Backstage confrontation' },
      { beat: 'Open challenge' },
      { beat: 'Title match' },
      { beat: 'Post-match attack' },
      { beat: 'Rematch demanded' }
    ]);
    expect(contextB.storyBeats.map(beat => beat.data)).toEqual([
      { beat: 'Victory celebration' }
    ]);
    expect(
      harness.storyBeats
        .filter(beat => beat.serialized_data !== null)
        .every(beat => Object.keys(beat.data).length === 0)
    ).toBe(true);
    expect(contextA.storyBeats).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: { beat: 'Newer legacy projection' } })
      ])
    );
  });

  it('applies a bounded statement timeout inside an opted-in read snapshot', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.loadContext('legacy', { statementTimeoutMs: 3_500 });

    const beginIndex = harness.commands.indexOf(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    const timeoutIndex = harness.commands.indexOf(
      "SELECT set_config('statement_timeout', $1, TRUE)"
    );
    expect(timeoutIndex).toBeGreaterThan(beginIndex);
    expect(harness.commandValues[timeoutIndex]).toEqual(['3500ms']);
    expect(harness.commands.at(-1)).toBe('COMMIT');
  });

  it('uses source-bounded legacy SQL only for the universe-read projection', async () => {
    const commands: string[] = [];
    const values: unknown[][] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string, queryValues: unknown[] = []) => {
          commands.push(normalizeSql(sql));
          values.push(queryValues);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
    } as unknown as Pool;
    const repository = new PostgresBackstageBookerRepository(pool);

    await expect(repository.loadContext('legacy', {
      statementTimeoutMs: 3_500,
      universeReadProjection: true,
    })).resolves.toEqual(expect.objectContaining({
      roster: [],
      events: [],
      storyBeats: [],
      storylines: [],
    }));

    const sql = commands.join('\n');
    expect(sql).toContain('LEFT(BTRIM(name), 121) AS name');
    expect(sql).toContain(
      'ORDER BY backstage_wrestlers.updated_at DESC, backstage_wrestlers.name ASC'
    );
    expect(sql).toContain('jsonb_strip_nulls(jsonb_build_object(');
    expect(sql).toContain(
      "CASE WHEN serialized_data IS NOT NULL THEN '{}'::jsonb ELSE data END AS data"
    );
    expect(sql).toContain(
      "octet_length(convert_to(serialized_data, 'UTF8')) <= 16384"
    );
    expect(sql).toContain('LEFT(BTRIM(story_key), 241) AS story_key');
    expect(sql).toContain('LEFT(LTRIM(storyline, $2), 1501) AS storyline');
    const storylineQueryIndex = commands.findIndex(command =>
      command.includes('LEFT(LTRIM(storyline, $2), 1501) AS storyline')
    );
    expect(storylineQueryIndex).toBeGreaterThan(-1);
    const storylineQueryValues = values[storylineQueryIndex];
    expect(storylineQueryValues?.[0]).toBe('legacy');
    const trimStartCharacters = storylineQueryValues?.[1];
    expect(typeof trimStartCharacters).toBe('string');
    expect((trimStartCharacters as string).length).toBeGreaterThan(0);
    expect((trimStartCharacters as string).trimStart()).toBe('');
    expect(trimStartCharacters).toContain('\uFEFF');
    expect(values).toContainEqual(['3500ms']);
    expect(commands.at(-1)).toBe('COMMIT');
  });

  it('rolls an entire roster update back after a mid-command write failure', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.updateRoster('legacy', [{ name: 'Existing Wrestler', overall: 70 }]);
    harness.failRosterAfterFirstMutation = true;

    await expect(repository.updateRoster('legacy', [
      { name: 'First New Wrestler', overall: 80 },
      { name: 'Second New Wrestler', overall: 90 }
    ])).rejects.toBeInstanceOf(BackstageBookerWriteError);

    await expect(repository.loadRoster('legacy')).resolves.toMatchObject([
      { name: 'Existing Wrestler', overall: 70 }
    ]);
    expect(harness.commands).toContain('ROLLBACK');
  });

  it('rolls back before commit when the authoritative roster contains an invalid stored row', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.wrestlers.push({
      universe_id: 'legacy',
      name: 'Manually Corrupted Wrestler',
      overall: 101,
      updated_at: '2026-08-14T12:00:00.000Z'
    });
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    const commandStart = harness.commands.length;

    const failure = await repository.updateRoster('legacy', [
      { name: 'Valid New Wrestler', overall: 90 }
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackstageBookerWriteError);
    expect(failure).toMatchObject({
      cause: {
        name: 'BackstageRosterValidationError',
        code: 'BACKSTAGE_ROSTER_INVALID',
        message: expect.stringContaining('Stored roster row')
      }
    });
    const transactionCommands = harness.commands.slice(commandStart);
    expect(transactionCommands).toContain('ROLLBACK');
    expect(transactionCommands).not.toContain('COMMIT');
    expect(harness.wrestlers).toEqual([
      expect.objectContaining({
        name: 'Manually Corrupted Wrestler',
        overall: 101
      })
    ]);
  });

  it('validates authoritative roster rows without capping the total universe roster', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.wrestlers.push(...Array.from({ length: 101 }, (_unused, index) => ({
      universe_id: 'legacy',
      name: `Stored Wrestler ${index + 1}`,
      overall: index % 101,
      updated_at: '2026-08-14T12:00:00.000Z'
    })));
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    const mutation = await repository.updateRoster('legacy', []);

    expect(mutation.roster).toHaveLength(101);
    expect(mutation.roster).toContainEqual({
      name: 'Stored Wrestler 101',
      overall: 100
    });
  });

  it('uses distinct advisory lock resources for independent universes', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.updateRoster('universe-a', []);
    await repository.updateRoster('universe-b', []);

    const lockResources = harness.commands
      .map((command, index) => ({ command, values: harness.commandValues[index] }))
      .filter(call => call.command.startsWith('SELECT pg_advisory_xact_lock('))
      .map(call => call.values?.[1]);
    expect(lockResources).toEqual(['roster:universe-a', 'roster:universe-b']);
  });

  it('retains the original fixed advisory lock for legacy roster mutations', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.updateRoster('legacy', []);

    const lockCallIndex = harness.commands.findIndex(command =>
      command === 'SELECT pg_advisory_xact_lock($1, $2)'
    );
    expect(lockCallIndex).toBeGreaterThan(-1);
    expect(harness.commandValues[lockCallIndex]).toEqual([
      0x41524341,
      0x524f5354
    ]);
  });

  it('blocks every non-legacy durable mutation before activation', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.legacyGlobalConstraintsPresent = true;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    const attempts = [
      () => repository.bookEvent(
        'universe-a',
        { name: 'Blocked event' },
        '10000000-0000-4000-8000-000000000002'
      ),
      () => repository.updateRoster(
        'universe-a',
        [{ name: 'Blocked wrestler', overall: 80 }]
      ),
      () => repository.trackStoryline('universe-a', { beat: 'Blocked beat' }),
      () => repository.saveStoryline(
        'universe-a',
        'blocked-key',
        'Blocked storyline'
      )
    ];

    for (const attempt of attempts) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: 'BackstageBookerWriteError',
        cause: expect.objectContaining({
          code: 'BACKSTAGE_BOOKER_UNIVERSE_SCOPE_NOT_ACTIVATED',
          message: 'Backstage Booker universe-scoped persistence is not activated.'
        })
      });
      expect(failure).toBeInstanceOf(BackstageBookerWriteError);
      const writeFailure = failure as BackstageBookerWriteError;
      expect(
        isBackstageBookerUniverseScopeNotActivatedError(writeFailure.cause)
      ).toBe(true);
      expect(writeFailure.cause).toBeInstanceOf(
        BackstageBookerUniverseScopeNotActivatedError
      );
    }
    expect(harness.events).toHaveLength(0);
    expect(harness.wrestlers).toHaveLength(0);
    expect(harness.storyBeats).toHaveLength(0);
    expect(harness.storylines).toHaveLength(0);
    expect(harness.commands.filter(command =>
      command.includes("conname = 'backstage_wrestlers_name_key'")
    )).toHaveLength(4);
    expect(harness.commands.some(command =>
      /^(?:INSERT|UPDATE|DELETE|LOCK TABLE)\b/u.test(command)
    )).toBe(false);
    expect(harness.commands.some(command =>
      command.startsWith('SELECT pg_advisory_xact_lock(')
      || command.startsWith('SELECT txid_current()')
    )).toBe(false);
  });

  it('continues to permit legacy mutations while global constraints remain', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.legacyGlobalConstraintsPresent = true;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.bookEvent(
      'legacy',
      { name: 'Legacy event' },
      '10000000-0000-4000-8000-000000000003'
    );
    await repository.updateRoster('legacy', [{ name: 'Legacy wrestler', overall: 84 }]);
    await repository.trackStoryline('legacy', { beat: 'Legacy beat' });
    await repository.saveStoryline('legacy', 'legacy-key', 'Legacy storyline');

    expect(harness.events).toHaveLength(1);
    expect(harness.wrestlers).toHaveLength(1);
    expect(harness.storyBeats).toHaveLength(1);
    expect(harness.storylines).toHaveLength(1);
  });

  it('keeps an invalid activation-query result distinct from preactivation', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.invalidActivationResult = true;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    const failure = await repository.bookEvent(
      'universe-a',
      { name: 'Mapping failure event' },
      '10000000-0000-4000-8000-000000000005'
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackstageBookerWriteError);
    const writeFailure = failure as BackstageBookerWriteError;
    expect(writeFailure.cause).toEqual(expect.objectContaining({
      name: 'TypeError',
      message:
        'Backstage Booker universe-scope activation query returned an invalid result.'
    }));
    expect(
      isBackstageBookerUniverseScopeNotActivatedError(writeFailure.cause)
    ).toBe(false);
    expect(harness.events).toHaveLength(0);
  });

  it('permits every non-legacy durable mutation after activation', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.legacyGlobalConstraintsPresent = false;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.bookEvent(
      'universe-a',
      { name: 'Activated event' },
      '10000000-0000-4000-8000-000000000004'
    );
    await repository.updateRoster('universe-a', [{ name: 'Activated wrestler', overall: 88 }]);
    await repository.trackStoryline('universe-a', { beat: 'Activated beat' });
    await repository.saveStoryline('universe-a', 'activated-key', 'Activated storyline');

    expect(harness.events).toHaveLength(1);
    expect(harness.wrestlers).toHaveLength(1);
    expect(harness.storyBeats).toHaveLength(1);
    expect(harness.storylines).toHaveLength(1);
  });

  it('configures storyline isolation before checking non-legacy activation', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await repository.trackStoryline('universe-a', { beat: 'Ordered activation check' });

    const beginIndex = harness.commands.indexOf('BEGIN');
    const isolationIndex = harness.commands.indexOf(
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
    );
    const activationIndex = harness.commands.findIndex(command =>
      command.includes("conname = 'backstage_wrestlers_name_key'")
      && command.includes("conname = 'backstage_storylines_story_key_key'")
    );
    const advisoryLockIndex = harness.commands.findIndex(command =>
      command.startsWith('SELECT pg_advisory_xact_lock(')
    );

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(isolationIndex).toBeGreaterThan(beginIndex);
    expect(activationIndex).toBeGreaterThan(isolationIndex);
    expect(advisoryLockIndex).toBeGreaterThan(activationIndex);
  });

  it('serializes saved-storyline commits per universe before assigning their revision', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    const saved = await repository.saveStoryline(
      'universe-a',
      'world-title',
      'The challenger signs the contract.'
    );

    const activationIndex = harness.commands.findIndex(command =>
      command.includes("conname = 'backstage_storylines_story_key_key'")
    );
    const advisoryLockIndex = harness.commands.findIndex(command =>
      command.startsWith('SELECT pg_advisory_xact_lock($1, hashtext($2))')
    );
    const revisionIndex = harness.commands.indexOf(
      'SELECT txid_current()::TEXT AS revision'
    );
    const insertIndex = harness.commands.findIndex(command =>
      command.startsWith('INSERT INTO backstage_storylines')
    );

    expect(activationIndex).toBeGreaterThanOrEqual(0);
    expect(advisoryLockIndex).toBeGreaterThan(activationIndex);
    expect(revisionIndex).toBeGreaterThan(advisoryLockIndex);
    expect(insertIndex).toBeGreaterThan(revisionIndex);
    expect(harness.commandValues[advisoryLockIndex]).toEqual([
      0x41524341,
      'saved-storylines:universe-a'
    ]);
    expect(saved).toEqual(expect.objectContaining({
      universeId: 'universe-a',
      storyKey: 'world-title',
      storyline: 'The challenger signs the contract.',
      revision: expect.stringMatching(/^[0-9]+$/u)
    }));
  });

  it('accepts a wrestler name containing 120 astral code points', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    const wrestlerName = '🤼'.repeat(120);

    await expect(repository.updateRoster('legacy', [
      { name: wrestlerName, overall: 91 }
    ])).resolves.toMatchObject({
      roster: [{ name: wrestlerName, overall: 91 }]
    });
  });

  it('accepts a story key containing 240 astral code points', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    const storyKey = '🎬'.repeat(240);

    await expect(repository.saveStoryline(
      'legacy',
      storyKey,
      'The final scene.'
    )).resolves.toMatchObject({
      storyKey,
      storyline: 'The final scene.'
    });
  });

  it('preserves a 100,000-code-point storyline containing astral characters', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    const storyline = ` ${'🔥'.repeat(99_998)} `;

    const saved = await repository.saveStoryline(
      'legacy',
      'astral-boundary',
      storyline
    );

    expect(Array.from(saved.storyline)).toHaveLength(100_000);
    expect(saved.storyline).toBe(storyline);
  });

  it('rejects PostgreSQL-inexpressible saved-storyline and event strings before database work', async () => {
    const invalidTextValues = [
      'embedded-' + String.fromCharCode(0) + '-value',
      'unpaired-high-' + String.fromCharCode(0xd800),
      'unpaired-low-' + String.fromCharCode(0xdc00),
    ];

    for (const invalidText of invalidTextValues) {
      const harness = new BackstageRepositoryHarness();
      const repository = new PostgresBackstageBookerRepository(harness.pool);

      await expect(repository.saveStoryline(
        'legacy',
        invalidText,
        'Valid storyline'
      )).rejects.toThrow('must not contain');
      await expect(repository.saveStoryline(
        'legacy',
        'valid-key',
        invalidText
      )).rejects.toThrow('must not contain');
      await expect(repository.bookEvent(
        'legacy',
        { card: [{ label: invalidText }] },
        '10000000-0000-4000-8000-000000000006'
      )).rejects.toThrow('must not contain');
      await expect(repository.bookEvent(
        'legacy',
        { card: [{ [invalidText]: 'value' }] },
        '10000000-0000-4000-8000-000000000007'
      )).rejects.toThrow('must not contain');

      expect(harness.commands).toHaveLength(0);
      expect(harness.events).toHaveLength(0);
      expect(harness.storylines).toHaveLength(0);
    }
  });

  it('preserves valid astral pairs recursively in event JSON', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    const eventData = {
      title: 'Astral showcase 🎬',
      card: [{ 'division-🤼': 'Champion 🔥 Challenger' }]
    };

    await expect(repository.bookEvent(
      'legacy',
      eventData,
      '10000000-0000-4000-8000-000000000008'
    )).resolves.toMatchObject({ data: eventData });
  });

  it('reports a failed COMMIT as an unknown outcome without issuing a misleading rollback', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    harness.failCommit = true;

    await expect(repository.bookEvent(
      'legacy',
      { name: 'Summer Showcase' },
      '10000000-0000-4000-8000-000000000001'
    )).rejects.toBeInstanceOf(BackstageBookerCommitUnknownError);

    expect(harness.commands.filter(command => command === 'ROLLBACK')).toHaveLength(0);
    expect(harness.releaseCount).toBe(1);
    expect(harness.releaseCauses[0]).toEqual(
      expect.objectContaining({ message: 'SENTINEL_COMMIT_FAILURE' })
    );
  });

  it('evicts a client when rollback fails instead of returning an open transaction', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    harness.failRosterAfterFirstMutation = true;
    harness.failRollback = true;

    await expect(repository.updateRoster('legacy', [
      { name: 'First New Wrestler', overall: 80 },
      { name: 'Second New Wrestler', overall: 90 }
    ])).rejects.toMatchObject({
      name: 'BackstageBookerWriteError',
      rollbackCause: expect.objectContaining({
        message: 'SENTINEL_ROLLBACK_FAILURE'
      })
    });

    expect(harness.releaseCount).toBe(1);
    expect(harness.releaseCauses[0]).toEqual(
      expect.objectContaining({ message: 'SENTINEL_ROLLBACK_FAILURE' })
    );
  });

  it('uses an explicit unavailable error when a connection cannot be acquired', async () => {
    const harness = new BackstageRepositoryHarness();
    harness.failConnect = true;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await expect(repository.updateRoster('legacy', [])).rejects.toBeInstanceOf(
      BackstageBookerRepositoryUnavailableError
    );
  });

  it('rejects an invalid universe identifier before opening a connection', async () => {
    const harness = new BackstageRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await expect(repository.loadRoster('../other-universe')).rejects.toThrow(
      'valid Backstage universe identifier'
    );
    expect(harness.commands).toHaveLength(0);
  });
});

interface CanonHarnessThread {
  id: string;
  universe_id: string;
  story_key: string;
  title: string;
  summary: string | null;
  status: string;
  version: number;
  created_revision: string;
  updated_revision: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface CanonHarnessBeat {
  id: string;
  universe_id: string;
  storyline_id: string;
  story_key: string;
  sequence: number;
  kind: string;
  summary: string;
  occurred_at: string;
  participant_names: string[];
  event_id: string | null;
  supersedes_beat_id: string | null;
  universe_revision: string;
  created_at: string;
}

interface CanonHarnessRevision {
  operation: 'upsertStoryline' | 'appendCanonBeat';
  request_fingerprint: string;
  result: Record<string, unknown>;
}

class CanonRepositoryHarness {
  readonly commands: string[] = [];
  readonly commandValues: unknown[][] = [];
  readonly releaseCauses: unknown[] = [];
  readonly rosterByUniverse = new Map<string, Set<string>>();
  readonly events = new Array<{ universeId: string; id: string }>();
  readonly revisions = new Map<string, CanonHarnessRevision>();
  participants: string[] = [];
  beats: CanonHarnessBeat[] = [];
  thread: CanonHarnessThread | null = null;
  headRevision = 0;
  failCommit = false;
  failDeferredConstraintCheck = false;
  private clockSequence = 0;
  private snapshot: {
    headRevision: number;
    thread: CanonHarnessThread | null;
    participants: string[];
    beats: CanonHarnessBeat[];
    revisions: Array<[string, CanonHarnessRevision]>;
  } | null = null;

  readonly pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => this.query(sql, values),
      release: (cause?: unknown) => this.releaseCauses.push(cause)
    }),
    query: async (sql: string, values: unknown[] = []) => this.query(sql, values)
  } as unknown as Pool;

  addRoster(universeId: string, ...names: string[]): void {
    this.rosterByUniverse.set(universeId, new Set(names));
  }

  private timestamp(): string {
    this.clockSequence += 1;
    return new Date(Date.UTC(2026, 7, 14, 15, 0, this.clockSequence)).toISOString();
  }

  private result<T>(rows: T[] = []) {
    return { rows, rowCount: rows.length };
  }

  private cloneThread(): CanonHarnessThread | null {
    return this.thread ? { ...this.thread } : null;
  }

  private revisionKey(universeId: string, mutationId: string): string {
    return `${universeId}:${mutationId}`;
  }

  async query(rawSql: string, values: unknown[] = []) {
    const sql = normalizeSql(rawSql);
    this.commands.push(sql);
    this.commandValues.push(values);

    if (sql === 'BEGIN' || sql.startsWith('BEGIN TRANSACTION')) {
      this.snapshot = {
        headRevision: this.headRevision,
        thread: this.cloneThread(),
        participants: [...this.participants],
        beats: this.beats.map(beat => ({ ...beat, participant_names: [...beat.participant_names] })),
        revisions: [...this.revisions.entries()].map(([key, value]) => [
          key,
          structuredClone(value)
        ])
      };
      return this.result();
    }
    if (sql === 'COMMIT') {
      this.snapshot = null;
      if (this.failCommit) {
        this.failCommit = false;
        throw new Error('SENTINEL_CANON_COMMIT_FAILURE');
      }
      return this.result();
    }
    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        this.headRevision = this.snapshot.headRevision;
        this.thread = this.snapshot.thread;
        this.participants = this.snapshot.participants;
        this.beats = this.snapshot.beats;
        this.revisions.clear();
        for (const [key, value] of this.snapshot.revisions) {
          this.revisions.set(key, value);
        }
      }
      this.snapshot = null;
      return this.result();
    }
    if (sql.startsWith('INSERT INTO backstage_canon_heads')) {
      return this.result();
    }
    if (
      sql.startsWith('SELECT revision::TEXT AS revision FROM backstage_canon_heads')
      && sql.endsWith('FOR UPDATE')
    ) {
      return this.result([{ revision: String(this.headRevision) }]);
    }
    if (sql.startsWith('SELECT operation, request_fingerprint, result')) {
      const revision = this.revisions.get(
        this.revisionKey(String(values[0]), String(values[1]))
      );
      return this.result(revision ? [structuredClone(revision)] : []);
    }
    if (
      sql.includes('FROM backstage_storyline_threads')
      && sql.endsWith('FOR UPDATE')
    ) {
      const [universeId, storyKey] = values.map(String);
      return this.result(
        this.thread
          && this.thread.universe_id === universeId
          && this.thread.story_key === storyKey
          ? [this.cloneThread()]
          : []
      );
    }
    if (
      sql.startsWith('SELECT name FROM backstage_wrestlers')
      && sql.endsWith('FOR KEY SHARE')
    ) {
      const universeId = String(values[0]);
      const requested = values[1] as string[];
      const roster = this.rosterByUniverse.get(universeId) ?? new Set<string>();
      return this.result(requested.filter(name => roster.has(name)).map(name => ({ name })));
    }
    if (sql.startsWith('UPDATE backstage_canon_heads')) {
      this.headRevision += 1;
      return this.result([{ revision: String(this.headRevision) }]);
    }
    if (sql.startsWith('INSERT INTO backstage_storyline_threads')) {
      const timestamp = this.timestamp();
      this.thread = {
        id: String(values[0]),
        universe_id: String(values[1]),
        story_key: String(values[2]),
        title: String(values[3]),
        summary: values[4] === null ? null : String(values[4]),
        status: String(values[5]),
        version: 1,
        created_revision: String(values[6]),
        updated_revision: String(values[6]),
        created_at: timestamp,
        updated_at: timestamp,
        closed_at: null
      };
      return this.result([this.cloneThread()]);
    }
    if (sql.startsWith('UPDATE backstage_storyline_threads')) {
      const expectedVersion = Number(values.at(-1));
      if (!this.thread || this.thread.version !== expectedVersion) {
        return this.result();
      }
      if (sql.includes('title = $3')) {
        this.thread.title = String(values[2]);
        this.thread.summary = values[3] === null ? null : String(values[3]);
        this.thread.status = String(values[4]);
        this.thread.updated_revision = String(values[5]);
      } else {
        this.thread.status = String(values[2]);
        this.thread.updated_revision = String(values[3]);
      }
      this.thread.version += 1;
      this.thread.updated_at = this.timestamp();
      this.thread.closed_at = new Set(['completed', 'cancelled']).has(this.thread.status)
        ? this.thread.closed_at ?? this.timestamp()
        : null;
      return this.result([this.cloneThread()]);
    }
    if (sql.startsWith('DELETE FROM backstage_storyline_participants')) {
      this.participants = [];
      return this.result();
    }
    if (sql.startsWith('INSERT INTO backstage_storyline_participants')) {
      this.participants = [...(values[2] as string[])];
      return this.result();
    }
    if (sql.startsWith('SELECT wrestler_name FROM backstage_storyline_participants')) {
      return this.result(this.participants.map(wrestler_name => ({ wrestler_name })));
    }
    if (sql.startsWith('SELECT id FROM backstage_events')) {
      const universeId = String(values[0]);
      const eventId = String(values[1]);
      return this.result(
        this.events.some(event => event.universeId === universeId && event.id === eventId)
          ? [{ id: eventId }]
          : []
      );
    }
    if (sql.startsWith('SELECT beat.id, EXISTS')) {
      const universeId = String(values[0]);
      const storylineId = String(values[1]);
      const beatId = String(values[2]);
      const beat = this.beats.find(candidate =>
        candidate.universe_id === universeId
        && candidate.storyline_id === storylineId
        && candidate.id === beatId
      );
      return this.result(beat ? [{
        id: beat.id,
        already_superseded: this.beats.some(candidate =>
          candidate.universe_id === universeId
          && candidate.supersedes_beat_id === beat.id
        )
      }] : []);
    }
    if (sql.startsWith('SELECT (COALESCE(MAX(sequence), 0)::BIGINT + 1)::TEXT')) {
      const universeId = String(values[0]);
      const storylineId = String(values[1]);
      const maximum = this.beats
        .filter(beat => beat.universe_id === universeId && beat.storyline_id === storylineId)
        .reduce((value, beat) => Math.max(value, beat.sequence), 0);
      return this.result([{ sequence: String(maximum + 1) }]);
    }
    if (sql.startsWith('INSERT INTO backstage_storyline_canon_beats')) {
      const beat: CanonHarnessBeat = {
        id: String(values[0]),
        universe_id: String(values[1]),
        storyline_id: String(values[2]),
        sequence: Number(values[3]),
        kind: String(values[4]),
        summary: String(values[5]),
        occurred_at: String(values[6]),
        participant_names: JSON.parse(String(values[7])) as string[],
        event_id: values[8] === null ? null : String(values[8]),
        supersedes_beat_id: values[9] === null ? null : String(values[9]),
        universe_revision: String(values[10]),
        story_key: String(values[11]),
        created_at: this.timestamp()
      };
      this.beats.push(beat);
      return this.result([{ ...beat, participant_names: [...beat.participant_names] }]);
    }
    if (sql.startsWith('INSERT INTO backstage_canon_revisions')) {
      const serializedResult = String(values[5]);
      this.revisions.set(
        this.revisionKey(String(values[0]), String(values[2])),
        {
          operation: values[3] as 'upsertStoryline' | 'appendCanonBeat',
          request_fingerprint: String(values[4]),
          result: JSON.parse(serializedResult) as Record<string, unknown>
        }
      );
      return this.result();
    }
    if (sql.startsWith('SET CONSTRAINTS')) {
      if (this.failDeferredConstraintCheck) {
        this.failDeferredConstraintCheck = false;
        throw new Error('SENTINEL_DEFERRED_CONSTRAINT_FAILURE');
      }
      return this.result();
    }
    if (sql === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') {
      return this.result();
    }
    if (
      sql.startsWith('SELECT name, overall, updated_at FROM backstage_wrestlers')
      || sql.startsWith('SELECT id, universe_id, data, created_at FROM backstage_events')
      || sql.includes('FROM ( SELECT id, universe_id, data, serialized_data')
      || sql.startsWith('SELECT id, universe_id, story_key, storyline, created_at')
    ) {
      return this.result();
    }
    if (sql.startsWith('SELECT revision::TEXT AS revision FROM backstage_canon_heads')) {
      return this.result(this.headRevision > 0 ? [{ revision: String(this.headRevision) }] : []);
    }
    if (sql.includes("jsonb_agg(participant.wrestler_name ORDER BY participant.sort_order)")) {
      return this.result(this.thread ? [{
        ...this.cloneThread(),
        participant_names: [...this.participants]
      }] : []);
    }
    if (sql.startsWith('SELECT recent.* FROM ( SELECT beat.id')) {
      const active = this.beats.filter(beat => !this.beats.some(replacement =>
        replacement.universe_id === beat.universe_id
        && replacement.supersedes_beat_id === beat.id
      ));
      return this.result(active.map(beat => ({
        ...beat,
        participant_names: [...beat.participant_names]
      })));
    }

    throw new Error(`UNHANDLED_CANON_HARNESS_QUERY: ${sql}`);
  }
}

const CANON_MUTATION_ONE = '11111111-1111-4111-8111-111111111111';
const CANON_MUTATION_TWO = '22222222-2222-4222-8222-222222222222';
const CANON_EVENT = '33333333-3333-4333-8333-333333333333';
const FINGERPRINT_ONE = 'a'.repeat(64);
const FINGERPRINT_TWO = 'b'.repeat(64);

function canonStorylineInput(overrides: Record<string, unknown> = {}) {
  return {
    universeId: 'legacy',
    mutationId: CANON_MUTATION_ONE,
    requestFingerprint: FINGERPRINT_ONE,
    storyKey: 'world-title-chase',
    title: 'World title chase',
    summary: null,
    status: 'active' as const,
    expectedVersion: 0,
    participantNames: ['Alex', 'Blair'],
    ...overrides
  };
}

function canonBeatInput(overrides: Record<string, unknown> = {}) {
  return {
    universeId: 'legacy',
    mutationId: CANON_MUTATION_TWO,
    requestFingerprint: FINGERPRINT_TWO,
    storyKey: 'world-title-chase',
    expectedVersion: 1,
    kind: 'development',
    summary: 'The challenger confronts the champion.',
    occurredAt: '2026-08-14T16:00:00.000Z',
    participantNames: ['Alex'],
    ...overrides
  };
}

function canonParticipantNamesAtJsonbBoundary(extraAsciiBytes: number): string[] {
  return Array.from(
    { length: 50 },
    (_, index) => [
      '😀'.repeat(80),
      '-',
      String(index).padStart(2, '0'),
      index < extraAsciiBytes ? 'x' : ''
    ].join('')
  );
}

describe('PostgresBackstageBookerRepository Phase 2A canon persistence', () => {
  it('resolves only the bounded canon-domain error codes for HTTP envelopes', () => {
    expect(resolveBackstageCanonDomainErrorHttpStatus(
      'BACKSTAGE_STORYLINE_NOT_FOUND'
    )).toBe(404);
    expect(resolveBackstageCanonDomainErrorHttpStatus(
      'BACKSTAGE_STORYLINE_VERSION_CONFLICT'
    )).toBe(409);
    expect(resolveBackstageCanonDomainErrorHttpStatus(
      'BACKSTAGE_BOOKER_WRITE_FAILED'
    )).toBeNull();
    expect(resolveBackstageCanonDomainErrorHttpStatus(null)).toBeNull();
  });

  it('enforces protocol canon bounds before opening a connection', async () => {
    const harness = new CanonRepositoryHarness();
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await expect(repository.upsertStoryline(canonStorylineInput({
      summary: 's'.repeat(10_001)
    }))).rejects.toThrow('summary must contain at most 10000 characters');
    await expect(repository.upsertStoryline(canonStorylineInput({
      participantNames: Array.from({ length: 51 }, (_, index) => `Wrestler ${index}`)
    }))).rejects.toThrow('participantNames must be an array containing at most 50 names');
    await expect(repository.upsertStoryline(canonStorylineInput({
      participantNames: Array.from(
        { length: 50 },
        (_, index) => `${'😀'.repeat(117)}-${String(index).padStart(2, '0')}`
      )
    }))).rejects.toThrow('participantNames exceeds its UTF-8 storage contract');
    await expect(repository.appendCanonBeat(canonBeatInput({
      kind: 'k'.repeat(65)
    }))).rejects.toThrow('kind must contain between 1 and 64 characters');
    await expect(repository.appendCanonBeat(canonBeatInput({
      summary: 's'.repeat(10_001)
    }))).rejects.toThrow('summary must contain between 1 and 10000 characters');

    expect(harness.commands).toHaveLength(0);
  });

  it('matches PostgreSQL jsonb separator bytes at the participant storage boundary', async () => {
    const acceptedNames = canonParticipantNamesAtJsonbBoundary(34);
    const acceptedPostgresBytes = Buffer.byteLength(
      JSON.stringify(acceptedNames),
      'utf8'
    ) + acceptedNames.length - 1;
    expect(acceptedPostgresBytes).toBe(16_384);

    const acceptedHarness = new CanonRepositoryHarness();
    acceptedHarness.addRoster('legacy', ...acceptedNames);
    const acceptedRepository = new PostgresBackstageBookerRepository(
      acceptedHarness.pool
    );
    await expect(acceptedRepository.upsertStoryline(canonStorylineInput({
      participantNames: acceptedNames
    }))).resolves.toMatchObject({
      storyline: { participantNames: acceptedNames }
    });

    const rejectedNames = canonParticipantNamesAtJsonbBoundary(35);
    const rejectedPostgresBytes = Buffer.byteLength(
      JSON.stringify(rejectedNames),
      'utf8'
    ) + rejectedNames.length - 1;
    expect(rejectedPostgresBytes).toBe(16_385);
    const rejectedHarness = new CanonRepositoryHarness();
    const rejectedRepository = new PostgresBackstageBookerRepository(
      rejectedHarness.pool
    );
    await expect(rejectedRepository.upsertStoryline(canonStorylineInput({
      participantNames: rejectedNames
    }))).rejects.toThrow('participantNames exceeds its UTF-8 storage contract');
    expect(rejectedHarness.commands).toHaveLength(0);
  });

  it('commits once and replays an identical mutation without advancing revision', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    const input = canonStorylineInput();

    const first = await repository.upsertStoryline(input);
    const replay = await repository.upsertStoryline(input);

    expect(first).toMatchObject({
      mutationId: CANON_MUTATION_ONE,
      revision: '1',
      replayed: false,
      storyline: {
        summary: null,
        version: 1,
        participantNames: ['Alex', 'Blair']
      }
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(harness.headRevision).toBe(1);
    expect(harness.commands.filter(command =>
      command.startsWith('UPDATE backstage_canon_heads')
    )).toHaveLength(1);
    expect(harness.commands.filter(command =>
      command.startsWith('INSERT INTO backstage_canon_revisions')
    )).toHaveLength(1);

    const revisionInsertIndex = harness.commands.findIndex(command =>
      command.startsWith('INSERT INTO backstage_canon_revisions')
    );
    const constraintCheckIndex = harness.commands.findIndex(command =>
      command.startsWith('SET CONSTRAINTS')
    );
    const commitIndex = harness.commands.indexOf('COMMIT');
    expect(constraintCheckIndex).toBeGreaterThan(revisionInsertIndex);
    expect(commitIndex).toBeGreaterThan(constraintCheckIndex);
  });

  it('rejects mutation-id fingerprint reuse and rolls back without another bump', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput());

    await expect(repository.upsertStoryline(canonStorylineInput({
      requestFingerprint: FINGERPRINT_TWO
    }))).rejects.toMatchObject({
      code: 'BACKSTAGE_MUTATION_ID_CONFLICT',
      httpStatus: 409
    });

    expect(harness.headRevision).toBe(1);
    expect(harness.commands.at(-1)).toBe('ROLLBACK');
  });

  it('exposes bounded not-found, CAS, and transition conflicts', async () => {
    const missingHarness = new CanonRepositoryHarness();
    missingHarness.addRoster('legacy', 'Alex', 'Blair');
    const missingRepository = new PostgresBackstageBookerRepository(missingHarness.pool);
    await expect(missingRepository.upsertStoryline(canonStorylineInput({
      expectedVersion: 1
    }))).rejects.toMatchObject({ code: 'BACKSTAGE_STORYLINE_NOT_FOUND' });

    const staleHarness = new CanonRepositoryHarness();
    staleHarness.addRoster('legacy', 'Alex', 'Blair');
    const staleRepository = new PostgresBackstageBookerRepository(staleHarness.pool);
    await staleRepository.upsertStoryline(canonStorylineInput());
    await expect(staleRepository.upsertStoryline(canonStorylineInput({
      mutationId: CANON_MUTATION_TWO,
      requestFingerprint: FINGERPRINT_TWO,
      expectedVersion: 4
    }))).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_VERSION_CONFLICT'
    });

    const invalidHarness = new CanonRepositoryHarness();
    const invalidRepository = new PostgresBackstageBookerRepository(invalidHarness.pool);
    const error = await invalidRepository.upsertStoryline(canonStorylineInput({
      status: 'completed'
    })).catch(value => value as unknown);
    expect(isBackstageCanonDomainError(error)).toBe(true);
    expect(error).toBeInstanceOf(BackstageCanonDomainError);
    expect(invalidHarness.commands).toHaveLength(0);
  });

  it('appends a payoff and closes the storyline atomically', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    harness.events.push({ universeId: 'legacy', id: CANON_EVENT });
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput());

    const result = await repository.appendCanonBeat(canonBeatInput({
      kind: 'payoff',
      summary: 'The challenger wins the championship.',
      eventId: CANON_EVENT,
      nextStatus: 'completed'
    }));

    expect(result).toMatchObject({
      revision: '2',
      replayed: false,
      storyline: { status: 'completed', version: 2 },
      beat: {
        storylineId: result.storyline.id,
        storyKey: 'world-title-chase',
        sequence: 1,
        kind: 'payoff',
        eventId: CANON_EVENT,
        revision: '2'
      }
    });
    await expect(repository.appendCanonBeat(canonBeatInput({
      kind: 'payoff',
      summary: 'The challenger wins the championship.',
      eventId: CANON_EVENT,
      nextStatus: 'completed'
    }))).resolves.toEqual({ ...result, replayed: true });
  });

  it('activates a draft atomically with its first canon beat', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput({ status: 'draft' }));

    await expect(repository.appendCanonBeat(canonBeatInput({
      nextStatus: 'active'
    }))).resolves.toMatchObject({
      revision: '2',
      storyline: { status: 'active', version: 2 },
      beat: { sequence: 1 }
    });
  });

  it('rolls back immediately when a beat participant is outside the thread', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput({
      participantNames: ['Alex']
    }));
    const commandStart = harness.commands.length;

    await expect(repository.appendCanonBeat(canonBeatInput({
      participantNames: ['Blair']
    }))).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_REFERENCE_INVALID'
    });

    const mutationCommands = harness.commands.slice(commandStart);
    const participantRead = mutationCommands.findIndex(command =>
      command.startsWith('SELECT wrestler_name FROM backstage_storyline_participants')
    );
    expect(participantRead).toBeGreaterThan(-1);
    expect(mutationCommands.slice(participantRead + 1)).toEqual(['ROLLBACK']);
    expect(mutationCommands.some(command =>
      command.startsWith('UPDATE backstage_canon_heads')
      || command.startsWith('INSERT INTO backstage_storyline_canon_beats')
    )).toBe(false);
  });

  it('rejects an event from another universe before revision or beat writes', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    harness.events.push({ universeId: 'other-universe', id: CANON_EVENT });
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput());
    const commandStart = harness.commands.length;

    await expect(repository.appendCanonBeat(canonBeatInput({
      eventId: CANON_EVENT
    }))).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_REFERENCE_INVALID'
    });

    const mutationCommands = harness.commands.slice(commandStart);
    const eventQueryIndex = mutationCommands.findIndex(command =>
      command.startsWith('SELECT id FROM backstage_events')
    );
    expect(eventQueryIndex).toBeGreaterThan(-1);
    expect(harness.commandValues[commandStart + eventQueryIndex]).toEqual([
      'legacy',
      CANON_EVENT
    ]);
    expect(mutationCommands.some(command =>
      command.startsWith('UPDATE backstage_canon_heads')
    )).toBe(false);
  });

  it('classifies COMMIT failure as unknown after forcing deferred checks', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    harness.failCommit = true;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await expect(repository.upsertStoryline(canonStorylineInput())).rejects
      .toBeInstanceOf(BackstageBookerCommitUnknownError);

    const constraintIndex = harness.commands.findIndex(command =>
      command.startsWith('SET CONSTRAINTS')
    );
    expect(constraintIndex).toBeGreaterThan(-1);
    expect(harness.commands.at(-1)).toBe('COMMIT');
    expect(harness.commands).not.toContain('ROLLBACK');
  });

  it('treats a deferred lineage failure as known and rolls the whole write back', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    harness.failDeferredConstraintCheck = true;
    const repository = new PostgresBackstageBookerRepository(harness.pool);

    await expect(repository.upsertStoryline(canonStorylineInput())).rejects
      .toBeInstanceOf(BackstageBookerWriteError);

    expect(harness.commands.at(-1)).toBe('ROLLBACK');
    expect(harness.commands).not.toContain('COMMIT');
    expect(harness.headRevision).toBe(0);
    expect(harness.thread).toBeNull();
    expect(harness.revisions).toHaveProperty('size', 0);
  });

  it('loads legacy and retcon-aware canon context from one read-only snapshot', async () => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput());
    const original = await repository.appendCanonBeat(canonBeatInput());
    const replacement = await repository.appendCanonBeat(canonBeatInput({
      mutationId: '44444444-4444-4444-8444-444444444444',
      requestFingerprint: 'c'.repeat(64),
      expectedVersion: 2,
      summary: 'The confrontation is corrected in canon.',
      supersedesBeatId: original.beat.id
    }));

    const context = await repository.loadContext('legacy');

    expect(context.canonContext).toMatchObject({
      universeId: 'legacy',
      revision: '3',
      storylines: [{ version: 3, summary: null }],
      activeBeats: [{
        id: replacement.beat.id,
        sequence: 2,
        supersedesBeatId: original.beat.id
      }]
    });
    expect(context.canonContext.activeBeats).toHaveLength(1);
    expect(harness.commands.filter(command =>
      command === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    )).toHaveLength(1);
  });

  it.each([
    ['storyline summary', (harness: CanonRepositoryHarness) => {
      if (harness.thread) harness.thread.summary = 's'.repeat(10_001);
    }],
    ['beat kind', (harness: CanonRepositoryHarness) => {
      if (harness.beats[0]) harness.beats[0].kind = 'k'.repeat(65);
    }],
    ['beat summary', (harness: CanonRepositoryHarness) => {
      if (harness.beats[0]) harness.beats[0].summary = 's'.repeat(10_001);
    }],
    ['beat participants', (harness: CanonRepositoryHarness) => {
      if (harness.beats[0]) {
        harness.beats[0].participant_names = Array.from(
          { length: 51 },
          (_, index) => `Wrestler ${index}`
        );
      }
    }]
  ])('rolls back a snapshot containing a protocol-wider stored %s', async (_label, mutate) => {
    const harness = new CanonRepositoryHarness();
    harness.addRoster('legacy', 'Alex', 'Blair');
    const repository = new PostgresBackstageBookerRepository(harness.pool);
    await repository.upsertStoryline(canonStorylineInput());
    await repository.appendCanonBeat(canonBeatInput());
    mutate(harness);
    const commandStart = harness.commands.length;

    await expect(repository.loadCanonContext('legacy')).rejects.toBeInstanceOf(
      BackstageBookerRepositoryUnavailableError
    );

    const snapshotCommands = harness.commands.slice(commandStart);
    expect(snapshotCommands.at(-1)).toBe('ROLLBACK');
    expect(snapshotCommands).not.toContain('COMMIT');
  });
});
