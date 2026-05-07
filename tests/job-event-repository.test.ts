import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const dbLoggerWarnMock = jest.fn();
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

const { recordJobEvent } = await import('../src/core/db/repositories/jobEventRepository.js');

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
    expect(queryMock.mock.calls[0]?.[2]).toBe(3);
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
  });
});
