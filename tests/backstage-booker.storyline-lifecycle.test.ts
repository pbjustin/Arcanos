import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunTrinityWritingPipeline = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockTransactionClientQuery = jest.fn();
const mockSaveMemory = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();
const { AUDITED_TRANSIENT_READ_QUERIES } =
  await import('../src/core/db/transientReadRegistry.js');
const { applyBackstageStorylineMutation } =
  await import('../src/core/db/repositories/backstageStorylineRepository.js');

jest.unstable_mockModule('@services/openai.js', () => ({
  getGPT5Model: mockGetGPT5Model,
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini'),
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  getComplexModel: jest.fn(() => 'gpt-4.1'),
  hasValidAPIKey: jest.fn(() => true),
  default: {
    getGPT5Model: mockGetGPT5Model
  }
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  applyBackstageRosterMutation: jest.fn(),
  applyBackstageStorylineMutation,
  query: mockQuery,
  transaction: mockTransaction,
  saveMemory: mockSaveMemory
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber
}));

const {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
  BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS,
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
  appendBoundedBackstageStorylineBeat
} = await import('../src/shared/backstage/backstageStoryline.js');
const { generateBooking, trackStoryline } =
  await import('../src/services/backstage-booker.js');

type StorylineBeat = Record<string, unknown>;
type StorylineRow = {
  serialized_data: string;
};
type QueryCall = [sql: string, params?: unknown[], options?: Record<string, unknown>];
let nextTransactionRevision = 100n;

function transactionQueryCalls(): QueryCall[] {
  return mockTransactionClientQuery.mock.calls as unknown as QueryCall[];
}

