import fs from 'fs';
import path from 'path';
import { createVersionId, getMonotonicTimestampMs } from './monotonicClock.js';
import { emitSafetyAuditEvent } from './auditEvents.js';
import crypto from 'crypto';

export type UnsafeConditionCode =
  | 'MEMORY_VERSION_MISMATCH'
  | 'PATTERN_INTEGRITY_FAILURE'
  | 'INTERPRETER_HEARTBEAT_LOSS'
  | 'POLICY_ENGINE_TIMEOUT_NO_FALLBACK'
  | 'WORKER_RESTART_THRESHOLD'
  | 'SAFETY_SUPERVISOR_FAILURE';

export type QuarantineKind = 'integrity' | 'worker' | 'policy' | 'memory' | 'generic';

export interface UnsafeConditionRecord {
  conditionId: string;
  code: UnsafeConditionCode;
  message: string;
  blocking: boolean;
  createdAt: string;
  monotonicTsMs: number;
  quarantineId?: string;
  metadata?: Record<string, unknown>;
  clearedAt?: string;
  clearedBy?: string;
  clearNote?: string;
}

export interface SafetyQuarantineRecord {
  quarantineId: string;
  kind: QuarantineKind;
  reason: string;
  integrityFailure: boolean;
  autoRecoverable: boolean;
  createdAt: string;
  monotonicTsMs: number;
  cooldownUntilMs?: number;
  metadata?: Record<string, unknown>;
  releasedAt?: string;
  releasedBy?: string;
  releaseNote?: string;
}

export interface WorkerFailureCounter {
  count: number;
  windowStartedMs: number;
  lastFailureMs: number;
}

export interface SafetyCounters {
  duplicateSuppressions: number;
  quarantineActivations: number;
  workerFailures: Record<string, WorkerFailureCounter>;
  heartbeatMisses: Record<string, number>;
  healthyCycles: Record<string, number>;
}

export interface SafetyRuntimeSnapshot {
  updatedAt: string;
  conditions: UnsafeConditionRecord[];
  quarantines: SafetyQuarantineRecord[];
  counters: SafetyCounters;
  trustedHashes: Record<string, string>;
}

interface UnsafeConditionInput {
  code: UnsafeConditionCode;
  message: string;
  blocking?: boolean;
  quarantineId?: string;
  metadata?: Record<string, unknown>;
}

