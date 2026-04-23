export interface JobRunnerRuntimeSettings {
  pollMs: number;
  idleBackoffMs: number;
  concurrency: number;
  baseWorkerId: string;
  statsWorkerId: string;
}

export interface JobRunnerDatabaseBootstrapSettings {
  retryMs: number;
  maxRetryMs: number;
  maxAttempts: number | null;
}

export interface JobRunnerSlotDefinition {
  slotIndex: number;
  slotNumber: number;
  workerId: string;
  statsWorkerId: string;
  isInspectorSlot: boolean;
}

export interface NonOverlappingTaskSkipEvent {
  taskName: string;
  skippedCount: number;
  runningForMs: number | null;
}

export type NonOverlappingTaskRunner = (() => Promise<boolean>) & {
  isRunning(): boolean;
};

export interface NonOverlappingTaskRunnerOptions {
  taskName: string;
  skipLogMinIntervalMs?: number;
  onSkip?: (event: NonOverlappingTaskSkipEvent) => void;
  nowMs?: () => number;
}

const RETRYABLE_DATABASE_BOOTSTRAP_ERROR_MARKERS = [
  'timeout exceeded when trying to connect',
  'connect timeout',
  'connection timeout',
  'connection terminated',
  'connection refused',
  'could not connect',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again',
  'enetwork',
  'enetunreach',
  'ehostunreach'
];

