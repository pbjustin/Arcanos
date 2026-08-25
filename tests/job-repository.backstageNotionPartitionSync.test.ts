import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const isDatabaseConnectedMock = jest.fn();
const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();
const recordJobEventWithClientMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock,
  isDatabaseConnected: isDatabaseConnectedMock,
}));

jest.unstable_mockModule('@core/db/query.js', () => ({
  query: jest.fn(),
}));

jest.unstable_mockModule('../src/core/db/repositories/jobEventRepository.js', () => ({
  recordJobEvent: jest.fn(),
  recordJobEventWithClient: recordJobEventWithClientMock,
}));

const {
  BackstageNotionPartitionSyncInProgressError,
  BackstageNotionPartitionSyncQueueSaturatedError,
  IdempotencyKeyConflictError,
  findOrCreateBackstageNotionPartitionSyncJob,
} = await import('../src/core/db/repositories/jobRepository.js');

const INPUT = Object.freeze({
  protocol: 'backstage-notion-partition-sync-job-v1',
  version: 1,
  universeId: 'my-universe-2k26',
  shardKey: 'current',
  configurationGeneration: 'generation-1',
  configurationDigest: 'd'.repeat(64),
});

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    worker_id: 'backstage-notion-partition-sync',
    job_type: 'backstage-notion-partition-sync',
    status: 'pending',
    claim_generation: '0',
    input: INPUT,
    request_fingerprint_hash: 'f'.repeat(64),
    idempotency_key_hash: 'b'.repeat(64),
    idempotency_scope_hash: 'a'.repeat(64),
    correlation_id: 'trace-1',
    created_at: new Date('2026-08-24T12:00:00.000Z'),
    updated_at: new Date('2026-08-24T12:00:00.000Z'),
    ...overrides,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    workerId: 'backstage-notion-partition-sync',
    input: INPUT,
    universeId: INPUT.universeId,
    shardKey: INPUT.shardKey,
    requestFingerprintHash: 'f'.repeat(64),
    idempotencyScopeHash: 'a'.repeat(64),
    idempotencyKeyHash: 'b'.repeat(64),
    idempotencyUntil: new Date(Date.now() + 60 * 60 * 1_000),
    correlationId: 'trace-1',
    ...overrides,
  };
}

describe('partition synchronization queue admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isDatabaseConnectedMock.mockReturnValue(true);
    getPoolMock.mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: clientQueryMock,
        release: clientReleaseMock,
      }),
    });
  });

  it.each([
    ['an open input envelope', {
      input: { ...INPUT, unexpected: true },
    }],
    ['a mismatched universe identity', {
      universeId: 'other-universe',
    }],
    ['a mismatched shard identity', {
      shardKey: 'archive/current',
    }],
    ['a malformed request fingerprint', {
      requestFingerprintHash: 'F'.repeat(64),
    }],
    ['a malformed actor scope hash', {
      idempotencyScopeHash: 'z'.repeat(64),
    }],
    ['a malformed idempotency key hash', {
      idempotencyKeyHash: 'short',
    }],
    ['an invalid idempotency deadline', {
      idempotencyUntil: new Date(Number.NaN),
    }],
    ['a past idempotency deadline', {
      idempotencyUntil: new Date(Date.now() - 1_000),
    }],
    ['an excessively distant idempotency deadline', {
      idempotencyUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000 + 60_000),
    }],
  ])('rejects %s before any database access', async (_label, overrides) => {
    await expect(
      findOrCreateBackstageNotionPartitionSyncJob(options(overrides))
    ).rejects.toBeInstanceOf(TypeError);

    expect(isDatabaseConnectedMock).not.toHaveBeenCalled();
    expect(getPoolMock).not.toHaveBeenCalled();
    expect(clientQueryMock).not.toHaveBeenCalled();
    expect(recordJobEventWithClientMock).not.toHaveBeenCalled();
  });

  it('atomically inserts one bounded job and its lifecycle events', async () => {
    const created = job();
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('COUNT(*)::int AS active_count')) {
        return { rows: [{ active_count: 0 }] };
      }
      if (text.includes('INSERT INTO job_data')) {
        return { rows: [created] };
      }
      return { rows: [] };
    });

    await expect(
      findOrCreateBackstageNotionPartitionSyncJob(options())
    ).resolves.toEqual({
      job: created,
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });

    const insertCall = clientQueryMock.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO job_data')
    ) as [string, unknown[]] | undefined;
    expect(insertCall?.[0]).toContain("'pending'");
    expect(insertCall?.[0]).toContain('0,\n         1,');
    expect(insertCall?.[0]).toContain('100');
    expect(insertCall?.[1]?.[2]).toBe(JSON.stringify(INPUT));
    expect(insertCall?.[1]).not.toContain('raw-idempotency-key');
    expect(recordJobEventWithClientMock).toHaveBeenCalledTimes(2);
    expect(recordJobEventWithClientMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        eventType: 'job.created',
        metadata: expect.objectContaining({
          universeId: INPUT.universeId,
          shardKey: INPUT.shardKey,
        }),
      })
    );
    expect(recordJobEventWithClientMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ eventType: 'job.queued' })
    );
    const commitCall = clientQueryMock.mock.calls.findIndex(
      ([sql]) => sql === 'COMMIT'
    );
    expect(commitCall).toBeGreaterThan(-1);
    expect(recordJobEventWithClientMock.mock.invocationCallOrder[1])
      .toBeLessThan(clientQueryMock.mock.invocationCallOrder[commitCall]!);
    expect(clientReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('replays the exact key before target and capacity checks', async () => {
    const existing = job();
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('idempotency_key_hash = $3')) {
        return { rows: [existing] };
      }
      return { rows: [] };
    });

    await expect(
      findOrCreateBackstageNotionPartitionSyncJob(options())
    ).resolves.toEqual({
      job: existing,
      created: false,
      deduped: true,
      dedupeReason: 'reused_explicit_key',
    });

    expect(clientQueryMock.mock.calls.some(
      ([sql]) => String(sql).includes('COUNT(*)::int AS active_count')
    )).toBe(false);
    expect(clientQueryMock.mock.calls.some(
      ([sql]) => String(sql).includes('INSERT INTO job_data')
    )).toBe(false);
  });

  it('conflicts when the same key is reused for another fingerprint', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes('idempotency_key_hash = $3')
        ? [job({ request_fingerprint_hash: 'x'.repeat(64) })]
        : [],
    }));

    await expect(
      findOrCreateBackstageNotionPartitionSyncJob(options())
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(recordJobEventWithClientMock).not.toHaveBeenCalled();
  });

  it('rejects an active duplicate target without consuming capacity', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("input ->> 'universeId'")
        ? [{ id: 'active-sync' }]
        : [],
    }));

    await expect(
      findOrCreateBackstageNotionPartitionSyncJob(options())
    ).rejects.toBeInstanceOf(BackstageNotionPartitionSyncInProgressError);
    expect(clientQueryMock.mock.calls.some(
      ([sql]) => String(sql).includes('COUNT(*)::int AS active_count')
    )).toBe(false);
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });

  it('serializes the global capacity check and inserts nothing when full', async () => {
    clientQueryMock.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes('COUNT(*)::int AS active_count')
        ? [{ active_count: 16 }]
        : [],
    }));

    await expect(
      findOrCreateBackstageNotionPartitionSyncJob(options())
    ).rejects.toBeInstanceOf(BackstageNotionPartitionSyncQueueSaturatedError);
    expect(clientQueryMock.mock.calls.some(
      ([sql]) => String(sql).includes('INSERT INTO job_data')
    )).toBe(false);
    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
  });
});
