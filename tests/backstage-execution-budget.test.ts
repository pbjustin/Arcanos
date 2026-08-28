import { describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_DEFAULT_MS,
  BACKSTAGE_CONTINUITY_OPERATION_TIMEOUT_MS,
  BACKSTAGE_RESULT_POLL_WAIT_MS,
  BACKSTAGE_WORKER_ABORT_DRAIN_TIMEOUT_MS,
  BACKSTAGE_WORKER_JOB_TIMEOUT_MAX_MS,
  BACKSTAGE_WORKER_JOB_TIMEOUT_MIN_MS,
  hasBackstageRecoveryBudget,
  resolveBackstageProviderDeferralDelayMs,
  resolveBackstageExecutionBudgetPolicy,
  resolveBackstageWorkerOperationDeadlineAt,
} from '../src/shared/backstage/backstageExecutionBudget.js';
import {
  isCooperativeDeadlineExceededError,
  runWithCooperativeAbortDrain,
} from '../src/shared/async/cooperativeAbortDrain.js';
import {
  JOB_LEASE_MAXIMUM_MS,
  JOB_LEASE_MINIMUM_MS,
  normalizeJobLeaseMs,
  resolveJobLeaseHeartbeatIntervalMs,
} from '../src/shared/jobs/jobLeaseTiming.js';

