import { createHash } from 'crypto';
import { getMonotonicTimestampMs } from '../monotonicClock.js';
import { createDefaultSnapshot, isRecord } from './defaults.js';
import type {
  QuarantineKind,
  SafetyCounters,
  SafetyQuarantineRecord,
  UnsafeConditionCode,
  UnsafeConditionRecord,
  WorkerFailureCounter
} from './types.js';

export const DEFAULT_MAX_ENTITY_KEYS = 1000;

type EntityCounterMaps = Pick<SafetyCounters, 'healthyCycles' | 'heartbeatMisses' | 'workerFailures'>;

function normalizeNonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  //audit Assumption: counters require finite non-negative integers; failure risk: NaN and negative values corrupt state math; expected invariant: integer >= 0; handling strategy: reject invalid values.
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

/**
 * Purpose: Normalize persisted worker failure counters.
 * Inputs/Outputs: unknown JSON value -> validated worker-failure map.
 * Edge cases: malformed entries are dropped to protect runtime math.
 */
export function normalizeWorkerFailures(value: unknown): Record<string, WorkerFailureCounter> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, WorkerFailureCounter> = {};
  for (const [key, counter] of Object.entries(value)) {
    if (!isRecord(counter)) {
      continue;
    }

    const count = normalizeNonNegativeInteger(counter.count);
    const windowStartedMs = normalizeNonNegativeInteger(counter.windowStartedMs);
    const lastFailureMs = normalizeNonNegativeInteger(counter.lastFailureMs);
    //audit Assumption: a counter record is valid only when all fields are valid integers; failure risk: partial malformed records create inconsistent windows; expected invariant: complete triplet required; handling strategy: skip invalid record.
    if (count === null || windowStartedMs === null || lastFailureMs === null) {
      continue;
    }

    normalized[key] = {
      count,
      windowStartedMs,
      lastFailureMs
    };
  }

  return normalized;
}

/**
 * Purpose: Normalize safety counters payload from disk.
 * Inputs/Outputs: unknown JSON value -> safe counters object.
 * Edge cases: missing maps default to empty maps; invalid scalars default to zero.
 */
export function normalizeCounters(value: unknown): SafetyCounters {
  if (!isRecord(value)) {
    return createDefaultSnapshot().counters;
  }

  const heartbeatMisses: Record<string, number> = {};
  const healthyCycles: Record<string, number> = {};

  if (isRecord(value.heartbeatMisses)) {
    for (const [key, raw] of Object.entries(value.heartbeatMisses)) {
      const parsed = normalizeNonNegativeInteger(raw);
      if (parsed !== null) {
        heartbeatMisses[key] = parsed;
      }
    }
  }

  if (isRecord(value.healthyCycles)) {
    for (const [key, raw] of Object.entries(value.healthyCycles)) {
      const parsed = normalizeNonNegativeInteger(raw);
      if (parsed !== null) {
        healthyCycles[key] = parsed;
      }
    }
  }

  return {
    duplicateSuppressions: normalizeNonNegativeInteger(value.duplicateSuppressions) ?? 0,
    quarantineActivations: normalizeNonNegativeInteger(value.quarantineActivations) ?? 0,
    workerFailures: normalizeWorkerFailures(value.workerFailures),
    heartbeatMisses,
    healthyCycles
  };
}

/**
 * Purpose: Normalize one unsafe-condition record from persisted state.
 * Inputs/Outputs: unknown JSON value -> validated unsafe condition or null.
 * Edge cases: missing required identifiers or text fields return null.
 */
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
    monotonicTsMs: normalizeNonNegativeInteger(raw.monotonicTsMs) ?? getMonotonicTimestampMs(),
    quarantineId: typeof raw.quarantineId === 'string' ? raw.quarantineId : undefined,
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    clearedAt: typeof raw.clearedAt === 'string' ? raw.clearedAt : undefined,
    clearedBy: typeof raw.clearedBy === 'string' ? raw.clearedBy : undefined,
    clearNote: typeof raw.clearNote === 'string' ? raw.clearNote : undefined
  };
}

/**
 * Purpose: Normalize one quarantine record from persisted state.
 * Inputs/Outputs: unknown JSON value -> validated quarantine or null.
 * Edge cases: malformed kind/reason/id records return null.
 */
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
    monotonicTsMs: normalizeNonNegativeInteger(raw.monotonicTsMs) ?? getMonotonicTimestampMs(),
    cooldownUntilMs: normalizeNonNegativeInteger(raw.cooldownUntilMs) ?? undefined,
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    releasedAt: typeof raw.releasedAt === 'string' ? raw.releasedAt : undefined,
    releasedBy: typeof raw.releasedBy === 'string' ? raw.releasedBy : undefined,
    releaseNote: typeof raw.releaseNote === 'string' ? raw.releaseNote : undefined
  };
}

/**
 * Purpose: Normalize entity IDs used as counter keys to a bounded storage-safe value.
 * Inputs/Outputs: raw entity ID string -> stable normalized key.
 * Edge cases: empty IDs normalize to "unknown" and oversized IDs are SHA-256 hashed.
 */
export function normalizeEntityKey(entityId: string): string {
  if (typeof entityId !== 'string' || entityId.trim().length === 0) {
    return 'unknown';
  }

  const trimmed = entityId.trim();
  if (trimmed.length <= 128) {
    return trimmed;
  }

  //audit Assumption: oversized attacker-controlled IDs should not become map keys directly; failure risk: memory growth via key flooding; expected invariant: bounded key length; handling strategy: hash long keys.
  const hash = createHash('sha256').update(trimmed).digest('hex');
  return `h:${hash}`;
}

/**
 * Purpose: Decide whether a new entity key can be accepted under key-cardinality limits.
 * Inputs/Outputs: key + optional current counters + optional max size -> boolean.
 * Edge cases: when counters are omitted, returns true for backwards compatibility.
 */
export function canAcceptEntityKey(
  key: string,
  counters?: EntityCounterMaps,
  maxEntityKeys: number = DEFAULT_MAX_ENTITY_KEYS
): boolean {
  if (!counters) {
    return true;
  }

  const boundedMax = Math.max(1, Math.floor(maxEntityKeys));
  const existingKeys = new Set<string>([
    ...Object.keys(counters.healthyCycles),
    ...Object.keys(counters.heartbeatMisses),
    ...Object.keys(counters.workerFailures)
  ]);

  if (existingKeys.has(key)) {
    return true;
  }

  return existingKeys.size < boundedMax;
}

/**
 * Purpose: Check whether a condition is active and matches code/quarantine filters.
 * Inputs/Outputs: condition + target code + optional quarantine ID -> boolean match.
 * Edge cases: cleared conditions never match.
 */
export function conditionMatches(
  condition: UnsafeConditionRecord,
  code: UnsafeConditionCode,
  quarantineId?: string
): boolean {
  if (condition.code !== code) {
    return false;
  }

  if (condition.clearedAt) {
    return false;
  }

  return condition.quarantineId === quarantineId;
}