interface QuarantineInput {
  kind: QuarantineKind;
  reason: string;
  integrityFailure: boolean;
  autoRecoverable?: boolean;
  cooldownMs?: number;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

const SAFETY_STATE_FILE = path.join(process.cwd(), 'memory', 'safety-runtime-state.json');
const SAVE_DEBOUNCE_MS = 100;
const MAX_ENTITY_KEYS = 1000;

let pendingSaveTimeout: NodeJS.Timeout | null = null;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDefaultSnapshot(): SafetyRuntimeSnapshot {
  return {
    updatedAt: new Date().toISOString(),
    conditions: [],
    quarantines: [],
    counters: {
      duplicateSuppressions: 0,
      quarantineActivations: 0,
      workerFailures: {},
      heartbeatMisses: {},
      healthyCycles: {}
    },
    trustedHashes: {}
  };
}

function ensureStateDirectory(): void {
  const dir = path.dirname(SAFETY_STATE_FILE);
  if (!fs.existsSync(dir)) {
    //audit Assumption: safety state directory may be missing on first boot; failure risk: snapshot persistence loss; expected invariant: directory exists before write; handling strategy: create recursively.
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeWorkerFailures(value: unknown): Record<string, WorkerFailureCounter> {
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

function normalizeCounters(value: unknown): SafetyCounters {
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

function normalizeUnsafeCondition(raw: unknown): UnsafeConditionRecord | null {
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

function normalizeQuarantine(raw: unknown): SafetyQuarantineRecord | null {
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

function normalizeEntityKey(entityId: string): string {
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

function canAcceptEntityKey(key: string): boolean {
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

function readStateFromDisk(): SafetyRuntimeSnapshot {
  try {
    if (!fs.existsSync(SAFETY_STATE_FILE)) {
      return createDefaultSnapshot();
    }

    const raw = fs.readFileSync(SAFETY_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return createDefaultSnapshot();
    }

    const conditions = Array.isArray(parsed.conditions)
      ? parsed.conditions
          .map(normalizeUnsafeCondition)
          .filter((item): item is UnsafeConditionRecord => item !== null)
      : [];
    const quarantines = Array.isArray(parsed.quarantines)
      ? parsed.quarantines
          .map(normalizeQuarantine)
          .filter((item): item is SafetyQuarantineRecord => item !== null)
      : [];

    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      conditions,
      quarantines,
      counters: normalizeCounters(parsed.counters),
      trustedHashes: isRecord(parsed.trustedHashes)
        ? Object.entries(parsed.trustedHashes).reduce<Record<string, string>>((accumulator, entry) => {
            const [key, value] = entry;
            if (typeof value === 'string' && value.length > 0) {
              accumulator[key] = value;
            }
            return accumulator;
          }, {})
        : {}
    };
  } catch {
    //audit Assumption: malformed safety snapshot must not crash boot; failure risk: unavailable control plane; expected invariant: in-memory defaults available; handling strategy: fallback to defaults.
    return createDefaultSnapshot();
  }
}

let runtimeSnapshot: SafetyRuntimeSnapshot = readStateFromDisk();

async function flushStateToDisk(reason?: string): Promise<void> {
  try {
    ensureStateDirectory();
    await fs.promises.writeFile(SAFETY_STATE_FILE, JSON.stringify(runtimeSnapshot, null, 2), 'utf8');
    emitSafetyAuditEvent({
      event: 'runtime_state_persisted',
      severity: 'info',
      details: { reason: reason || 'scheduled_flush', updatedAt: runtimeSnapshot.updatedAt }
    });
  } catch (err) {
    emitSafetyAuditEvent({
      event: 'runtime_state_persist_failed',
      severity: 'error',
      details: { reason: reason || 'scheduled_flush', error: String(err) }
    });
  }
}

function scheduleSave(reason: string): void {
  runtimeSnapshot.updatedAt = new Date().toISOString();
  if (pendingSaveTimeout) {
    clearTimeout(pendingSaveTimeout);
  }
  pendingSaveTimeout = setTimeout(() => {
    void flushStateToDisk(reason);
    pendingSaveTimeout = null;
  }, SAVE_DEBOUNCE_MS);
  emitSafetyAuditEvent({
    event: 'runtime_state_persist_scheduled',
    severity: 'debug',
    details: { reason, updatedAt: runtimeSnapshot.updatedAt }
  });
}

function saveState(reason: string): void {
  // non-blocking coalesced persistence to reduce sync I/O DoS risk
  scheduleSave(reason);
}

function isConditionActive(condition: UnsafeConditionRecord): boolean {
  return !condition.clearedAt;
}

function isQuarantineActive(quarantine: SafetyQuarantineRecord): boolean {
  return !quarantine.releasedAt;
}

function conditionMatches(
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

/**
 * Purpose: Return full runtime safety snapshot for status and diagnostics.
 * Inputs/Outputs: No inputs; returns immutable snapshot clone.
 * Edge cases: Clone prevents external mutation of in-memory state.
 */
export function getSafetyRuntimeSnapshot(): SafetyRuntimeSnapshot {
  return cloneJson(runtimeSnapshot);
}

/**
 * Purpose: Return currently active unsafe conditions.
 * Inputs/Outputs: Optional filter by condition code; returns active list.
 * Edge cases: Excludes previously cleared historical entries.
 */
export function getActiveUnsafeConditions(code?: UnsafeConditionCode): UnsafeConditionRecord[] {
  return runtimeSnapshot.conditions.filter(condition => {
    //audit Assumption: only uncleared conditions should block writes; failure risk: stale historical condition triggers false blocks; expected invariant: active list excludes cleared; handling strategy: active check first.
    if (!isConditionActive(condition)) {
      return false;
    }
    //audit Assumption: optional code filter narrows query scope; failure risk: accidental over-filtering; expected invariant: return all active when no filter; handling strategy: conditional filter.
    return code ? condition.code === code : true;
  });
}

/**
 * Purpose: Return currently active quarantine records.
 * Inputs/Outputs: Optional quarantine kind; returns active quarantine list.
 * Edge cases: Released quarantines remain in history but are excluded.
 */
export function getActiveQuarantines(kind?: QuarantineKind): SafetyQuarantineRecord[] {
  return runtimeSnapshot.quarantines.filter(record => {
    if (!isQuarantineActive(record)) {
      return false;
    }
    return kind ? record.kind === kind : true;
  });
}

/**
 * Purpose: Determine whether system is unsafe for mutating execution.
 * Inputs/Outputs: No inputs; returns boolean unsafe flag.
 * Edge cases: Only blocking active conditions trigger unsafe=true.
 */
export function hasUnsafeBlockingConditions(): boolean {
  return runtimeSnapshot.conditions.some(condition => isConditionActive(condition) && condition.blocking);
}

/**
 * Purpose: Activate an unsafe condition with deduplication.
 * Inputs/Outputs: Condition descriptor; returns active condition record.
 * Edge cases: Existing active condition with same code/quarantine is reused.
 */
export function activateUnsafeCondition(input: UnsafeConditionInput): UnsafeConditionRecord {
  const existing = runtimeSnapshot.conditions.find(condition =>
    conditionMatches(condition, input.code, input.quarantineId)
  );
  //audit Assumption: duplicate active condition should not fan out alerts; failure risk: alert storms and noisy state churn; expected invariant: one active condition per code/quarantine pair; handling strategy: reuse existing condition.
  if (existing) {
    return existing;
  }

  const condition: UnsafeConditionRecord = {
    conditionId: createVersionId('unsafe-condition'),
    code: input.code,
    message: input.message,
    blocking: input.blocking !== false,
    createdAt: new Date().toISOString(),
    monotonicTsMs: getMonotonicTimestampMs(),
    quarantineId: input.quarantineId,
    metadata: input.metadata
  };

  runtimeSnapshot.conditions.push(condition);
  saveState('activateUnsafeCondition');
  emitSafetyAuditEvent({
    event: 'unsafe_condition_activated',
    severity: 'warn',
    details: {
      conditionId: condition.conditionId,
      code: condition.code,
      quarantineId: condition.quarantineId
    }
  });
  return condition;
}

/**
 * Purpose: Clear an active unsafe condition by ID.
 * Inputs/Outputs: Condition ID + actor metadata; returns true if cleared.
 * Edge cases: No-op false when condition is missing or already cleared.
 */
export function clearUnsafeCondition(
  conditionId: string,
  actor: string,
  clearNote?: string
): boolean {
  const condition = runtimeSnapshot.conditions.find(record => record.conditionId === conditionId);
  //audit Assumption: condition must exist before clear; failure risk: false success signal; expected invariant: only existing active conditions are cleared; handling strategy: return false on missing/inactive.
  if (!condition || !isConditionActive(condition)) {
    return false;
  }

  condition.clearedAt = new Date().toISOString();
  condition.clearedBy = actor;
  condition.clearNote = clearNote;
  saveState('clearUnsafeCondition');
  emitSafetyAuditEvent({
    event: 'unsafe_condition_cleared',
    severity: 'info',
    details: { conditionId, actor, clearNote }
  });
  return true;
}

/**
 * Purpose: Clear all active unsafe conditions that match a quarantine ID.
 * Inputs/Outputs: Quarantine ID + actor; returns number of cleared conditions.
 * Edge cases: Returns 0 when no linked active conditions exist.
 */
export function clearUnsafeConditionsByQuarantine(
  quarantineId: string,
  actor: string,
  clearNote?: string
): number {
  let clearedCount = 0;
  for (const condition of runtimeSnapshot.conditions) {
    if (!isConditionActive(condition)) {
      continue;
    }
    if (condition.quarantineId !== quarantineId) {
      continue;
    }
    condition.clearedAt = new Date().toISOString();
    condition.clearedBy = actor;
    condition.clearNote = clearNote;
    clearedCount += 1;
  }

  if (clearedCount > 0) {
    saveState('clearUnsafeConditionsByQuarantine');
    emitSafetyAuditEvent({
      event: 'unsafe_conditions_cleared_by_quarantine',
      severity: 'info',
      details: { quarantineId, actor, clearedCount }
    });
  }
  return clearedCount;
}

/**
 * Purpose: Register a quarantine record and persist it.
 * Inputs/Outputs: Quarantine descriptor; returns active quarantine record.
 * Edge cases: Dedupe key prevents duplicate active quarantines for same failure.
 */
export function registerQuarantine(input: QuarantineInput): SafetyQuarantineRecord {
  if (input.dedupeKey) {
    const existing = runtimeSnapshot.quarantines.find(record => {
      if (!isQuarantineActive(record)) {
        return false;
      }
      const existingKey = record.metadata?.dedupeKey;
      return typeof existingKey === 'string' && existingKey === input.dedupeKey;
    });
    //audit Assumption: dedupe key uniquely identifies an active quarantine class; failure risk: duplicate quarantines for same incident; expected invariant: active dedupe collisions reuse existing quarantine; handling strategy: short-circuit return.
    if (existing) {
      return existing;
    }
  }

  const nowMs = getMonotonicTimestampMs();
  const quarantine: SafetyQuarantineRecord = {
    quarantineId: createVersionId('quarantine'),
    kind: input.kind,
    reason: input.reason,
    integrityFailure: input.integrityFailure,
    autoRecoverable: input.autoRecoverable !== false,
    createdAt: new Date().toISOString(),
    monotonicTsMs: nowMs,
    cooldownUntilMs: input.cooldownMs && input.cooldownMs > 0 ? nowMs + input.cooldownMs : undefined,
    metadata: {
      ...(input.metadata || {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {})
    }
  };

  runtimeSnapshot.quarantines.push(quarantine);
  runtimeSnapshot.counters.quarantineActivations += 1;
  saveState('registerQuarantine');
  emitSafetyAuditEvent({
    event: 'quarantine_registered',
    severity: 'warn',
    details: {
      quarantineId: quarantine.quarantineId,
      kind: quarantine.kind,
      integrityFailure: quarantine.integrityFailure
    }
  });
  return quarantine;
}

/**
 * Purpose: Release an active quarantine record.
 * Inputs/Outputs: Quarantine ID and actor details; returns release status.
 * Edge cases: integrityOnly prevents releasing non-integrity quarantine classes.
 */
export function releaseQuarantine(
  quarantineId: string,
  options: { actor: string; releaseNote?: string; integrityOnly?: boolean }
): { released: boolean; reason?: string; quarantine?: SafetyQuarantineRecord } {
  const quarantine = runtimeSnapshot.quarantines.find(record => record.quarantineId === quarantineId);
  //audit Assumption: unknown quarantine IDs should not be treated as success; failure risk: false operator confirmations; expected invariant: missing IDs return not_found; handling strategy: explicit reason payload.
  if (!quarantine) {
    return { released: false, reason: 'not_found' };
  }
  //audit Assumption: released quarantine must remain immutable after release; failure risk: repeated release side effects; expected invariant: second release rejected; handling strategy: return already_released.
  if (!isQuarantineActive(quarantine)) {
    return { released: false, reason: 'already_released', quarantine };
  }
  //audit Assumption: integrityOnly release endpoint must not release non-integrity quarantines; failure risk: bypassing auto-recovery safety policy; expected invariant: integrity class check enforced; handling strategy: reject with reason.
  if (options.integrityOnly && !quarantine.integrityFailure) {
    return { released: false, reason: 'not_integrity', quarantine };
  }

  quarantine.releasedAt = new Date().toISOString();
  quarantine.releasedBy = options.actor;
  quarantine.releaseNote = options.releaseNote;
  clearUnsafeConditionsByQuarantine(quarantineId, options.actor, options.releaseNote);
  saveState('releaseQuarantine');
  emitSafetyAuditEvent({
    event: 'quarantine_released',
    severity: 'info',
    details: {
      quarantineId,
      actor: options.actor,
      integrityFailure: quarantine.integrityFailure
    }
  });
  return { released: true, quarantine };
}

/**
 * Purpose: Increment duplicate suppression counter for lock collisions.
 * Inputs/Outputs: Lock key; returns updated duplicate suppression count.
 * Edge cases: Counter is monotonic and persisted for diagnostics.
 */
export function recordDuplicateSuppression(lockKey: string): number {
  runtimeSnapshot.counters.duplicateSuppressions += 1;
  saveState('recordDuplicateSuppression');
  emitSafetyAuditEvent({
    event: 'duplicate_suppression',
    severity: 'warn',
    details: {
      lockKey,
      duplicateSuppressions: runtimeSnapshot.counters.duplicateSuppressions
    }
  });
  return runtimeSnapshot.counters.duplicateSuppressions;
}

/**
 * Purpose: Increment worker failure counter in a bounded restart window.
 * Inputs/Outputs: Worker ID + threshold/window; returns count and exceeded flag.
 * Edge cases: Counter resets when failure falls outside active window.
 */
export function incrementWorkerFailure(
  workerId: string,
  threshold: number,
  windowMs: number
): { count: number; exceeded: boolean } {
  const nowMs = getMonotonicTimestampMs();
  const key = normalizeEntityKey(workerId);
  if (!canAcceptEntityKey(key)) {
    emitSafetyAuditEvent({
      event: 'entity_key_limit_reached',
      severity: 'warn',
      details: { entityId: key, threshold: MAX_ENTITY_KEYS }
    });
    return { count: 0, exceeded: false };
  }

  const existing = runtimeSnapshot.counters.workerFailures[key];

  //audit Assumption: failures outside restart window should reset count; failure risk: stale failures causing false quarantine; expected invariant: window-bounded counters; handling strategy: reset when expired.
  if (!existing || nowMs - existing.windowStartedMs > windowMs) {
    runtimeSnapshot.counters.workerFailures[key] = {
      count: 1,
      windowStartedMs: nowMs,
      lastFailureMs: nowMs
    };
  } else {
    existing.count += 1;
    existing.lastFailureMs = nowMs;
  }

  saveState('incrementWorkerFailure');
  const count = runtimeSnapshot.counters.workerFailures[key].count;
  return { count, exceeded: count >= threshold };
}

/**
 * Purpose: Reset worker failure and heartbeat counters after recovery.
 * Inputs/Outputs: Worker/engine ID; no return value.
 * Edge cases: No-op when counters do not exist.
 */
export function resetFailureSignals(entityId: string): void {
  const key = normalizeEntityKey(entityId);
  delete runtimeSnapshot.counters.workerFailures[key];
  delete runtimeSnapshot.counters.heartbeatMisses[key];
  runtimeSnapshot.counters.healthyCycles[key] = 0;
  saveState('resetFailureSignals');
}

/**
 * Purpose: Increment heartbeat miss counter for a supervised entity.
 * Inputs/Outputs: Entity ID and miss threshold; returns count and threshold flag.
 * Edge cases: Missing entity counter starts at zero.
 */
export function incrementHeartbeatMiss(
  entityId: string,
  threshold: number
): { count: number; exceeded: boolean } {
  const key = normalizeEntityKey(entityId);
  if (!canAcceptEntityKey(key)) {
    emitSafetyAuditEvent({
      event: 'entity_key_limit_reached',
      severity: 'warn',
      details: { entityId: key, threshold: MAX_ENTITY_KEYS }
    });
    return { count: 0, exceeded: false };
  }

  const current = runtimeSnapshot.counters.heartbeatMisses[key] || 0;
  const next = current + 1;
  runtimeSnapshot.counters.heartbeatMisses[key] = next;
  runtimeSnapshot.counters.healthyCycles[key] = 0;
  saveState('incrementHeartbeatMiss');
  return { count: next, exceeded: next >= threshold };
}

/**
 * Purpose: Record a healthy cycle for supervised recovery logic.
 * Inputs/Outputs: Entity ID; returns updated healthy cycle count.
 * Edge cases: Missing entity counter starts at one.
 */
export function incrementHealthyCycle(entityId: string): number {
  const key = normalizeEntityKey(entityId);
  if (!canAcceptEntityKey(key)) {
    emitSafetyAuditEvent({
      event: 'entity_key_limit_reached',
      severity: 'warn',
      details: { entityId: key, threshold: MAX_ENTITY_KEYS }
    });
    return 0;
  }

  const next = (runtimeSnapshot.counters.healthyCycles[key] || 0) + 1;
  runtimeSnapshot.counters.healthyCycles[key] = next;
  saveState('incrementHealthyCycle');
  return next;
}

/**
 * Purpose: Read trusted integrity hash baseline by protected ID.
 * Inputs/Outputs: Integrity ID; returns hash string or undefined.
 * Edge cases: Missing baseline returns undefined.
 */
export function getTrustedHash(integrityId: string): string | undefined {
  return runtimeSnapshot.trustedHashes[integrityId];
}

/**
 * Purpose: Set trusted integrity hash baseline for a protected ID.
 * Inputs/Outputs: Integrity ID + hash; no return value.
 * Edge cases: Empty hash is ignored to prevent baseline corruption.
 */
export function setTrustedHash(integrityId: string, hash: string): void {
  //audit Assumption: empty hashes are invalid trust baselines; failure risk: disabling integrity checks; expected invariant: non-empty hash required; handling strategy: ignore invalid hash writes.
  if (!hash || !hash.trim()) {
    return;
  }
  runtimeSnapshot.trustedHashes[integrityId] = hash.trim();
  saveState('setTrustedHash');
}

/**
 * Purpose: Build standard unsafe-to-proceed payload contract.
 * Inputs/Outputs: No inputs; returns HTTP payload object for 503 responses.
 * Edge cases: Includes only active blocking conditions/quarantines.
 */
export function buildUnsafeToProceedPayload(): {
  error: 'UNSAFE_TO_PROCEED';
  conditions: string[];
  quarantineIds: string[];
  timestamp: string;
} {
  const activeConditions = getActiveUnsafeConditions().filter(condition => condition.blocking);
  const activeQuarantines = getActiveQuarantines();
  return {
    error: 'UNSAFE_TO_PROCEED',
    conditions: activeConditions.map(condition => condition.code),
    quarantineIds: activeQuarantines.map(record => record.quarantineId),
    timestamp: new Date().toISOString()
  };
}

/**
 * Purpose: Reset in-memory and persisted safety state for isolated tests.
 * Inputs/Outputs: No inputs; no return value.
 * Edge cases: Missing state file is ignored.
 */
export function resetSafetyRuntimeStateForTests(): void {
  runtimeSnapshot = createDefaultSnapshot();
  try {
    if (fs.existsSync(SAFETY_STATE_FILE)) {
      fs.unlinkSync(SAFETY_STATE_FILE);
    }
  } catch {
    //audit Assumption: test reset should not throw on cleanup races; failure risk: flaky test teardown; expected invariant: in-memory state reset regardless of file cleanup; handling strategy: swallow unlink failures.
  }
}
