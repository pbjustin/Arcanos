/**
 * v2 Trust Verification — Configuration
 *
 * Required env vars:
 *   REDIS_URL       — Redis connection string (e.g. redis://localhost:6379)
 *   JWKS_URL        — JWKS endpoint for EdDSA public keys
 *   V2_TRUST_ISSUER — (optional) override token issuer claim
 */

export const V2_CONFIG = {
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
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
