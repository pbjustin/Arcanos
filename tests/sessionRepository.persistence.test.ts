import { describe, expect, it, jest } from '@jest/globals';

const mockInitializeDatabase = jest.fn<() => Promise<boolean>>();
const mockIsDatabaseConnected = jest.fn<() => boolean>();
const mockCloseDatabase = jest.fn<() => Promise<void>>();
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockInitializeTables = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('@core/db/client.js', () => ({
  close: mockCloseDatabase,
  initializeDatabase: mockInitializeDatabase,
  isDatabaseConnected: mockIsDatabaseConnected
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: mockQuery,
  transaction: mockTransaction
}));

jest.unstable_mockModule('@core/db/schema.js', () => ({
  initializeTables: mockInitializeTables
}));

describe('sessionRepository bootstrap recovery', () => {
  it('retries once when schema bootstrap loses the connection during a restart', async () => {
    jest.resetModules();
    jest.clearAllMocks();

    let connected = false;
    mockIsDatabaseConnected.mockImplementation(() => connected);
    mockInitializeDatabase.mockImplementation(async () => {
      connected = true;
      return true;
    });
    mockCloseDatabase.mockImplementation(async () => {
      connected = false;
    });
    mockInitializeTables
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(undefined);
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
    expect(mockCloseDatabase).toHaveBeenCalledTimes(1);
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
});
