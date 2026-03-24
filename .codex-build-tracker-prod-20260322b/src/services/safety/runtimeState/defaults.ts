import type { SafetyRuntimeSnapshot } from './types.js';
export { isRecord } from '@shared/typeGuards.js';

/**
 * Purpose: Deep-clone runtime-state payloads through JSON serialization.
 * Inputs/Outputs: Serializable value in; detached clone out.
 * Edge cases: Preserves existing JSON-only semantics and intentionally drops non-JSON values.
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Purpose: Create the empty persisted runtime-state snapshot.
 * Inputs/Outputs: No inputs; returns a zeroed snapshot document.
 * Edge cases: Timestamp is generated at call time so fresh snapshots are always monotonic from the caller perspective.
 */
export function createDefaultSnapshot(): SafetyRuntimeSnapshot {
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
