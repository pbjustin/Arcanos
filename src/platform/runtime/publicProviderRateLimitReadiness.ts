import { config } from '@platform/runtime/config.js';
import {
  probeRedisPublicProviderRateLimitCapability,
  publicProviderRateLimitCapabilityGate,
} from '@platform/runtime/publicProviderRateLimitStore.js';
import {
  getRedisLifecycleSnapshot,
  type RedisLifecycleSnapshot,
} from '@platform/runtime/redisLifecycle.js';
import type { PublicProviderRateLimitStoreMode } from '@platform/runtime/publicProviderRateLimitPolicy.js';

export type PublicProviderRateLimitReadinessStatus =
  | 'not_required'
  | 'pending'
  | 'ready'
  | 'failed';

export interface PublicProviderRateLimitReadinessSnapshot {
  status: PublicProviderRateLimitReadinessStatus;
  readyGeneration: number;
  retryAttempt: number;
  retryScheduled: boolean;
}

interface PublicProviderRateLimitReadinessTrackerOptions {
  getRedisSnapshot: () => RedisLifecycleSnapshot;
  mode: PublicProviderRateLimitStoreMode;
  namespace: string | null;
  onReadyGeneration?: (generation: number) => void;
  probe: (namespace: string) => Promise<void>;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface PublicProviderRateLimitReadinessTracker {
  getSnapshot(): PublicProviderRateLimitReadinessSnapshot;
  invalidateReadyGeneration(generation: number): void;
  observe(snapshot: RedisLifecycleSnapshot): void;
  stop(): void;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

function normalizedDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.max(1, Math.trunc(Number(value)))
    : fallback;
}

/** Track one generation-fenced Redis capability probe outside readiness requests. */
export function createPublicProviderRateLimitReadinessTracker(
  options: PublicProviderRateLimitReadinessTrackerOptions
): PublicProviderRateLimitReadinessTracker {
  const retryBaseDelayMs = normalizedDelay(
    options.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    normalizedDelay(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS)
  );
  let stopped = false;
  let observedReadyGeneration = 0;
  let capabilityRevision = 0;
  let inFlightProbe: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let state: PublicProviderRateLimitReadinessSnapshot = {
    status: options.mode === 'memory'
      ? 'not_required'
      : options.namespace
        ? 'pending'
        : 'failed',
    readyGeneration: 0,
    retryAttempt: 0,
    retryScheduled: false,
  };

  const clearRetry = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    state = { ...state, retryScheduled: false };
  };

