/**
 * Centralized watchdog timeout configuration.
 * Model-aware adaptive timeouts with budget-safe clamping.
 */

import { WATCHDOG_LIMIT_MS, SAFETY_BUFFER_MS } from '../../runtime/runtimeBudget.js';

export const TIMEOUT_MAP: Record<string, number> = {
  "gpt-5": 60_000,
  "gpt-5.1": 60_000,
  "gpt-4o": 35_000,
  "gpt-3.5-turbo": 25_000,
  "finetune": 30_000,
  "default": 30_000
};

const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT = Math.max(MIN_TIMEOUT_MS, WATCHDOG_LIMIT_MS - SAFETY_BUFFER_MS);

const normalizeModel = (model: string): string => {
  const normalized = (model || '').toLowerCase();
  if (normalized.startsWith('gpt-5')) {
    return 'gpt-5';
  }
  return normalized;
};

export function resolveTimeout(model: string, _reasoningDepth = 1): number {
  const key = normalizeModel(model);
  const configured = TIMEOUT_MAP[key] ?? TIMEOUT_MAP.default;
  return Math.max(MIN_TIMEOUT_MS, Math.min(configured, MAX_TIMEOUT));
}