describe('Backstage execution timeout budget', () => {
  it('keeps every heavy HRC stage inside one finite worker deadline', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'queued_generation',
      action: 'generateBookingWithHRC',
    });

    expect(policy.totalTimeoutMs).toBe(180_000);
    expect(policy.operationTimeoutMs + policy.finalizationReserveMs)
      .toBe(policy.totalTimeoutMs);
    expect(
      policy.modelStageTimeoutMs
      + policy.recoveryStageTimeoutMs
      + policy.hrcStageReserveMs
      + policy.orchestrationReserveMs
    ).toBeLessThanOrEqual(policy.operationTimeoutMs);
    expect(policy.maxRecoveryAttempts).toBe(1);
    expect(policy.abortDrainTimeoutMs)
      .toBe(BACKSTAGE_WORKER_ABORT_DRAIN_TIMEOUT_MS);
    expect(policy.abortDrainTimeoutMs).toBeLessThan(policy.finalizationReserveMs);
    expect(policy.resultPollWaitMs).toBe(BACKSTAGE_RESULT_POLL_WAIT_MS);
    expect(Object.values(policy).every(value => (
      typeof value !== 'number' || Number.isFinite(value)
    ))).toBe(true);
  });

  it('cannot recreate a forty-second primary plus repair inside a sixty-second synchronous HRC cap', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'bounded_sync_generation',
      action: 'generateBookingWithHRC',
      configuration: { generationStageTimeoutMs: 40_000 },
    });

    expect(policy.modelStageTimeoutMs).toBe(30_000);
    expect(
      policy.modelStageTimeoutMs
      + policy.recoveryStageTimeoutMs
      + policy.hrcStageReserveMs
      + policy.finalizationReserveMs
    ).toBeLessThanOrEqual(policy.totalTimeoutMs);
    expect(policy.totalTimeoutMs).toBeLessThan(60_000);
  });

  it('retains a bounded low-latency continuity profile', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'continuity_sync',
    });

    expect(policy.action).toBe('queryContinuity');
    expect(policy.modelStageTimeoutMs)
      .toBe(BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_DEFAULT_MS);
    expect(policy.totalTimeoutMs).toBe(BACKSTAGE_CONTINUITY_OPERATION_TIMEOUT_MS);
    expect(policy.totalTimeoutMs).toBeLessThan(60_000);
    expect(policy.resultPollWaitMs).toBe(0);
  });

  it.each([
    ['below minimum', 1, BACKSTAGE_WORKER_JOB_TIMEOUT_MIN_MS],
    ['at minimum', BACKSTAGE_WORKER_JOB_TIMEOUT_MIN_MS, BACKSTAGE_WORKER_JOB_TIMEOUT_MIN_MS],
    ['at maximum', BACKSTAGE_WORKER_JOB_TIMEOUT_MAX_MS, BACKSTAGE_WORKER_JOB_TIMEOUT_MAX_MS],
    ['above maximum', 999_999, BACKSTAGE_WORKER_JOB_TIMEOUT_MAX_MS],
  ] as const)('clamps worker deadline %s deterministically', (_label, configured, expected) => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'queued_generation',
      action: 'generateBookingWithHRC',
      configuration: { workerJobTimeoutMs: configured },
    });

    expect(policy.totalTimeoutMs).toBe(expected);
    expect(policy.operationTimeoutMs).toBeLessThan(policy.totalTimeoutMs);
    expect(
      policy.modelStageTimeoutMs
      + policy.recoveryStageTimeoutMs
      + policy.hrcStageReserveMs
      + policy.orchestrationReserveMs
    ).toBeLessThanOrEqual(policy.operationTimeoutMs);
  });

  it('reserves enough time and tokens before allowing one recovery', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'queued_generation',
      action: 'generateBookingWithHRC',
    });
    const allowed = {
      policy,
      runtimeRemainingMs:
        policy.recoveryStageTimeoutMs + policy.hrcStageReserveMs,
      requestRemainingMs:
        policy.recoveryStageTimeoutMs
          + policy.hrcStageReserveMs,
      recoveryOutputTokenLimit: policy.recoveryOutputTokenReserve,
      recoveryAttempted: false,
    };

    expect(hasBackstageRecoveryBudget(allowed)).toBe(true);
    expect(hasBackstageRecoveryBudget({
      ...allowed,
      runtimeRemainingMs:
        policy.recoveryStageTimeoutMs + policy.hrcStageReserveMs - 1,
    })).toBe(false);
    expect(hasBackstageRecoveryBudget({
      ...allowed,
      requestRemainingMs:
        policy.recoveryStageTimeoutMs
          + policy.hrcStageReserveMs
          - 1,
    })).toBe(false);
    expect(hasBackstageRecoveryBudget({
      ...allowed,
      recoveryOutputTokenLimit: policy.recoveryOutputTokenReserve - 1,
    })).toBe(false);
    expect(hasBackstageRecoveryBudget({
      ...allowed,
      recoveryAttempted: true,
    })).toBe(false);
  });

  it('keeps synchronous finalization inside its request-level recovery gate', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'bounded_sync_generation',
      action: 'generateBooking',
    });
    const minimumRequestReserveMs =
      policy.recoveryStageTimeoutMs + policy.finalizationReserveMs;

    expect(hasBackstageRecoveryBudget({
      policy,
      runtimeRemainingMs: policy.recoveryStageTimeoutMs,
      requestRemainingMs: minimumRequestReserveMs,
      recoveryOutputTokenLimit: policy.recoveryOutputTokenReserve,
      recoveryAttempted: false,
    })).toBe(true);
    expect(hasBackstageRecoveryBudget({
      policy,
      runtimeRemainingMs: policy.recoveryStageTimeoutMs,
      requestRemainingMs: minimumRequestReserveMs - 1,
      recoveryOutputTokenLimit: policy.recoveryOutputTokenReserve,
      recoveryAttempted: false,
    })).toBe(false);
  });

  it('anchors the operation deadline to persisted first-start time across reclaims', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'queued_generation',
    });
    const startedAtMs = Date.parse('2026-08-23T12:00:00.000Z');

    expect(resolveBackstageWorkerOperationDeadlineAt(
      new Date(startedAtMs),
      policy,
      startedAtMs + 50_000
    )).toBe(startedAtMs + policy.operationTimeoutMs);
    expect(resolveBackstageWorkerOperationDeadlineAt(
      new Date(startedAtMs),
      policy,
      startedAtMs + 120_000
    )).toBe(startedAtMs + policy.operationTimeoutMs);
  });

  it('admits provider recovery only when the next claim precedes the durable deadline', () => {
    expect(resolveBackstageProviderDeferralDelayMs({
      deadlineAt: 10_000,
      requestedDelayMs: 1_499,
      nowMs: 8_500,
    })).toBe(1_499);
    expect(resolveBackstageProviderDeferralDelayMs({
      deadlineAt: 10_000,
      requestedDelayMs: 1_500,
      nowMs: 8_500,
    })).toBeNull();
    expect(resolveBackstageProviderDeferralDelayMs({
      deadlineAt: 10_000,
      requestedDelayMs: 30_000,
      nowMs: 8_500,
    })).toBeNull();
    expect(resolveBackstageProviderDeferralDelayMs({
      deadlineAt: 10_000,
      requestedDelayMs: 30_000,
      nowMs: 10_000,
    })).toBeNull();
  });
});

