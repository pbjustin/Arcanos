const DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS = 6_000;
const MIN_GPT_ROUTE_HARD_TIMEOUT_MS = 5_000;
const MAX_GPT_ROUTE_HARD_TIMEOUT_MS = 6_000;

export function resolveGptRouteHardTimeoutMs(): number {
  const configuredTimeoutMs = Number.parseInt(process.env.GPT_ROUTE_HARD_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS;
  }

  return Math.max(
    MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
    Math.min(MAX_GPT_ROUTE_HARD_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
  );
}

export const GPT_ROUTE_HARD_TIMEOUT_BOUNDS = {
  defaultMs: DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS,
  minMs: MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
  maxMs: MAX_GPT_ROUTE_HARD_TIMEOUT_MS
} as const;
