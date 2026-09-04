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
const mockGetEnvBoolean = jest.fn();
const { AUDITED_TRANSIENT_READ_QUERIES } =
  await import('../src/core/db/transientReadRegistry.js');
const { applyBackstageRosterMutation } =
  await import('../src/core/db/repositories/backstageRosterRepository.js');

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

jest.unstable_mockModule('../src/services/backstageNotionAuthority.js', () => ({
  isBackstageNotionAuthorityDatabaseError: (value: unknown) => (
    typeof value === 'object'
    && value !== null
    && (value as { code?: unknown }).code === 'BN001'
  ),
  isBackstageNotionAuthorityEnforced: jest.fn(async () => false),
  readBackstageNotionAuthorityConfiguration: jest.fn(() => ({ status: 'absent' })),
  resolveEffectiveBackstageNotionAuthorityRoot: jest.fn(async () => null)
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  applyBackstageRosterMutation,
  applyBackstageStorylineMutation: jest.fn(),
  isTransactionCommitAmbiguousError: jest.fn(() => false),
  query: mockQuery,
  transaction: mockTransaction,
  saveMemory: mockSaveMemory
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber,
  getEnvBoolean: mockGetEnvBoolean
}));

const {
  BACKSTAGE_ROSTER_MAX_ITEMS,
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
  BACKSTAGE_WRESTLER_NAME_MAX_LENGTH,
  BackstageRosterPersistenceError
} = await import('../src/shared/backstage/backstageRoster.js');
const { generateBooking, simulateMatch, updateRoster } =
  await import('../src/services/backstage-booker.js');

type QueryCall = [sql: string, params?: unknown[], options?: Record<string, unknown>];

function queryCalls(): QueryCall[] {
  return mockQuery.mock.calls as unknown as QueryCall[];
}

function findQueryCall(sql: string): QueryCall | undefined {
  return queryCalls().find(([calledSql]) => calledSql === sql);
}

function transactionQueryCalls(): QueryCall[] {
  return mockTransactionClientQuery.mock.calls as unknown as QueryCall[];
}

function findTransactionQueryCall(sql: string): QueryCall | undefined {
  return transactionQueryCalls().find(([calledSql]) => calledSql === sql);
}

function configureSuccessfulRosterTransaction(
  rows: Array<{ name: string; overall: number }>,
  revision = '100'
): void {
  mockTransactionClientQuery.mockImplementation(async (sql: unknown) => {
    if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
      return { rows: [{}] };
    }
    if (typeof sql === 'string' && sql.includes('txid_current')) {
      return { rows: [{ revision }] };
    }
    if (sql === AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql) {
      return { rows };
    }
    return { rows: [] };
  });
}

function wrestlerBatch(count: number, prefix = 'Wrestler') {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `${prefix} ${index + 1}`,
    overall: index % 101
  }));
}

