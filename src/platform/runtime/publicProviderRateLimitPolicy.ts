export const DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX = 100;
export const DEFAULT_PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX = 20;
export const DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PUBLIC_PROVIDER_RATE_LIMIT_MAX = 1_000_000;
export const MAX_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type PublicProviderRateLimitStoreMode = 'memory' | 'redis';

const PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

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

export function normalizePublicProviderClientRateLimitMax(
  value: unknown,
  globalMaximum: number
): number {
  const normalizedGlobalMaximum = normalizePublicProviderRateLimitMax(globalMaximum);
  const maximum = Math.max(1, normalizedGlobalMaximum - 1);
  const fallback = Math.min(DEFAULT_PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX, maximum);
  return normalizeBoundedInteger(value, fallback, 1, maximum);
}

export function normalizePublicProviderRateLimitWindowMs(value: unknown): number {
  return normalizeBoundedInteger(
    value,
    DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS,
    1000,
    MAX_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS
  );
}

/** Production provider admissions always use the shared Redis lifecycle. */
export function normalizePublicProviderRateLimitStoreMode(
  value: unknown,
  nodeEnvironment: string
): PublicProviderRateLimitStoreMode {
  if (nodeEnvironment.trim().toLowerCase() === 'production') {
    return 'redis';
  }

  return typeof value === 'string' && value.trim().toLowerCase() === 'redis'
    ? 'redis'
    : 'memory';
}

export interface PublicProviderRateLimitNamespaceInput {
  configuredNamespace?: string;
  nodeEnvironment: string;
  railwayProjectId?: string;
  railwayEnvironmentId?: string;
  railwayServiceId?: string;
}

export interface PublicProviderRailwayRealIpTrustInput {
  railwayProjectId?: string;
  railwayEnvironmentId?: string;
  railwayServiceId?: string;
}

/** Require exact opt-in plus the complete Railway service identity tuple. */
export function resolvePublicProviderTrustRailwayRealIp(
  value: unknown,
  input: PublicProviderRailwayRealIpTrustInput
): boolean {
  const railwayIdentityComplete = [
    input.railwayProjectId,
    input.railwayEnvironmentId,
    input.railwayServiceId,
  ].every((part) => typeof part === 'string' && part.trim().length > 0);
  return railwayIdentityComplete
    && typeof value === 'string'
    && value.trim().toLowerCase() === 'true';
}

/**
 * Resolve a stable deployment namespace without using deploy- or commit-scoped
 * identifiers that would reset the shared window during a rollout.
 */
export function resolvePublicProviderRateLimitNamespace(
  input: PublicProviderRateLimitNamespaceInput
): string | null {
  const railwayParts = [
    input.railwayProjectId?.trim(),
    input.railwayEnvironmentId?.trim(),
    input.railwayServiceId?.trim(),
  ];
  if (railwayParts.every((value): value is string => Boolean(value))) {
    return `railway:${railwayParts.join(':')}`;
  }

  const configuredNamespace = input.configuredNamespace?.trim().toLowerCase();
  if (configuredNamespace) {
    return PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE_PATTERN.test(configuredNamespace)
      ? `configured:${configuredNamespace}`
      : null;
  }

  const nodeEnvironment = input.nodeEnvironment.trim().toLowerCase() || 'development';
  return nodeEnvironment === 'production' ? null : `local:${nodeEnvironment}`;
}
