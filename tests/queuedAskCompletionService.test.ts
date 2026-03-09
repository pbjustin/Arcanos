import { describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import {
  resolveAsyncAskPollIntervalMs,
  resolveAsyncAskWaitForResultMs,
  waitForQueuedAskJobCompletion
} from '../src/services/queuedAskCompletionService.js';

function createQueuedAskJob(partial: Partial<JobData>): JobData {
  return {
    id: partial.id ?? 'job-123',
    worker_id: partial.worker_id ?? 'api',
    job_type: partial.job_type ?? 'ask',
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
    created_at: partial.created_at ?? new Date().toISOString(),
    updated_at: partial.updated_at ?? new Date().toISOString(),
    priority: partial.priority ?? 100,
    last_worker_id: partial.last_worker_id ?? null,
    autonomy_state: partial.autonomy_state ?? {}
  } as JobData;
}

describe('queuedAskCompletionService', () => {
  it('clamps wait durations and preserves explicit zero', () => {
    expect(resolveAsyncAskWaitForResultMs(0)).toBe(0);
    expect(resolveAsyncAskWaitForResultMs(45_000)).toBe(30_000);
    expect(
      resolveAsyncAskWaitForResultMs(undefined, {
        ASK_ASYNC_WAIT_FOR_RESULT_MS: '12000'
      } as NodeJS.ProcessEnv)
    ).toBe(12_000);
  });

  it('clamps poll intervals into a safe range', () => {
    expect(resolveAsyncAskPollIntervalMs(1)).toBe(50);
    expect(resolveAsyncAskPollIntervalMs(5_000)).toBe(1_000);
  });

  it('returns completed when the queued job reaches a terminal success state', async () => {
    const getJobByIdFn = jest
      .fn<() => Promise<JobData | null>>()
      .mockResolvedValue(createQueuedAskJob({
        status: 'completed',
        output: {
          result: 'done'
        }
      }));

    const completion = await waitForQueuedAskJobCompletion(
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

    expect(completion.state).toBe('completed');
    expect(getJobByIdFn).toHaveBeenCalledWith('job-123');
  });

  it('returns pending after the bounded wait window expires', async () => {
    let nowMs = 0;
    const getJobByIdFn = jest
      .fn<() => Promise<JobData | null>>()
      .mockResolvedValue(createQueuedAskJob({
        status: 'running'
      }));

    const completion = await waitForQueuedAskJobCompletion(
      'job-123',
      {
        waitForResultMs: 300,
        pollIntervalMs: 100
      },
      {
        getJobByIdFn,
        sleepFn: async (sleepMs: number) => {
          nowMs += sleepMs;
        },
        nowFn: () => nowMs
      }
    );

    expect(completion.state).toBe('pending');
    expect(getJobByIdFn).toHaveBeenCalled();
  });
});
