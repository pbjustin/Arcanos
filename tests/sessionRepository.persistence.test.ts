import { describe, expect, it, jest } from '@jest/globals';

const mockInitializeDatabase = jest.fn<(workerId?: string) => Promise<boolean>>();
const mockGetPool = jest.fn<() => object | null>();
const mockIsDatabaseConnected = jest.fn<() => boolean>();
const mockClosePoolIfCurrent = jest.fn<(expectedPool: object) => Promise<boolean>>();
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockInitializeTables = jest.fn<() => Promise<boolean>>();
const mockIsDatabaseSchemaReady = jest.fn<() => boolean>();

jest.unstable_mockModule('@core/db/client.js', () => ({
  closePoolIfCurrent: mockClosePoolIfCurrent,
  getPool: mockGetPool,
  initializeDatabase: mockInitializeDatabase,
  isDatabaseConnected: mockIsDatabaseConnected
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: mockQuery,
  transaction: mockTransaction
}));

jest.unstable_mockModule('@core/db/schema.js', () => ({
  initializeTables: mockInitializeTables,
  isDatabaseSchemaReady: mockIsDatabaseSchemaReady
}));

describe('sessionRepository bootstrap recovery', () => {
  it('retries once when schema bootstrap loses the connection during a restart', async () => {
    jest.resetModules();
    jest.clearAllMocks();

    let connected = false;
    let schemaReady = false;
    let currentPool: object | null = null;
    const firstPool = {};
    const secondPool = {};
    let initializationCount = 0;
    mockGetPool.mockImplementation(() => currentPool);
    mockIsDatabaseConnected.mockImplementation(() => connected);
    mockIsDatabaseSchemaReady.mockImplementation(() => schemaReady);
    mockInitializeDatabase.mockImplementation(async () => {
      connected = true;
      currentPool = initializationCount === 0 ? firstPool : secondPool;
      initializationCount += 1;
      return true;
    });
    mockClosePoolIfCurrent.mockImplementation(async expectedPool => {
      if (currentPool !== expectedPool) {
        return false;
      }
      connected = false;
      schemaReady = false;
      currentPool = null;
      return true;
    });
    mockInitializeTables
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockImplementationOnce(async () => {
        schemaReady = true;
        return true;
      });
    mockQuery.mockResolvedValue({
      rows: [{
        id: '10046659-238d-4979-9820-e1580981ade1',
        label: 'ARCANOS backend diagnostics session',
        tag: 'session_diagnostic_retry',
        memory_type: 'diagnostic',
        payload: { probeValue: 'ARCANOS-PROBE-1' },
        transcript_summary: null,
        audit_trace_id: null,
        created_at: '2026-03-19T03:52:45.000Z',
        updated_at: '2026-03-19T03:52:45.000Z',
        latest_version_number: 1
      }]
    });

    const { getStoredSessionById } = await import('../src/core/db/repositories/sessionRepository.js');
    const result = await getStoredSessionById('10046659-238d-4979-9820-e1580981ade1');

    expect(mockInitializeDatabase).toHaveBeenCalledTimes(2);
    expect(mockInitializeTables).toHaveBeenCalledTimes(2);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledWith(firstPool);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      id: '10046659-238d-4979-9820-e1580981ade1',
      label: 'ARCANOS backend diagnostics session',
      tag: 'session_diagnostic_retry',
      memoryType: 'diagnostic',
      payload: { probeValue: 'ARCANOS-PROBE-1' },
      transcriptSummary: null,
      auditTraceId: null,
      createdAt: '2026-03-19T03:52:45.000Z',
      updatedAt: '2026-03-19T03:52:45.000Z',
      latestVersionNumber: 1
    });
  });

  it('does not close a replacement pool when schema initialization resolves false for the captured pool', async () => {
    jest.resetModules();
    jest.clearAllMocks();

    let connected = true;
    let schemaReady = false;
    const firstPool = {};
    const replacementPool = {};
    let currentPool: object | null = firstPool;
    mockGetPool.mockImplementation(() => currentPool);
    mockIsDatabaseConnected.mockImplementation(() => connected);
    mockIsDatabaseSchemaReady.mockImplementation(() => schemaReady);
    mockInitializeDatabase.mockResolvedValue(true);
    mockClosePoolIfCurrent.mockImplementation(async expectedPool => currentPool === expectedPool);
    mockInitializeTables
      .mockImplementationOnce(async () => {
        currentPool = replacementPool;
        return false;
      })
      .mockImplementationOnce(async () => {
        schemaReady = true;
        return true;
      });
    mockQuery.mockResolvedValue({
      rows: [{
        id: '10046659-238d-4979-9820-e1580981ade1',
        label: 'ARCANOS backend diagnostics session',
        tag: 'session_diagnostic_retry',
        memory_type: 'diagnostic',
        payload: { probeValue: 'ARCANOS-PROBE-1' },
        transcript_summary: null,
        audit_trace_id: null,
        created_at: '2026-03-19T03:52:45.000Z',
        updated_at: '2026-03-19T03:52:45.000Z',
        latest_version_number: 1
      }]
    });

    const { getStoredSessionById } = await import('../src/core/db/repositories/sessionRepository.js');
    const result = await getStoredSessionById('10046659-238d-4979-9820-e1580981ade1');

    expect(mockInitializeDatabase).not.toHaveBeenCalled();
    expect(mockInitializeTables).toHaveBeenCalledTimes(2);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledWith(firstPool);
    expect(currentPool).toBe(replacementPool);
    expect(result?.id).toBe('10046659-238d-4979-9820-e1580981ade1');
  });
});

