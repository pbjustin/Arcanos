import { getEnv } from "@platform/runtime/env.js";

export type RedisConnectionSource = 'REDIS_URL' | 'discrete' | 'none';

export interface RedisConnectionResolution {
  configured: boolean;
  source: RedisConnectionSource;
  url?: string;
}

function normalizeRedisEnvValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function isUsableRedisUrl(urlValue: string): boolean {
  try {
    const parsedRedisUrl = new URL(urlValue);
    return parsedRedisUrl.protocol === 'redis:' && Boolean(parsedRedisUrl.hostname);
  } catch {
    return false;
  }
}

function buildRedisUrlFromDiscreteEnv(): string | undefined {
  const redisHost = normalizeRedisEnvValue(getEnv('REDISHOST') || getEnv('REDIS_HOST'));

  //audit Assumption: discrete Redis connection settings are unusable without a host; failure risk: malformed health and runtime URLs; expected invariant: only host-complete discrete configs produce a URL; handling strategy: return undefined until host is present.
  if (!redisHost) {
    return undefined;
  }

  const redisPort = normalizeRedisEnvValue(getEnv('REDISPORT') || getEnv('REDIS_PORT')) || '6379';
  const redisUsername = normalizeRedisEnvValue(getEnv('REDISUSER') || getEnv('REDIS_USER')) || '';
  const redisPassword = normalizeRedisEnvValue(getEnv('REDISPASSWORD') || getEnv('REDIS_PASSWORD')) || '';

  const encodedRedisUsername = encodeURIComponent(redisUsername);
  const encodedRedisPassword = encodeURIComponent(redisPassword);

  //audit Assumption: Redis auth sections vary between username/password, password-only, and anonymous deployments; failure risk: invalid authority segment breaks all connections; expected invariant: emitted auth segment matches only the configured credentials; handling strategy: branch explicitly by credential shape.
  const redisAuthSegment = redisUsername
    ? `${encodedRedisUsername}:${encodedRedisPassword}@`
    : redisPassword
      ? `:${encodedRedisPassword}@`
      : '';

  return `redis://${redisAuthSegment}${redisHost}:${redisPort}`;
}

/**
 * Resolve Redis connection settings from runtime environment variables.
 *
 * Purpose:
 * - Centralize Railway-compatible Redis env resolution for health checks and services.
 *
 * Inputs/outputs:
 * - Input: none; reads runtime env through the config boundary.
 * - Output: normalized Redis connection resolution with source metadata.
 *
 * Edge case behavior:
 * - Malformed `REDIS_URL` falls through to discrete env variables instead of throwing.
 */
export function resolveConfiguredRedisConnection(): RedisConnectionResolution {
  const directRedisUrl = normalizeRedisEnvValue(getEnv('REDIS_URL'));

  //audit Assumption: an explicit REDIS_URL should win when it parses as a usable redis endpoint; failure risk: a malformed direct URL blocks valid discrete Railway vars; expected invariant: valid direct URLs take precedence, invalid ones fall through; handling strategy: validate before selecting the direct source.
  if (directRedisUrl && isUsableRedisUrl(directRedisUrl)) {
    return {
      configured: true,
      source: 'REDIS_URL',
      url: directRedisUrl
    };
  }

  const discreteRedisUrl = buildRedisUrlFromDiscreteEnv();

  //audit Assumption: discrete Railway-style vars are the next-best source when REDIS_URL is absent or malformed; failure risk: Redis-ready deployments appear unconfigured; expected invariant: host-complete discrete configs resolve to a usable URL; handling strategy: emit a discrete resolution when available.
  if (discreteRedisUrl) {
    return {
      configured: true,
      source: 'discrete',
      url: discreteRedisUrl
    };
  }

  return {
    configured: false,
    source: 'none'
  };
}

/**
 * Resolve a Redis URL with a deterministic fallback.
 *
 * Purpose:
 * - Support subsystems that intentionally allow localhost Redis during local development.
 *
 * Inputs/outputs:
 * - Input: optional fallback Redis URL.
 * - Output: resolved configured URL or the provided fallback.
 *
 * Edge case behavior:
 * - Returns the fallback when Redis is not explicitly configured.
 */
export function resolveRedisUrlWithFallback(
  fallbackRedisUrl: string = 'redis://localhost:6379'
): string {
  const configuredRedisConnection = resolveConfiguredRedisConnection();

  //audit Assumption: some local-only workflows intentionally rely on a localhost fallback; failure risk: production unexpectedly targets localhost if configuration detection regresses; expected invariant: configured URLs always override the fallback; handling strategy: prefer explicit configuration and fall back only when none is present.
  if (configuredRedisConnection.url) {
    return configuredRedisConnection.url;
  }

  return fallbackRedisUrl;
}