describe('backstage-booker roster containment', () => {
  const sparseRosterPayload: unknown[] = [];
  sparseRosterPayload.length = 1;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetEnvBoolean.mockReturnValue(false);
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: { responses: {} } });
    mockSaveMemory.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(async (
      callback: (client: { query: typeof mockTransactionClientQuery }) => Promise<unknown>
    ) => callback({ query: mockTransactionClientQuery }));
    configureSuccessfulRosterTransaction([]);
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'Fresh roster booking',
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
    ['a non-array payload', { name: 'Rhea Ripley', overall: 96 }],
    ['a sparse roster array', sparseRosterPayload],
    ['a null roster item', [null]],
    ['an array roster item', [[{ name: 'Rhea Ripley', overall: 96 }]]],
    ['a non-string name', [{ name: 42, overall: 96 }]],
    ['an empty trimmed name', [{ name: '   ', overall: 96 }]],
    ['a PostgreSQL-incompatible NUL name', [{ name: 'Rhea\u0000Ripley', overall: 96 }]],
    ['an unpaired high-surrogate name', [{
      name: 'Rhea' + String.fromCharCode(0xd800) + 'Ripley',
      overall: 96
    }]],
    ['an unpaired low-surrogate name', [{
      name: 'Rhea' + String.fromCharCode(0xdc00) + 'Ripley',
      overall: 96
    }]],
    ['a name over the Unicode code-point limit', [{ name: '😀'.repeat(BACKSTAGE_WRESTLER_NAME_MAX_LENGTH + 1), overall: 96 }]],
    ['a string rating', [{ name: 'Rhea Ripley', overall: '96' }]],
    ['a fractional rating', [{ name: 'Rhea Ripley', overall: 96.5 }]],
    ['a negative rating', [{ name: 'Rhea Ripley', overall: -1 }]],
    ['a rating over 100', [{ name: 'Rhea Ripley', overall: 101 }]],
    ['a non-finite rating', [{ name: 'Rhea Ripley', overall: Number.POSITIVE_INFINITY }]],
    ['a duplicate trimmed name', [
      { name: ' Rhea Ripley ', overall: 95 },
      { name: 'Rhea Ripley', overall: 96 }
    ]],
    ['one item over the roster cap', wrestlerBatch(BACKSTAGE_ROSTER_MAX_ITEMS + 1)]
  ])('rejects %s before any query or snapshot side effect', async (_label, payload) => {
    await expect(updateRoster(payload)).rejects.toMatchObject({
      code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed required fields without invoking them', async () => {
    const nameGetter = jest.fn(() => 'Rhea Ripley');
    const overallGetter = jest.fn(() => 96);
    const item = {};
    Object.defineProperties(item, {
      name: { enumerable: true, get: nameGetter },
      overall: { enumerable: true, get: overallGetter }
    });

    await expect(updateRoster([item])).rejects.toMatchObject({
      code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE
    });

    expect(nameGetter).not.toHaveBeenCalled();
    expect(overallGetter).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('accepts exactly 100 supplied items in one bulk transaction', async () => {
    const payload = wrestlerBatch(BACKSTAGE_ROSTER_MAX_ITEMS, 'Exact-cap');
    configureSuccessfulRosterTransaction(payload, '101');

    await expect(updateRoster(payload)).resolves.toEqual(payload);

    const upsertCalls = transactionQueryCalls()
      .filter(([sql]) => sql.includes('INSERT INTO backstage_wrestlers'));
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.[0]).toContain('UNNEST($2::TEXT[], $3::INTEGER[])');
    expect(upsertCalls[0]?.[1]).toEqual([
      'legacy',
      payload.map(wrestler => wrestler.name),
      payload.map(wrestler => wrestler.overall)
    ]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  it('trims Unicode names, strips extra properties, and treats case variants as distinct', async () => {
    const boundaryName = `😀${'x'.repeat(BACKSTAGE_WRESTLER_NAME_MAX_LENGTH - 1)}`;
    const expectedRoster = [
      { name: boundaryName, overall: 100 },
      { name: 'rhea ripley', overall: 95 },
      { name: 'Rhea Ripley', overall: 96 }
    ];
    const payload = [
      { name: `  ${boundaryName}  `, overall: 100, ignored: 'extra' },
      { name: ' rhea ripley ', overall: 95, nested: { ignored: true } },
      { name: 'Rhea Ripley', overall: 96, ignored: false }
    ];
    configureSuccessfulRosterTransaction(expectedRoster, '102');

    await expect(updateRoster(payload)).resolves.toEqual(expectedRoster);

    const upsertParams = transactionQueryCalls()
      .filter(([sql]) => sql.includes('INSERT INTO backstage_wrestlers'))
      .map(([, params]) => params);
    expect(upsertParams).toEqual([[
      'legacy',
      expectedRoster.map(({ name }) => name),
      expectedRoster.map(({ overall }) => overall)
    ]]);
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'backstage-universe:legacy:roster:latest',
      expect.objectContaining({ roster: expectedRoster, source: 'database', revision: '102' }),
      { ifNewerRevision: '102' }
    );
  });

  it('preserves the empty-array refresh contract without issuing upserts', async () => {
    const freshRows = [{ name: 'Existing Wrestler', overall: 88 }];
    configureSuccessfulRosterTransaction(freshRows, '103');

    await expect(updateRoster([])).resolves.toEqual(freshRows);

    expect(transactionQueryCalls()
      .filter(([sql]) => sql.includes('INSERT INTO backstage_wrestlers'))).toHaveLength(0);
    expect(findTransactionQueryCall(
      AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql
    )).toEqual([
      AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql,
      ['legacy']
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'backstage-universe:legacy:roster:latest',
      expect.objectContaining({ roster: freshRows, source: 'database', revision: '103' }),
      { ifNewerRevision: '103' }
    );
  });

  it('fails closed when the bulk write fails without a snapshot or fallback query', async () => {
    mockTransactionClientQuery
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ revision: '104' }] })
      .mockRejectedValueOnce(new Error('injected roster bulk write failure'));

    await expect(updateRoster([{ name: 'Rejected Wrestler', overall: 91 }]))
      .rejects.toEqual(expect.objectContaining({
        name: 'BackstageRosterPersistenceError',
        code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
        message: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE
      }));

    expect(mockTransactionClientQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('fails closed when the transactional roster read fails after the bulk write', async () => {
    mockTransactionClientQuery
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ revision: '105' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('injected transactional roster read failure'));

    await expect(updateRoster([{ name: 'Read Failure Wrestler', overall: 92 }]))
      .rejects.toBeInstanceOf(BackstageRosterPersistenceError);

    expect(transactionQueryCalls()).toHaveLength(4);
    expect(transactionQueryCalls()[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(transactionQueryCalls()[1]?.[0]).toContain('txid_current');
    expect(transactionQueryCalls()[2]?.[0]).toContain('INSERT INTO backstage_wrestlers');
    expect(transactionQueryCalls()[3]?.[0]).toBe(
      AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('does not replace the process roster when the authoritative transaction fails', async () => {
    const committedRoster = [
      { name: 'Committed One', overall: 90 },
      { name: 'Committed Two', overall: 80 }
    ];
    configureSuccessfulRosterTransaction(committedRoster, '106');
    await updateRoster(committedRoster);

    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (
      callback: (client: { query: typeof mockTransactionClientQuery }) => Promise<unknown>
    ) => callback({ query: mockTransactionClientQuery }));
    mockTransactionClientQuery.mockRejectedValueOnce(new Error('replacement transaction failed'));
    mockQuery.mockRejectedValueOnce(new Error('database unavailable for match read'));
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      await expect(updateRoster([
        { name: 'Uncommitted One', overall: 99 },
        { name: 'Uncommitted Two', overall: 98 }
      ])).rejects.toBeInstanceOf(BackstageRosterPersistenceError);

      await expect(simulateMatch({
        wrestler1: 'Committed One',
        wrestler2: 'Committed Two',
        matchType: 'Singles'
      })).resolves.toEqual(expect.objectContaining({
        match: 'Committed One vs Committed Two (Singles)'
      }));
    } finally {
      randomSpy.mockRestore();
    }

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('does not replace process state when the transaction reports an unconfirmed commit', async () => {
    const committedRoster = [
      { name: 'Confirmed One', overall: 90 },
      { name: 'Confirmed Two', overall: 80 }
    ];
    configureSuccessfulRosterTransaction(committedRoster, '107');
    await updateRoster(committedRoster);

    jest.clearAllMocks();
    const unconfirmedRoster = [
      { name: 'Unconfirmed One', overall: 99 },
      { name: 'Unconfirmed Two', overall: 98 }
    ];
    configureSuccessfulRosterTransaction(unconfirmedRoster, '108');
    mockTransaction.mockImplementationOnce(async (
      callback: (client: { query: typeof mockTransactionClientQuery }) => Promise<unknown>
    ) => {
      await callback({ query: mockTransactionClientQuery });
      throw new Error('commit acknowledgement lost');
    });

    await expect(updateRoster(unconfirmedRoster)).rejects.toEqual(
      expect.objectContaining({
        code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
        message: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE
      })
    );

    mockQuery.mockRejectedValueOnce(new Error('database unavailable for match read'));
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      await expect(simulateMatch({
        wrestler1: 'Confirmed One',
        wrestler2: 'Confirmed Two',
        matchType: 'Singles'
      })).resolves.toEqual(expect.objectContaining({
        match: 'Confirmed One vs Confirmed Two (Singles)'
      }));
    } finally {
      randomSpy.mockRestore();
    }

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('returns each committed roster while serializing overlapping snapshot writes', async () => {
    const firstRoster = [{ name: 'First Commit', overall: 91 }];
    const secondRoster = [{ name: 'Second Commit', overall: 92 }];
    let transactionCount = 0;
    mockTransaction.mockImplementation(async (
      callback: (client: { query: typeof mockTransactionClientQuery }) => Promise<unknown>
    ) => {
      const transactionRoster = transactionCount === 0 ? firstRoster : secondRoster;
      transactionCount += 1;
      const revision = transactionCount === 1 ? '109' : '110';
      const clientQuery = jest.fn(async (sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('txid_current')) {
          return { rows: [{ revision }] };
        }
        return sql === AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql
          ? { rows: transactionRoster }
          : { rows: [] };
      });
      return callback({ query: clientQuery as typeof mockTransactionClientQuery });
    });

    let releaseFirstSnapshot: (() => void) | undefined;
    let markFirstSnapshotStarted: (() => void) | undefined;
    const firstSnapshotStarted = new Promise<void>(resolve => {
      markFirstSnapshotStarted = resolve;
    });
    const firstSnapshotPending = new Promise<void>(resolve => {
      releaseFirstSnapshot = resolve;
    });
    mockSaveMemory
      .mockImplementationOnce(async () => {
        markFirstSnapshotStarted?.();
        await firstSnapshotPending;
      })
      .mockResolvedValueOnce(undefined);

    const firstUpdate = updateRoster(firstRoster);
    await firstSnapshotStarted;
    const secondUpdate = updateRoster(secondRoster);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
    releaseFirstSnapshot?.();
    await expect(Promise.all([firstUpdate, secondUpdate])).resolves.toEqual([
      firstRoster,
      secondRoster
    ]);
    expect(mockSaveMemory).toHaveBeenNthCalledWith(
      1,
      'backstage-universe:legacy:roster:latest',
      expect.objectContaining({ roster: firstRoster, revision: '109' }),
      { ifNewerRevision: '109' }
    );
    expect(mockSaveMemory).toHaveBeenNthCalledWith(
      2,
      'backstage-universe:legacy:roster:latest',
      expect.objectContaining({ roster: secondRoster, revision: '110' }),
      { ifNewerRevision: '110' }
    );
  });

  it('does not let a delayed older commit acknowledgement regress process fallback state', async () => {
    const olderRoster = [
      { name: 'Older One', overall: 81 },
      { name: 'Older Two', overall: 82 }
    ];
    const newerRoster = [
      { name: 'Newer One', overall: 91 },
      { name: 'Newer Two', overall: 92 }
    ];
    let transactionCount = 0;
    let releaseOlderCommit: (() => void) | undefined;
    let markOlderCallbackComplete: (() => void) | undefined;
    const olderCommitPending = new Promise<void>(resolve => {
      releaseOlderCommit = resolve;
    });
    const olderCallbackComplete = new Promise<void>(resolve => {
      markOlderCallbackComplete = resolve;
    });

    mockTransaction.mockImplementation(async (
      callback: (client: { query: typeof mockTransactionClientQuery }) => Promise<unknown>
    ) => {
      const isOlder = transactionCount === 0;
      transactionCount += 1;
      const transactionRoster = isOlder ? olderRoster : newerRoster;
      const revision = isOlder ? '111' : '112';
      const clientQuery = jest.fn(async (sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('txid_current')) {
          return { rows: [{ revision }] };
        }
        return sql === AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql
          ? { rows: transactionRoster }
          : { rows: [] };
      });
      const result = await callback({ query: clientQuery as typeof mockTransactionClientQuery });
      if (isOlder) {
        markOlderCallbackComplete?.();
        await olderCommitPending;
      }
      return result;
    });

    const olderUpdate = updateRoster(olderRoster);
    await olderCallbackComplete;
    await expect(updateRoster(newerRoster)).resolves.toEqual(newerRoster);
    releaseOlderCommit?.();
    await expect(olderUpdate).resolves.toEqual(olderRoster);

    mockQuery.mockRejectedValueOnce(new Error('database unavailable for match read'));
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      await expect(simulateMatch({
        wrestler1: 'Newer One',
        wrestler2: 'Newer Two',
        matchType: 'Singles'
      })).resolves.toEqual(expect.objectContaining({
        match: 'Newer One vs Newer Two (Singles)'
      }));
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('uses uncached current rows for the post-update snapshot and response', async () => {
    const submitted = [{ name: 'Updated Wrestler', overall: 91 }];
    const freshRows = [
      { name: 'Existing Wrestler', overall: 84 },
      { name: 'Updated Wrestler', overall: 91 }
    ];
    configureSuccessfulRosterTransaction(freshRows, '113');

    await expect(updateRoster(submitted)).resolves.toEqual(freshRows);

    expect(findTransactionQueryCall(
      AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql
    )).toEqual([
      AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql,
      ['legacy']
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'backstage-universe:legacy:roster:latest',
      expect.objectContaining({ roster: freshRows, source: 'database', revision: '113' }),
      { ifNewerRevision: '113' }
    );
  });

  it.each([
    ['an Error rejection', new Error('snapshot unavailable')],
    ['a non-Error rejection', null]
  ])('keeps the convenience snapshot best-effort after %s', async (_label, snapshotError) => {
    const freshRows = [
      { name: 'Durable One', overall: 94 },
      { name: 'Durable Two', overall: 93 }
    ];
    configureSuccessfulRosterTransaction(freshRows, '114');
    mockSaveMemory.mockRejectedValueOnce(snapshotError);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(updateRoster(freshRows)).resolves.toEqual(freshRows);

      mockQuery.mockRejectedValueOnce(new Error('database unavailable for match read'));
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        await expect(simulateMatch({
          wrestler1: 'Durable One',
          wrestler2: 'Durable Two',
          matchType: 'Singles'
        })).resolves.toEqual(expect.objectContaining({
          match: 'Durable One vs Durable Two (Singles)'
        }));
      } finally {
        randomSpy.mockRestore();
      }
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  it('marks only transient persistence causes as retryable', async () => {
    mockTransaction.mockRejectedValueOnce(Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET'
    }));
    await expect(updateRoster([{ name: 'Transient', overall: 90 }]))
      .rejects.toMatchObject({ retryable: true });

    mockTransaction.mockRejectedValueOnce(Object.assign(new Error('constraint failed'), {
      code: '23514'
    }));
    await expect(updateRoster([{ name: 'Permanent', overall: 90 }]))
      .rejects.toMatchObject({ retryable: false });
  });

  it.each([
    new Error('Connection terminated unexpectedly'),
    new Error('pool wrapper', {
      cause: new Error('timeout exceeded when trying to connect')
    }),
    Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014'
    }),
    new AggregateError([
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    ], 'pool failures')
  ])('recognizes nested and code-less PostgreSQL transport failures as retryable', async error => {
    mockTransaction.mockRejectedValueOnce(error);

    await expect(updateRoster([{ name: 'Transient', overall: 90 }]))
      .rejects.toMatchObject({ retryable: true });
  });

  it('does not retry an explicitly cancelled PostgreSQL statement', async () => {
    mockTransaction.mockRejectedValueOnce(Object.assign(
      new Error('canceling statement due to user request'),
      { code: '57014' }
    ));

    await expect(updateRoster([{ name: 'Cancelled', overall: 90 }]))
      .rejects.toMatchObject({ retryable: false });
  });

  it('defines two zero-rated wrestlers as a 50/50 matchup', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      await expect(simulateMatch({
        wrestler1: 'Zero One',
        wrestler2: 'Zero Two',
        matchType: 'Singles'
      }, [
        { name: 'Zero One', overall: 0 },
        { name: 'Zero Two', overall: 0 }
      ])).resolves.toMatchObject({
        probability: {
          'Zero One': '0.50',
          'Zero Two': '0.50'
        }
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('uses an uncached roster-table read when match input omits a roster', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { name: 'Fresh One', overall: 90 },
        { name: 'Fresh Two', overall: 80 }
      ]
    });
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      await expect(simulateMatch({
        wrestler1: 'Fresh One',
        wrestler2: 'Fresh Two',
        matchType: 'Singles'
      })).resolves.toEqual(expect.objectContaining({ match: 'Fresh One vs Fresh Two (Singles)' }));
    } finally {
      randomSpy.mockRestore();
    }

    expect(findQueryCall(AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_MATCH_ROSTER_READ.sql)?.[2])
      .toEqual(expect.objectContaining({ useCache: false }));
  });

  it('uses an uncached recent roster in the structured booking prompt', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (sql === AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_ROSTER_RECENT.sql) {
        return {
          rows: [{ name: 'Fresh Prompt Wrestler', overall: 93, updated_at: '2026-08-03T12:00:00.000Z' }]
        };
      }
      return { rows: [] };
    });

    await expect(generateBooking('Build a title rivalry from the current roster.'))
      .resolves.toBe('Fresh roster booking');

    expect(findQueryCall(AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_ROSTER_RECENT.sql)?.[2])
      .toEqual(expect.objectContaining({ useCache: false }));
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: expect.stringContaining('- Fresh Prompt Wrestler (Overall 93)')
      })
    }));
  });
});
