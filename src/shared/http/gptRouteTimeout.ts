const DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS = 6_000;
const MIN_GPT_ROUTE_HARD_TIMEOUT_MS = 5_000;
const MAX_GPT_ROUTE_HARD_TIMEOUT_MS = 60_000;
const DEFAULT_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS = 8_000;
const MAX_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS = 10_000;

export function resolveGptRouteHardTimeoutMs(
  options: {
    profile?: 'default' | 'dag_execution';
    defaultMsOverride?: number;
    minimumMsOverride?: number;
  } = {},
): number {
  const profile = options.profile ?? 'default';
  const normalizedDefaultMsOverride =
    typeof options.defaultMsOverride === 'number' &&
    Number.isFinite(options.defaultMsOverride) &&
    options.defaultMsOverride > 0
      ? Math.max(
          MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
          Math.min(MAX_GPT_ROUTE_HARD_TIMEOUT_MS, Math.trunc(options.defaultMsOverride))
        )
      : undefined;
  const normalizedMinimumMsOverride =
    typeof options.minimumMsOverride === 'number' &&
    Number.isFinite(options.minimumMsOverride) &&
    options.minimumMsOverride > 0
      ? Math.max(
          MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
          Math.min(MAX_GPT_ROUTE_HARD_TIMEOUT_MS, Math.trunc(options.minimumMsOverride))
        )
      : undefined;
  const envKey =
    profile === 'dag_execution'
      ? 'GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS'
      : 'GPT_ROUTE_HARD_TIMEOUT_MS';
  const configuredTimeoutMs = Number.parseInt(process.env[envKey] ?? '', 10);

  if (profile === 'dag_execution') {
    if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
      return Math.max(
        DEFAULT_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS,
        normalizedMinimumMsOverride ?? 0
      );
    }

    const resolvedTimeoutMs = Math.max(
      DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS,
      Math.min(MAX_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
    );
    return Math.max(resolvedTimeoutMs, normalizedMinimumMsOverride ?? 0);
  }

  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return Math.max(
      normalizedDefaultMsOverride ?? DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS,
      normalizedMinimumMsOverride ?? 0
    );
  }

  const resolvedTimeoutMs = Math.max(
    MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
    Math.min(MAX_GPT_ROUTE_HARD_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
  );
  return Math.max(resolvedTimeoutMs, normalizedMinimumMsOverride ?? 0);
}

export const GPT_ROUTE_HARD_TIMEOUT_BOUNDS = {
  defaultMs: DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS,
  minMs: MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
  maxMs: MAX_GPT_ROUTE_HARD_TIMEOUT_MS,
  dagExecutionDefaultMs: DEFAULT_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS,
  dagExecutionMaxMs: MAX_GPT_ROUTE_DAG_EXECUTION_HARD_TIMEOUT_MS,
} as const;
