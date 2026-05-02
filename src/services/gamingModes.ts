import { isRecord } from "@shared/typeGuards.js";
import { extractTextPrompt, normalizeStringList } from "@transport/http/payloadNormalization.js";

export type GamingMode = "guide" | "build" | "meta";

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
  if ((mode === "build" || mode === "meta") && !game) {
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
      guideUrl: getStringField(payload, "guideUrl") ?? getStringField(payload, "url"),
      guideUrls: normalizeStringList(
        isRecord(payload) ? payload.urls : undefined,
        isRecord(payload) ? payload.guideUrls : undefined
      ),
      auditEnabled: getBooleanField(payload, "audit") || getBooleanField(payload, "enableAudit"),
      hrcEnabled: getBooleanField(payload, "hrc") || getBooleanField(payload, "enableHrc"),
    }
  };
}
