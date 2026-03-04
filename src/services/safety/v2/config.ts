/**
 * v2 Trust Verification — Configuration
 *
 * Required env vars:
 *   REDIS_URL       — Redis connection string (e.g. redis://localhost:6379)
 *   JWKS_URL        — JWKS endpoint for EdDSA public keys
 *   V2_TRUST_ISSUER — (optional) override token issuer claim
 */

function isUsableRedisUrl(urlValue: string): boolean {
  try {
    const parsed = new URL(urlValue);
    return parsed.protocol === "redis:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function buildRedisUrlFromDiscreteEnv(): string | null {
  const host =
    process.env.REDISHOST?.trim() ||
    process.env.REDIS_HOST?.trim() ||
    "";
  if (!host) {
    //audit Assumption: host-less discrete vars cannot produce a valid redis URL; failure risk: malformed connection string loops reconnects; expected invariant: only host-complete URLs are emitted; handling strategy: return null and defer to next fallback.
    return null;
  }

  const port =
    process.env.REDISPORT?.trim() ||
    process.env.REDIS_PORT?.trim() ||
    "6379";
  const username =
    process.env.REDISUSER?.trim() ||
    process.env.REDIS_USER?.trim() ||
    "";
  const password =
    process.env.REDISPASSWORD?.trim() ||
    process.env.REDIS_PASSWORD?.trim() ||
    "";

  const encodedUsername = encodeURIComponent(username);
  const encodedPassword = encodeURIComponent(password);

  //audit Assumption: auth pair combinations vary by provider; failure risk: invalid auth section when one value is missing; expected invariant: auth segment matches provided credentials only; handling strategy: construct auth component by explicit branch.
  const authSegment = username
    ? `${encodedUsername}:${encodedPassword}@`
    : password
      ? `:${encodedPassword}@`
      : "";

  return `redis://${authSegment}${host}:${port}`;
}

function resolveRedisUrl(): string {
  const rawRedisUrl = process.env.REDIS_URL?.trim();
  if (rawRedisUrl && isUsableRedisUrl(rawRedisUrl)) {
    return rawRedisUrl;
  }

  const discreteUrl = buildRedisUrlFromDiscreteEnv();
  if (discreteUrl) {
    //audit Assumption: malformed provider URL should not block redis when discrete vars are valid; failure risk: fallback silently points to wrong endpoint; expected invariant: composed URL includes explicit host and port; handling strategy: prefer composed URL only when host is present.
    return discreteUrl;
  }

  //audit Assumption: local development should still boot without redis env vars; failure risk: production accidentally targets localhost when all vars missing; expected invariant: deterministic final fallback; handling strategy: retain localhost default as last resort.
  return "redis://localhost:6379";
}

export const V2_CONFIG = {
  REDIS_URL: resolveRedisUrl(),
  JWKS_URL: process.env.JWKS_URL ?? "",
  EXPECTED_ISSUER: process.env.V2_TRUST_ISSUER ?? "arcanos-trust-authority",
  ALLOWED_ALG: "EdDSA" as const,
  CLOCK_SKEW_SECONDS: 5,
  NONCE_PREFIX: "nonce:",
  LOCK_PREFIX: "lock:",
  CIRCUIT_BREAKER: {
    FAILURE_THRESHOLD: 5,
    RESET_TIMEOUT_MS: 30_000,
    HALF_OPEN_MAX_CALLS: 1,
  },
  LOCK_DEFAULTS: {
    TTL_MS: 5_000,
    HEARTBEAT_INTERVAL_MS: 2_000,
  },
} as const;
