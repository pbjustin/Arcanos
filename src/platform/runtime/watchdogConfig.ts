/**
 * Centralized watchdog timeout configuration.
 * Model-aware adaptive timeouts with reasoning depth scaling.
 */

export const TIMEOUT_MAP: Record<string, number> = {
  "gpt-5": 45000,
  "gpt-4o": 35000,
  "gpt-3.5-turbo": 25000,
  "finetune": 30000,
  "default": 30000
};

export const MAX_TIMEOUT = 60000;

export function resolveTimeout(model: string, reasoningDepth = 1): number {
  const base = TIMEOUT_MAP[model] ?? TIMEOUT_MAP["default"];
  const multiplier = Math.min(reasoningDepth, 3);
  const resolved = base + (multiplier * 5000);
  return Math.min(resolved, MAX_TIMEOUT);
}
