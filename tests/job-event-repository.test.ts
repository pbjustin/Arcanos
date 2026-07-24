import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PoolClient } from 'pg';

const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const dbLoggerWarnMock = jest.fn();
const recordJobEventInsertFailureMock = jest.fn();
const loggerMock = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('@core/db/client.js', () => ({
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: loggerMock,
  apiLogger: loggerMock,
  dbLogger: {
    warn: dbLoggerWarnMock
  },
  aiLogger: loggerMock,
  workerLogger: loggerMock
}));

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordJobEventInsertFailure: recordJobEventInsertFailureMock
}));

const {
  cleanupJobEvents,
  listJobEventTimeline,
  recordJobEvent,
  recordJobEventWithClient
} = await import('../src/core/db/repositories/jobEventRepository.js');
const tokenLikeValue = ['secret', '-token'].join('');
const tokenField = ['to', 'ken'].join('');

describe('jobEventRepository.recordJobEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('returns a structured skip when the database is unavailable', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);

    await expect(recordJobEvent({
      jobId: '11111111-1111-4111-8111-111111111111',
      eventType: 'job.created'
    })).resolves.toEqual({ inserted: false, reason: 'database_unavailable' });

    expect(queryMock).not.toHaveBeenCalled();
    expect(recordJobEventInsertFailureMock).toHaveBeenCalledWith('database_unavailable');
  });

  it('redacts metadata and normalizes optional fields before insert', async () => {
    const secretLikeValue = ['sk', '-abcdefghijklmnopqrstuvwxyz'].join('');
    const bearerLikeValue = ['Bearer', ' abcdefghijklmnop'].join('');
    const assignmentLikeValue = ['to', 'ken=abcdefghijklmnop'].join('');
    const apiKeyField = ['api', 'Key'].join('');
    const authorizationField = ['authoriza', 'tion'].join('');
    await expect(recordJobEvent({
      jobId: '11111111-1111-4111-8111-111111111111',
      eventType: 'ai.request.failed',
      traceId: '   ',
      workerId: '   ',
      durationMs: -12.5,
      metadata: {
        [apiKeyField]: secretLikeValue,
        nested: {
          [authorizationField]: bearerLikeValue
        },
        values: [bearerLikeValue],
        diagnostic: assignmentLikeValue
      }
    })).resolves.toEqual({ inserted: true });

    const params = queryMock.mock.calls[0]?.[1] as unknown[];
    expect(queryMock.mock.calls[0]?.[2]).toBe(1);
    expect(params[1]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(0);

    const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
    expect(metadata[apiKeyField]).toBe('[REDACTED]');
    expect((metadata.nested as Record<string, unknown>)[authorizationField]).toBe('[REDACTED]');
    expect((metadata.values as unknown[])[0]).toBe('[REDACTED]');
    expect(metadata.diagnostic).toBe('[REDACTED]');
  });

  it('truncates fractional durations consistently', async () => {
    await recordJobEvent({
      jobId: '11111111-1111-4111-8111-111111111111',
      eventType: 'job.completed',
      durationMs: 42.9
    });

    const params = queryMock.mock.calls[0]?.[1] as unknown[];
    expect(params[4]).toBe(42);
  });

  it('handles serialization failure without throwing or inserting', async () => {
    await expect(recordJobEvent({
      jobId: '11111111-1111-4111-8111-111111111111',
      eventType: 'job.failed',
      metadata: {
        unsupported: 1n
      } as unknown as Record<string, unknown>
    })).resolves.toEqual({ inserted: false, reason: 'serialization_failed' });

    expect(queryMock).not.toHaveBeenCalled();
    expect(recordJobEventInsertFailureMock).toHaveBeenCalledWith('serialization_failed');
  });

  it('handles insert failure without logging raw credential-like error text', async () => {
    const bearerLikeValue = ['Bearer', ' abcdefghijklmnop'].join('');
    const assignmentLikeValue = ['to', 'ken=abcdefghijklmnop'].join('');
    queryMock.mockRejectedValueOnce(
      new Error(`provider failed with ${bearerLikeValue} and ${assignmentLikeValue}`)
    );

    await expect(recordJobEvent({
      jobId: '11111111-1111-4111-8111-111111111111',
      eventType: 'job.failed'
    })).resolves.toEqual({ inserted: false, reason: 'insert_failed' });

    const warningPayload = JSON.stringify(dbLoggerWarnMock.mock.calls);
    expect(warningPayload).not.toContain(bearerLikeValue);
    expect(warningPayload).not.toContain(assignmentLikeValue);
    expect(recordJobEventInsertFailureMock).toHaveBeenCalledWith('insert_failed');
  });
});

