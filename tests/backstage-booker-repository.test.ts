import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'pg';

import {
  BackstageBookerCommitUnknownError,
  BackstageBookerRepositoryUnavailableError,
  BackstageBookerUniverseScopeNotActivatedError,
  BackstageBookerWriteError,
  isBackstageBookerUniverseScopeNotActivatedError,
  PostgresBackstageBookerRepository
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
