import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const queryMock = jest.fn();
const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();
const recordJobEventMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: queryMock
}));

jest.unstable_mockModule('../src/core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: recordJobEventMock
}));

const {
  createJob,
  findOrCreateGptJob
} = await import('../src/core/db/repositories/jobRepository.js');

function returnedJob(status: string, claimGeneration: string, jobType = 'gpt') {
  return {
    id: `job-${status}`,
    worker_id: 'queue',
    job_type: jobType,
    status,
    claim_generation: claimGeneration,
    input: {},
    created_at: new Date(),
    updated_at: new Date()
  };
}

describe('jobRepository initial claim generations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: clientReleaseMock
      })
    });
  });

  it.each([
    ['pending', '0'],
    ['running', '1']
  ])('creates %s jobs with generation %s', async (status, generation) => {
    queryMock.mockImplementation(async (_sql: unknown, params: unknown[]) => ({
      rows: [returnedJob(status, String(params[23]))]
    }));

    await expect(createJob('queue', 'gpt', {}, {
      status
    })).resolves.toEqual(expect.objectContaining({
      status,
      claim_generation: generation
    }));

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('claim_generation');
    expect(sql).toContain('$24::bigint');
    expect(params[23]).toBe(generation);
  });

  it('uses an explicit deadline before a database-clock non-GPT fallback', async () => {
    const explicitDeadline = '2099-01-01T00:00:00.000Z';
    queryMock.mockImplementation(async (_sql: unknown, params: unknown[]) => ({
      rows: [returnedJob('completed', String(params[23]), 'ask')]
    }));

    await createJob('queue', 'ask', {}, {
      status: 'completed',
      retentionUntil: explicitDeadline
    });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "$20::timestamptz,\n         CASE\n           WHEN $25::bigint > 0"
    );
    expect(sql).toContain(
      "THEN NOW() + ($25::bigint * INTERVAL '1 millisecond')"
    );
    expect(params).toHaveLength(25);
    expect(params[19]).toBe(explicitDeadline);
    expect(params[24]).toBe(24 * 60 * 60 * 1_000);
  });

  it('leaves GPT creation on its canonical absolute lifecycle deadlines', async () => {
    queryMock.mockImplementation(async (_sql: unknown, params: unknown[]) => ({
      rows: [returnedJob('completed', String(params[23]))]
    }));

    await createJob('queue', 'gpt', {}, { status: 'completed' });

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[18]).toEqual(expect.any(String));
    expect(params[19]).toEqual(expect.any(String));
    expect(params[24]).toBe(0);
  });

  it('starts a direct running GPT creation at generation one', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO job_data')) {
        return {
          rows: [returnedJob('running', String(params?.[22]))]
        };
      }

      return { rows: [] };
    });

    const result = await findOrCreateGptJob({
      workerId: 'api',
      input: { gptId: 'arcanos-core', body: { prompt: 'test' } },
      requestFingerprintHash: 'a'.repeat(64),
      idempotencyScopeHash: 'b'.repeat(64),
      idempotencyOrigin: 'derived',
      createOptions: {
        status: 'running',
        lastWorkerId: 'api:priority-gpt-direct',
        leaseExpiresAt: new Date(Date.now() + 30_000)
      }
    });

    expect(result).toMatchObject({
      created: true,
      job: {
        status: 'running',
        claim_generation: '1'
      }
    });
    const insertCall = clientQueryMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO job_data')
    ) as [string, unknown[]] | undefined;
    expect(insertCall?.[0]).toContain('$23::bigint');
    expect(insertCall?.[1]?.[22]).toBe('1');
  });
});
