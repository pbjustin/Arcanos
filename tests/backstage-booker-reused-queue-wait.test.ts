import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_RESULT_POLL_WAIT_MS,
  resolveBackstageExecutionBudgetPolicy,
} from '../src/shared/backstage/backstageExecutionBudget.js';
import {
  DEFAULT_ASYNC_GPT_WAIT_POLL_MS,
  MAX_ASYNC_GPT_WAIT_POLLS,
  MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS,
  resolveAsyncGptPollIntervalMs,
  resolveAsyncGptWaitForResultMs,
} from '../src/services/queuedGptCompletionService.js';
import { resolveQueuedJobWaitPollLimit } from '../src/services/queuedJobCompletionPolling.js';

describe('Backstage Booker reused queue wait', () => {
  it('uses the existing maximum bounded hybrid wait before returning HTTP 202', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'queued_generation',
      action: 'generateBooking',
    });

    expect(BACKSTAGE_RESULT_POLL_WAIT_MS).toBe(30_000);
    expect(BACKSTAGE_RESULT_POLL_WAIT_MS).toBe(MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS);
    expect(resolveAsyncGptWaitForResultMs(BACKSTAGE_RESULT_POLL_WAIT_MS))
      .toBe(BACKSTAGE_RESULT_POLL_WAIT_MS);
    expect(policy.resultPollWaitMs).toBe(BACKSTAGE_RESULT_POLL_WAIT_MS);
    expect(policy.resultPollWaitMs).toBeLessThan(policy.operationTimeoutMs);
  });

  it('keeps continuity and bounded synchronous generation outside the queue wait', () => {
    expect(resolveBackstageExecutionBudgetPolicy({
      profile: 'continuity_sync',
    }).resultPollWaitMs).toBe(0);
    expect(resolveBackstageExecutionBudgetPolicy({
      profile: 'bounded_sync_generation',
      action: 'generateBooking',
    }).resultPollWaitMs).toBe(0);
  });

  it('keeps the 30-second polling window within the shared read bounds', () => {
    const emptyEnvironment = {} as NodeJS.ProcessEnv;
    const defaultPollIntervalMs = resolveAsyncGptPollIntervalMs(
      undefined,
      emptyEnvironment
    );
    const minimumPollIntervalMs = resolveAsyncGptPollIntervalMs(1, emptyEnvironment);

    expect(defaultPollIntervalMs).toBe(DEFAULT_ASYNC_GPT_WAIT_POLL_MS);
    expect(resolveQueuedJobWaitPollLimit(
      BACKSTAGE_RESULT_POLL_WAIT_MS,
      defaultPollIntervalMs,
      MAX_ASYNC_GPT_WAIT_POLLS
    )).toBe(121);
    expect(minimumPollIntervalMs).toBe(50);
    expect(resolveQueuedJobWaitPollLimit(
      BACKSTAGE_RESULT_POLL_WAIT_MS,
      minimumPollIntervalMs,
      MAX_ASYNC_GPT_WAIT_POLLS
    )).toBe(MAX_ASYNC_GPT_WAIT_POLLS);
  });
});
