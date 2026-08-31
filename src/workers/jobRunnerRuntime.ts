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

export const WORKER_BOOTSTRAP_READY_SENTINEL = 'ARCANOS_WORKER_BOOTSTRAP_READY_V1';
export const WORKER_OPERATIONAL_STATE_PREFIX = 'ARCANOS_WORKER_OPERATIONAL_STATE_V1 ';
export const JOB_WORKER_STATS_ID_MAX_CHARACTERS = 255;

export type WorkerOperationalState =
  | 'accepting_claims'
  | 'paused_budget'
  | 'paused_rss'
  | 'dependency_failure';

export interface WorkerOperationalStateSignal {
  workerId: string;
  sequence: number;
  state: WorkerOperationalState;
  reason: string | null;
  retryAt: string | null;
}

export interface WorkerStartupReadinessRetryDecision {
  state: 'paused_budget' | 'dependency_failure';
  reason: string;
  retryAt: string | null;
  delayMs: number;
}

export interface WorkerBootstrapReadyDestination {
  write(chunk: string): unknown;
}

/**
 * Emit the exact launcher-facing worker readiness protocol.
 * Purpose: keep deployment activation independent from configurable log filtering.
 * Inputs/outputs: writes one newline-terminated sentinel to stdout by default.
 * Edge case behavior: write failures remain fatal so the worker cannot run without communicating readiness.
 */
export function emitWorkerBootstrapReadySignal(
  destination: WorkerBootstrapReadyDestination = process.stdout
): void {
  destination.write(`${WORKER_BOOTSTRAP_READY_SENTINEL}\n`);
}

function sanitizeOperationalProtocolValue(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return normalized ? Array.from(normalized).slice(0, maxLength).join('') : null;
}

export function createWorkerOperationalStateReporter(
  workerIdInput: string,
  destination: WorkerBootstrapReadyDestination = process.stdout
): (state: WorkerOperationalState, reason?: string | null, retryAt?: string | null) => void {
  const exactWorkerId = workerIdInput.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  if (Array.from(exactWorkerId).length > JOB_WORKER_STATS_ID_MAX_CHARACTERS) {
    throw new RangeError(
      `Worker operational readiness id must not exceed ${JOB_WORKER_STATS_ID_MAX_CHARACTERS} characters.`
    );
  }
  const workerId = sanitizeOperationalProtocolValue(workerIdInput, JOB_WORKER_STATS_ID_MAX_CHARACTERS);
  if (!workerId) {
    throw new Error('Worker operational readiness requires a non-empty worker id.');
  }
  let sequence = 0;
  let lastPayload = '';
  return (state, reason = null, retryAt = null) => {
    const normalizedRetryAt = retryAt && Number.isFinite(Date.parse(retryAt))
      ? new Date(retryAt).toISOString()
      : null;
    const nextState = {
      workerId,
      state,
      reason: sanitizeOperationalProtocolValue(reason, 256),
      retryAt: normalizedRetryAt
    };
    const comparisonPayload = JSON.stringify(nextState);
    if (comparisonPayload === lastPayload) {
      return;
    }
    lastPayload = comparisonPayload;
    sequence += 1;
    const signal: WorkerOperationalStateSignal = { ...nextState, sequence };
    destination.write(`${WORKER_OPERATIONAL_STATE_PREFIX}${JSON.stringify(signal)}\n`);
  };
}

/**
 * Retry only startup-readiness failures explicitly classified as recoverable.
 * Paused state is published before each wait; accepting state remains owned by
 * the fully initialized consumer slots after the startup gate succeeds.
 */
export async function waitForWorkerStartupReadiness<T>(params: {
  attempt: () => Promise<T>;
  resolveRetry: (
    error: unknown
  ) => WorkerStartupReadinessRetryDecision | null | Promise<WorkerStartupReadinessRetryDecision | null>;
  reportPause: (decision: WorkerStartupReadinessRetryDecision) => void;
  wait: (delayMs: number) => Promise<void>;
}): Promise<T> {
  for (;;) {
    try {
      return await params.attempt();
    } catch (error) {
      const decision = await params.resolveRetry(error);
      if (!decision) {
        throw error;
      }
      params.reportPause(decision);
      await params.wait(Math.max(0, Math.trunc(decision.delayMs)));
    }
  }
}

/**
 * Commit readiness only after every consumer slot is ready and no runtime has settled.
 * Purpose: prevent ready-then-failed slots and final-readiness microtask ties from producing a false activation signal.
 * Inputs/outputs: accepts paired readiness/runtime promises plus one synchronous commit callback.
 * Edge case behavior: mismatched or empty slot sets fail closed; runtime rejection identity is preserved.
 */
