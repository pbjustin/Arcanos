import { isRecord } from "@shared/typeGuards.js";
import { redactString } from "@shared/redaction.js";
import { extractTextPrompt, normalizeStringList } from "@transport/http/payloadNormalization.js";

export type GamingMode = "guide" | "build" | "meta";

export type GamingEvidenceOrigin = "frontend_web_search";

export type GamingEvidenceRequest = {
  required: true;
  reason: "CURRENT_VERSION_EVIDENCE_REQUIRED";
  game: string;
  version?: string;
  maxCandidateUrls: 4;
  queries: string[];
};

export type GamingFallbackReason =
  | "CURRENT_EVIDENCE_UNAVAILABLE"
  | "GAMING_PROVIDER_ERROR"
  | "GAMING_PROVIDER_UNAVAILABLE"
  | "INTAKE_PARSE_TIMEOUT"
  | "INTAKE_RETRIEVAL_FAILED"
  | "INTAKE_RETRIEVAL_TIMEOUT"
  | "INTAKE_UNKNOWN_TIMEOUT"
  | "INTAKE_UPSTREAM_TIMEOUT"
  | "PROVIDER_COMPLETION_INCOMPLETE";

export type GamingDiscoveryReason =
  | "DISCOVERY_CURATED_SOURCE_UNAVAILABLE"
  | "DISCOVERY_DISABLED"
  | "DISCOVERY_EVIDENCE_BELOW_THRESHOLD"
  | "DISCOVERY_EXPLICIT_CURRENT_LOOKUP"
  | "DISCOVERY_MISSING_GAME"
  | "DISCOVERY_NOT_NEEDED"
  | "DISCOVERY_NO_SOURCE_CANDIDATES"
  | "DISCOVERY_PATCH_SENSITIVE"
  | "DISCOVERY_SUPPLIED_SOURCE_FAILED";

export type GamingDiscoveryFailureReason =
  | "DISCOVERY_ALL_CANDIDATES_REJECTED"
  | "DISCOVERY_BUDGET_EXHAUSTED"
  | "DISCOVERY_DISABLED"
  | "DISCOVERY_FETCH_FAILED"
  | "DISCOVERY_LOW_QUALITY"
  | "DISCOVERY_NOT_NEEDED"
  | "DISCOVERY_NO_RESULTS"
  | "DISCOVERY_PROVIDER_ERROR"
  | "DISCOVERY_PROVIDER_TIMEOUT"
  | "DISCOVERY_PROVIDER_UNCONFIGURED";

export type GamingError = {
  code: string;
  message: string;
  details?: unknown;
};

export type GamingSuccessEnvelope = {
  ok: true;
  route: "gaming";
  mode: GamingMode;
  data: {
    response: string;
    sources: Array<{ url: string; snippet?: string; error?: string }>;
    fallbackReason?: GamingFallbackReason;
    discoveryReason?: GamingDiscoveryReason;
    discoveryFailureReason?: GamingDiscoveryFailureReason;
    evidenceRequest?: GamingEvidenceRequest;
    auditTrace?: {
      draft: string;
      finalized: string;
    };
    hrc?: unknown;
  };
};

export type GamingErrorEnvelope = {
  ok: false;
  route: "gaming";
  mode: GamingMode | null;
  error: GamingError;
};

export type ValidatedGamingRequest = {
  mode: GamingMode;
  prompt: string;
  game?: string;
  guideUrl?: string;
  guideUrls: string[];
  evidenceOrigin?: GamingEvidenceOrigin;
  requestedVersion?: string;
  evidenceAttempt?: number;
  auditEnabled: boolean;
  hrcEnabled: boolean;
};

export type GamingEvidenceRetryRequest = {
  game: string;
  mode: GamingMode;
  originalPrompt: string;
  candidateUrls: string[];
  requestedVersion?: string;
  evidenceAttempt: 1;
};

export type GamingEvidenceRetryValidation =
  | { ok: true; value: GamingEvidenceRetryRequest }
  | { ok: false; code: "BAD_REQUEST" | "EVIDENCE_RETRY_LIMIT_REACHED"; message: string };

export type PublicGamingRequestValidationError = {
  code: "GPT_ACTION_REQUIRED" | "BAD_REQUEST" | "GAMEPLAY_MODE_REQUIRED" | "PROMPT_REQUIRED";
  message: string;
};

const MAX_PUBLIC_GAMING_PAYLOAD_DEPTH = 32;
const MAX_PUBLIC_GAMING_PAYLOAD_NODES = 4096;

function publicGamingRequestExceedsStructuralLimits(body: Record<string, unknown>): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (current.depth > MAX_PUBLIC_GAMING_PAYLOAD_DEPTH) {
      return true;
    }
    const children = Array.isArray(current.value)
      ? current.value
      : isRecord(current.value)
        ? Object.values(current.value)
        : [];
    if (visited + stack.length + children.length > MAX_PUBLIC_GAMING_PAYLOAD_NODES) {
      return true;
    }
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }

  return false;
}

function getStringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBooleanField(payload: unknown, key: string): boolean {
  return isRecord(payload) && payload[key] === true;
}

function getOptionalEvidenceAttempt(payload: unknown): unknown {
  return isRecord(payload) ? payload.evidenceAttempt : undefined;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= maxLength
    && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);
}

function isBoundedPromptText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);
}

function normalizeRequestedVersion(value: unknown): string | undefined {
  if (!isBoundedText(value, 64)) {
    return undefined;
  }
  return /^(?:(?:version|patch|v)\s*)?(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)$/iu.exec(value.trim())?.[1];
}

function normalizeGameValue(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function validateGamingEvidenceRetryRequest(body: unknown): GamingEvidenceRetryValidation {
  if (!isRecord(body)) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry requires a JSON object." };
  }

  const allowedFields = new Set([
    "game",
    "mode",
    "originalPrompt",
    "candidateUrls",
    "requestedVersion",
    "evidenceAttempt"
  ]);
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry contains unsupported fields." };
  }

  const mode = resolveGamingMode(body);
  if (!mode) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry requires mode 'guide', 'build', or 'meta'." };
  }
  if (!isBoundedText(body.game, 120)) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry requires a bounded game value." };
  }
  const game = normalizeGameValue(body.game);
  if (
    redactString(game) === "[REDACTED]"
    || /https?:\/\/|\b\S+@\S+\.\S+\b|\bgh[opusr]_[A-Za-z0-9]{12,}\b/iu.test(game)
  ) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry game contains unsupported sensitive data." };
  }
  if (!isBoundedPromptText(body.originalPrompt, 8_000)) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry requires a bounded originalPrompt value." };
  }
  if (body.evidenceAttempt !== 1) {
    return body.evidenceAttempt === undefined
      ? { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry requires evidenceAttempt 1." }
      : { ok: false, code: "EVIDENCE_RETRY_LIMIT_REACHED", message: "Gaming evidence retry permits exactly one evidence attempt." };
  }
  if (!Array.isArray(body.candidateUrls) || body.candidateUrls.length > 4) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry accepts at most four candidate URLs." };
  }
  if (!body.candidateUrls.every((value) => isBoundedText(value, 2_048))) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry candidate URLs must be bounded strings." };
  }
  const requestedVersion = normalizeRequestedVersion(body.requestedVersion);
  if (body.requestedVersion !== undefined && !requestedVersion) {
    return { ok: false, code: "BAD_REQUEST", message: "Gaming evidence retry requestedVersion must be a bounded string." };
  }

  return {
    ok: true,
    value: {
      game,
      mode,
      originalPrompt: body.originalPrompt.trim(),
      candidateUrls: body.candidateUrls.map((value) => value.trim()),
      ...(requestedVersion ? { requestedVersion } : {}),
      evidenceAttempt: 1
    }
  };
}

export function resolveGamingMode(payload: unknown): GamingMode | null {
  const value = getStringField(payload, "mode")?.toLowerCase();
  if (value === "guide" || value === "build" || value === "meta") {
    return value;
  }

  return null;
}

export function validatePublicGamingQueryRequest(
  body: unknown,
  requestedAction: string | null
): PublicGamingRequestValidationError | null {
  if (!requestedAction) {
    return {
      code: "GPT_ACTION_REQUIRED",
      message: "Gaming requests require action 'query'."
    };
  }
  if (requestedAction !== "query") {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.payload)) {
    return {
      code: "BAD_REQUEST",
      message: "Gaming query requests require a payload object."
    };
  }
  if (publicGamingRequestExceedsStructuralLimits(body)) {
    return {
      code: "BAD_REQUEST",
      message: "Gaming query request exceeds the supported structural limits."
    };
  }

  const payloadHasMode = Object.prototype.hasOwnProperty.call(body.payload, "mode");
  const mode = payloadHasMode ? resolveGamingMode(body.payload) : resolveGamingMode(body);
  if (!mode) {
    return {
      code: "GAMEPLAY_MODE_REQUIRED",
      message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'."
    };
  }

  const promptKeys = ["prompt", "message", "text", "content", "query"];
  const payloadHasPromptAlias = promptKeys.some((key) => Object.prototype.hasOwnProperty.call(body.payload, key));
  const prompt = payloadHasPromptAlias ? extractTextPrompt(body.payload) : extractTextPrompt(body);
  return prompt
    ? null
    : {
        code: "PROMPT_REQUIRED",
        message: "query requires a non-empty prompt."
      };
}

export function formatGamingSuccess(params: {
  mode: GamingMode;
  data: GamingSuccessEnvelope["data"];
}): GamingSuccessEnvelope {
  return {
    ok: true,
    route: "gaming",
    mode: params.mode,
    data: params.data,
  };
}

