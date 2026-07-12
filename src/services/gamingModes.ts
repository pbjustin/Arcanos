import { isRecord } from "@shared/typeGuards.js";
import { extractTextPrompt, normalizeStringList } from "@transport/http/payloadNormalization.js";

export type GamingMode = "guide" | "build" | "meta";

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
  auditEnabled: boolean;
  hrcEnabled: boolean;
};

export type PublicGamingRequestValidationError = {
  code: "GPT_ACTION_REQUIRED" | "BAD_REQUEST" | "GAMEPLAY_MODE_REQUIRED" | "PROMPT_REQUIRED";
  message: string;
};

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

  const game = getStringField(payload, "game");
  const guideUrl = getStringField(payload, "guideUrl") ?? getStringField(payload, "url");
  const guideUrls = normalizeStringList(
    isRecord(payload) ? payload.urls : undefined,
    isRecord(payload) ? payload.guideUrls : undefined
  );
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
      auditEnabled: getBooleanField(payload, "audit") || getBooleanField(payload, "enableAudit"),
      hrcEnabled: getBooleanField(payload, "hrc") || getBooleanField(payload, "enableHrc"),
    }
  };
}
