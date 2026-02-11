/**
 * v2 Trust Verification — JWKS Key Resolution
 *
 * Uses jose's createRemoteJWKSet for automatic kid-based lookup,
 * caching, and key rotation handling.
 *
 * REQUIRES: npm install jose
 */

import { createRemoteJWKSet, type FlattenedJWSInput, type JWSHeaderParameters } from "jose";
import { V2_CONFIG } from "./config.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function getJWKS() {
  if (!V2_CONFIG.JWKS_URL) {
    throw new Error("JWKS_URL is not configured — cannot verify trust tokens");
  }

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(V2_CONFIG.JWKS_URL), {
      cacheMaxAge: 60_000,
      cooldownDuration: 30_000,
    });
  }

  return jwks;
}