export function formatGamingError(params: {
  mode: GamingMode | null;
  error: GamingError;
}): GamingErrorEnvelope {
  return {
    ok: false,
    route: "gaming",
    mode: params.mode,
    error: params.error,
  };
}

export function validateGamingRequest(payload: unknown): { ok: true; value: ValidatedGamingRequest } | { ok: false; error: GamingErrorEnvelope } {
  const mode = resolveGamingMode(payload);
  if (!mode) {
    return {
      ok: false,
      error: formatGamingError({
        mode: null,
        error: {
          code: "GAMEPLAY_MODE_REQUIRED",
          message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'."
        }
      })
    };
  }

  const prompt = extractTextPrompt(payload);
  if (!prompt) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: `Gaming mode '${mode}' requires a text prompt.`
        }
      })
    };
  }

  const rawGame = getStringField(payload, "game");
  const game = rawGame ? normalizeGameValue(rawGame) : undefined;
  if (
    game
    && (
      redactString(game) === "[REDACTED]"
      || /https?:\/\/|\b\S+@\S+\.\S+\b|\bgh[opusr]_[A-Za-z0-9]{12,}\b/iu.test(game)
    )
  ) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming game value contains unsupported sensitive data."
        }
      })
    };
  }
  const guideUrl = getStringField(payload, "guideUrl") ?? getStringField(payload, "url");
  if (isRecord(payload) && payload.candidateUrls !== undefined) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming candidateUrls are accepted only by the evidence retry route."
        }
      })
    };
  }
  const rawEvidenceOrigin = isRecord(payload) ? payload.evidenceOrigin : undefined;
  const evidenceOrigin = getStringField(payload, "evidenceOrigin");
  if (rawEvidenceOrigin !== undefined && evidenceOrigin !== "frontend_web_search") {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming evidenceOrigin is not supported."
        }
      })
    };
  }
  const evidenceAttempt = getOptionalEvidenceAttempt(payload);
  if (evidenceAttempt !== undefined && (typeof evidenceAttempt !== "number" || !Number.isInteger(evidenceAttempt) || evidenceAttempt < 0)) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming evidenceAttempt must be a non-negative integer."
        }
      })
    };
  }
  if (typeof evidenceAttempt === "number" && evidenceAttempt > 1) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "EVIDENCE_RETRY_LIMIT_REACHED",
          message: "Gaming evidence retry permits at most one evidence attempt."
        }
      })
    };
  }
  const hasEvidenceOrigin = rawEvidenceOrigin !== undefined;
  const hasEvidenceAttempt = evidenceAttempt !== undefined;
  if (hasEvidenceOrigin !== hasEvidenceAttempt) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming evidenceOrigin and evidenceAttempt must be provided together."
        }
      })
    };
  }
  if (hasEvidenceOrigin && (evidenceOrigin !== "frontend_web_search" || evidenceAttempt !== 1)) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Frontend Gaming evidence requires evidenceOrigin frontend_web_search and evidenceAttempt 1."
        }
      })
    };
  }
  const rawRequestedVersion = isRecord(payload) ? payload.requestedVersion : undefined;
  const requestedVersion = normalizeRequestedVersion(rawRequestedVersion);
  if (rawRequestedVersion !== undefined && !requestedVersion) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming requestedVersion must be a bounded string."
        }
      })
    };
  }
  const guideUrls = normalizeStringList(
    isRecord(payload) ? payload.urls : undefined,
    isRecord(payload) ? payload.guideUrls : undefined
  );
  const candidateCount = new Set(
    [...(guideUrl ? [guideUrl] : []), ...guideUrls].map((url) => url.trim().toLowerCase())
  ).size;
  if (candidateCount > 4) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: "Gaming accepts at most four candidate URLs."
        }
      })
    };
  }
  if ((mode === "build" || mode === "meta") && !game && !guideUrl && guideUrls.length === 0) {
    return {
      ok: false,
      error: formatGamingError({
        mode,
        error: {
          code: "BAD_REQUEST",
          message: `Gaming mode '${mode}' requires a game field.`
        }
      })
    };
  }

  return {
    ok: true,
    value: {
      mode,
      prompt,
      game,
      guideUrl,
      guideUrls,
      ...(evidenceOrigin === "frontend_web_search" ? { evidenceOrigin } : {}),
      ...(requestedVersion ? { requestedVersion } : {}),
      ...(typeof evidenceAttempt === "number" ? { evidenceAttempt } : {}),
      auditEnabled: getBooleanField(payload, "audit") || getBooleanField(payload, "enableAudit"),
      hrcEnabled: getBooleanField(payload, "hrc") || getBooleanField(payload, "enableHrc"),
    }
  };
}
