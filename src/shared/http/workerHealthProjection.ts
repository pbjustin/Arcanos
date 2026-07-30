export type PublicWorkerHealthState =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'offline'
  | 'unknown';

export type PublicWorkerRuntimeState =
  | 'active'
  | 'pending'
  | 'disabled'
  | 'offline'
  | 'unknown';

export type PublicWorkerQueueState =
  | 'idle'
  | 'active'
  | 'stalled'
  | 'unavailable';

export type PublicWorkerMemoryState =
  | 'active'
  | 'degraded'
  | 'offline'
  | 'unknown';

type TimestampCandidate = string | Date | null | undefined;
type CountCandidate = number | null | undefined;

export interface PublicWorkerHealthProjectionInput {
  timestamp: TimestampCandidate;
  status?: unknown;
  runtime?: {
    status?: unknown;
    totalDispatched?: CountCandidate;
    startedAt?: TimestampCandidate;
    lastDispatchAt?: TimestampCandidate;
  };
  workers?: {
    status?: unknown;
    total?: CountCandidate;
    available?: CountCandidate;
    configured?: CountCandidate;
    active?: CountCandidate;
    observed?: CountCandidate;
    stale?: CountCandidate;
    degraded?: CountCandidate;
    unhealthy?: CountCandidate;
    lastHeartbeatAt?: TimestampCandidate;
  };
  queue?: {
    status?: unknown;
    total?: CountCandidate;
    pending?: CountCandidate;
    running?: CountCandidate;
    completed?: CountCandidate;
    retainedFailed?: CountCandidate;
    delayed?: CountCandidate;
    stalledRunning?: CountCandidate;
    lastUpdatedAt?: TimestampCandidate;
  };
  memory?: {
    status?: unknown;
    routes?: CountCandidate;
    lastUpdatedAt?: TimestampCandidate;
  };
}

export interface PublicWorkerHealthProjection {
  status: PublicWorkerHealthState;
  overallStatus: PublicWorkerHealthState;
  totalWorkers: number | null;
  availableWorkers: number | null;
  runtime: {
    status: PublicWorkerRuntimeState;
    totalDispatched: number | null;
    startedAt: string | null;
    lastDispatchAt: string | null;
  };
  workers: {
    status: PublicWorkerHealthState;
    total: number | null;
    available: number | null;
    configured: number | null;
    active: number | null;
    observed: number | null;
    stale: number | null;
    degraded: number | null;
    unhealthy: number | null;
    lastHeartbeatAt: string | null;
  };
  queue: {
    status: PublicWorkerQueueState;
    total: number | null;
    pending: number | null;
    running: number | null;
    completed: number | null;
    retainedFailed: number | null;
    delayed: number | null;
    stalledRunning: number | null;
    lastUpdatedAt: string | null;
  };
  memory: {
    status: PublicWorkerMemoryState;
    routes: number | null;
    lastUpdatedAt: string | null;
  };
  timestamp: string | null;
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeHealthState(value: unknown): PublicWorkerHealthState {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'ok') {
      return 'healthy';
    }
    if (normalized === 'warning') {
      return 'degraded';
    }
    if (normalized === 'critical') {
      return 'unhealthy';
    }
  }

  return normalizeEnum(
    value,
    ['healthy', 'degraded', 'unhealthy', 'offline', 'unknown'] as const,
    'unknown'
  );
}

function normalizeCount(value: CountCandidate): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function normalizeTimestamp(value: TimestampCandidate): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null;
}

