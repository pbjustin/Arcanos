import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import { dispatchModuleAction, getModuleMetadata } from "../modules.js";
import type { GptMatchMethod } from "@platform/logging/gptLogger.js";
import { persistModuleConversation } from "@services/moduleConversationPersistence.js";
import {
  executeNaturalLanguageMemoryCommand,
  parseNaturalLanguageMemoryCommand
} from "@services/naturalLanguageMemory.js";

export type AskEnvelope =
  | { ok: true; result: unknown; _route: RouteMeta }
  | { ok: false; error: { code: string; message: string; details?: unknown }; _route: RouteMeta };

export type RouteMeta = {
  requestId?: string;
  gptId: string;
  module?: string;
  action?: string;
  matchMethod?: GptMatchMethod | "normalized";
  route?: string;
  availableActions?: string[];
  moduleVersion?: string | null;
  timestamp: string;
};

export type RouteGptRequestInput = {
  gptId: string;
  body: any;
  requestId?: string;
  logger?: any;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractPrompt(body: any): string | null {
  const direct =
    body?.message ||
    body?.prompt ||
    body?.userInput ||
    body?.content ||
    body?.text ||
    body?.query;

  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  if (Array.isArray(body?.messages)) {
    const lastUser = [...body.messages].reverse().find((m: any) => m?.role === "user");
    if (typeof lastUser?.content === "string" && lastUser.content.trim().length > 0) return lastUser.content.trim();
  }

  return null;
}

/**
 * Build module action payload while preserving explicit caller payloads.
 * Inputs: raw request body and resolved module action.
 * Output: payload object passed to module action handlers.
 * Edge cases: when body.payload exists, it is forwarded verbatim for strict action contracts.
 */
function buildDispatchPayload(body: unknown): unknown {
  //audit Assumption: explicit payload should take precedence for module actions; failure risk: action contracts receiving reshaped fields; expected invariant: payload passed through unchanged when provided; handling strategy: prefer `body.payload`.
  if (isRecord(body) && Object.prototype.hasOwnProperty.call(body, "payload")) {
    return body.payload;
  }

  const prompt = extractPrompt(body);

  //audit Assumption: legacy module handlers often inspect `prompt` even for non-query actions; failure risk: callers using message/query aliases break after dispatch normalization; expected invariant: prompt alias is preserved when extractable; handling strategy: inject prompt field for object payload fallbacks.
  if (isRecord(body)) {
    const normalizedPayload = { ...body };
    if (prompt) {
      normalizedPayload.prompt = prompt;
    }
    return normalizedPayload;
  }

  //audit Assumption: scalar request bodies should still map to text prompt payloads; failure risk: scalar body dropped by module handlers; expected invariant: string input remains routable as prompt; handling strategy: wrap scalar input in object payload.
  if (typeof prompt === "string" && prompt.length > 0) {
    return { prompt };
  }

  //audit Assumption: legacy callers send top-level fields instead of payload wrappers; failure risk: module breakage for compatibility clients; expected invariant: top-level body remains supported; handling strategy: forward raw body fallback.
  return body;
}

function actionRequiresPrompt(action: string): boolean {
  return action === "query";
}

function resolveSessionId(body: unknown, payload: unknown): string | undefined {
  const bodySessionId = isRecord(body) && typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (bodySessionId) {
    return bodySessionId;
  }

  const payloadSessionId =
    isRecord(payload) && typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (payloadSessionId) {
    return payloadSessionId;
  }

  return undefined;
}

const UNIVERSAL_MEMORY_SESSION_ID = "global";

function resolveMemorySessionId(body: unknown, payload: unknown, moduleName: string, gptId: string): string {
  const explicitSessionId = resolveSessionId(body, payload);
  if (explicitSessionId) {
    return explicitSessionId;
  }

  //audit Assumption: ChatGPT-style memory should be universally addressable across modules when callers omit sessionId; failure risk: mixed tenants on shared infra; expected invariant: deterministic global fallback memory namespace; handling strategy: use explicit global session key and recommend per-user sessionId for multi-tenant contexts.
  void moduleName;
  void gptId;
  return UNIVERSAL_MEMORY_SESSION_ID;
}

function hasExplicitMemoryCue(prompt: string): boolean {
  const normalizedPrompt = normalize(prompt);

  //audit Assumption: empty prompts cannot carry actionable memory commands; failure risk: false positives; expected invariant: cue checks run only for non-empty text; handling strategy: hard false on empty.
  if (!normalizedPrompt) {
    return false;
  }

  return (
    /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:save|store|remember)\b/.test(normalizedPrompt) ||
    /^(?:please\s+)?(?:lookup|look\s*up|find|search)\b/.test(normalizedPrompt) ||
    /\b(memory|memories|remember|remembered|recall|saved)\b/.test(normalizedPrompt)
  );
}

