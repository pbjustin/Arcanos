import { describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import {
  resolveAsyncGptPollIntervalMs,
  resolveAsyncGptWaitForResultMs,
  waitForQueuedGptJobCompletion
} from '../src/services/queuedGptCompletionService.js';

function createQueuedGptJob(partial: Partial<JobData>): JobData {
  return {
    id: partial.id ?? 'job-123',
    worker_id: partial.worker_id ?? 'api',
    job_type: partial.job_type ?? 'gpt',
    status: partial.status ?? 'pending',
    input: partial.input ?? {},
    output: partial.output ?? null,
    error_message: partial.error_message ?? null,
    retry_count: partial.retry_count ?? 0,
    max_retries: partial.max_retries ?? 2,
    next_run_at: partial.next_run_at ?? new Date().toISOString(),
    started_at: partial.started_at ?? null,
    completed_at: partial.completed_at ?? null,
    last_heartbeat_at: partial.last_heartbeat_at ?? null,
    lease_expires_at: partial.lease_expires_at ?? null,
    priority: partial.priority ?? 100,
    last_worker_id: partial.last_worker_id ?? null,
    autonomy_state: partial.autonomy_state ?? {},
    created_at: partial.created_at ?? new Date().toISOString(),
    updated_at: partial.updated_at ?? new Date().toISOString(),
    cancel_requested_at: partial.cancel_requested_at ?? null,
    cancel_reason: partial.cancel_reason ?? null,
    retention_until: partial.retention_until ?? null,
    idempotency_until: partial.idempotency_until ?? null,
    expires_at: partial.expires_at ?? null
  } as JobData;
}

describe('queuedGptCompletionService', () => {
  it('clamps wait durations and preserves explicit zero', () => {
    expect(resolveAsyncGptWaitForResultMs(0)).toBe(0);
    expect(resolveAsyncGptWaitForResultMs(45_000)).toBe(15_000);
    expect(
      resolveAsyncGptWaitForResultMs(undefined, {
        GPT_ASYNC_WAIT_FOR_RESULT_MS: '12000'
      } as NodeJS.ProcessEnv)
    ).toBe(12_000);
  });

  it('clamps poll intervals into a safe range', () => {
    expect(resolveAsyncGptPollIntervalMs(1)).toBe(50);
    expect(resolveAsyncGptPollIntervalMs(5_000)).toBe(1_000);
  });

  it('returns cancelled when the queued GPT job is cancelled during the wait window', async () => {
    const getJobByIdFn = jest
      .fn<() => Promise<JobData | null>>()
      .mockResolvedValue(createQueuedGptJob({
        status: 'cancelled',
        error_message: 'Job cancellation requested by client.'
      }));

    const completion = await waitForQueuedGptJobCompletion(
      'job-123',
      {
        waitForResultMs: 5_000
      },
      {
        getJobByIdFn,
        sleepFn: async () => undefined,
        nowFn: () => 0
      }
    );

    expect(completion.state).toBe('cancelled');
  });

  it('returns expired when the queued GPT job has been expired by retention maintenance', async () => {
    const getJobByIdFn = jest
      .fn<() => Promise<JobData | null>>()
      .mockResolvedValue(createQueuedGptJob({
        status: 'expired',
        error_message: 'Async GPT job expired after its retention window.'
      }));

    const completion = await waitForQueuedGptJobCompletion(
      'job-123',
      {
        waitForResultMs: 5_000
      },
      {
        getJobByIdFn,
        sleepFn: async () => undefined,
        nowFn: () => 0
      }
    );

    expect(completion.state).toBe('expired');
  });
});
