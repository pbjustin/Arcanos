import { getEnv } from '@platform/runtime/env.js';
import { parseEnvInteger } from '@platform/runtime/envParsers.js';

export const QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME =
  'ARCANOS_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS';
export const DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS = 12_000;
export const MIN_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS = 1_000;
export const MAX_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS = 25_000;

export interface QueryFinetuneAttemptLatencyBudgetDiagnostics {
  envName: string;
  configuredValue: string | null;
  resolvedValueMs: number;
  defaultValueMs: number;
  minimumValueMs: number;
  maximumValueMs: number;
  source: 'default' | 'environment' | 'invalid-environment-fallback';
  usedFallbackDefault: boolean;
}

function isValidConfiguredQueryFinetuneAttemptLatencyBudget(
  configuredValue: string | null
): boolean {
  if (configuredValue === null) {
    return false;
  }

  const parsedConfiguredValue = Number(configuredValue);

  //audit Assumption: only finite integers inside the bounded operational window should count as accepted operator overrides; failure risk: malformed values are logged as active production settings and mislead incident review; expected invariant: diagnostics mark an override as valid only when the route would actually honor it; handling strategy: mirror the parser bounds with an explicit validity check before classifying the source.
  return (
    Number.isFinite(parsedConfiguredValue) &&
    Math.floor(parsedConfiguredValue) >= MIN_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS &&
    Math.floor(parsedConfiguredValue) <= MAX_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS &&
    Math.floor(parsedConfiguredValue) !== 0
  );
}

/**
 * Purpose: resolve the `/query-finetune` per-attempt latency budget and expose enough metadata for startup diagnostics.
 * Inputs/Outputs: process environment -> normalized latency budget diagnostics with raw env visibility and bounded defaults.
 * Edge cases: missing, non-numeric, or out-of-range environment overrides fall back to the safe default while preserving the raw configured value for auditing.
 */
export function getQueryFinetuneAttemptLatencyBudgetDiagnostics(): QueryFinetuneAttemptLatencyBudgetDiagnostics {
  const configuredValue = getEnv(QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME) ?? null;
  const resolvedValueMs = parseEnvInteger(
    configuredValue ?? undefined,
    DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
    {
      allowZero: false,
      minimum: MIN_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
      maximum: MAX_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
      roundingMode: 'floor'
    }
  );

  const source = configuredValue === null
    ? 'default'
    : isValidConfiguredQueryFinetuneAttemptLatencyBudget(configuredValue)
      ? 'environment'
      : 'invalid-environment-fallback';

  return {
    envName: QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_ENV_NAME,
    configuredValue,
    resolvedValueMs,
    defaultValueMs: DEFAULT_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
    minimumValueMs: MIN_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
    maximumValueMs: MAX_QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS,
    source,
    usedFallbackDefault: source !== 'environment'
  };
}

/**
 * Purpose: provide the normalized `/query-finetune` per-attempt latency budget to request handlers.
 * Inputs/Outputs: process environment -> bounded millisecond budget.
 * Edge cases: invalid overrides fall back to the default budget exposed by the diagnostics helper.
 */
export function resolveQueryFinetuneAttemptLatencyBudgetMs(): number {
  return getQueryFinetuneAttemptLatencyBudgetDiagnostics().resolvedValueMs;
}
