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
