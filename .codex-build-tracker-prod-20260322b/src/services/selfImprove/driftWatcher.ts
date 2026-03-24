/**
 * Drift Watcher
 *
 * Ties to triggers:
 * - Self-test pipeline failures
 * - CLEAR score falling below minimum
 *
 * It does NOT apply changes; it only signals the controller.
 */
import { aiLogger } from "@platform/logging/structuredLogging.js";

export interface DriftSignal {
  kind: 'none' | 'self_test_fail' | 'clear_drop';
  severity: 'low' | 'medium' | 'high';
  details: Record<string, unknown>;
}

export function evaluateDrift(input: {
  clearOverall?: number;
  clearMin?: number;
  selfTestFailed?: boolean;
  selfTestFailureCount?: number;
}): DriftSignal {
  const { clearOverall, clearMin, selfTestFailed, selfTestFailureCount } = input;

  if (selfTestFailed) {
    const sev: DriftSignal['severity'] = (selfTestFailureCount ?? 1) >= 3 ? 'high' : 'medium';
    return { kind: 'self_test_fail', severity: sev, details: { selfTestFailureCount } };
  }

  if (typeof clearOverall === 'number' && typeof clearMin === 'number' && clearOverall < clearMin) {
    const delta = clearMin - clearOverall;
    const sev: DriftSignal['severity'] = delta >= 1 ? 'high' : (delta >= 0.5 ? 'medium' : 'low');
    return { kind: 'clear_drop', severity: sev, details: { clearOverall, clearMin, delta } };
  }

  return { kind: 'none', severity: 'low', details: {} };
}

export function logDriftSignal(signal: DriftSignal) {
  if (signal.kind === 'none') return;
  aiLogger.warn("Drift signal detected", { module: "driftWatcher", ...signal });
}