describe('cooperative deadline drain', () => {
  it('waits for the aborted callback to drain before surfacing its deadline', async () => {
    jest.useFakeTimers();
    let releaseDrain!: () => void;
    const drainReleased = new Promise<void>(resolve => {
      releaseDrain = resolve;
    });
    let observedAbort = false;
    let settled = false;

    try {
      const execution = runWithCooperativeAbortDrain(
        {
          timeoutMs: 1_000,
          abortMessage: 'bounded deadline',
          scope: 'test_deadline',
        },
        async () => {
          const signal = (await import('@arcanos/runtime')).getRequestAbortSignal();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              observedAbort = true;
              void drainReleased.then(() => reject(signal.reason));
            }, { once: true });
          });
        }
      );
      void execution.finally(() => {
        settled = true;
      }).catch(() => undefined);

      await jest.advanceTimersByTimeAsync(1_001);
      expect(observedAbort).toBe(true);
      expect(settled).toBe(false);
      releaseDrain();
      await expect(execution).rejects.toMatchObject({
        code: 'COOPERATIVE_DEADLINE_EXCEEDED',
        scope: 'test_deadline',
      });
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not relabel an early provider AbortError as a deadline', async () => {
    const providerAbort = Object.assign(new Error('provider transport aborted'), {
      name: 'AbortError',
    });
    await expect(runWithCooperativeAbortDrain(
      {
        timeoutMs: 1_000,
        abortMessage: 'bounded deadline',
        scope: 'test_deadline',
      },
      async () => {
        throw providerAbort;
      }
    )).rejects.toBe(providerAbort);
    expect(isCooperativeDeadlineExceededError(providerAbort)).toBe(false);
  });

  it('surfaces a deadline after a finite drain ceiling when cooperative work ignores abort', async () => {
    jest.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let settled = false;

    try {
      const execution = runWithCooperativeAbortDrain(
        {
          timeoutMs: 1_000,
          maxDrainMs: 250,
          abortMessage: 'bounded stalled drain',
          scope: 'test_bounded_drain',
        },
        async () => {
          observedSignal = (await import('@arcanos/runtime')).getRequestAbortSignal();
          await new Promise<void>(() => undefined);
        }
      );
      void execution.finally(() => {
        settled = true;
      }).catch(() => undefined);

      await jest.advanceTimersByTimeAsync(1_001);
      expect(observedSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(250);
      await expect(execution).rejects.toMatchObject({
        code: 'COOPERATIVE_DEADLINE_EXCEEDED',
        scope: 'test_bounded_drain',
      });
      expect(settled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('queue lease timing', () => {
  it.each([
    ['below minimum', 1, JOB_LEASE_MINIMUM_MS],
    ['at minimum', JOB_LEASE_MINIMUM_MS, JOB_LEASE_MINIMUM_MS],
    ['above maximum', 999_999, JOB_LEASE_MAXIMUM_MS],
  ] as const)('normalizes lease %s', (_label, configured, expected) => {
    expect(normalizeJobLeaseMs(configured)).toBe(expected);
  });

  it('renews a legitimate long operation with multiple live-lease opportunities', () => {
    const leaseMs = 15_000;
    const heartbeatMs = resolveJobLeaseHeartbeatIntervalMs(leaseMs);
    let nowMs = 0;
    let leaseExpiresAtMs = leaseMs;

    expect(heartbeatMs).toBe(5_000);
    while (nowMs < 150_000) {
      nowMs += heartbeatMs;
      expect(nowMs).toBeLessThanOrEqual(leaseExpiresAtMs);
      leaseExpiresAtMs = nowMs + leaseMs;
    }
    expect(leaseExpiresAtMs).toBeGreaterThan(nowMs);
  });
});
