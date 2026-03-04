/**
 * Centralized watchdog timeout configuration.
 * Model-aware adaptive timeouts with budget-safe clamping.
 */

import { WATCHDOG_LIMIT_MS, SAFETY_BUFFER_MS } from '@platform/resilience/runtimeBudget.js';
import { parseEnvInteger } from '@platform/runtime/envParsers.js';

const MIN_TIMEOUT_MS = 1_000;

function resolveModelTimeoutEnv(varName: string, fallback: number): number {
  //audit Assumption: timeout env values may be absent/invalid in production; risk: NaN or sub-second watchdog windows causing false aborts; invariant: timeout remains >= MIN_TIMEOUT_MS; handling: parse with bounded fallback.
  return parseEnvInteger(process.env[varName], fallback, {
    minimum: MIN_TIMEOUT_MS,
    roundingMode: 'floor'
  });
}

export const TIMEOUT_MAP: Record<string, number> = {
  "gpt-5": resolveModelTimeoutEnv('TRINITY_TIMEOUT_GPT5_MS', 60_000),
  "gpt-5.1": resolveModelTimeoutEnv('TRINITY_TIMEOUT_GPT51_MS', resolveModelTimeoutEnv('TRINITY_TIMEOUT_GPT5_MS', 60_000)),
  "gpt-4o": resolveModelTimeoutEnv('TRINITY_TIMEOUT_GPT4O_MS', 35_000),
  "gpt-3.5-turbo": resolveModelTimeoutEnv('TRINITY_TIMEOUT_GPT35_MS', 25_000),
  "finetune": resolveModelTimeoutEnv('TRINITY_TIMEOUT_FINETUNE_MS', 30_000),
  "default": resolveModelTimeoutEnv('TRINITY_TIMEOUT_DEFAULT_MS', 30_000)
};

export const MAX_TIMEOUT = Math.max(MIN_TIMEOUT_MS, WATCHDOG_LIMIT_MS - SAFETY_BUFFER_MS);

const normalizeModel = (model: string): string => {
  const normalized = (model || '').toLowerCase();
  //audit Assumption: GPT-5 variants should share the same watchdog class by default; risk: missing per-variant map entries; invariant: normalized key resolves to known timeout bucket; handling: collapse to gpt-5 umbrella.
  if (normalized.startsWith('gpt-5')) {
    return 'gpt-5';
  }
  return normalized;
};

/**
 * Resolve watchdog timeout for a model while respecting global runtime budget limits.
 * Inputs/Outputs: model name (+ optional reasoning depth placeholder) -> bounded timeout milliseconds.
 * Edge cases: unknown model names fall back to default timeout bucket, always clamped to [MIN_TIMEOUT_MS, MAX_TIMEOUT].
 */
export function resolveTimeout(model: string, _reasoningDepth = 1): number {
  const key = normalizeModel(model);
  const configured = TIMEOUT_MAP[key] ?? TIMEOUT_MAP.default;
  return Math.max(MIN_TIMEOUT_MS, Math.min(configured, MAX_TIMEOUT));
}