async function loadSessionHarness() {
  jest.resetModules();
  jest.resetAllMocks();
  const state = { connected: true, schemaReady: false, pool: {} as object | null };
  mockGetPool.mockImplementation(() => state.pool);
  mockIsDatabaseConnected.mockImplementation(() => state.connected);
  mockIsDatabaseSchemaReady.mockImplementation(() => state.schemaReady);
  mockInitializeDatabase.mockImplementation(async () => {
    state.connected = true;
    state.pool = {};
    return true;
  });
  mockInitializeTables.mockImplementation(async () => {
    state.schemaReady = true;
    return true;
  });
  mockClosePoolIfCurrent.mockImplementation(async capturedPool => {
    if (state.pool !== capturedPool) {
      return false;
    }
    state.connected = false;
    state.schemaReady = false;
    state.pool = null;
    return true;
  });
  mockQuery.mockResolvedValue({ rows: [] });
  const repository = await import('../src/core/db/repositories/sessionRepository.js');
  return { state, repository, read: () => repository.getStoredSessionById('fixture-session') };
}

describe('sessionRepository readiness contracts', () => {
  it('does not bootstrap an already ready pool', async () => {
    const harness = await loadSessionHarness();
    harness.state.schemaReady = true;

    await harness.read();

    expect(mockInitializeDatabase).not.toHaveBeenCalled();
    expect(mockInitializeTables).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('exhausts only two false-schema attempts and preserves the write failure contract', async () => {
    const harness = await loadSessionHarness();
    mockInitializeTables.mockResolvedValue(false);

    await expect(harness.repository.createStoredSession({
      label: 'fixture session', memoryType: 'test', payload: {}
    })).rejects.toThrow('Persistent session storage is unavailable');
    await harness.read();

    expect(mockInitializeTables).toHaveBeenCalledTimes(2);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(2);
    expect(mockInitializeDatabase).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('does not retry non-transient schema exceptions and preserves its exact warning', async () => {
    const harness = await loadSessionHarness();
    const failure = new Error('permission denied for schema fixture');
    mockInitializeTables.mockRejectedValue(failure);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await harness.read();
      await harness.read();

      expect(mockInitializeTables).toHaveBeenCalledTimes(1);
      expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        '[Sessions] Failed to initialize persistent session storage:', failure.message
      );
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    ['57P01', 'database restart'],
    ['', 'server closed the connection unexpectedly'],
    ['', 'connection terminated unexpectedly']
  ])('retains transient retry for code %s and message %s', async (code, message) => {
    const harness = await loadSessionHarness();
    mockInitializeTables.mockRejectedValueOnce(Object.assign(new Error(message), { code }));

    await harness.read();

    expect(mockInitializeTables).toHaveBeenCalledTimes(2);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('cleans the captured pool after an exception without closing its replacement', async () => {
    const harness = await loadSessionHarness();
    const capturedPool = harness.state.pool;
    const replacementPool = {};
    mockInitializeTables.mockImplementationOnce(async () => {
      harness.state.pool = replacementPool;
      throw Object.assign(new Error('fixture restart'), { code: '57P01' });
    });

    await harness.read();

    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledWith(capturedPool);
    expect(harness.state.pool).toBe(replacementPool);
    expect(mockInitializeDatabase).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('coalesces callers while captured-pool cleanup and the bounded retry are in flight', async () => {
    const harness = await loadSessionHarness();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    mockInitializeTables.mockResolvedValueOnce(false);
    mockClosePoolIfCurrent.mockImplementationOnce(async () => {
      await cleanup;
      harness.state.connected = false;
      harness.state.schemaReady = false;
      harness.state.pool = null;
      return true;
    });

    const leader = harness.read();
    await Promise.resolve();
    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
    const follower = harness.read();
    expect(mockQuery).not.toHaveBeenCalled();
    releaseCleanup();
    await Promise.all([leader, follower]);

    expect(mockInitializeTables).toHaveBeenCalledTimes(2);
    expect(mockInitializeDatabase).toHaveBeenCalledTimes(1);
    expect(mockClosePoolIfCurrent).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('recovers from database initialization failure after cooldown without a stranded promise', async () => {
    const harness = await loadSessionHarness();
    let nowMs = 1_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    harness.state.connected = false;
    harness.state.pool = null;
    mockInitializeDatabase.mockResolvedValueOnce(false);
    try {
      await harness.read();
      await harness.read();
      expect(mockInitializeDatabase).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalled();

      nowMs += 30_000;
      await harness.read();

      expect(mockInitializeDatabase).toHaveBeenCalledTimes(2);
      expect(mockInitializeTables).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
});
