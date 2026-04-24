import { describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import {
  createPostgresQueueSchedulerAdapter,
  toJobSchedulingMetadata,
  toLeaseState,
  toRetryState
} from '../src/core/scheduler/postgresAdapter.js';

function buildJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-1',
    worker_id: 'worker-origin',
    job_type: 'gpt',
    status: 'running',
    input: {
      gptId: 'arcanos-build'
    },
    retry_count: 0,
    max_retries: 1,
    next_run_at: new Date('2026-04-24T10:01:00.000Z'),
    started_at: new Date('2026-04-24T10:00:00.000Z'),
    last_heartbeat_at: new Date('2026-04-24T10:00:02.000Z'),
    lease_expires_at: new Date('2026-04-24T10:00:30.000Z'),
    priority: 0,
    last_worker_id: 'worker-1',
    created_at: new Date('2026-04-24T09:59:00.000Z'),
    updated_at: new Date('2026-04-24T10:00:00.000Z'),
    ...overrides
  };
}

describe('PostgresQueueSchedulerAdapter', () => {
  it('delegates claims to the existing repository and reports scheduler lane metadata', async () => {
    const job = buildJob();
    const claimNextPendingJob = jest.fn(async () => job);
    const adapter = createPostgresQueueSchedulerAdapter({
      claimNextPendingJob,
      getJobQueueSummary: jest.fn(async () => null)
    });

    const result = await adapter.claimNext({
      workerId: 'worker-1',
      leaseMs: 15_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 5,
      priorityLaneMaxPriority: 3
    });

    expect(claimNextPendingJob).toHaveBeenCalledWith({
      workerId: 'worker-1',
      leaseMs: 15_000,
      priorityQueueEnabled: true,
      priorityQueueWeight: 5,
      priorityLaneMaxPriority: 3
    });
    expect(result).toEqual({
      adapter: 'postgres',
      lane: 'priority',
      job
    });
  });

  it('maps JobData into the formal scheduler contract', () => {
    const job = buildJob({
      retry_count: 1,
      error_message: 'provider timeout'
    });

    expect(toJobSchedulingMetadata(job)).toEqual({
      jobId: 'job-1',
      gptId: 'arcanos-build',
      priority: 0,
      lane: 'priority',
      createdAt: new Date('2026-04-24T09:59:00.000Z'),
      attempts: 1,
      maxRetries: 1
    });
    expect(toLeaseState(job)).toEqual({
      workerId: 'worker-1',
      leaseExpiresAt: new Date('2026-04-24T10:00:30.000Z')
    });
    expect(toRetryState(job)).toEqual({
      attempts: 1,
      lastError: 'provider timeout',
      nextRetryAt: new Date('2026-04-24T10:01:00.000Z')
    });
  });
});