function normalizeQueueState(
  value: unknown,
  queue: PublicWorkerHealthProjectionInput['queue']
): PublicWorkerQueueState {
  const normalizedValue = typeof value === 'string'
    ? value.trim().toLowerCase()
    : null;
  const explicitState = normalizeEnum(
    value,
    ['idle', 'active', 'stalled', 'unavailable'] as const,
    'unavailable'
  );
  if (
    normalizedValue !== null
    && ['idle', 'active', 'stalled', 'unavailable'].includes(normalizedValue)
  ) {
    return explicitState;
  }

  const stalledRunning = normalizeCount(queue?.stalledRunning);
  if (stalledRunning !== null && stalledRunning > 0) {
    return 'stalled';
  }

  const pending = normalizeCount(queue?.pending);
  const running = normalizeCount(queue?.running);
  const delayed = normalizeCount(queue?.delayed);
  if (
    (pending !== null && pending > 0)
    || (running !== null && running > 0)
    || (delayed !== null && delayed > 0)
  ) {
    return 'active';
  }

  const hasKnownCount = [
    queue?.total,
    queue?.pending,
    queue?.running,
    queue?.completed,
    queue?.retainedFailed,
    queue?.delayed,
    queue?.stalledRunning,
  ].some(valueCandidate => normalizeCount(valueCandidate) !== null);
  return hasKnownCount ? 'idle' : 'unavailable';
}

/**
 * Reconstruct the anonymous worker-health response from a closed allowlist.
 * Identifiers, free-form diagnostics, job snapshots, results, and paths are
 * intentionally impossible to carry through this projection.
 */
export function projectPublicWorkerHealth(
  input: PublicWorkerHealthProjectionInput
): PublicWorkerHealthProjection {
  const status = normalizeHealthState(input.status);
  const totalWorkers = normalizeCount(input.workers?.total);
  const availableWorkers = normalizeCount(input.workers?.available);

  return {
    status,
    overallStatus: status,
    totalWorkers,
    availableWorkers,
    runtime: {
      status: normalizeEnum(
        input.runtime?.status,
        ['active', 'pending', 'disabled', 'offline', 'unknown'] as const,
        'unknown'
      ),
      totalDispatched: normalizeCount(input.runtime?.totalDispatched),
      startedAt: normalizeTimestamp(input.runtime?.startedAt),
      lastDispatchAt: normalizeTimestamp(input.runtime?.lastDispatchAt),
    },
    workers: {
      status: normalizeHealthState(input.workers?.status),
      total: totalWorkers,
      available: availableWorkers,
      configured: normalizeCount(input.workers?.configured),
      active: normalizeCount(input.workers?.active),
      observed: normalizeCount(input.workers?.observed),
      stale: normalizeCount(input.workers?.stale),
      degraded: normalizeCount(input.workers?.degraded),
      unhealthy: normalizeCount(input.workers?.unhealthy),
      lastHeartbeatAt: normalizeTimestamp(input.workers?.lastHeartbeatAt),
    },
    queue: {
      status: normalizeQueueState(input.queue?.status, input.queue),
      total: normalizeCount(input.queue?.total),
      pending: normalizeCount(input.queue?.pending),
      running: normalizeCount(input.queue?.running),
      completed: normalizeCount(input.queue?.completed),
      retainedFailed: normalizeCount(input.queue?.retainedFailed),
      delayed: normalizeCount(input.queue?.delayed),
      stalledRunning: normalizeCount(input.queue?.stalledRunning),
      lastUpdatedAt: normalizeTimestamp(input.queue?.lastUpdatedAt),
    },
    memory: {
      status: normalizeEnum(
        input.memory?.status,
        ['active', 'degraded', 'offline', 'unknown'] as const,
        'unknown'
      ),
      routes: normalizeCount(input.memory?.routes),
      lastUpdatedAt: normalizeTimestamp(input.memory?.lastUpdatedAt),
    },
    timestamp: normalizeTimestamp(input.timestamp),
  };
}

export function selectLatestPublicWorkerTimestamp(
  ...values: TimestampCandidate[]
): string | null {
  const timestamps = values
    .map(normalizeTimestamp)
    .filter((value): value is string => value !== null);
  if (timestamps.length === 0) {
    return null;
  }

  return timestamps.reduce((latest, candidate) => (
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest
  ));
}
