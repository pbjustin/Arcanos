import path from 'path';
import { fileURLToPath } from 'url';
import type { WorkerRuntimeModeResolution } from '@platform/runtime/unifiedConfig.js';

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

export interface JobRunnerEntrypointRuntimeMode {
  enabled: boolean;
  disabledReason: string | null;
  reason: string;
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
  'connection reset',
  'connection refused',
  'could not connect',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again',
  'enetwork',
  'enetunreach',
  'ehostunreach'
];

const DATABASE_ERROR_CONTEXT_MARKERS = [
  'database',
  'postgres',
  'postgresql',
  'pg_hba.conf',
  'sql',
  'job_data',
  'database_url',
  'database_private_url',
  'database_public_url'
];

const POSTGRES_TRANSIENT_ERROR_CONTEXT_MARKERS = [
  'timeout exceeded when trying to connect',
  'connection terminated unexpectedly',
  'server closed the connection unexpectedly',
  'terminating connection due to administrator command',
  'remaining connection slots are reserved'
];

const POSTGRES_TRANSIENT_ERROR_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08p01',
  '53300',
  '57p01',
  '57p02',
  '57p03'
]);

const RETRYABLE_TRANSPORT_ERROR_CODES = new Set([
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again',
  'enetwork',
  'enetunreach',
  'ehostunreach'
]);

const NON_DATABASE_TRANSIENT_CONTEXT_MARKERS = [
  'openai',
  'provider',
  'provider probe',
  'provider request',
  'provider unavailable',
  'probing provider',
  'api key',
  'authentication',
  'circuit breaker'
];

function readStringProperty(value: unknown, propertyName: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[propertyName];
  return typeof candidate === 'string' ? candidate : null;
}

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
 * Resolve how long a claimed job should be deferred while the provider recovers.
 * Purpose: keep claimed jobs out of immediate re-claim churn until the provider retry window opens.
 * Inputs/outputs: accepts the provider retry timestamp plus a local fallback, returns a positive delay in ms.
 * Edge case behavior: stale or invalid retry timestamps fall back to at least one second.
 */
export function resolveProviderPauseMs(
  nextRetryAt: string | null,
  fallbackMs: number,
  nowMs = Date.now()
): number {
  const normalizedFallbackMs =
    Number.isFinite(fallbackMs) && fallbackMs > 0
      ? Math.max(1_000, Math.trunc(fallbackMs))
      : 1_000;

  if (!nextRetryAt) {
    return normalizedFallbackMs;
  }

  const remainingMs = Math.ceil(Date.parse(nextRetryAt) - nowMs);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return normalizedFallbackMs;
  }

  return Math.max(normalizedFallbackMs, remainingMs);
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
 * Resolve whether the direct job-runner entrypoint may start mutation loops.
 * Purpose: keep standalone worker startup aligned with the stable process-role resolver.
 * Inputs/outputs: accepts the stable worker runtime mode and returns a logging-friendly decision.
 * Edge case behavior: explicit web role wins even when RUN_WORKERS was requested.
 */
export function resolveJobRunnerEntrypointRuntimeMode(
  workerRuntimeMode: Pick<
    WorkerRuntimeModeResolution,
    'resolvedRunWorkers' | 'reason'
  >
): JobRunnerEntrypointRuntimeMode {
  if (workerRuntimeMode.resolvedRunWorkers) {
    const enabledReason =
      workerRuntimeMode.reason === 'process_kind_worker'
        ? 'ARCANOS_PROCESS_KIND=worker starts the dedicated async queue dispatcher'
        : workerRuntimeMode.reason === 'requested'
          ? 'RUN_WORKERS requested the dedicated async queue dispatcher'
          : 'Workers enabled; starting the dedicated async queue dispatcher';

    return {
      enabled: true,
      disabledReason: null,
      reason: enabledReason
    };
  }

  const disabledReason =
    workerRuntimeMode.reason === 'process_kind_web'
      ? 'RUN_WORKERS disabled for explicit web process role; workers not started.'
      : 'RUN_WORKERS disabled; workers not started.';

  return {
    enabled: false,
    disabledReason,
    reason: disabledReason
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
  const normalizedCode = (readStringProperty(error, 'code') ?? '').trim().toLowerCase();

  return (
    RETRYABLE_DATABASE_BOOTSTRAP_ERROR_MARKERS.some(marker =>
      normalizedMessage.includes(marker)
    ) ||
    POSTGRES_TRANSIENT_ERROR_CONTEXT_MARKERS.some(marker =>
      normalizedMessage.includes(marker)
    ) ||
    POSTGRES_TRANSIENT_ERROR_CODES.has(normalizedCode) ||
    RETRYABLE_TRANSPORT_ERROR_CODES.has(normalizedCode)
  );
}

/**
 * Select the outer slot retry log event for a retryable transient error.
 * Purpose: keep the retry/backoff behavior while avoiding database labels for generic provider/network failures.
 * Inputs/outputs: accepts an error value and returns the structured log event name.
 * Edge case behavior: retryable transport errors without database context use a generic worker event.
 */
export function selectJobRunnerSlotTransientRetryEvent(error: unknown):
  | 'worker.database.transient_error_retry'
  | 'worker.transient_error_retry' {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String(error ?? '');
  const normalizedMessage = message.toLowerCase();
  const normalizedCode = (readStringProperty(error, 'code') ?? '').trim().toLowerCase();
  const hasDirectDatabaseContext =
    DATABASE_ERROR_CONTEXT_MARKERS.some(marker => normalizedMessage.includes(marker)) ||
    /\bpg\b/.test(normalizedMessage) ||
    POSTGRES_TRANSIENT_ERROR_CODES.has(normalizedCode);
  if (hasDirectDatabaseContext) {
    return 'worker.database.transient_error_retry';
  }

  const hasNonDatabaseContext = NON_DATABASE_TRANSIENT_CONTEXT_MARKERS.some(marker =>
    normalizedMessage.includes(marker)
  );
  const hasPostgresTransientContext = POSTGRES_TRANSIENT_ERROR_CONTEXT_MARKERS.some(marker =>
    normalizedMessage.includes(marker)
  );

  return hasPostgresTransientContext && !hasNonDatabaseContext
    ? 'worker.database.transient_error_retry'
    : 'worker.transient_error_retry';
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

export function isEntrypointModule(moduleUrl: string, argv: string[] = process.argv): boolean {
  const entrypoint = argv[1];
  if (!entrypoint) {
    return false;
  }

  try {
    return path.resolve(entrypoint) === path.resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
