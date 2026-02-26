import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

const BEARER_PREFIX = "Bearer ";
const GPT_ID_HEADER = "x-gpt-id";
const GPT_ID_AUTH_MODES = new Set(["api-key", "gpt-id", "hybrid"] as const);

type AgentAuthMode = "api-key" | "gpt-id" | "hybrid";

function readConfiguredApiKey(): string | undefined {
  return process.env.AGENT_API_KEY ?? process.env.BACKEND_API_KEY ?? process.env.API_KEY;
}

/**
 * Purpose: Resolve backend auth mode for agent routes.
 * Input: process env AGENT_AUTH_MODE value.
 * Output: supported auth mode string.
 * Edge case behavior: defaults to api-key for unknown values.
 */
function readAgentAuthMode(): AgentAuthMode {
  const rawMode = (process.env.AGENT_AUTH_MODE ?? "api-key").trim().toLowerCase();
  //audit assumption: auth mode can be misconfigured; failure risk: unintended auth bypass if invalid values accepted; expected invariant: only allow known modes; handling strategy: fail to strict default (api-key).
  if (!GPT_ID_AUTH_MODES.has(rawMode as AgentAuthMode)) {
    return "api-key";
  }

  return rawMode as AgentAuthMode;
}

/**
 * Purpose: Parse trusted GPT IDs from environment configuration.
 * Input: comma-separated TRUSTED_GPT_IDS or BACKEND_TRUSTED_GPT_IDS.
 * Output: set of trimmed non-empty GPT IDs.
 * Edge case behavior: returns empty set when values are missing.
 */
function readTrustedGptIds(): Set<string> {
  const trustedIdsRaw = process.env.BACKEND_TRUSTED_GPT_IDS ?? process.env.TRUSTED_GPT_IDS ?? "";
  //audit assumption: trusted IDs are comma-delimited; failure risk: malformed values widen trust scope; expected invariant: only explicit non-empty IDs are trusted; handling strategy: trim/filter tokens.
  return new Set(
    trustedIdsRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
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
 * Purpose: Read x-gpt-id from request headers.
 * Input: Express request object.
 * Output: normalized GPT ID or null.
 * Edge case behavior: returns null for non-string/blank values.
 */
function parsePresentedGptId(req: Request): string | null {
  const rawHeaderValue = req.header(GPT_ID_HEADER);
  if (!rawHeaderValue) {
    return null;
  }

  const normalizedGptId = rawHeaderValue.trim();
  //audit assumption: GPT identity must be explicit and non-empty; failure risk: empty header treated as trusted actor; expected invariant: blank IDs rejected; handling strategy: normalize and null-check.
  return normalizedGptId.length > 0 ? normalizedGptId : null;
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
 * Enforces authentication for agent backend routes.
 * Input: Express request/response/next.
 * Output: continues request flow on success; sends 401/500 on failure.
 * Edge case behavior: fails closed when selected auth mode is missing required config.
 */
export function requireAgentApiKey(req: Request, res: Response, next: NextFunction): void {
  const authMode = readAgentAuthMode();
  const configuredApiKey = readConfiguredApiKey();
  const trustedGptIds = readTrustedGptIds();

  const requestToken = parseBearerToken(req.header("authorization"));
  const presentedGptId = parsePresentedGptId(req);

  const apiKeyAccepted = Boolean(configuredApiKey && requestToken && timingSafeEquals(configuredApiKey, requestToken));
  const gptIdAccepted = Boolean(presentedGptId && trustedGptIds.has(presentedGptId));

  //audit assumption: api-key mode requires configured secret; failure risk: accidental unauthenticated route access; expected invariant: missing config must fail closed; handling strategy: return 500 for operator remediation.
  if (authMode === "api-key" && !configuredApiKey) {
    res.status(500).json({ error: "Authentication is not configured" });
    return;
  }

  //audit assumption: gpt-id mode requires non-empty allowlist; failure risk: any arbitrary id could authenticate; expected invariant: explicit trusted IDs list required; handling strategy: fail closed when unset.
  if (authMode === "gpt-id" && trustedGptIds.size === 0) {
    res.status(500).json({ error: "Trusted GPT IDs are not configured" });
    return;
  }

  //audit assumption: hybrid mode should accept either approved mechanism; failure risk: operator lockout if one source temporarily absent; expected invariant: at least one validated signal succeeds; handling strategy: OR acceptance.
  if (authMode === "hybrid") {
    if (apiKeyAccepted || gptIdAccepted) {
      next();
      return;
    }

    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  //audit assumption: api-key mode must require valid bearer token; failure risk: header spoofing; expected invariant: timing-safe secret check passes; handling strategy: reject with 401 when invalid.
  if (authMode === "api-key") {
    if (apiKeyAccepted) {
      next();
      return;
    }

    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  //audit assumption: gpt-id mode trusts only allowlisted IDs; failure risk: untrusted GPT impersonation; expected invariant: supplied ID must exist in trusted set; handling strategy: reject non-members.
  if (gptIdAccepted) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}