function readPositiveIntegerEnvValue(
  rawValue: string | undefined,
  fallback: number
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function readNonNegativeIntegerEnvValue(
  rawValue: string | undefined,
  fallback: number
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

/**
 * Resolve a stable per-worker offset for interval work.
 * Purpose: spread same-frequency worker tasks without relying on non-deterministic randomness.
 * Inputs/outputs: accepts a worker id and interval, returns an offset in [0, intervalMs).
 * Edge case behavior: invalid intervals collapse to a zero delay.
 */
export function computeDeterministicIntervalJitterMs(
  workerId: string,
  intervalMs: number
): number {
  const normalizedIntervalMs = Math.trunc(intervalMs);
  if (!Number.isFinite(normalizedIntervalMs) || normalizedIntervalMs <= 1) {
    return 0;
  }

  let hash = 2166136261;
  for (let index = 0; index < workerId.length; index += 1) {
    hash ^= workerId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % normalizedIntervalMs;
}

/**
 * Create an async interval guard that skips ticks while the previous run is still active.
 * Purpose: prevent timer-driven DB work from piling up when a previous tick is delayed.
 * Inputs/outputs: accepts one async task and returns a callable runner; resolves true when executed, false when skipped.
 * Edge case behavior: failed tasks still release the guard in finally, and skip notifications are rate-limited.
 */
export function createNonOverlappingTaskRunner(
  task: () => Promise<void>,
  options: NonOverlappingTaskRunnerOptions
): NonOverlappingTaskRunner {
  const skipLogMinIntervalMs = Math.max(1_000, options.skipLogMinIntervalMs ?? 30_000);
  const nowMs = options.nowMs ?? (() => Date.now());
  let running = false;
  let runningStartedAtMs: number | null = null;
  let skippedCount = 0;
  let lastSkipLogAtMs = 0;

  const runner = (async (): Promise<boolean> => {
    const currentMs = nowMs();
    if (running) {
      skippedCount += 1;
      const shouldLogSkip =
        options.onSkip &&
        (lastSkipLogAtMs === 0 || currentMs - lastSkipLogAtMs >= skipLogMinIntervalMs);

      if (shouldLogSkip) {
        lastSkipLogAtMs = currentMs;
        options.onSkip?.({
          taskName: options.taskName,
          skippedCount,
          runningForMs: runningStartedAtMs === null
            ? null
            : Math.max(0, currentMs - runningStartedAtMs)
        });
      }

      return false;
    }

    running = true;
    runningStartedAtMs = currentMs;
    try {
      await task();
      return true;
    } finally {
      running = false;
      runningStartedAtMs = null;
      skippedCount = 0;
      lastSkipLogAtMs = 0;
    }
  }) as NonOverlappingTaskRunner;

  runner.isRunning = () => running;
  return runner;
}

/**
 * Resolve queue-worker runtime settings from the environment.
 * Purpose: centralize Railway worker polling and concurrency configuration in one pure helper.
 * Inputs/outputs: accepts an optional environment object and returns normalized runtime settings.
 * Edge case behavior: invalid or missing numeric env values fall back to safe positive defaults.
 */
export function resolveJobRunnerRuntimeSettings(
  env: NodeJS.ProcessEnv = process.env
): JobRunnerRuntimeSettings {
  //audit Assumption: explicit job-worker concurrency should override legacy worker-count settings; failure risk: accidental single-slot runtime despite configured worker fan-out; expected invariant: JOB_WORKER_CONCURRENCY wins, WORKER_COUNT remains a compatibility fallback, and runtime always resolves at least one consumer slot; handling strategy: normalize the env cascade in one place.
  const concurrency = readPositiveIntegerEnvValue(
    env.JOB_WORKER_CONCURRENCY,
    readPositiveIntegerEnvValue(env.WORKER_COUNT, 1)
  );
  const baseWorkerId =
    env.JOB_WORKER_ID?.trim() ||
    env.WORKER_ID?.trim() ||
    'async-queue';

  return {
    pollMs: readPositiveIntegerEnvValue(env.JOB_WORKER_POLL_MS, 250),
    idleBackoffMs: readPositiveIntegerEnvValue(env.JOB_WORKER_IDLE_BACKOFF_MS, 1_000),
    concurrency,
    baseWorkerId,
    statsWorkerId: env.JOB_WORKER_STATS_ID?.trim() || baseWorkerId
  };
}

/**
 * Resolve database bootstrap retry settings for the worker process.
 * Purpose: prevent transient Railway database reachability failures from permanently crashing the worker.
 * Inputs/outputs: accepts an optional environment object and returns normalized retry settings.
 * Edge case behavior: maxAttempts=0 means retry indefinitely; invalid values fall back to conservative defaults.
 */
export function resolveJobRunnerDatabaseBootstrapSettings(
  env: NodeJS.ProcessEnv = process.env
): JobRunnerDatabaseBootstrapSettings {
  const maxAttempts = readNonNegativeIntegerEnvValue(
    env.JOB_WORKER_DB_BOOTSTRAP_MAX_ATTEMPTS,
    0
  );

  return {
    retryMs: readPositiveIntegerEnvValue(env.JOB_WORKER_DB_BOOTSTRAP_RETRY_MS, 5_000),
    maxRetryMs: readPositiveIntegerEnvValue(env.JOB_WORKER_DB_BOOTSTRAP_MAX_RETRY_MS, 30_000),
    maxAttempts: maxAttempts === 0 ? null : maxAttempts
  };
}

/**
 * Identify transient DB reachability errors that should delay worker startup instead of crashing the process.
 */
export function isRetryableJobRunnerDatabaseBootstrapError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String(error ?? '');
  const normalizedMessage = message.toLowerCase();
  return RETRYABLE_DATABASE_BOOTSTRAP_ERROR_MARKERS.some(marker =>
    normalizedMessage.includes(marker)
  );
}

/**
 * Build normalized queue-consumer slot definitions for one worker process.
 * Purpose: generate distinct worker ids for leases and snapshots while preserving a shared stats identity.
 * Inputs/outputs: accepts resolved runtime settings and returns one slot definition per consumer.
 * Edge case behavior: a single-slot runtime keeps the base worker id unchanged for backward compatibility.
 */
export function buildJobRunnerSlotDefinitions(
  runtimeSettings: JobRunnerRuntimeSettings
): JobRunnerSlotDefinition[] {
  return Array.from({ length: runtimeSettings.concurrency }, (_, slotIndex) => {
    const slotNumber = slotIndex + 1;
    const workerId =
      runtimeSettings.concurrency === 1
        ? runtimeSettings.baseWorkerId
        : `${runtimeSettings.baseWorkerId}-slot-${slotNumber}`;

    return {
      slotIndex,
      slotNumber,
      workerId,
      statsWorkerId: runtimeSettings.statsWorkerId,
      isInspectorSlot: slotIndex === 0
    };
  });
}
