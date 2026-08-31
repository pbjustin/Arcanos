import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getPoolMock = jest.fn();
const clientQueryMock = jest.fn();
const clientReleaseMock = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: getPoolMock
}));

const {
  getWorkerBudgetWindowUsage,
  reserveWorkerAiProviderAttempt
} = await import('../src/core/db/repositories/workerBudgetRepository.js');

describe('worker budget PostgreSQL transaction bounds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql !== 'string') {
        return { rows: [] };
      }
      if (sql.includes('SELECT COALESCE')) {
        return { rows: [{ evaluated_at: new Date('2026-08-30T18:00:00.000Z') }] };
      }
      if (sql.includes('COUNT(*)::int AS used_count')) {
        return { rows: [{ used_count: 0, recovery_reservation_at: null }] };
      }
      if (sql.includes('WHERE id = $1::uuid')) {
        return { rows: [] };
      }
      if (sql.includes('ARRAY_AGG(event.occurred_at')) {
        return {
          rows: [{
            evaluated_at: new Date('2026-08-30T18:00:00.000Z'),
            job_claim_count: 0,
            ai_provider_attempt_count: 0,
            job_claim_times: null,
            ai_provider_attempt_times: null
          }]
        };
      }
      return { rows: [] };
    });
    getPoolMock.mockReturnValue({
      connect: jest.fn(async () => ({
        query: clientQueryMock,
        release: clientReleaseMock
      }))
    });
  });

  it('installs parameterized local bounds immediately after BEGIN and before provider locking', async () => {
    await reserveWorkerAiProviderAttempt({
      statsWorkerId: 'async-queue',
      workerId: 'async-queue-slot-1',
      limit: 2,
      jobId: randomUUID(),
      operation: '/v1/responses',
      reservationId: randomUUID()
    });

    const calls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    const beginIndex = calls.findIndex(sql => sql === 'BEGIN ISOLATION LEVEL READ COMMITTED');
    const boundsIndex = calls.findIndex(sql => sql.includes("set_config('lock_timeout'"));
    const lockIndex = calls.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
    const commitIndex = calls.findIndex(sql => sql === 'COMMIT');
    expect(boundsIndex).toBeGreaterThan(beginIndex);
    expect(lockIndex).toBeGreaterThan(boundsIndex);
    expect(commitIndex).toBeGreaterThan(lockIndex);
    expect(clientQueryMock.mock.calls[boundsIndex]?.[1]).toEqual([1_000, 5_000, 10_000]);
    expect(clientReleaseMock).toHaveBeenCalledWith(undefined);
  });

  it('bounds the readiness usage query in its own read-committed transaction', async () => {
    await expect(getWorkerBudgetWindowUsage('async-queue', {
      jobLimit: 2,
      aiLimit: 3
    })).resolves.toEqual({
      statsWorkerId: 'async-queue',
      evaluatedAt: '2026-08-30T18:00:00.000Z',
      jobClaims: 0,
      aiProviderAttempts: 0,
      nextJobClaimAvailableAt: null,
      nextAiProviderAttemptAvailableAt: null
    });

    const calls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    const beginIndex = calls.findIndex(sql => sql === 'BEGIN ISOLATION LEVEL READ COMMITTED');
    const boundsIndex = calls.findIndex(sql => sql.includes("set_config('statement_timeout'"));
    const usageIndex = calls.findIndex(sql => sql.includes('ARRAY_AGG(event.occurred_at'));
    const commitIndex = calls.findIndex(sql => sql === 'COMMIT');
    expect(boundsIndex).toBeGreaterThan(beginIndex);
    expect(usageIndex).toBeGreaterThan(boundsIndex);
    expect(commitIndex).toBeGreaterThan(usageIndex);
    expect(clientQueryMock.mock.calls[boundsIndex]?.[1]).toEqual([1_000, 5_000, 10_000]);
    expect(clientReleaseMock).toHaveBeenCalledWith(undefined);
  });

  it('rolls back and propagates a bounded server error without recording evidence', async () => {
    const lockTimeout = Object.assign(
      new Error('canceling statement due to lock timeout'),
      { code: '55P03' }
    );
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
        throw lockTimeout;
      }
      return { rows: [] };
    });

    await expect(reserveWorkerAiProviderAttempt({
      statsWorkerId: 'async-queue',
      workerId: 'async-queue-slot-1',
      limit: 2,
      jobId: randomUUID()
    })).rejects.toBe(lockTimeout);

    expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO job_events')
    )).toBe(false);
    expect(clientReleaseMock).toHaveBeenCalledWith(undefined);
  });

  it('discards a client whose rollback fails while preserving the bounded owner error', async () => {
    const lockTimeout = Object.assign(
      new Error('canceling statement due to lock timeout'),
      { code: '55P03' }
    );
    const rollbackError = new Error('connection closed before rollback');
    clientQueryMock.mockImplementation(async (sql: unknown) => {
      if (sql === 'ROLLBACK') {
        throw rollbackError;
      }
      if (typeof sql === 'string' && sql.includes('pg_advisory_xact_lock')) {
        throw lockTimeout;
      }
      return { rows: [] };
    });

    await expect(reserveWorkerAiProviderAttempt({
      statsWorkerId: 'async-queue',
      workerId: 'async-queue-slot-1',
      limit: 2,
      jobId: randomUUID()
    })).rejects.toBe(lockTimeout);

    expect(clientReleaseMock).toHaveBeenCalledWith(rollbackError);
  });
});
