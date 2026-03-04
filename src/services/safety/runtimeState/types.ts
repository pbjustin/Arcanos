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