export async function commitAllWorkerSlotsReadyOrThrow(
  slotReadinessPromises: readonly Promise<void>[],
  slotRuntimePromises: readonly Promise<void>[],
  commitReadiness: () => void
): Promise<void> {
  if (
    slotReadinessPromises.length === 0 ||
    slotReadinessPromises.length !== slotRuntimePromises.length
  ) {
    throw new Error('WORKER_SLOT_READINESS_CONFIGURATION_INVALID');
  }

  let runtimeSettled = false;
  let firstRuntimeSettlementError: unknown;
  let rejectFirstRuntimeSettlement!: (reason?: unknown) => void;
  const firstRuntimeSettlement = new Promise<never>((_resolve, reject) => {
    rejectFirstRuntimeSettlement = reject;
  });

  const recordRuntimeSettlement = (error: unknown): void => {
    if (runtimeSettled) {
      return;
    }

    runtimeSettled = true;
    firstRuntimeSettlementError = error;
    rejectFirstRuntimeSettlement(error);
  };

  slotRuntimePromises.forEach((slotRuntimePromise, slotIndex) => {
    void slotRuntimePromise.then(
      () => recordRuntimeSettlement(
        new Error(`WORKER_SLOT_RUNTIME_SETTLED_BEFORE_READINESS:slot=${slotIndex + 1}`)
      ),
      (error: unknown) => recordRuntimeSettlement(error)
    );
  });

  await Promise.race([
    Promise.all(slotReadinessPromises).then(() => undefined),
    firstRuntimeSettlement
  ]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  if (runtimeSettled) {
    throw firstRuntimeSettlementError;
  }

  commitReadiness();
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

export interface JobRunnerIdleBackoffDelayOptions {
  baseIdleBackoffMs: number;
  workerId: string;
  idleStreak: number;
  maxIdleBackoffMs?: number;
}

export type ClaimedJobAbortCause =
  | 'durable_cancellation'
  | 'lease_lost'
  | 'process_shutdown';

export interface ClaimedJobAbortState {
  cause: ClaimedJobAbortCause | null;
  durableCancellationReason: string | null;
}

export function selectClaimedJobAbortCause(
  currentCause: ClaimedJobAbortCause | null,
  nextCause: ClaimedJobAbortCause
): ClaimedJobAbortCause {
  if (
    currentCause === 'durable_cancellation' ||
    nextCause === 'durable_cancellation'
  ) {
    return 'durable_cancellation';
  }

  return currentCause ?? nextCause;
}

export function advanceClaimedJobAbortState(
  currentState: ClaimedJobAbortState,
  nextCause: ClaimedJobAbortCause,
  message: string
): ClaimedJobAbortState {
  return {
    cause: selectClaimedJobAbortCause(currentState.cause, nextCause),
    durableCancellationReason:
      nextCause === 'durable_cancellation'
        ? message
        : currentState.durableCancellationReason
  };
}

export function shouldPersistClaimedJobCancellation(
  cause: ClaimedJobAbortCause | null
): boolean {
  return cause === 'durable_cancellation';
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

export function resolveJobRunnerIdleBackoffDelayMs(
  options: JobRunnerIdleBackoffDelayOptions
): number {
  const baseIdleBackoffMs =
    Number.isFinite(options.baseIdleBackoffMs) && options.baseIdleBackoffMs > 0
      ? Math.max(1, Math.trunc(options.baseIdleBackoffMs))
      : 1_000;
  const maxIdleBackoffMs =
    Number.isFinite(options.maxIdleBackoffMs) && (options.maxIdleBackoffMs ?? 0) > 0
      ? Math.max(baseIdleBackoffMs, Math.trunc(options.maxIdleBackoffMs ?? baseIdleBackoffMs))
      : Math.max(baseIdleBackoffMs, 30_000);
  const idleStreak = Number.isFinite(options.idleStreak)
    ? Math.max(0, Math.trunc(options.idleStreak))
    : 0;
  const exponent = Math.min(idleStreak, 6);
  const exponentialDelayMs = Math.min(
    maxIdleBackoffMs,
    baseIdleBackoffMs * (2 ** exponent)
  );
  const jitterRangeMs = Math.max(
    1,
    Math.min(5_000, Math.floor(exponentialDelayMs * 0.2))
  );
  const jitterMs = computeDeterministicIntervalJitterMs(options.workerId, jitterRangeMs);

  return Math.min(maxIdleBackoffMs, exponentialDelayMs + jitterMs);
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
 * Edge case behavior: invalid numeric values fall back safely; overlong persisted stats identities fail before startup.
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
  const statsWorkerId = env.JOB_WORKER_STATS_ID?.trim() || baseWorkerId;
  if (/[\u0000-\u001f\u007f]/u.test(statsWorkerId)) {
    throw new RangeError('JOB_WORKER_STATS_ID must not contain control characters.');
  }
  if (Array.from(statsWorkerId).length > JOB_WORKER_STATS_ID_MAX_CHARACTERS) {
    throw new RangeError(
      `JOB_WORKER_STATS_ID must not exceed ${JOB_WORKER_STATS_ID_MAX_CHARACTERS} characters.`
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(baseWorkerId)) {
    throw new RangeError('JOB_WORKER_ID must not contain control characters.');
  }
  const longestLeaseWorkerId = concurrency === 1
    ? baseWorkerId
    : `${baseWorkerId}-slot-${concurrency}`;
  if (Array.from(longestLeaseWorkerId).length > JOB_WORKER_STATS_ID_MAX_CHARACTERS) {
    throw new RangeError(
      `Derived JOB_WORKER_ID must not exceed ${JOB_WORKER_STATS_ID_MAX_CHARACTERS} characters.`
    );
  }

  return {
    pollMs: readPositiveIntegerEnvValue(env.JOB_WORKER_POLL_MS, 250),
    idleBackoffMs: readPositiveIntegerEnvValue(env.JOB_WORKER_IDLE_BACKOFF_MS, 1_000),
    concurrency,
    baseWorkerId,
    statsWorkerId
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
