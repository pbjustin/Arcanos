export const DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX = 100;
export const DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PUBLIC_PROVIDER_RATE_LIMIT_MAX = 1_000_000;
export const MAX_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function normalizePublicProviderRateLimitMax(value: unknown): number {
  return normalizeBoundedInteger(
    value,
    DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX,
    1,
    MAX_PUBLIC_PROVIDER_RATE_LIMIT_MAX
  );
}

export function normalizePublicProviderRateLimitWindowMs(value: unknown): number {
  return normalizeBoundedInteger(
    value,
    DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS,
    1000,
    MAX_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS
  );
}