describe('jobEventRepository.recordJobEventWithClient', () => {
  const transactionQueryMock = jest.fn();
  const transactionClient = {
    query: transactionQueryMock
  } as unknown as PoolClient;

  beforeEach(() => {
    jest.clearAllMocks();
    transactionQueryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('inserts expiry evidence through the caller transaction', async () => {
    await expect(
      recordJobEventWithClient(transactionClient, {
        jobId: '11111111-1111-4111-8111-111111111111',
        eventType: 'job.expired',
        traceId: 'trace-expiry',
        metadata: {
          reason: 'job_expired_before_completion'
        }
      })
    ).resolves.toBeUndefined();

    expect(transactionQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO job_events'),
      expect.arrayContaining([
        '11111111-1111-4111-8111-111111111111',
        'trace-expiry',
        'job.expired'
      ])
    );
  });

  it('throws when the transaction cannot persist lifecycle evidence', async () => {
    transactionQueryMock.mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      recordJobEventWithClient(transactionClient, {
        jobId: '11111111-1111-4111-8111-111111111111',
        eventType: 'job.completed'
      })
    ).rejects.toMatchObject({
      code: 'JOB_EVENT_INSERT_FAILED'
    });
  });
});

describe('jobEventRepository.cleanupJobEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [
        { id: 'event-1' },
        { id: 'event-2' }
      ],
      rowCount: 2
    });
  });

  it('returns a structured skip when the database is unavailable', async () => {
    isDatabaseConnectedMock.mockReturnValue(false);

    await expect(cleanupJobEvents({
      dryRun: false,
      retentionDays: 14,
      batchSize: 25
    })).resolves.toEqual(expect.objectContaining({
      databaseAvailable: false,
      dryRun: false,
      retentionDays: 14,
      batchSize: 25,
      matchedRows: 0,
      deletedRows: 0,
      eventIds: []
    }));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('dry-runs old job event cleanup without deleting rows', async () => {
    const result = await cleanupJobEvents({
      dryRun: true,
      retentionDays: 7,
      batchSize: 50
    });

    expect(result).toEqual(expect.objectContaining({
      databaseAvailable: true,
      dryRun: true,
      retentionDays: 7,
      batchSize: 50,
      matchedRows: 2,
      deletedRows: 0,
      eventIds: ['event-1', 'event-2']
    }));
    expect(queryMock.mock.calls[0]?.[0]).toContain('SELECT id');
    expect(queryMock.mock.calls[0]?.[0]).toContain('WHERE occurred_at < NOW() - ($1::int * INTERVAL \'1 day\')');
    expect(queryMock.mock.calls[0]?.[0]).toContain('ORDER BY occurred_at ASC, id ASC');
    expect(queryMock.mock.calls[0]?.[0]).toContain('LIMIT $2');
    expect(queryMock.mock.calls[0]?.[0]).not.toContain('DELETE FROM job_events');
  });

  it('deletes old job events in a bounded batch', async () => {
    const result = await cleanupJobEvents({
      dryRun: false,
      retentionDays: 90,
      batchSize: 1_500
    });

    expect(result.deletedRows).toBe(2);
    expect(queryMock.mock.calls[0]?.[0]).toContain('LIMIT $2');
    expect(queryMock.mock.calls[0]?.[0]).toContain('DELETE FROM job_events');
    expect(queryMock.mock.calls[0]?.[1]).toEqual([90, 1_500]);
    expect(queryMock.mock.calls[0]?.[3]).toBe(false);
  });

  it('handles cleanup query failures without throwing', async () => {
    queryMock.mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(cleanupJobEvents()).resolves.toEqual(expect.objectContaining({
      databaseAvailable: true,
      matchedRows: 0,
      deletedRows: 0,
      eventIds: []
    }));
  });
});

describe('jobEventRepository.listJobEventTimeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 'event-1',
          job_id: 'job-1',
          trace_id: 'trace-1',
          event_type: 'job.queued',
          worker_id: null,
          occurred_at: new Date('2026-05-07T12:00:00.000Z'),
          duration_ms: null,
          metadata: {
            [tokenField]: tokenLikeValue
          }
        }
      ]
    });
  });

  it('queries timelines with bounded filters and redacted metadata', async () => {
    const result = await listJobEventTimeline({
      jobId: 'job-1',
      traceId: 'trace-1',
      workerId: 'worker-1',
      eventType: 'job.queued',
      occurredAfter: '2026-05-07T11:00:00.000Z',
      occurredBefore: '2026-05-07T13:00:00.000Z',
      limit: 5_000
    });

    expect(result).toEqual({
      available: true,
      events: [
        expect.objectContaining({
          id: 'event-1',
          jobId: 'job-1',
          traceId: 'trace-1',
          eventType: 'job.queued',
          occurredAt: '2026-05-07T12:00:00.000Z',
          metadata: {
            [tokenField]: '[REDACTED]'
          }
        })
      ]
    });
    expect(queryMock.mock.calls[0]?.[0]).toContain('ORDER BY occurred_at ASC, id ASC');
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      'job-1',
      'trace-1',
      'worker-1',
      'job.queued',
      '2026-05-07T11:00:00.000Z',
      '2026-05-07T13:00:00.000Z',
      1_000
    ]);
  });

  it('returns table_unavailable for missing job_events table', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }));

    await expect(listJobEventTimeline()).resolves.toEqual({
      available: false,
      reason: 'table_unavailable',
      events: []
    });
  });
});