  const scheduleRetry = (generation: number): void => {
    if (stopped || retryTimer || options.mode !== 'redis' || !options.namespace) {
      return;
    }
    const exponent = Math.min(state.retryAttempt, 16);
    const delayMs = Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** exponent));
    state = {
      ...state,
      retryAttempt: state.retryAttempt + 1,
      retryScheduled: true,
    };
    retryTimer = setTimeout(() => {
      retryTimer = null;
      state = { ...state, retryScheduled: false };
      const current = options.getRedisSnapshot();
      if (
        stopped
        || current.state !== 'READY'
        || current.readyGeneration !== generation
        || observedReadyGeneration !== generation
      ) {
        return;
      }
      startProbe(generation);
    }, delayMs);
    retryTimer.unref?.();
  };

  const startProbe = (generation: number): void => {
    const namespace = options.namespace;
    if (
      stopped
      || inFlightProbe
      || options.mode !== 'redis'
      || !namespace
      || observedReadyGeneration !== generation
    ) {
      return;
    }
    clearRetry();
    const probeRevision = capabilityRevision;
    state = {
      status: 'pending',
      readyGeneration: generation,
      retryAttempt: state.retryAttempt,
      retryScheduled: false,
    };
    let probe: Promise<void>;
    try {
      probe = options.probe(namespace);
    } catch (error) {
      probe = Promise.reject(error);
    }
    inFlightProbe = probe;
    void probe.then(() => {
      const current = options.getRedisSnapshot();
      if (
        stopped
        || current.state !== 'READY'
        || current.readyGeneration !== generation
        || observedReadyGeneration !== generation
        || capabilityRevision !== probeRevision
      ) {
        return;
      }
      options.onReadyGeneration?.(generation);
      state = {
        status: 'ready',
        readyGeneration: generation,
        retryAttempt: 0,
        retryScheduled: false,
      };
    }).catch(() => {
      const current = options.getRedisSnapshot();
      if (
        stopped
        || current.state !== 'READY'
        || current.readyGeneration !== generation
        || observedReadyGeneration !== generation
        || capabilityRevision !== probeRevision
      ) {
        return;
      }
      state = {
        status: 'failed',
        readyGeneration: generation,
        retryAttempt: state.retryAttempt,
        retryScheduled: false,
      };
      scheduleRetry(generation);
    }).finally(() => {
      if (inFlightProbe === probe) {
        inFlightProbe = null;
      }
      const current = options.getRedisSnapshot();
      if (
        !stopped
        && !inFlightProbe
        && current.state === 'READY'
        && current.readyGeneration === observedReadyGeneration
      ) {
        if (current.readyGeneration !== generation) {
          startProbe(current.readyGeneration);
        } else if (
          capabilityRevision !== probeRevision
          && state.status === 'failed'
          && !retryTimer
        ) {
          scheduleRetry(generation);
        }
      }
    });
  };

  return {
    getSnapshot(): PublicProviderRateLimitReadinessSnapshot {
      return { ...state };
    },
    invalidateReadyGeneration(generation): void {
      if (
        stopped
        || options.mode !== 'redis'
        || !options.namespace
        || observedReadyGeneration !== generation
      ) {
        return;
      }
      const current = options.getRedisSnapshot();
      if (current.state !== 'READY' || current.readyGeneration !== generation) {
        return;
      }
      if (retryTimer && state.status === 'failed') {
        return;
      }
      capabilityRevision += 1;
      state = {
        status: 'failed',
        readyGeneration: generation,
        retryAttempt: state.readyGeneration === generation ? state.retryAttempt : 0,
        retryScheduled: false,
      };
      if (!inFlightProbe) {
        scheduleRetry(generation);
      }
    },
    observe(snapshot): void {
      if (stopped) {
        return;
      }
      if (options.mode === 'memory') {
        clearRetry();
        observedReadyGeneration = snapshot.readyGeneration;
        state = {
          status: 'not_required',
          readyGeneration: snapshot.readyGeneration,
          retryAttempt: 0,
          retryScheduled: false,
        };
        return;
      }
      if (!options.namespace) {
        clearRetry();
        observedReadyGeneration = snapshot.readyGeneration;
        state = {
          status: 'failed',
          readyGeneration: snapshot.readyGeneration,
          retryAttempt: 0,
          retryScheduled: false,
        };
        return;
      }
      if (snapshot.state !== 'READY') {
        clearRetry();
        observedReadyGeneration = snapshot.readyGeneration;
        state = {
          status: 'pending',
          readyGeneration: snapshot.readyGeneration,
          retryAttempt: 0,
          retryScheduled: false,
        };
        return;
      }
      if (observedReadyGeneration === snapshot.readyGeneration) {
        if (
          state.status === 'ready'
          || inFlightProbe
          || retryTimer
          || state.status === 'failed'
        ) {
          return;
        }
      } else {
        clearRetry();
        observedReadyGeneration = snapshot.readyGeneration;
        state = {
          status: 'pending',
          readyGeneration: snapshot.readyGeneration,
          retryAttempt: 0,
          retryScheduled: false,
        };
      }
      startProbe(snapshot.readyGeneration);
    },
    stop(): void {
      stopped = true;
      clearRetry();
    },
  };
}

const publicProviderRateLimitReadinessTracker =
  createPublicProviderRateLimitReadinessTracker({
    getRedisSnapshot: getRedisLifecycleSnapshot,
    mode: config.limits.publicProviderRateLimitStore,
    namespace: config.limits.publicProviderRateLimitNamespace,
    onReadyGeneration: (generation) => {
      publicProviderRateLimitCapabilityGate.markReadyGeneration(generation);
    },
    probe: probeRedisPublicProviderRateLimitCapability,
  });

export function observePublicProviderRateLimitRedisLifecycle(
  snapshot: RedisLifecycleSnapshot
): void {
  publicProviderRateLimitReadinessTracker.observe(snapshot);
}

export function getPublicProviderRateLimitReadinessSnapshot():
PublicProviderRateLimitReadinessSnapshot {
  return publicProviderRateLimitReadinessTracker.getSnapshot();
}

/** Revalidate exact limiter commands after a same-generation admission failure. */
export function invalidatePublicProviderRateLimitReadiness(
  expectedReadyGeneration: number
): void {
  publicProviderRateLimitReadinessTracker.invalidateReadyGeneration(
    expectedReadyGeneration
  );
}

export function stopPublicProviderRateLimitReadinessTracker(): void {
  publicProviderRateLimitReadinessTracker.stop();
}
