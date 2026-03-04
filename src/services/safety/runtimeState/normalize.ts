import type { SafetyCounters, SafetyQuarantineRecord, UnsafeConditionRecord } from './types.js';

export function normalizeWorkerFailures(value: unknown): Record<string, WorkerFailureCounter> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, WorkerFailureCounter> = {};
  for (const [key, counter] of Object.entries(value)) {
    if (!isRecord(counter)) {
      continue;
    }

    const count = Number(counter.count);
    const windowStartedMs = Number(counter.windowStartedMs);
    const lastFailureMs = Number(counter.lastFailureMs);
    //audit Assumption: counters must contain finite numbers; failure risk: NaN counter math; expected invariant: numeric counters only; handling strategy: skip malformed entries.
    if (!Number.isFinite(count) || !Number.isFinite(windowStartedMs) || !Number.isFinite(lastFailureMs)) {
      continue;
    }

    normalized[key] = {
      count: Math.max(0, Math.floor(count)),
      windowStartedMs: Math.max(0, Math.floor(windowStartedMs)),
      lastFailureMs: Math.max(0, Math.floor(lastFailureMs))
    };
  }

  return normalized;
}
export function normalizeCounters(value: unknown): SafetyCounters {
  if (!isRecord(value)) {
    return createDefaultSnapshot().counters;
  }

  const heartbeatMisses: Record<string, number> = {};
  const healthyCycles: Record<string, number> = {};

  if (isRecord(value.heartbeatMisses)) {
    for (const [key, raw] of Object.entries(value.heartbeatMisses)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        heartbeatMisses[key] = Math.floor(parsed);
      }
    }
  }

  if (isRecord(value.healthyCycles)) {
    for (const [key, raw] of Object.entries(value.healthyCycles)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        healthyCycles[key] = Math.floor(parsed);
      }
    }
  }

  return {
    duplicateSuppressions: Number.isFinite(Number(value.duplicateSuppressions))
      ? Math.max(0, Math.floor(Number(value.duplicateSuppressions)))
      : 0,
    quarantineActivations: Number.isFinite(Number(value.quarantineActivations))
      ? Math.max(0, Math.floor(Number(value.quarantineActivations)))
      : 0,
    workerFailures: normalizeWorkerFailures(value.workerFailures),
    heartbeatMisses,
    healthyCycles
  };
}
export function normalizeUnsafeCondition(raw: unknown): UnsafeConditionRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.conditionId !== 'string' || typeof raw.code !== 'string' || typeof raw.message !== 'string') {
    return null;
  }

  return {
    conditionId: raw.conditionId,
    code: raw.code as UnsafeConditionCode,
    message: raw.message,
    blocking: raw.blocking !== false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    monotonicTsMs: Number.isFinite(Number(raw.monotonicTsMs))
      ? Math.floor(Number(raw.monotonicTsMs))
      : getMonotonicTimestampMs(),
    quarantineId: typeof raw.quarantineId === 'string' ? raw.quarantineId : undefined,
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    clearedAt: typeof raw.clearedAt === 'string' ? raw.clearedAt : undefined,
    clearedBy: typeof raw.clearedBy === 'string' ? raw.clearedBy : undefined,
    clearNote: typeof raw.clearNote === 'string' ? raw.clearNote : undefined
  };
}
export function normalizeQuarantine(raw: unknown): SafetyQuarantineRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (typeof raw.quarantineId !== 'string' || typeof raw.kind !== 'string' || typeof raw.reason !== 'string') {
    return null;
  }

  return {
    quarantineId: raw.quarantineId,
    kind: raw.kind as QuarantineKind,
    reason: raw.reason,
    integrityFailure: Boolean(raw.integrityFailure),
    autoRecoverable: raw.autoRecoverable !== false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    monotonicTsMs: Number.isFinite(Number(raw.monotonicTsMs))
      ? Math.floor(Number(raw.monotonicTsMs))
      : getMonotonicTimestampMs(),
    cooldownUntilMs: Number.isFinite(Number(raw.cooldownUntilMs))
      ? Math.floor(Number(raw.cooldownUntilMs))
      : undefined,
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    releasedAt: typeof raw.releasedAt === 'string' ? raw.releasedAt : undefined,
    releasedBy: typeof raw.releasedBy === 'string' ? raw.releasedBy : undefined,
    releaseNote: typeof raw.releaseNote === 'string' ? raw.releaseNote : undefined
  };
}
export function normalizeEntityKey(entityId: string): string {
  if (typeof entityId !== 'string' || !entityId.trim()) {
    return 'unknown';
  }
  const trimmed = entityId.trim();
  if (trimmed.length <= 128) {
    return trimmed;
  }
  // long/attacker-controlled keys are hashed to prevent unbounded memory growth
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  return `h:${hash}`;
}
export function canAcceptEntityKey(key: string): boolean {
  const existingKeys = new Set<string>([
    ...Object.keys(runtimeSnapshot.counters.healthyCycles),
    ...Object.keys(runtimeSnapshot.counters.heartbeatMisses),
    ...Object.keys(runtimeSnapshot.counters.workerFailures)
  ]);
  if (existingKeys.has(key)) {
    return true;
  }
  return existingKeys.size < MAX_ENTITY_KEYS;
}
export function conditionMatches(
  condition: UnsafeConditionRecord,
  code: UnsafeConditionCode,
  quarantineId?: string
): boolean {
  if (condition.code !== code) {
    return false;
  }
  if (!isConditionActive(condition)) {
    return false;
  }
  return condition.quarantineId === quarantineId;
}
