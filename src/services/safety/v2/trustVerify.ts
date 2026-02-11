/**
 * v2 Trust Verification — Token Verification
 *
 * Validates EdDSA-signed JWTs with:
 *  - Strict algorithm enforcement (no algorithm confusion)
 *  - kid-based JWKS lookup
 *  - Atomic nonce replay prevention via Redis NX
 *  - Clock skew validation
 *  - Nonce format validation
 *  - Trace ID propagation
 *  - Fail-closed when Redis is unavailable
 */

import { jwtVerify, type JWTPayload } from "jose";
import { V2_CONFIG } from "./config.js";
import { getJWKS } from "./jwks.js";
import { setNX } from "./redisClient.js";
import { logAuditEvent } from "./auditLogger.js";

export type TrustLevel = "FULL" | "DEGRADED" | "UNSAFE";

export interface TrustPayload extends JWTPayload {
  trust: TrustLevel;
  nonce: string;
  trace: string;
}

const VALID_TRUST_LEVELS = new Set<string>(["FULL", "DEGRADED", "UNSAFE"]);
const NONCE_MAX_LENGTH = 128;
const NONCE_PATTERN = /^[a-zA-Z0-9_\-]+$/;

export async function verifyTrustToken(token: string): Promise<TrustPayload> {
  const jwks = getJWKS();

  // jose verifies the algorithm against the allowlist and resolves kid
  // automatically via the JWKS endpoint.
  const { protectedHeader, payload } = await jwtVerify(token, jwks, {
    issuer: V2_CONFIG.EXPECTED_ISSUER,
    algorithms: [V2_CONFIG.ALLOWED_ALG],
    requiredClaims: ["exp", "iat", "nonce", "trace", "trust"],
  });

  // Belt-and-suspenders: reject if header algorithm doesn't match
  if (protectedHeader.alg !== V2_CONFIG.ALLOWED_ALG) {
    throw new Error(
      `Algorithm confusion: expected ${V2_CONFIG.ALLOWED_ALG}, got ${protectedHeader.alg}`
    );
  }

  // Validate trust level enum
  const trust = payload.trust as string;
  if (!VALID_TRUST_LEVELS.has(trust)) {
    throw new Error(`Invalid trust level: ${trust}`);
  }

  // Validate required numeric claims exist
  const iat = payload.iat;
  const exp = payload.exp;
  if (iat === undefined || exp === undefined) {
    throw new Error("Missing required claims: iat or exp");
  }

  // Clock skew check
  const nowSec = Math.floor(Date.now() / 1_000);
  if (Math.abs(nowSec - iat) > V2_CONFIG.CLOCK_SKEW_SECONDS) {
    throw new Error(
      `Clock skew violation: iat=${iat}, now=${nowSec}, max=${V2_CONFIG.CLOCK_SKEW_SECONDS}s`
    );
  }

  // Nonce format validation — prevent injection into Redis key space
  const nonce = payload.nonce as string;
  if (
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    nonce.length > NONCE_MAX_LENGTH ||
    !NONCE_PATTERN.test(nonce)
  ) {
    throw new Error("Invalid nonce format");
  }

  // Nonce replay prevention
  const ttl = exp - nowSec;

  if (ttl <= 0) {
    throw new Error("Token already expired — nonce TTL would be non-positive");
  }

  const nonceKey = `${V2_CONFIG.NONCE_PREFIX}${nonce}`;

  let wasSet: boolean;
  try {
    wasSet = await setNX(nonceKey, ttl);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Circuit breaker")) {
      logAuditEvent({
        type: "DEGRADED_MODE",
        reason: "Redis circuit breaker open",
        trace: payload.trace as string,
      });
      throw new Error("Trust verification degraded — Redis unavailable, failing closed");
    }
    throw err;
  }

  if (!wasSet) {
    logAuditEvent({
      type: "REPLAY_DETECTED",
      nonce,
      trace: payload.trace as string,
    });
    throw new Error("Replay detected — nonce already consumed");
  }

  logAuditEvent({
    type: "TRUST_VERIFIED",
    trust,
    nonce,
    trace: payload.trace as string,
  });

  return payload as TrustPayload;
}