function pickAction(available: string[], requested?: string): string | null {
  if (requested) return available.includes(requested) ? requested : null;
  if (available.includes("query")) return "query";
  if (available.includes("run")) return "run";
  if (available.length === 1) return available[0];
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Module dispatch timeout after ${ms}ms`)), ms)),
  ]);
}

type GptMapEntry = { module: string; route: string };

function normalize(s: string): string {
  return (s || "").toLowerCase().trim();
}

function stripNonAlnum(s: string): string {
  return normalize(s).replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string): number {
  const A = stripNonAlnum(a);
  const B = stripNonAlnum(b);
  const n = A.length, m = B.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const d: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[n][m];
}

function resolveGptEntry(incomingGptId: string, gptModuleMap: Record<string, GptMapEntry>): { entry: GptMapEntry; matchMethod: GptMatchMethod | "normalized"; matchedId: string } | null {
  const configuredGptIds = Object.keys(gptModuleMap);

  // 1) exact match
  const exact = configuredGptIds.find(id => id === incomingGptId);
  if (exact) return { entry: gptModuleMap[exact], matchMethod: "exact", matchedId: exact };

  // 2) normalized direct match
  const normalizedIncoming = normalize(incomingGptId);
  const normalizedEntry = gptModuleMap[normalizedIncoming];
  if (normalizedEntry) return { entry: normalizedEntry, matchMethod: "normalized", matchedId: normalizedIncoming };

  // 3) longest substring match
  const sortedIds = [...configuredGptIds].sort((a, b) => b.length - a.length);
  const substrMatch = sortedIds.find(id => incomingGptId.includes(id));
  if (substrMatch) return { entry: gptModuleMap[substrMatch], matchMethod: "substring" as GptMatchMethod, matchedId: substrMatch };

  // 4) token-subset heuristic
  const incomingTokens = new Set(normalize(incomingGptId).split(/[^a-z0-9]+/).filter(Boolean));
  let tokenMatchId: string | undefined;
  for (const id of configuredGptIds) {
    const tokens = normalize(id).split(/[^a-z0-9]+/).filter(Boolean);
    if (!tokens.length) continue;
    const common = tokens.filter(t => incomingTokens.has(t)).length;
    const ratio = common / tokens.length;
    if (ratio >= 0.6) {
      tokenMatchId = id;
      break;
    }
  }
  if (tokenMatchId) return { entry: gptModuleMap[tokenMatchId], matchMethod: "token-subset" as GptMatchMethod, matchedId: tokenMatchId };

  // 5) fuzzy Levenshtein fallback
  let bestId: string | undefined;
  let bestScore = Infinity;
  for (const id of configuredGptIds) {
    const distance = levenshtein(incomingGptId, id);
    if (distance < bestScore) {
      bestScore = distance;
      bestId = id;
    }
  }
  if (bestId) {
    const threshold = Math.max(2, Math.floor(bestId.length * 0.25));
    if (bestScore <= threshold) {
      return { entry: gptModuleMap[bestId], matchMethod: "fuzzy" as GptMatchMethod, matchedId: bestId };
    }
  }

  return null;
}



export type ResolveEnvelope =
  | { ok: true; plan: { matchedId: string; module: string; route: string; action: string | null; availableActions: string[]; moduleVersion: string | null; moduleDescription: string | null; matchMethod: GptMatchMethod | "normalized"; }; _route: RouteMeta }
  | { ok: false; error: { code: string; message: string; details?: unknown }; _route: RouteMeta };

/**
 * Resolve a gptId to its target module + default action WITHOUT executing the module.
 * Useful for introspection and debugging routing/mapping issues.
 */
export async function resolveGptRouting(gptId: string, requestId?: string): Promise<ResolveEnvelope> {
  const trimmedGptId = (gptId ?? "").trim();

  const baseRoute: RouteMeta = {
    requestId,
    gptId: trimmedGptId,
    timestamp: new Date().toISOString(),
  };

  if (!trimmedGptId) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "Missing gptId" }, _route: baseRoute };
  }

  const gptModuleMap = await getGptModuleMap();
  const resolved = resolveGptEntry(trimmedGptId, gptModuleMap);

  if (!resolved) {
    return { ok: false, error: { code: "UNKNOWN_GPT", message: `gptId '${trimmedGptId}' is not registered` }, _route: baseRoute };
  }

  const { entry, matchMethod, matchedId } = resolved;
  const meta = getModuleMetadata(entry.module);
  const availableActions = meta?.actions ?? [];
  const action = pickAction(availableActions);

  return {
    ok: true,
    plan: {
      matchedId,
      module: entry.module,
      route: entry.route,
      action,
      availableActions,
      moduleVersion: (meta as any)?.version ?? null,
      moduleDescription: (meta as any)?.description ?? null,
      matchMethod,
    },
    _route: {
      ...baseRoute,
      module: entry.module,
      action: action ?? undefined,
      matchMethod,
      route: entry.route,
      availableActions,
      moduleVersion: (meta as any)?.version ?? null,
    },
  };
}
export async function routeGptRequest(input: RouteGptRequestInput): Promise<AskEnvelope> {
  const { gptId, body, requestId, logger } = input;
  const trimmedGptId = (gptId ?? "").trim();

  const baseRoute: RouteMeta = {
    requestId,
    gptId: trimmedGptId,
    timestamp: new Date().toISOString(),
  };

  if (!trimmedGptId) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "Missing gptId" }, _route: baseRoute };
  }
  if (trimmedGptId.length > 256) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "gptId too long" }, _route: baseRoute };
  }

  const gptModuleMap = await getGptModuleMap();
  const resolved = resolveGptEntry(trimmedGptId, gptModuleMap as any);
  if (!resolved) {
    return {
      ok: false,
      error: { code: "UNKNOWN_GPT", message: `gptId '${trimmedGptId}' is not registered` },
      _route: baseRoute,
    };
  }

  const { entry, matchMethod } = resolved;
  const moduleMetadata = getModuleMetadata(entry.module);
  const availableActions = moduleMetadata?.actions ?? [];
  const requestedAction = typeof body?.action === "string" ? body.action.trim() : undefined;
  const payload = buildDispatchPayload(body);
  const prompt = extractPrompt(payload);
  const parsedMemoryCommand =
    typeof prompt === "string" ? parseNaturalLanguageMemoryCommand(prompt) : { intent: "unknown" };
  const actionCandidate = pickAction(availableActions, requestedAction);
  const hasNoRoutableAction = !actionCandidate;

  const shouldInterceptMemoryInDispatcher =
    typeof prompt === "string" &&
    parsedMemoryCommand.intent !== "unknown" &&
    (hasExplicitMemoryCue(prompt) || hasNoRoutableAction) &&
    (!requestedAction || requestedAction === "query");

  //audit Assumption: memory commands should bypass module action ambiguity (e.g., multi-action modules without default query); failure risk: user cannot use memory reliably via dispatcher; expected invariant: explicit memory intents always have a deterministic execution path; handling strategy: early memory execution branch before action resolution.
  if (shouldInterceptMemoryInDispatcher) {
    try {
      const memorySessionId = resolveMemorySessionId(body, payload, entry.module, trimmedGptId);
      const memoryResult = await executeNaturalLanguageMemoryCommand({
        input: prompt,
        sessionId: memorySessionId
      });

      const routedMemoryResult = {
        handledBy: "memory-dispatcher",
        memory: memoryResult
      };

      await persistModuleConversation({
        moduleName: entry.module,
        route: entry.route,
        action: requestedAction || "memory",
        gptId: trimmedGptId,
        sessionId: memorySessionId,
        requestId,
        requestPayload: payload,
        responsePayload: routedMemoryResult
      }).catch((error: unknown) => {
        //audit Assumption: memory intercept persistence failures should not block user-visible memory response; failure risk: transcript/history gaps; expected invariant: command result still returned; handling strategy: warn and continue.
        logger?.warn?.("gpt.dispatch.memory_persistence_failed", {
          requestId,
          gptId: trimmedGptId,
          module: entry.module,
          action: requestedAction || "memory",
          error: String((error as Error)?.message ?? error)
        });
      });

      logger?.info?.("gpt.dispatch.memory_intercept", {
        requestId,
        gptId: trimmedGptId,
        module: entry.module,
        action: requestedAction || "memory",
        memoryIntent: parsedMemoryCommand.intent,
        memoryOperation: memoryResult.operation
      });

      return {
        ok: true,
        result: routedMemoryResult,
        _route: {
          ...baseRoute,
          module: entry.module,
          action: requestedAction || "memory",
          matchMethod,
          route: entry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null
        }
      };
    } catch (err: any) {
      return {
        ok: false,
        error: { code: "MODULE_ERROR", message: err?.message ?? "Memory command dispatch failed" },
        _route: {
          ...baseRoute,
          module: entry.module,
          action: requestedAction || "memory",
          matchMethod,
          route: entry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null
        }
      };
    }
  }

  const action = actionCandidate;

  if (!action) {
    const message = requestedAction
      ? `Requested action '${requestedAction}' is not available for module ${entry.module}`
      : availableActions.length > 1
      ? `Ambiguous actions and no default 'query' action found for module ${entry.module}`
      : `No actions available for module ${entry.module}`;

    return {
      ok: false,
      error: {
        code: "NO_DEFAULT_ACTION",
        message,
        details: { availableActions, requestedAction },
      },
      _route: {
        ...baseRoute,
        module: entry.module,
        matchMethod,
        route: entry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }

  const timeoutMs = typeof body?.timeoutMs === "number" ? body.timeoutMs : 15000;

  //audit Assumption: query actions depend on natural-language prompt content; failure risk: modules receiving empty prompt and failing deep in stack; expected invariant: query dispatch has message/prompt text; handling strategy: validate prompt at router boundary.
  if (actionRequiresPrompt(action) && !prompt) {
    return {
      ok: false,
      error: { code: "BAD_REQUEST", message: "Query actions require message/prompt (or messages[])." },
      _route: {
        ...baseRoute,
        module: entry.module,
        action,
        matchMethod,
        route: entry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }

  logger?.info?.("gpt.dispatch.plan", { requestId, gptId: trimmedGptId, module: entry.module, action, matchMethod });

  try {
    const result = await withTimeout(dispatchModuleAction(entry.module, action, payload), timeoutMs);

    const sessionId = resolveSessionId(body, payload);
    await persistModuleConversation({
      moduleName: entry.module,
      route: entry.route,
      action,
      gptId: trimmedGptId,
      sessionId,
      requestId,
      requestPayload: payload,
      responsePayload: result
    }).catch((error: unknown) => {
      //audit Assumption: persistence failures should not fail successful module responses; failure risk: dropped conversation history; expected invariant: user still receives module output; handling strategy: warn and continue.
      logger?.warn?.("gpt.dispatch.persistence_failed", {
        requestId,
        gptId: trimmedGptId,
        module: entry.module,
        action,
        error: String((error as Error)?.message ?? error),
      });
    });

    logger?.info?.("gpt.dispatch.ok", { requestId, gptId: trimmedGptId, module: entry.module, action });

    return {
      ok: true,
      result,
      _route: {
        ...baseRoute,
        module: entry.module,
        action,
        matchMethod,
        route: entry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  } catch (err: any) {
    logger?.error?.("gpt.dispatch.error", {
      requestId,
      gptId: trimmedGptId,
      module: entry.module,
      action,
      matchMethod,
      error: String(err?.message ?? err),
    });

    return {
      ok: false,
      error: { code: "MODULE_ERROR", message: err?.message ?? "Module dispatch failed" },
      _route: {
        ...baseRoute,
        module: entry.module,
        action,
        matchMethod,
        route: entry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }
}