function queryCalls(): QueryCall[] {
  return mockQuery.mock.calls as unknown as QueryCall[];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function configureSuccessfulStorylineTransaction(
  rows: StorylineRow[],
  revision = (nextTransactionRevision += 1n).toString()
): void {
  mockTransactionClientQuery.mockImplementation(async (sql: unknown, _params?: unknown[]) => {
    if (typeof sql !== 'string') {
      return { rows: [] };
    }

    const normalized = normalizeSql(sql);
    if (normalized.includes('pg_advisory_xact_lock')) {
      return { rows: [{}] };
    }
    if (normalized.includes('txid_current')) {
      return { rows: [{ revision }] };
    }
    if (normalized.startsWith('INSERT INTO backstage_story_beats')) {
      return {
        rows: [{ id: 'inserted-beat' }]
      };
    }
    if (
      normalized.includes('FROM backstage_story_beats')
      && normalized.includes('SELECT recent.serialized_data')
      && normalized.includes('LIMIT')
    ) {
      return { rows };
    }
    return { rows: [] };
  });
}

function payloadAtSerializedUtf8Bytes(totalBytes: number): StorylineBeat {
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

function storylineRows(beats: StorylineBeat[]): StorylineRow[] {
  return beats.map(data => ({
    serialized_data: JSON.stringify(data)
  }));
}

describe('backstage-booker storyline lifecycle containment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: { responses: {} } });
    mockSaveMemory.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockTransaction.mockImplementation(async (
      callback: (client: { query: typeof mockTransactionClientQuery }) => Promise<unknown>
    ) => callback({ query: mockTransactionClientQuery }));
    configureSuccessfulStorylineTransaction([]);
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'Fresh storyline booking',
      activeModel: 'trinity-model',
      fallbackFlag: false,
      routingStages: ['TRINITY'],
      auditSafe: { mode: 'true', passed: true, flags: [] },
      taskLineage: [],
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: []
      },
      meta: {
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'backstage-booker.generateBooking',
        classification: 'writing'
      }
    });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'opening beat'],
    ['a number', 42]
  ])('rejects %s before transaction or snapshot side effects', async (_label, payload) => {
    await expect(trackStoryline(payload)).rejects.toMatchObject({
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('translates non-serializable circular objects into the stable validation contract', async () => {
    const payload: StorylineBeat = {};
    payload.self = payload;

    await expect(trackStoryline(payload)).rejects.toMatchObject({
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('translates revoked proxy reflection failures into the stable validation contract', async () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    await expect(trackStoryline(revocable.proxy)).rejects.toMatchObject({
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('rejects a toJSON hook that changes the root value into an array', async () => {
    const payload = {
      toJSON: () => ['not', 'an', 'object']
    };

    await expect(trackStoryline(payload)).rejects.toMatchObject({
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('accepts exactly 16,384 serialized UTF-8 bytes', async () => {
    const payload = payloadAtSerializedUtf8Bytes(BACKSTAGE_STORYLINE_MAX_BYTES);
    configureSuccessfulStorylineTransaction(storylineRows([payload]));

    await expect(trackStoryline(payload)).resolves.toEqual([payload]);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    const insertCall = transactionQueryCalls().find(([sql]) =>
      normalizeSql(sql).startsWith('INSERT INTO backstage_story_beats')
    );
    expect(insertCall?.[1]).toEqual([JSON.stringify(payload)]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['an escaped null character', '\u0000'],
    ['an escaped unpaired surrogate', '\uD800']
  ])('preserves %s in the exact text component', async (_label, value) => {
    const payload = { value };
    configureSuccessfulStorylineTransaction(storylineRows([payload]));

    await expect(trackStoryline(payload)).resolves.toEqual([payload]);

    const insertCall = transactionQueryCalls().find(([sql]) =>
      normalizeSql(sql).startsWith('INSERT INTO backstage_story_beats')
    );
    expect(insertCall?.[1]).toEqual([JSON.stringify(payload)]);
    expect(insertCall?.[0]).toContain("'{}'::JSONB");
    expect(insertCall?.[0]).not.toContain('$1::TEXT::JSONB');
  });

  it('rejects one serialized UTF-8 byte over the limit before side effects', async () => {
    const payload = payloadAtSerializedUtf8Bytes(BACKSTAGE_STORYLINE_MAX_BYTES + 1);

    await expect(trackStoryline(payload)).rejects.toMatchObject({
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('serializes insert, retention pruning, and deterministic bounded read in one transaction', async () => {
    const retainedBeats = Array.from(
      { length: BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS },
      (_unused, index) => ({ sequence: index + 1 })
    );
    const insertedBeat = retainedBeats[retainedBeats.length - 1] as StorylineBeat;
    const returnedBeats = retainedBeats.slice(-BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS);
    const revision = (nextTransactionRevision += 1n).toString();
    configureSuccessfulStorylineTransaction(storylineRows(retainedBeats), revision);

    await expect(trackStoryline(insertedBeat)).resolves.toEqual(returnedBeats);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();

    const calls = transactionQueryCalls();
    const isolationIndex = calls.findIndex(([sql]) =>
      normalizeSql(sql) === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
    );
    const lockIndex = calls.findIndex(([sql]) => sql.includes('pg_advisory_xact_lock'));
    const revisionIndex = calls.findIndex(([sql]) => sql.includes('txid_current'));
    const legacyUpdateIndex = calls.findIndex(([sql]) => {
      const normalized = normalizeSql(sql);
      return normalized.startsWith('WITH newest_legacy AS MATERIALIZED')
        && normalized.includes('UPDATE backstage_story_beats');
    });
    const insertIndex = calls.findIndex(([sql]) =>
      normalizeSql(sql).startsWith('INSERT INTO backstage_story_beats')
    );
    const nullCleanupIndex = calls.findIndex(([sql]) =>
      normalizeSql(sql) === 'DELETE FROM backstage_story_beats WHERE serialized_data IS NULL'
    );
    const retentionDeleteIndex = calls.findIndex(([sql]) => {
      const normalized = normalizeSql(sql);
      return normalized.startsWith('WITH expired AS MATERIALIZED')
        && normalized.includes('DELETE FROM backstage_story_beats');
    });
    const compactionIndex = calls.findIndex(([sql]) => {
      const normalized = normalizeSql(sql);
      return normalized.startsWith('WITH ordered AS MATERIALIZED')
        && normalized.includes('SET storage_sequence = ordered.compact_sequence');
    });
    const selectIndex = calls.findIndex(([sql]) => {
      const normalized = normalizeSql(sql);
      return normalized.includes('SELECT recent.serialized_data')
        && normalized.includes('FROM backstage_story_beats')
        && normalized.includes('LIMIT')
    });

    expect(isolationIndex).toBe(0);
    expect(lockIndex).toBeGreaterThan(isolationIndex);
    expect(revisionIndex).toBeGreaterThan(lockIndex);
    expect(legacyUpdateIndex).toBeGreaterThan(revisionIndex);
    expect(nullCleanupIndex).toBeGreaterThan(legacyUpdateIndex);
    expect(retentionDeleteIndex).toBeGreaterThan(nullCleanupIndex);
    expect(compactionIndex).toBeGreaterThan(retentionDeleteIndex);
    expect(insertIndex).toBeGreaterThan(compactionIndex);
    expect(selectIndex).toBeGreaterThan(insertIndex);

    const legacyUpdateCall = calls[legacyUpdateIndex];
    const insertCall = calls[insertIndex];
    const retentionDeleteCall = calls[retentionDeleteIndex];
    const selectCall = calls[selectIndex];
    expect(legacyUpdateCall?.[1]).toEqual([
      BACKSTAGE_STORYLINE_MAX_BYTES,
      BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS
    ]);
    expect(insertCall?.[0]).toContain('RETURNING');
    expect(insertCall?.[0]).toContain("'{}'::JSONB");
    expect(insertCall?.[0]).toContain('$1::TEXT');
    expect(insertCall?.[0]).not.toContain('$1::TEXT::JSONB');
    expect(insertCall?.[0]).toContain('clock_timestamp()');
    expect(insertCall?.[0]).toContain('COALESCE(MAX(storage_sequence), 0) + 1');
    expect(insertCall?.[0]).not.toContain('MAX(created_at)');
    expect(insertCall?.[1]).toEqual([JSON.stringify(insertedBeat)]);
    expect(retentionDeleteCall?.[1]).toEqual([
      BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS - 1
    ]);
    expect(normalizeSql(retentionDeleteCall?.[0] ?? '')).toMatch(
      /ORDER BY storage_sequence DESC, id DESC OFFSET \$1/u
    );
    expect(selectCall?.[1]).toEqual([
      'inserted-beat',
      BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS
    ]);
    expect(normalizeSql(selectCall?.[0] ?? '')).toMatch(
      /storage_sequence DESC, id DESC LIMIT \$2/u
    );
    expect(normalizeSql(selectCall?.[0] ?? '')).toMatch(
      /recent\.storage_sequence ASC, \(recent\.id = \$1::UUID\) ASC, recent\.id ASC/u
    );

    const legacySql = normalizeSql(legacyUpdateCall?.[0] ?? '');
    expect(legacySql).toContain('ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)');
    expect(legacySql).not.toMatch(/created_at\s*[<>]=?\s*(?:NOW|CURRENT_DATE)/iu);
    expect(normalizeSql(retentionDeleteCall?.[0] ?? '')).not.toContain('created_at');

    expect(mockSaveMemory).toHaveBeenCalledWith(
      'backstage-storybeats:latest',
      expect.objectContaining({
        beats: returnedBeats,
        source: 'database',
        revision
      }),
      { ifNewerRevision: revision }
    );
  });

  it('fails closed on non-transient persistence errors without publishing a snapshot', async () => {
    mockTransaction.mockRejectedValue(
      Object.assign(new Error('violates check constraint'), { code: '23514' })
    );

    await expect(trackStoryline({ sequence: 'rejected' })).rejects.toMatchObject({
      code: BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
      message: 'Storyline persistence could not be confirmed.'
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('caps the directly used volatile store at 100 without expiring old beats by age', () => {
    const oldBeat = { sequence: 1, occurredAt: '1900-01-01T00:00:00.000Z' };
    let retained: StorylineBeat[] = [oldBeat];
    for (let sequence = 2; sequence <= 100; sequence += 1) {
      retained = appendBoundedBackstageStorylineBeat(retained, { sequence });
    }

    expect(retained).toHaveLength(BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS);
    expect(retained[0]).toEqual(oldBeat);

    retained = appendBoundedBackstageStorylineBeat(retained, { sequence: 101 });
    expect(retained).toHaveLength(BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS);
    expect(retained[0]).toEqual({ sequence: 2 });
    expect(retained.at(-1)).toEqual({ sequence: 101 });
  });

  it('bypasses the process-local cache for mutable storyline prompt reads', async () => {
    await expect(generateBooking('Continue the current feud.')).resolves.toBe(
      'Fresh storyline booking'
    );

    const beatRead = queryCalls().find(([sql]) =>
      sql === AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_STORY_BEATS_RECENT.sql
    );
    const savedStorylineRead = queryCalls().find(([sql]) =>
      sql === AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_STORYLINES_RECENT.sql
    );
    expect(beatRead?.[2]).toEqual(expect.objectContaining({ useCache: false }));
    expect(savedStorylineRead?.[2]).toEqual(expect.objectContaining({ useCache: false }));
  });

  it('bounds volatile fallback retention to 100, responses to 25, and prompt context to 5', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const seedBeat = { sequence: 'database-seed' };
      configureSuccessfulStorylineTransaction(storylineRows([seedBeat]));
      await trackStoryline(seedBeat);
      const durableSnapshotCallsAfterSeed = mockSaveMemory.mock.calls.length;

      mockTransaction.mockRejectedValue(
        Object.assign(new Error('database unavailable'), { code: '08006' })
      );
      let result: StorylineBeat[] = [];
      for (let sequence = 0; sequence <= BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS; sequence += 1) {
        result = await trackStoryline({ sequence });
      }

      const expected = Array.from(
        { length: BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS },
        (_unused, index) => ({
          sequence:
            BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS
            - BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS
            + 1
            + index
        })
      );
      expect(result).toEqual(expected);
      expect(mockSaveMemory).toHaveBeenCalledTimes(durableSnapshotCallsAfterSeed);

      mockQuery.mockRejectedValue(new Error('database unavailable'));
      await generateBooking('Continue the current feud.');
      const pipelineCall = mockRunTrinityWritingPipeline.mock.calls.at(-1) as unknown[] | undefined;
      const pipelineRequest = pipelineCall?.[0] as {
        input?: { prompt?: string };
      } | undefined;
      const prompt = pipelineRequest?.input?.prompt ?? '';
      expect(prompt.match(/^- #\d+:/gmu)).toHaveLength(5);
      expect(prompt).toContain('{"sequence":96}');
      expect(prompt).toContain('{"sequence":100}');
      expect(prompt).not.toContain('{"sequence":95}');
      expect(prompt).not.toContain('database-seed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
