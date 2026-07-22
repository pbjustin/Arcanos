import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  DependencyLifecycle,
  type DependencyLifecycleAdapter,
  type DependencyLifecycleSleep,
} from '../src/platform/runtime/dependencyLifecycle.js';

type TestErrorCode = 'TEST_UNAVAILABLE' | 'TEST_TIMEOUT';

interface TestResource {
  ready: boolean;
}

interface ManualSleepCall {
  delayMs: number;
  signal: AbortSignal;
  settled: boolean;
  resolve: () => void;
}

function createManualSleep(): {
  sleep: DependencyLifecycleSleep;
  calls: ManualSleepCall[];
  resolveNext: (delayMs: number) => void;
} {
  const calls: ManualSleepCall[] = [];
  const sleep: DependencyLifecycleSleep = (delayMs, signal) => new Promise<void>((resolve, reject) => {
    const call: ManualSleepCall = {
      delayMs,
      signal,
      settled: false,
      resolve: () => {
        if (call.settled) {
          return;
        }
        call.settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
    };
    const onAbort = () => {
      if (call.settled) {
        return;
      }
      call.settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new Error('sleep aborted'));
    };

    calls.push(call);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return {
    sleep,
    calls,
    resolveNext(delayMs: number): void {
      const call = calls.find((candidate) => !candidate.settled && candidate.delayMs === delayMs);
      if (!call) {
        throw new Error(`No pending ${delayMs}ms sleep.`);
      }
      call.resolve();
    }
  };
}

async function flushAsyncWork(iterations = 16): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('DependencyLifecycle', () => {
  const lifecycles: Array<DependencyLifecycle<TestResource, TestErrorCode>> = [];

  afterEach(async () => {
    await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.stop()));
  });

  it('satisfies an unconfigured dependency without creating a resource', () => {
    const createResource = jest.fn(() => ({ ready: false }));
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: false }),
      connect: jest.fn(async () => undefined),
      validate: jest.fn(async () => undefined),
      isReady: (resource) => resource.ready,
      invalidate: jest.fn(),
      close: jest.fn(async () => undefined),
      subscribeUnavailable: jest.fn(() => jest.fn()),
      classifyError: () => 'TEST_UNAVAILABLE'
    };
    const lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100
    });
    lifecycles.push(lifecycle);

    lifecycle.start();

    expect(createResource).not.toHaveBeenCalled();
    expect(lifecycle.getReadyResource()).toBeNull();
    expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      configured: false,
      ready: false,
      retryScheduled: false
    }));
  });

  it('reuses one resource and one subscription across retry and recovery', async () => {
    const manualSleep = createManualSleep();
    const resource: TestResource = { ready: false };
    const createResource = jest.fn(() => resource);
    let connectAttempt = 0;
    let reportUnavailable: ((error: unknown) => void) | null = null;
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: true, createResource }),
      connect: jest.fn(async (target) => {
        connectAttempt += 1;
        if (connectAttempt === 1) {
          throw Object.assign(new Error('not available'), { code: 'TEST_UNAVAILABLE' });
        }
        target.ready = true;
      }),
      validate: jest.fn(async () => undefined),
      isReady: (target) => target.ready,
      invalidate: jest.fn((target) => {
        target.ready = false;
      }),
      close: jest.fn(async (target) => {
        target.ready = false;
      }),
      subscribeUnavailable: jest.fn((_target, listener) => {
        reportUnavailable = listener;
        return jest.fn();
      }),
      classifyError: (error) => (
        error && typeof error === 'object' && (error as { code?: string }).code === 'DEPENDENCY_ATTEMPT_TIMEOUT'
          ? 'TEST_TIMEOUT'
          : 'TEST_UNAVAILABLE'
      )
    };
    const lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      sleep: manualSleep.sleep,
      random: () => 0
    });
    lifecycles.push(lifecycle);

    lifecycle.start();
    lifecycle.start();
    await flushAsyncWork();
    expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      retryScheduled: true,
      attempt: 1,
      lastErrorCode: 'TEST_UNAVAILABLE'
    }));

    manualSleep.resolveNext(10);
    await flushAsyncWork();
    expect(lifecycle.getReadyResource()).toBe(resource);
    expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({
      state: 'READY',
      recoveryCount: 1
    }));

    expect(reportUnavailable).not.toBeNull();
    reportUnavailable?.(Object.assign(new Error('lost'), { code: 'TEST_UNAVAILABLE' }));
    reportUnavailable?.(Object.assign(new Error('duplicate'), { code: 'TEST_UNAVAILABLE' }));
    await flushAsyncWork();

    expect(lifecycle.getSnapshot().state).toBe('READY');
    expect(createResource).toHaveBeenCalledTimes(1);
    expect(adapter.subscribeUnavailable).toHaveBeenCalledTimes(1);
    expect(adapter.connect).toHaveBeenCalledTimes(3);
  });

  it('does not publish ready when the resource becomes unavailable during validation', async () => {
    const manualSleep = createManualSleep();
    const resource: TestResource = { ready: false };
    let reportUnavailable: ((error: unknown) => void) | null = null;
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: true, createResource: () => resource }),
      connect: jest.fn(async (target) => {
        target.ready = true;
      }),
      validate: jest.fn(async (target) => {
        target.ready = false;
        reportUnavailable?.(Object.assign(new Error('lost during validation'), {
          code: 'TEST_UNAVAILABLE'
        }));
      }),
      isReady: (target) => target.ready,
      invalidate: jest.fn((target) => {
        target.ready = false;
      }),
      close: jest.fn(async (target) => {
        target.ready = false;
      }),
      subscribeUnavailable: jest.fn((_target, listener) => {
        reportUnavailable = listener;
        return jest.fn();
      }),
      classifyError: () => 'TEST_UNAVAILABLE'
    };
    const lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      sleep: manualSleep.sleep
    });
    lifecycles.push(lifecycle);

    lifecycle.start();
    await flushAsyncWork();

    expect(lifecycle.getReadyResource()).toBeNull();
    expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      ready: false,
      retryScheduled: true,
      lastErrorCode: 'TEST_UNAVAILABLE'
    }));
    expect(adapter.connect).toHaveBeenCalledTimes(1);
  });

  it('suppresses the unavailable event echoed synchronously by invalidation', async () => {
    const resource: TestResource = { ready: false };
    let unavailableListener: ((error: unknown) => void) | null = null;
    const events: string[] = [];
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: true, createResource: () => resource }),
      connect: jest.fn(async (target) => {
        target.ready = true;
      }),
      validate: jest.fn(async () => undefined),
      isReady: (target) => target.ready,
      invalidate: jest.fn((target) => {
        const wasReady = target.ready;
        target.ready = false;
        if (wasReady) {
          unavailableListener?.(Object.assign(new Error('resource ended'), {
            code: 'TEST_UNAVAILABLE'
          }));
        }
      }),
      close: jest.fn(async (target) => {
        target.ready = false;
      }),
      subscribeUnavailable: jest.fn((_target, listener) => {
        unavailableListener = listener;
        return jest.fn();
      }),
      classifyError: () => 'TEST_UNAVAILABLE'
    };
    const lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      onEvent: (event) => {
        events.push(event.kind);
      }
    });
    lifecycles.push(lifecycle);

    lifecycle.start();
    await flushAsyncWork();
    expect(lifecycle.getSnapshot().state).toBe('READY');

    lifecycle.reportUnavailable(Object.assign(new Error('socket lost'), {
      code: 'TEST_UNAVAILABLE'
    }));
    await flushAsyncWork();

    expect(events.filter((kind) => kind === 'unavailable')).toHaveLength(1);
    expect(adapter.connect).toHaveBeenCalledTimes(2);
    expect(adapter.subscribeUnavailable).toHaveBeenCalledTimes(1);
    expect(lifecycle.getSnapshot().state).toBe('READY');
  });

  it('continues shutdown when subscription cleanup throws and closes once', async () => {
    const resource: TestResource = { ready: false };
    const close = jest.fn(async (target: TestResource) => {
      target.ready = false;
    });
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: true, createResource: () => resource }),
      connect: jest.fn(async (target) => {
        target.ready = true;
      }),
      validate: jest.fn(async () => undefined),
      isReady: (target) => target.ready,
      invalidate: jest.fn((target) => {
        target.ready = false;
      }),
      close,
      subscribeUnavailable: jest.fn(() => () => {
        throw new Error('unsubscribe failed');
      }),
      classifyError: () => 'TEST_UNAVAILABLE'
    };
    const lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100
    });
    lifecycles.push(lifecycle);

    lifecycle.start();
    await flushAsyncWork();
    await lifecycle.stop();
    await lifecycle.stop();

    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.getSnapshot()).toEqual(expect.objectContaining({
      state: 'DEGRADED',
      ready: false,
      retryScheduled: false
    }));
  });

  it('keeps the unavailable listener attached through resource closure', async () => {
    const resource: TestResource = { ready: false };
    let unavailableListener: ((error: unknown) => void) | null = null;
    let closeHadUnavailableListener = false;
    const unsubscribe = jest.fn(() => {
      unavailableListener = null;
    });
    const close = jest.fn(async (target: TestResource) => {
      closeHadUnavailableListener = unavailableListener !== null;
      unavailableListener?.(Object.assign(new Error('close-time socket error'), {
        code: 'TEST_UNAVAILABLE'
      }));
      target.ready = false;
    });
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: true, createResource: () => resource }),
      connect: jest.fn(async (target) => {
        target.ready = true;
      }),
      validate: jest.fn(async () => undefined),
      isReady: (target) => target.ready,
      invalidate: jest.fn((target) => {
        target.ready = false;
      }),
      close,
      subscribeUnavailable: jest.fn((_target, listener) => {
        unavailableListener = listener;
        return unsubscribe;
      }),
      classifyError: () => 'TEST_UNAVAILABLE'
    };
    const lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100
    });
    lifecycles.push(lifecycle);

    lifecycle.start();
    await flushAsyncWork();
    await lifecycle.stop();

    expect(close).toHaveBeenCalledTimes(1);
    expect(closeHadUnavailableListener).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unavailableListener).toBeNull();
    expect(adapter.invalidate).not.toHaveBeenCalled();
  });

  it('rejects invalid timing policy before starting', () => {
    const adapter: DependencyLifecycleAdapter<TestResource, TestErrorCode> = {
      resolve: () => ({ configured: false }),
      connect: jest.fn(async () => undefined),
      validate: jest.fn(async () => undefined),
      isReady: () => false,
      invalidate: jest.fn(),
      close: jest.fn(async () => undefined),
      subscribeUnavailable: jest.fn(() => jest.fn()),
      classifyError: () => 'TEST_UNAVAILABLE'
    };

    expect(() => new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 0,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100
    })).toThrow('attemptTimeoutMs must be a positive finite number.');
    expect(() => new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: 100,
      retryBaseDelayMs: 200,
      retryMaxDelayMs: 100
    })).toThrow('retryMaxDelayMs must be greater than or equal to retryBaseDelayMs.');
  });
});
