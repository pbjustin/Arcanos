import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  createPublicProviderRateLimitReadinessTracker,
} from '../src/platform/runtime/publicProviderRateLimitReadiness.js';
import {
  createPublicProviderRateLimitCapabilityGate,
} from '../src/platform/runtime/publicProviderRateLimitStore.js';
import type {
  RedisLifecycleSnapshot,
} from '../src/platform/runtime/redisLifecycle.js';

function redisSnapshot(
  state: RedisLifecycleSnapshot['state'],
  readyGeneration: number
): RedisLifecycleSnapshot {
  return {
    state,
    configured: true,
    connected: state === 'READY',
    attemptInFlight: state === 'STARTING',
    readyGeneration,
    circuitEnabled: true,
    circuitState: state === 'READY' ? 'CLOSED' : state === 'STARTING' ? 'HALF_OPEN' : 'OPEN',
    circuitFailureThreshold: 1,
    attempt: 1,
    recoveryCount: Math.max(0, readyGeneration - 1),
    retryScheduled: state === 'DEGRADED',
    lastTransitionAt: '2026-08-01T00:00:00.000Z',
    lastReadyAt: state === 'READY' ? '2026-08-01T00:00:00.000Z' : null,
    lastErrorCode: state === 'DEGRADED' ? 'REDIS_UNAVAILABLE' : null,
    operationGate: {
      inFlight: 0,
      admittedTotal: 0,
      rejectedTotal: 0,
      succeededTotal: 0,
      failedTotal: 0,
      timedOutTotal: 0,
      lastOperation: null,
      lastOutcome: null,
      lastDurationMs: null,
    },
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(iterations = 10): Promise<void> {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  jest.useRealTimers();
});

describe('public provider rate-limit capability readiness tracker', () => {
  it('runs one probe per ready generation and publishes only matching success', async () => {
    let current = redisSnapshot('READY', 1);
    const generationOne = createDeferred();
    const generationTwo = createDeferred();
    const probe = jest.fn()
      .mockImplementationOnce(() => generationOne.promise)
      .mockImplementationOnce(() => generationTwo.promise);
    const tracker = createPublicProviderRateLimitReadinessTracker({
      getRedisSnapshot: () => current,
      mode: 'redis',
      namespace: 'railway:project:environment:service',
      probe,
    });

    tracker.observe(current);
    tracker.observe(current);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot()).toEqual({
      status: 'pending',
      readyGeneration: 1,
      retryAttempt: 0,
      retryScheduled: false,
    });

    current = redisSnapshot('DEGRADED', 1);
    tracker.observe(current);
    current = redisSnapshot('READY', 2);
    tracker.observe(current);
    expect(probe).toHaveBeenCalledTimes(1);

    generationOne.resolve();
    await flushAsyncWork();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.getSnapshot()).toEqual(expect.objectContaining({
      status: 'pending',
      readyGeneration: 2,
    }));

    generationTwo.resolve();
    await flushAsyncWork();
    expect(tracker.getSnapshot()).toEqual({
      status: 'ready',
      readyGeneration: 2,
      retryAttempt: 0,
      retryScheduled: false,
    });
    tracker.stop();
  });

  it('retries a failed capability check with bounded single-flight backoff', async () => {
    jest.useFakeTimers();
    const current = redisSnapshot('READY', 3);
    const retry = createDeferred();
    const probe = jest.fn()
      .mockRejectedValueOnce(new Error('capability unavailable'))
      .mockImplementationOnce(() => retry.promise);
    const tracker = createPublicProviderRateLimitReadinessTracker({
      getRedisSnapshot: () => current,
      mode: 'redis',
      namespace: 'railway:project:environment:service',
      probe,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 100,
    });

    tracker.observe(current);
    await flushAsyncWork();
    expect(tracker.getSnapshot()).toEqual({
      status: 'failed',
      readyGeneration: 3,
      retryAttempt: 1,
      retryScheduled: true,
    });
    tracker.observe(current);
    expect(probe).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(50);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.getSnapshot()).toEqual(expect.objectContaining({
      status: 'pending',
      readyGeneration: 3,
      retryScheduled: false,
    }));

    retry.resolve();
    await flushAsyncWork();
    expect(tracker.getSnapshot()).toEqual({
      status: 'ready',
      readyGeneration: 3,
      retryAttempt: 0,
      retryScheduled: false,
    });
    tracker.stop();
  });

  it('revalidates the same ready generation after a live admission capability failure', async () => {
    jest.useFakeTimers();
    const current = redisSnapshot('READY', 4);
    const capabilityGate = createPublicProviderRateLimitCapabilityGate();
    const probe = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('NOPERM EVAL is no longer allowed'))
      .mockResolvedValueOnce(undefined);
    const tracker = createPublicProviderRateLimitReadinessTracker({
      getRedisSnapshot: () => current,
      mode: 'redis',
      namespace: 'railway:project:environment:service',
      onReadyGeneration: (generation) => capabilityGate.markReadyGeneration(generation),
      probe,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 100,
    });

    tracker.observe(current);
    await flushAsyncWork();
    expect(tracker.getSnapshot()).toEqual({
      status: 'ready',
      readyGeneration: 4,
      retryAttempt: 0,
      retryScheduled: false,
    });

    tracker.invalidateReadyGeneration(3);
    expect(probe).toHaveBeenCalledTimes(1);
    capabilityGate.markFailedGeneration(4);
    tracker.invalidateReadyGeneration(4);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(tracker.getSnapshot()).toEqual({
      status: 'failed',
      readyGeneration: 4,
      retryAttempt: 1,
      retryScheduled: true,
    });
    expect(capabilityGate.isFailedGeneration(4)).toBe(true);
    tracker.invalidateReadyGeneration(4);
    expect(probe).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(50);
    await flushAsyncWork();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.getSnapshot()).toEqual({
      status: 'failed',
      readyGeneration: 4,
      retryAttempt: 2,
      retryScheduled: true,
    });

    await jest.advanceTimersByTimeAsync(100);
    await flushAsyncWork();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(tracker.getSnapshot()).toEqual({
      status: 'ready',
      readyGeneration: 4,
      retryAttempt: 0,
      retryScheduled: false,
    });
    expect(capabilityGate.isFailedGeneration(4)).toBe(false);
    tracker.stop();
  });

  it('does not let an older in-flight probe erase a newer capability failure', async () => {
    jest.useFakeTimers();
    const current = redisSnapshot('READY', 5);
    const staleProbe = createDeferred();
    const recoveryProbe = createDeferred();
    const probe = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => staleProbe.promise)
      .mockImplementationOnce(() => recoveryProbe.promise);
    const tracker = createPublicProviderRateLimitReadinessTracker({
      getRedisSnapshot: () => current,
      mode: 'redis',
      namespace: 'railway:project:environment:service',
      probe,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 100,
    });

    tracker.observe(current);
    await flushAsyncWork();
    expect(tracker.getSnapshot().status).toBe('ready');

    tracker.invalidateReadyGeneration(5);
    await jest.advanceTimersByTimeAsync(50);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.getSnapshot().status).toBe('pending');

    tracker.invalidateReadyGeneration(5);
    expect(tracker.getSnapshot()).toEqual({
      status: 'failed',
      readyGeneration: 5,
      retryAttempt: 1,
      retryScheduled: false,
    });

    staleProbe.resolve();
    await flushAsyncWork();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(tracker.getSnapshot()).toEqual({
      status: 'failed',
      readyGeneration: 5,
      retryAttempt: 2,
      retryScheduled: true,
    });

    await jest.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(tracker.getSnapshot().status).toBe('pending');
    recoveryProbe.resolve();
    await flushAsyncWork();
    expect(tracker.getSnapshot()).toEqual({
      status: 'ready',
      readyGeneration: 5,
      retryAttempt: 0,
      retryScheduled: false,
    });
    tracker.stop();
  });

  it('does not probe when the configured store is process-local memory', () => {
    const current = redisSnapshot('READY', 1);
    const probe = jest.fn(async () => undefined);
    const tracker = createPublicProviderRateLimitReadinessTracker({
      getRedisSnapshot: () => current,
      mode: 'memory',
      namespace: null,
      probe,
    });

    tracker.observe(current);
    expect(probe).not.toHaveBeenCalled();
    expect(tracker.getSnapshot()).toEqual({
      status: 'not_required',
      readyGeneration: 1,
      retryAttempt: 0,
      retryScheduled: false,
    });
    tracker.stop();
  });
});
