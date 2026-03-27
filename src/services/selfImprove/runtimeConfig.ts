import { getEnvNumber } from '@platform/runtime/env.js';

const DEFAULT_PREDICTIVE_LOOP_INTERVAL_MS = 30_000;

export function resolvePredictiveHealingLoopIntervalMs(
  fallbackIntervalMs = DEFAULT_PREDICTIVE_LOOP_INTERVAL_MS
): number {
  const predictiveIntervalMs = getEnvNumber('PREDICTIVE_HEALING_INTERVAL_MS', Number.NaN);
  if (Number.isFinite(predictiveIntervalMs)) {
    return Math.max(1_000, predictiveIntervalMs);
  }

  return Math.max(1_000, getEnvNumber('SELF_HEAL_LOOP_INTERVAL_MS', fallbackIntervalMs));
}
