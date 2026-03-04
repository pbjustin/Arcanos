import type { SafetyRuntimeSnapshot } from './types.js';

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
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
