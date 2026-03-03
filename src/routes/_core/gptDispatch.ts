import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import { dispatchModuleAction, getModuleMetadata } from "../modules.js";
import type { GptMatchMethod } from "@platform/logging/gptLogger.js";

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

  const prompt = extractPrompt(body);
  if (!prompt) {
    return {
      ok: false,
      error: { code: "BAD_REQUEST", message: "Request must include message/prompt (or messages[])" },
      _route: baseRoute,
    };
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
  const requestedAction = typeof body?.action === "string" ? body.action : undefined;
  const action = pickAction(availableActions, requestedAction);

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

  logger?.info?.("gpt.dispatch.plan", { requestId, gptId: trimmedGptId, module: entry.module, action, matchMethod });

  try {
    const payload = { prompt, domain: body?.domain, metadata: body?.metadata };
    const result = await withTimeout(dispatchModuleAction(entry.module, action, payload), timeoutMs);

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
