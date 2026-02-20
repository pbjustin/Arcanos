import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

const BEARER_PREFIX = "Bearer ";

function readConfiguredApiKey(): string | undefined {
  return process.env.AGENT_API_KEY ?? process.env.BACKEND_API_KEY ?? process.env.API_KEY;
}

/**
 * Parses a bearer token from an Authorization header value.
 * Input: raw Authorization header.
 * Output: bearer token string when present, otherwise null.
 * Edge case behavior: returns null when the header is missing or malformed.
 */
function parseBearerToken(authorizationHeader: string | undefined): string | null {
  //audit assumption: clients use standard "Bearer <token>" format. Failure risk: malformed headers bypass parsing.
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const bearerValue = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  //audit invariant: parsed bearer credential must be non-empty before timing-safe comparison.
  return bearerValue.length > 0 ? bearerValue : null;
}

/**
 * Compares two secrets using constant-time equality to reduce timing attack leakage.
 * Input: expected and actual secret values.
 * Output: true when values are equal, otherwise false.
 * Edge case behavior: returns false on length mismatch.
 */
function timingSafeEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");

  //audit assumption: equal-length buffers are required by timingSafeEqual; mismatch must fail closed.
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Enforces bearer authentication for agent backend routes.
 * Input: Express request/response/next.
 * Output: continues request flow on success; sends 401/500 on failure.
 * Edge case behavior: fails closed when AGENT_API_KEY is not configured.
 */
export function requireAgentApiKey(req: Request, res: Response, next: NextFunction): void {
  const configuredApiKey = readConfiguredApiKey();
  //audit assumption: at least one supported API-key env var is managed as a deployment secret.
  if (!configuredApiKey) {
    res.status(500).json({ error: "Authentication is not configured" });
    return;
  }

  const requestToken = parseBearerToken(req.header("authorization"));
  //audit strategy: reject missing or mismatched tokens to preserve access-control invariant.
  if (!requestToken || !timingSafeEquals(configuredApiKey, requestToken)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
