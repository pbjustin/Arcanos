import getGptModuleMap, {
  rebuildGptModuleMap,
  validateGptRegistry,
  type GptModuleEntry
} from "@platform/runtime/gptRouterConfig.js";
import {
  buildArcanosCoreTimeoutFallbackEnvelope,
  resolveArcanosCoreTimeoutPhase
} from "@services/arcanos-core.js";
import { dispatchModuleAction, getModuleMetadata } from "../modules.js";
import type { GptMatchMethod } from "@platform/logging/gptLogger.js";
import { persistModuleConversation } from "@services/moduleConversationPersistence.js";
import {
  executeNaturalLanguageMemoryCommand,
  extractNaturalLanguageSessionId,
  extractNaturalLanguageStorageLabel,
  hasNaturalLanguageMemoryCue,
  parseNaturalLanguageMemoryCommand
} from "@services/naturalLanguageMemory.js";
import { detectBackstageBookerIntent } from "@services/backstageBookerRouteShortcut.js";
import {
  buildRepoInspectionAnswer,
  collectRepoImplementationEvidence,
  shouldInspectRepoPrompt,
} from "@services/repoImplementationEvidence.js";
import { extractDiagnosticTextInput, isDiagnosticRequest } from "@shared/http/diagnosticRequest.js";
import { isRecord } from "@shared/typeGuards.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import type { Request } from "express";
import {
  getRequestAbortContext,
  getRequestRemainingMs,
  isAbortError,
  runWithRequestAbortTimeout
} from "@arcanos/runtime";
import {
  recordDispatcherFallback,
  recordDispatcherMisroute,
  recordDispatcherRoute,
  recordMemoryDispatchIgnored,
  recordUnknownGpt,
} from "@platform/observability/appMetrics.js";
import {
  recordPromptDebugTrace,
  type PromptDebugStage,
  type PromptDebugTracePatch,
} from "@services/promptDebugTraceService.js";
import {
  assertWritingPlaneClassification,
  classifyGptRequestPlane,
} from "./gptPlaneClassification.js";
import {
  ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG,
  normalizeBooleanFlagValue
} from "@shared/gpt/gptDirectAction.js";

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
  request?: Request;
  bypassIntentRouting?: boolean;
  runtimeExecutionMode?: 'request' | 'background';
  parentAbortSignal?: AbortSignal;
  suppressTimeoutFallback?: boolean;
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

function extractMode(body: unknown, payload: unknown): string | null {
  const bodyMode = isRecord(body) && typeof body.mode === "string" ? body.mode.trim().toLowerCase() : "";
  if (bodyMode) {
    return bodyMode;
  }

  const payloadMode = isRecord(payload) && typeof payload.mode === "string" ? payload.mode.trim().toLowerCase() : "";
  return payloadMode || null;
}

function buildDiagnosticRouteResult(): { ok: true; route: "diagnostic"; message: "backend operational" } {
  return {
    ok: true,
    route: "diagnostic",
    message: "backend operational"
  };
}

const FORWARDED_TOP_LEVEL_PAYLOAD_KEYS = [
  'message',
  'prompt',
  'userInput',
  'content',
  'text',
  'query',
  'messages',
  'sessionId',
  'overrideAuditSafe',
  'answerMode',
  'maxWords',
  'max_words',
  '__arcanosExecutionMode',
  ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG,
] as const;

function mergeForwardedTopLevelPayloadFields(
  body: Record<string, unknown>,
  explicitPayload: Record<string, unknown>
): Record<string, unknown> {
  const mergedPayload = { ...explicitPayload };

  for (const key of FORWARDED_TOP_LEVEL_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(mergedPayload, key)) {
      continue;
    }

    const forwardedValue = body[key];
    if (forwardedValue !== undefined) {
      mergedPayload[key] = forwardedValue;
    }
  }

  return mergedPayload;
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
    const explicitPayload = body.payload;
    if (isRecord(explicitPayload)) {
      const sanitizedPayload = mergeForwardedTopLevelPayloadFields(body, explicitPayload);
      delete sanitizedPayload.gptId;
      return sanitizedPayload;
    }
    return explicitPayload;
  }

  const prompt = extractPrompt(body);

  //audit Assumption: legacy module handlers often inspect `prompt` even for non-query actions; failure risk: callers using message/query aliases break after dispatch normalization; expected invariant: prompt alias is preserved when extractable; handling strategy: inject prompt field for object payload fallbacks.
  if (isRecord(body)) {
    const normalizedPayload = { ...body };
    delete normalizedPayload.gptId;
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

function applyRuntimeExecutionModeOverride(
  payload: unknown,
  runtimeExecutionMode: 'request' | 'background' | undefined
): unknown {
  if (!runtimeExecutionMode || !isRecord(payload)) {
    return payload;
  }

  return {
    ...payload,
    __arcanosExecutionMode: runtimeExecutionMode
  };
}

function readSuppressTimeoutFallbackFlag(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  return normalizeBooleanFlagValue(payload[ARCANOS_SUPPRESS_TIMEOUT_FALLBACK_FLAG]);
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

type PromptIntentClassification = {
  intent: 'memory' | 'generic';
  reason: string;
};

function classifyPromptIntent(params: {
  prompt: string | null;
  parsedMemoryCommand: { intent: string };
  hasMemoryCue: boolean;
}): PromptIntentClassification {
  const { prompt, parsedMemoryCommand, hasMemoryCue } = params;

  if (!prompt) {
    return {
      intent: 'generic',
      reason: 'no_prompt',
    };
  }

  if (parsedMemoryCommand.intent !== 'unknown' && hasMemoryCue) {
    return {
      intent: 'memory',
      reason: `memory_${parsedMemoryCommand.intent}`,
    };
  }

  return {
    intent: 'generic',
    reason: parsedMemoryCommand.intent !== 'unknown' ? 'memory_cue_not_confirmed' : 'no_specialized_intent',
  };
}

function resolveMemorySessionId(
  body: unknown,
  payload: unknown,
  moduleName: string,
  gptId: string,
  prompt: string | null
): string | undefined {
  const explicitSessionId = resolveSessionId(body, payload);
  if (explicitSessionId) {
    return explicitSessionId;
  }

  const promptScopedSessionId = typeof prompt === 'string' ? extractNaturalLanguageSessionId(prompt) : null;
  //audit Assumption: some clients communicate session scope inside the natural-language prompt rather than a structured field; failure risk: saves and recalls collapse into the global namespace; expected invariant: explicit prompt-level session labels outrank the global fallback; handling strategy: extract and honor safe inline session identifiers before defaulting.
  if (promptScopedSessionId) {
    return promptScopedSessionId;
  }

  const promptScopedStorageLabel = typeof prompt === 'string' ? extractNaturalLanguageStorageLabel(prompt) : null;
  //audit Assumption: some callers specify memory scope via a quoted storage label instead of a structured sessionId; failure risk: dispatcher routes label-based recall to the global namespace and returns unrelated memory rows; expected invariant: explicit prompt-level storage labels remain exact memory targets; handling strategy: pass the raw label through so the memory service can resolve its alias deterministically.
  if (promptScopedStorageLabel) {
    return promptScopedStorageLabel;
  }

  //audit Assumption: anonymous memory commands must remain stateless by default; failure risk: unrelated callers share one implicit memory namespace; expected invariant: memory interception only persists when a caller provides an explicit session scope or session-like label; handling strategy: return undefined and let the memory service fail closed.
  void moduleName;
  void gptId;
  return undefined;
}

function pickAction(available: string[], requested?: string, defaultAction?: string | null): string | null {
  if (requested) return available.includes(requested) ? requested : null;
  //audit Assumption: explicit module defaults should outrank generic `query`/`run` heuristics; failure risk: specialized modules like Backstage Booker remain ambiguous even after declaring their canonical default behavior; expected invariant: configured defaultAction wins when valid; handling strategy: honor metadata defaultAction before implicit fallbacks.
  if (defaultAction && available.includes(defaultAction)) return defaultAction;
  if (available.includes("query")) return "query";
  if (available.includes("run")) return "run";
  if (available.length === 1) return available[0];
  return null;
}

function normalizeRequestedAction(requestedAction: string | undefined): string | undefined {
  return typeof requestedAction === 'string' && requestedAction.trim().length > 0
    ? requestedAction.trim()
    : undefined;
}

function getLegacyQueryAlias(requestedAction: string | undefined): 'ask' | 'chat' | null {
  const normalizedRequestedAction = normalizeRequestedAction(requestedAction);
  if (!normalizedRequestedAction) {
    return null;
  }

  const loweredRequestedAction = normalize(normalizedRequestedAction);
  if (loweredRequestedAction === 'ask' || loweredRequestedAction === 'chat') {
    return loweredRequestedAction;
  }

  return null;
}

/**
 * Purpose: Canonicalize legacy requested actions onto supported module actions.
 * Inputs/Outputs: Accepts an optional caller-provided action plus the module's available actions and returns the canonical action name.
 * Edge cases: Preserves direct matches and blank actions while rewriting legacy `ask`/`chat` requests onto `query` when safe.
 */
function resolveRequestedActionAlias(
  requestedAction: string | undefined,
  availableActions: string[]
): string | undefined {
  //audit Assumption: blank action names should behave like absent actions; failure risk: whitespace-only actions forcing false NO_DEFAULT_ACTION errors; expected invariant: blank actions do not override defaults; handling strategy: trim and return undefined for blank values.
  if (typeof requestedAction !== 'string') {
    return undefined;
  }

  const trimmedRequestedAction = requestedAction.trim();
  if (trimmedRequestedAction.length === 0) {
    return undefined;
  }

  const normalizedRequestedAction = trimmedRequestedAction.toLowerCase();
  const directMatch = availableActions.find(
    (actionName) => actionName.toLowerCase() === normalizedRequestedAction
  );

  //audit Assumption: case-only mismatches are safe to normalize onto the module's canonical casing; failure risk: action lookup missing valid handlers due to casing drift; expected invariant: returned actions use registered module casing; handling strategy: prefer the first direct module action match.
  if (directMatch) {
    return directMatch;
  }

  const legacyQueryAlias = getLegacyQueryAlias(trimmedRequestedAction);
  //audit Assumption: legacy callers still send `ask`/`chat` during migration; failure risk: canonical `query` modules reject compatible legacy traffic; expected invariant: query-capable modules accept legacy aliases via canonical `query`; handling strategy: rewrite only when `query` is actually supported.
  if (legacyQueryAlias && availableActions.includes('query')) {
    return 'query';
  }

  return trimmedRequestedAction;
}

const DISPATCH_TIMEOUT_ERROR_MARKERS = [
  'openai_call_aborted_due_to_budget',
  'runtime_budget_exhausted',
  'runtimebudget',
  'budgetexceeded',
  'watchdog threshold',
  'execution aborted by watchdog',
  'request was aborted.',
];

function isDispatchTimeoutError(err: unknown, timeoutMs?: number): boolean {
  if (isAbortError(err)) {
    return true;
  }

  const normalizedMessage = resolveErrorMessage(err).toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  if (typeof timeoutMs === 'number' && normalizedMessage === `module dispatch timeout after ${timeoutMs}ms`) {
    return true;
  }

  return DISPATCH_TIMEOUT_ERROR_MARKERS.some((marker) => normalizedMessage.includes(marker));
}

function isDispatchCancellationError(err: unknown): boolean {
  if (!isAbortError(err)) {
    return false;
  }

  const normalizedMessage = resolveErrorMessage(err).toLowerCase();
  return normalizedMessage.includes('cancel');
}

function buildDispatchTimeoutMessage(timeoutMs?: number, scope: 'module' | 'mcp' = 'module'): string {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return scope === 'mcp'
      ? `MCP dispatch timeout after ${timeoutMs}ms`
      : `Module dispatch timeout after ${timeoutMs}ms`;
  }

  return scope === 'mcp'
    ? 'MCP dispatch timed out before completion.'
    : 'Module dispatch timed out before completion.';
}

function buildDispatchTimeoutDetails(moduleName: string, errorMessage: string): Record<string, unknown> | undefined {
  const normalizedMessage = errorMessage.toLowerCase();
  if (
    moduleName === 'ARCANOS:CORE' &&
    normalizedMessage.includes('arcanos:core pipeline timeout after')
  ) {
    return {
      timeoutKind: 'pipeline_timeout',
      degradedModeReason: 'arcanos_core_pipeline_timeout'
    };
  }

  return undefined;
}

function logTrinityExecution(
  requestLogger: { info?: (message: string, meta?: Record<string, unknown>) => void } | undefined,
  params: {
    requestId?: string;
    gptId: string;
    action: 'query';
    handler: string;
    path: string;
    module: string;
    route: string;
  }
): void {
  requestLogger?.info?.('[trinity-exec]', {
    requestId: params.requestId,
    gptId: params.gptId,
    action: params.action,
    handler: params.handler,
    path: params.path,
    module: params.module,
    route: params.route,
  });
}

interface AutomaticBackstageBookerDispatchIntent {
  module: 'BACKSTAGE:BOOKER';
  route: string;
  action: 'generateBooking';
  reason: string;
}

/**
 * Resolve an automatic backstage-booker dispatch when a prompt clearly requests wrestling booking.
 * Inputs/outputs: current module context + prompt + GPT map -> backstage-booker dispatch intent or null.
 * Edge cases: only upgrades default/query-style traffic so explicit non-booker actions keep their existing semantics.
 */
function inferAutomaticBackstageBookerDispatchIntent(params: {
  currentModuleName: string;
  currentRoute: string;
  prompt: string | null;
  requestedAction: string | undefined;
  gptModuleMap: Record<string, GptMapEntry>;
}): AutomaticBackstageBookerDispatchIntent | null {
  const { currentModuleName, currentRoute, prompt, requestedAction, gptModuleMap } = params;

  //audit Assumption: explicit non-query actions must preserve caller intent; failure risk: dispatcher rewrites specialized action contracts into booking generation; expected invariant: only default/query-style traffic can auto-route; handling strategy: reject non-query explicit actions.
  if (requestedAction && requestedAction !== "query") {
    return null;
  }

  const intentMatch = detectBackstageBookerIntent(prompt);
  //audit Assumption: booker auto-routing should require a strong scored match; failure risk: generic prompts hijack to backstage booking; expected invariant: no reroute without deterministic detection; handling strategy: return null when no intent match exists.
  if (!intentMatch) {
    return null;
  }

  if (currentModuleName === "BACKSTAGE:BOOKER") {
    return {
      module: "BACKSTAGE:BOOKER",
      route: currentRoute,
      action: "generateBooking",
      reason: intentMatch.reason
    };
  }

  //audit Assumption: core/default GPT traffic may need to hand off to the dedicated booker module for wrestling-booking prompts; failure risk: prompt remains in generic chat path and returns filler/greetings; expected invariant: a registered backstage route exists before reroute; handling strategy: scan the GPT map for the canonical booker route and reroute only when found.
  if (currentModuleName === "ARCANOS:CORE") {
    const backstageEntry = Object.values(gptModuleMap).find(entry => entry.module === "BACKSTAGE:BOOKER");
    if (!backstageEntry) {
      return null;
    }

    return {
      module: "BACKSTAGE:BOOKER",
      route: backstageEntry.route,
      action: "generateBooking",
      reason: intentMatch.reason
    };
  }

  return null;
}

const DEFAULT_MODULE_DISPATCH_TIMEOUT_MS = 15000;
const DEFAULT_BACKGROUND_MODULE_DISPATCH_TIMEOUT_MS = 180000;
const SUPPRESS_PROMPT_DEBUG_TRACE_FLAG = '__arcanosSuppressPromptDebugTrace';
const REDACTED_GPT_ACCESS_PROMPT = '[REDACTED_GPT_ACCESS_PROMPT]';
const REDACTED_GPT_ACCESS_PAYLOAD = '[REDACTED_GPT_ACCESS_PAYLOAD]';

function readPromptDebugSuppressionFlag(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const rawValue = value[SUPPRESS_PROMPT_DEBUG_TRACE_FLAG];
  return rawValue === true || (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === 'true');
}

function shouldSuppressPromptDebugTrace(body: unknown, preDispatchPayload: unknown): boolean {
  return readPromptDebugSuppressionFlag(body) || readPromptDebugSuppressionFlag(preDispatchPayload);
}

function sanitizePromptDebugExecutorPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_GPT_ACCESS_PAYLOAD;
  }

  const sanitizedPayload: Record<string, unknown> = {
    redacted: true,
    payload: REDACTED_GPT_ACCESS_PAYLOAD,
  };

  for (const key of ['executor', 'module', 'action', 'timeoutMs', 'timeoutSource']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      sanitizedPayload[key] = value[key];
    }
  }

  return sanitizedPayload;
}

function sanitizePromptDebugPatchForGptAccess(patch: PromptDebugTracePatch): PromptDebugTracePatch {
  return {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, 'rawPrompt')
      ? { rawPrompt: REDACTED_GPT_ACCESS_PROMPT }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'normalizedPrompt')
      ? { normalizedPrompt: REDACTED_GPT_ACCESS_PROMPT }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'finalExecutorPayload')
      ? { finalExecutorPayload: sanitizePromptDebugExecutorPayload(patch.finalExecutorPayload) }
      : {}),
  };
}

function recordDispatchPromptDebugTrace(
  requestId: string,
  stage: PromptDebugStage,
  patch: PromptDebugTracePatch,
  suppressPromptDebugTrace: boolean
) {
  return recordPromptDebugTrace(
    requestId,
    stage,
    suppressPromptDebugTrace ? sanitizePromptDebugPatchForGptAccess(patch) : patch
  );
}

function resolvePositiveTimeoutMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveBackgroundDispatchTimeoutMs(): number {
  const configuredTimeoutMs = Number.parseInt(process.env.GPT_BACKGROUND_DISPATCH_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return DEFAULT_BACKGROUND_MODULE_DISPATCH_TIMEOUT_MS;
  }

  return Math.max(60_000, Math.min(300_000, Math.trunc(configuredTimeoutMs)));
}

function resolveDispatchTimeout(
  body: unknown,
  moduleMetadata: { defaultTimeoutMs?: number } | null,
  runtimeExecutionMode?: 'request' | 'background'
): {
  timeoutMs: number;
  timeoutSource:
    | "request"
    | "module-default"
    | "dispatcher-default"
    | "request-cap"
    | "background-default"
    | "background-cap";
} {
  const moduleTimeoutMs = resolvePositiveTimeoutMs(moduleMetadata?.defaultTimeoutMs);
  if (runtimeExecutionMode === 'background') {
    const backgroundTimeoutMs = Math.max(
      moduleTimeoutMs ?? 0,
      resolveBackgroundDispatchTimeoutMs()
    );
    const requestRemainingMs = getRequestRemainingMs();

    if (requestRemainingMs !== null) {
      return {
        timeoutMs: Math.max(1, Math.min(backgroundTimeoutMs, requestRemainingMs)),
        timeoutSource: backgroundTimeoutMs > requestRemainingMs ? 'background-cap' : 'background-default'
      };
    }

    return {
      timeoutMs: backgroundTimeoutMs,
      timeoutSource: 'background-default'
    };
  }

  const requestTimeoutMs = resolvePositiveTimeoutMs((body as any)?.timeoutMs);
  if (requestTimeoutMs !== null) {
    const requestRemainingMs = getRequestRemainingMs();
    if (requestRemainingMs !== null) {
      return {
        timeoutMs: Math.max(1, Math.min(requestTimeoutMs, requestRemainingMs)),
        timeoutSource: requestTimeoutMs > requestRemainingMs ? "request-cap" : "request"
      };
    }
    return { timeoutMs: requestTimeoutMs, timeoutSource: "request" };
  }

  if (moduleTimeoutMs !== null) {
    const requestRemainingMs = getRequestRemainingMs();
    if (requestRemainingMs !== null) {
      return {
        timeoutMs: Math.max(1, Math.min(moduleTimeoutMs, requestRemainingMs)),
        timeoutSource: moduleTimeoutMs > requestRemainingMs ? "request-cap" : "module-default"
      };
    }
    return { timeoutMs: moduleTimeoutMs, timeoutSource: "module-default" };
  }

  const requestRemainingMs = getRequestRemainingMs();
  if (requestRemainingMs !== null) {
    return {
      timeoutMs: Math.max(1, Math.min(DEFAULT_MODULE_DISPATCH_TIMEOUT_MS, requestRemainingMs)),
      timeoutSource: DEFAULT_MODULE_DISPATCH_TIMEOUT_MS > requestRemainingMs ? "request-cap" : "dispatcher-default"
    };
  }

  return {
    timeoutMs: DEFAULT_MODULE_DISPATCH_TIMEOUT_MS,
    timeoutSource: "dispatcher-default",
  };
}

type GptMapEntry = GptModuleEntry;

const FORCED_DIRECT_GPT_BINDINGS: Record<string, GptMapEntry> = {
  "arcanos-gaming": { module: "ARCANOS:GAMING", route: "gaming" },
};

function normalize(s: string): string {
  return (s || "").toLowerCase().trim();
}

function resolveForcedDirectGptEntry(incomingGptId: string): {
  entry: GptMapEntry;
  matchMethod: GptMatchMethod | "normalized";
  matchedId: string;
} | null {
  const exactEntry = FORCED_DIRECT_GPT_BINDINGS[incomingGptId];
  if (exactEntry) {
    return {
      entry: exactEntry,
      matchMethod: "exact",
      matchedId: incomingGptId,
    };
  }

  return null;
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

type UnknownGptRecoveryResult = {
  gptModuleMap: Record<string, GptModuleEntry>;
  resolved: { entry: GptMapEntry; matchMethod: GptMatchMethod | "normalized"; matchedId: string } | null;
  missingRequiredGpts: string[];
  requiredGptIds: string[];
};

async function recoverUnknownGptEntry(params: {
  gptId: string;
  requestId?: string;
  logger?: any;
  endpoint?: string;
}): Promise<UnknownGptRecoveryResult> {
  const { gptId, requestId, logger, endpoint } = params;
  logger?.warn?.("gpt.dispatch.lookup.rehydrate", {
    requestId,
    gptId,
    endpoint,
  });

  const gptModuleMap = await rebuildGptModuleMap();
  const validation = validateGptRegistry(gptModuleMap);
  const resolved = resolveGptEntry(gptId, gptModuleMap);

  logger?.[resolved ? "info" : "warn"]?.("gpt.dispatch.lookup.rehydrate_result", {
    requestId,
    gptId,
    endpoint,
    recovered: Boolean(resolved),
    requiredGptIds: validation.requiredGptIds,
    missingRequiredGpts: validation.missingGptIds,
  });

  return {
    gptModuleMap,
    resolved,
    missingRequiredGpts: validation.missingGptIds,
    requiredGptIds: validation.requiredGptIds
  };
}

function buildUnknownGptError(trimmedGptId: string, recovery?: {
  missingRequiredGpts?: string[];
  missingGptIds?: string[];
  requiredGptIds: string[];
}): { code: string; message: string; details?: Record<string, unknown> } {
  const missingRequiredGpts = recovery?.missingRequiredGpts ?? recovery?.missingGptIds ?? [];
  const details = recovery
    ? {
        recoveryAttempted: true,
        requiredGptIds: recovery.requiredGptIds,
        missingRequiredGpts,
        recoveryHint:
          missingRequiredGpts.length > 0
            ? `Registry rehydration ran, but required GPT bindings are still missing: ${missingRequiredGpts.join(', ')}. Check startup logs for gpt.registry.startup and verify the built-in module definitions loaded correctly.`
            : `Registry rehydration ran but '${trimmedGptId}' is still unknown. Check GPT_MODULE_MAP overrides and /healthz required_gpts output.`
      }
    : undefined;

  return {
    code: "UNKNOWN_GPT",
    message: `gptId '${trimmedGptId}' is not registered`,
    ...(details ? { details } : {})
  };
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

  const directResolved = resolveForcedDirectGptEntry(trimmedGptId);
  let gptModuleMap = directResolved ? null : await getGptModuleMap();
  let resolved = directResolved ?? resolveGptEntry(trimmedGptId, gptModuleMap ?? {});

  if (!resolved) {
    const recovery = await recoverUnknownGptEntry({
      gptId: trimmedGptId,
      requestId
    });
    gptModuleMap = recovery.gptModuleMap;
    resolved = resolveForcedDirectGptEntry(trimmedGptId) ?? recovery.resolved;
    if (!resolved) {
      return {
        ok: false,
        error: buildUnknownGptError(trimmedGptId, recovery),
        _route: baseRoute
      };
    }
  }

  const { entry, matchMethod, matchedId } = resolved;
  const meta = getModuleMetadata(entry.module);
  const availableActions = meta?.actions ?? [];
  const action = pickAction(availableActions, undefined, meta?.defaultAction ?? null);

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
  const {
    gptId,
    body,
    requestId,
    logger,
    request,
    bypassIntentRouting,
    runtimeExecutionMode,
    parentAbortSignal,
    suppressTimeoutFallback: suppressTimeoutFallbackInput
  } = input;
  const trimmedGptId = (gptId ?? "").trim();
  const requestEndpoint = request?.originalUrl ?? request?.url ?? request?.path;
  const preDispatchPayload = applyRuntimeExecutionModeOverride(
    buildDispatchPayload(body),
    runtimeExecutionMode
  );
  const suppressTimeoutFallback =
    suppressTimeoutFallbackInput === true ||
    readSuppressTimeoutFallbackFlag(preDispatchPayload);
  const suppressPromptDebugTrace = shouldSuppressPromptDebugTrace(body, preDispatchPayload);
  const diagnosticTextInput = extractPrompt(preDispatchPayload) ?? extractDiagnosticTextInput(body as Record<string, unknown> | undefined);
  const promptDebugRequestId = requestId ?? `gpt-${trimmedGptId || 'unknown'}`;
  const rawPrompt = extractPrompt(body) ?? diagnosticTextInput ?? '';
  const normalizedPrompt = extractPrompt(preDispatchPayload) ?? diagnosticTextInput ?? '';
  recordDispatchPromptDebugTrace(promptDebugRequestId, 'ingress', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
  }, suppressPromptDebugTrace);
  recordDispatchPromptDebugTrace(promptDebugRequestId, 'preprocess', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
    normalizedPrompt,
  }, suppressPromptDebugTrace);

  const baseRoute: RouteMeta = {
    requestId,
    gptId: trimmedGptId,
    timestamp: new Date().toISOString(),
  };

  logger?.info?.("gpt.dispatch.received", {
    requestId,
    gptId: trimmedGptId,
    endpoint: requestEndpoint,
  });

  if (!trimmedGptId) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "Missing gptId" }, _route: baseRoute };
  }
  if (trimmedGptId.length > 256) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "gptId too long" }, _route: baseRoute };
  }

  //audit Assumption: diagnostic probes must never enter module resolution or gameplay dispatch; failure risk: lightweight health checks trigger simulation, HRC, or persistence side effects; expected invariant: `action:"ping"` or `prompt:"ping"` returns the fixed diagnostic payload immediately; handling strategy: short-circuit before GPT map lookup and before any action inference.
  if (isDiagnosticRequest(body as Record<string, unknown> | undefined, diagnosticTextInput)) {
    recordDispatchPromptDebugTrace(promptDebugRequestId, 'response', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: 'diagnostic',
      selectedModule: 'diagnostic',
      responseReturned: buildDiagnosticRouteResult(),
    }, suppressPromptDebugTrace);
    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: 'diagnostic',
      route: 'diagnostic',
      handler: 'diagnostic',
      outcome: 'ok',
    });
    return {
      ok: true,
      result: buildDiagnosticRouteResult(),
      _route: {
        ...baseRoute,
        module: "diagnostic",
        action: "diagnostic",
        route: "diagnostic",
        availableActions: [],
        moduleVersion: null,
      }
    };
  }

  const rawRequestedAction = typeof body?.action === "string" ? body.action.trim() : undefined;
  const writePlaneClassification = classifyGptRequestPlane({
    body,
    promptText: normalizedPrompt || rawPrompt || null,
    requestedAction: rawRequestedAction ?? null,
  });
  if (writePlaneClassification.plane !== "writing") {
    const controlError =
      writePlaneClassification.plane === "reject"
        ? {
            code: writePlaneClassification.errorCode,
            message: writePlaneClassification.message,
            details: {
              canonical: writePlaneClassification.canonical,
              reason: writePlaneClassification.reason,
              kind: writePlaneClassification.kind,
            },
          }
        : {
            code: "WRITING_PLANE_ONLY",
            message:
              "Control-plane requests must be handled by direct control handlers before entering the writing dispatcher.",
            details: {
              reason: writePlaneClassification.reason,
              kind: writePlaneClassification.kind,
            },
          };

    logger?.warn?.("gpt.dispatch.write_guard_rejected", {
      requestId,
      gptId: trimmedGptId,
      endpoint: requestEndpoint,
      action: writePlaneClassification.action,
      plane: writePlaneClassification.plane,
      kind: writePlaneClassification.kind,
      reason: writePlaneClassification.reason,
    });
    if (writePlaneClassification.kind === "mcp_control") {
      logger?.error?.("gpt.dispatch.write_guard.mcp_violation", {
        requestId,
        gptId: trimmedGptId,
        endpoint: requestEndpoint,
        action: writePlaneClassification.action,
        plane: writePlaneClassification.plane,
        kind: writePlaneClassification.kind,
        reason: writePlaneClassification.reason,
      });
    }
    if (writePlaneClassification.kind === "dag_control") {
      logger?.error?.("gpt.dispatch.write_guard.dag_violation", {
        requestId,
        gptId: trimmedGptId,
        endpoint: requestEndpoint,
        action: writePlaneClassification.action,
        plane: writePlaneClassification.plane,
        kind: writePlaneClassification.kind,
        reason: writePlaneClassification.reason,
      });
    }
    recordDispatcherMisroute({
      gptId: trimmedGptId,
      module: "write-guard",
      reason: writePlaneClassification.reason,
    });
    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: "write-guard",
      route: "write_guard",
      handler: "write-guard",
      outcome: "rejected",
    });
    recordDispatchPromptDebugTrace(promptDebugRequestId, "fallback", {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? "/gpt/:gptId",
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: "write_guard",
      selectedModule: "write-guard",
      fallbackPathUsed: "write-guard",
      fallbackReason: controlError.message,
    }, suppressPromptDebugTrace);
    return {
      ok: false,
      error: controlError,
      _route: {
        ...baseRoute,
        action: writePlaneClassification.action,
        route: "write_guard",
      },
    };
  }
  assertWritingPlaneClassification(writePlaneClassification);

  logger?.info?.("gpt.write.entry", {
    requestId,
    gptId: trimmedGptId,
    endpoint: requestEndpoint,
    action: writePlaneClassification.action ?? "query",
  });

  const forcedDirectResolved = resolveForcedDirectGptEntry(trimmedGptId);
  const forceDirectModuleRouting = Boolean(forcedDirectResolved) || bypassIntentRouting === true;
  let gptModuleMap = forcedDirectResolved ? null : await getGptModuleMap();
  let resolved = forcedDirectResolved ?? resolveGptEntry(trimmedGptId, (gptModuleMap ?? {}) as any);
  if (!resolved) {
    const recovery = await recoverUnknownGptEntry({
      gptId: trimmedGptId,
      requestId,
      logger,
      endpoint: requestEndpoint,
    });
    gptModuleMap = recovery.gptModuleMap;
    resolved = resolveForcedDirectGptEntry(trimmedGptId) ?? recovery.resolved;
  }
  if (!resolved) {
    logger?.warn?.("gpt.dispatch.lookup.unknown", {
      requestId,
      gptId: trimmedGptId,
      endpoint: requestEndpoint,
      requiredGptIds: validateGptRegistry((gptModuleMap ?? {}) as Record<string, GptModuleEntry>).requiredGptIds,
    });
    recordUnknownGpt({
      gptId: trimmedGptId,
      outcome: 'not_registered',
    });
    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: 'unknown',
      route: 'unknown',
      handler: 'unknown-gpt',
      outcome: 'error',
    });
    return {
      ok: false,
      error: buildUnknownGptError(
        trimmedGptId,
        validateGptRegistry((gptModuleMap ?? {}) as Record<string, GptModuleEntry>)
      ),
      _route: baseRoute,
    };
  }

  const { entry, matchMethod } = resolved;
  logger?.info?.("gpt.dispatch.lookup.resolved", {
    requestId,
    gptId: trimmedGptId,
    endpoint: requestEndpoint,
    module: entry.module,
    route: entry.route,
    matchMethod,
    forcedDirectRoute: forceDirectModuleRouting,
    bypassIntentRouting: bypassIntentRouting === true,
  });
  const payload = preDispatchPayload;
  const prompt = extractPrompt(payload);
  const requestedMode = extractMode(body, payload);
  let activeEntry = entry;
  let moduleMetadata = getModuleMetadata(activeEntry.module);
  let availableActions = moduleMetadata?.actions ?? [];
  let requestedAction = resolveRequestedActionAlias(rawRequestedAction, availableActions);

  //audit Assumption: gameplay generation must be explicit and never inferred from a GPT binding alone; failure risk: minimal or context-free prompts fall into the gaming simulation pipeline; expected invariant: ARCANOS:GAMING executes only when callers send `mode:"gameplay"`; handling strategy: fail closed before memory, repo inspection, HRC, and module dispatch.
  if (activeEntry.module === "ARCANOS:GAMING" && requestedMode !== "gameplay") {
    return {
      ok: false,
      error: {
        code: "GAMEPLAY_MODE_REQUIRED",
        message: "Gameplay requests require explicit mode 'gameplay'."
      },
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        action: requestedAction ?? undefined,
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      }
    };
  }

  const parsedMemoryCommand =
    typeof prompt === "string" ? parseNaturalLanguageMemoryCommand(prompt) : { intent: "unknown" };
  const initialActionCandidate = pickAction(availableActions, requestedAction, moduleMetadata?.defaultAction ?? null);
  const hasNoRoutableAction = !initialActionCandidate;
  const sessionId = resolveSessionId(body, payload);
  const hasMemoryCue = typeof prompt === "string" && hasNaturalLanguageMemoryCue(prompt);
  const promptIntentClassification = classifyPromptIntent({
    prompt,
    parsedMemoryCommand,
    hasMemoryCue,
  });
  const repoInspectionRequested = shouldInspectRepoPrompt(prompt);

  logger?.info?.("gpt.dispatch.intent_classification", {
    requestId,
    gptId: trimmedGptId,
    endpoint: requestEndpoint,
    selectedModule: activeEntry.module,
    selectedRoute: activeEntry.route,
    promptIntent: promptIntentClassification.intent,
    classificationReason: promptIntentClassification.reason,
    routingDetectedIntent: "STANDARD",
    memoryIntent: parsedMemoryCommand.intent !== "unknown" ? parsedMemoryCommand.intent : null,
    fallbackReason: null,
  });
  recordDispatchPromptDebugTrace(promptDebugRequestId, 'routing', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
    normalizedPrompt,
    selectedRoute: activeEntry.route,
    selectedModule: activeEntry.module,
    repoInspectionChosen: repoInspectionRequested,
    runtimeInspectionChosen: false,
    intentTags: [
      promptIntentClassification.intent,
      ...(parsedMemoryCommand.intent !== "unknown" ? [`memory:${parsedMemoryCommand.intent}`] : []),
    ],
  }, suppressPromptDebugTrace);

  const shouldInterceptMemoryInDispatcher =
    typeof prompt === "string" &&
    parsedMemoryCommand.intent !== "unknown" &&
    (hasMemoryCue || hasNoRoutableAction) &&
    (!requestedAction || requestedAction === "query");

  //audit Assumption: memory commands should bypass module action ambiguity (e.g., multi-action modules without default query); failure risk: user cannot use memory reliably via dispatcher; expected invariant: explicit memory intents always have a deterministic execution path; handling strategy: early memory execution branch before action resolution.
  if (!forceDirectModuleRouting && shouldInterceptMemoryInDispatcher) {
    try {
      const memorySessionId = resolveMemorySessionId(body, payload, activeEntry.module, trimmedGptId, prompt);
      const memoryResult = await executeNaturalLanguageMemoryCommand({
        input: prompt,
        sessionId: memorySessionId
      });

      const routedMemoryResult = {
        handledBy: "memory-dispatcher",
        memory: memoryResult
      };

      await persistModuleConversation({
        moduleName: activeEntry.module,
        route: activeEntry.route,
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
          module: activeEntry.module,
          action: requestedAction || "memory",
          error: String((error as Error)?.message ?? error)
        });
      });

      logger?.info?.("gpt.dispatch.memory_intercept", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action: requestedAction || "memory",
        memoryIntent: parsedMemoryCommand.intent,
        memoryOperation: memoryResult.operation
      });

      if (memoryResult.operation === "ignored") {
        recordMemoryDispatchIgnored({
          gptId: trimmedGptId,
          module: activeEntry.module,
          reason: 'ignored_without_fallback',
        });
      }
      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'memory-dispatcher',
        outcome: memoryResult.operation === 'ignored' ? 'ignored' : 'ok',
      });
      recordDispatchPromptDebugTrace(promptDebugRequestId, 'response', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools: ['memory-dispatcher'],
        finalExecutorPayload: {
          executor: 'memory-dispatcher',
          prompt,
          sessionId: memorySessionId,
        },
        responseReturned: routedMemoryResult,
        fallbackPathUsed: memoryResult.operation === 'ignored' ? 'memory-ignored' : null,
        fallbackReason: memoryResult.operation === 'ignored' ? 'ignored_without_fallback' : null,
      }, suppressPromptDebugTrace);
      return {
        ok: true,
        result: routedMemoryResult,
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: requestedAction || "memory",
          matchMethod,
          route: activeEntry.route,
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
          module: activeEntry.module,
          action: requestedAction || "memory",
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null
        }
      };
    }
  }

  const automaticBackstageBookerDispatch = forceDirectModuleRouting
    ? null
    : inferAutomaticBackstageBookerDispatchIntent({
        currentModuleName: activeEntry.module,
        currentRoute: activeEntry.route,
        prompt,
        requestedAction,
        gptModuleMap: (gptModuleMap ?? {}) as Record<string, GptMapEntry>
      });

  if (automaticBackstageBookerDispatch) {
    activeEntry = {
      module: automaticBackstageBookerDispatch.module,
      route: automaticBackstageBookerDispatch.route
    };
    moduleMetadata = getModuleMetadata(activeEntry.module);
    availableActions = moduleMetadata?.actions ?? [];
    requestedAction = resolveRequestedActionAlias(rawRequestedAction, availableActions);
    logger?.info?.("gpt.dispatch.booker.auto_selected", {
      requestId,
      gptId: trimmedGptId,
      originalModule: entry.module,
      module: activeEntry.module,
      action: automaticBackstageBookerDispatch.action,
      reason: automaticBackstageBookerDispatch.reason,
      route: activeEntry.route,
      matchMethod
    });
  }

  const actionCandidate =
    automaticBackstageBookerDispatch?.action ??
    pickAction(availableActions, requestedAction, moduleMetadata?.defaultAction ?? null);

  //audit Assumption: action alias rewrites must remain visible during the deprecation window; failure risk: silent compatibility behavior masks stale callers; expected invariant: logs show when legacy action names are rewritten; handling strategy: emit structured alias telemetry whenever canonical action differs from caller input.
  if (
    rawRequestedAction &&
    requestedAction &&
    rawRequestedAction.trim().toLowerCase() !== requestedAction.toLowerCase()
  ) {
    logger?.info?.("gpt.dispatch.action_alias", {
      requestId,
      gptId: trimmedGptId,
      module: activeEntry.module,
      requestedAction: rawRequestedAction,
      canonicalAction: requestedAction,
    });
  }

  let automaticRepoInspectionResult:
    | {
        handledBy: "repo-inspection";
        repoInspection: {
          reason: "prompt_requests_repo_inspection";
          answer: string;
          evidence: Awaited<ReturnType<typeof collectRepoImplementationEvidence>>;
        };
      }
    | null = null;
  if (
    !forceDirectModuleRouting &&
    activeEntry.module === "ARCANOS:CORE" &&
    (!requestedAction || requestedAction === "query") &&
    (!actionCandidate || actionCandidate === "query") &&
    repoInspectionRequested
  ) {
    try {
      const repoEvidence = await collectRepoImplementationEvidence();
      automaticRepoInspectionResult = {
        handledBy: "repo-inspection",
        repoInspection: {
          reason: "prompt_requests_repo_inspection",
          answer: buildRepoInspectionAnswer(prompt!, repoEvidence),
          evidence: repoEvidence,
        },
      };

      logger?.info?.("gpt.dispatch.repo_inspection.ok", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        reason: "prompt_requests_repo_inspection",
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "MODULE_ERROR",
          message: `Repository inspection failed: ${resolveErrorMessage(error)}`,
        },
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: "repo.inspect",
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null,
        },
      };
    }
  }
  if (automaticRepoInspectionResult) {
    await persistModuleConversation({
      moduleName: activeEntry.module,
      route: activeEntry.route,
      action: "repo.inspect",
      gptId: trimmedGptId,
      sessionId,
      requestId,
      requestPayload: payload,
      responsePayload: automaticRepoInspectionResult,
    }).catch((error: unknown) => {
      logger?.warn?.("gpt.dispatch.repo_inspection.persistence_failed", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action: "repo.inspect",
        error: String((error as Error)?.message ?? error),
      });
    });

    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: activeEntry.module,
      route: activeEntry.route,
      handler: 'repo-inspection',
      outcome: 'ok',
    });
    recordDispatchPromptDebugTrace(promptDebugRequestId, 'response', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: activeEntry.route,
      selectedModule: activeEntry.module,
      selectedTools: ['repo-inspection'],
      repoInspectionChosen: true,
      runtimeInspectionChosen: false,
      finalExecutorPayload: {
        executor: 'repo-inspection',
        prompt,
      },
      responseReturned: automaticRepoInspectionResult,
    }, suppressPromptDebugTrace);
    return {
      ok: true,
      result: automaticRepoInspectionResult,
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        action: "repo.inspect",
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }

  const action = actionCandidate;

  if (!action) {
    const message = requestedAction
      ? `Requested action '${rawRequestedAction ?? requestedAction}' is not available for module ${activeEntry.module}`
      : availableActions.length > 1
      ? `Ambiguous actions and no default 'query' action found for module ${activeEntry.module}`
      : `No actions available for module ${activeEntry.module}`;

    return {
      ok: false,
      error: {
        code: "NO_DEFAULT_ACTION",
        message,
        details: { availableActions, requestedAction },
      },
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }

  const { timeoutMs, timeoutSource } = resolveDispatchTimeout(
    body,
    moduleMetadata,
    runtimeExecutionMode
  );

  //audit Assumption: query actions depend on natural-language prompt content; failure risk: modules receiving empty prompt and failing deep in stack; expected invariant: query dispatch has message/prompt text; handling strategy: validate prompt at router boundary.
  if (actionRequiresPrompt(action) && !prompt) {
    return {
      ok: false,
      error: { code: "BAD_REQUEST", message: "Query actions require message/prompt (or messages[])." },
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        action,
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }

  logger?.info?.("gpt.dispatch.plan", {
    requestId,
    gptId: trimmedGptId,
    module: activeEntry.module,
    action,
    matchMethod,
    timeoutMs,
    timeoutSource,
  });
  recordDispatchPromptDebugTrace(promptDebugRequestId, 'executor', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
    normalizedPrompt,
    selectedRoute: activeEntry.route,
    selectedModule: activeEntry.module,
    selectedTools: [],
    repoInspectionChosen: repoInspectionRequested,
    runtimeInspectionChosen: false,
    finalExecutorPayload: {
      executor: 'module-dispatch',
      module: activeEntry.module,
      action,
      payload,
      timeoutMs,
      timeoutSource,
    },
  }, suppressPromptDebugTrace);

  if (action === "query") {
    logTrinityExecution(logger, {
      requestId,
      gptId: trimmedGptId,
      action,
      handler: activeEntry.module,
      path: `/gpt/${trimmedGptId}`,
      module: activeEntry.module,
      route: activeEntry.route,
    });
  }

  const dispatchStartedAt = Date.now();

  try {
      const activeAbortContext = getRequestAbortContext();
      const result = await runWithRequestAbortTimeout(
        {
          timeoutMs,
          requestId,
          parentSignal: parentAbortSignal ?? activeAbortContext?.signal,
          abortMessage: `Module dispatch timeout after ${timeoutMs}ms`
        },
      () => dispatchModuleAction(activeEntry.module, action, payload)
    );

    const resolvedSessionId = resolveSessionId(body, payload);
    await persistModuleConversation({
      moduleName: activeEntry.module,
      route: activeEntry.route,
      action,
      gptId: trimmedGptId,
      sessionId: resolvedSessionId,
      requestId,
      requestPayload: payload,
      responsePayload: result
    }).catch((error: unknown) => {
      //audit Assumption: persistence failures should not fail successful module responses; failure risk: dropped conversation history; expected invariant: user still receives module output; handling strategy: warn and continue.
      logger?.warn?.("gpt.dispatch.persistence_failed", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action,
        error: String((error as Error)?.message ?? error),
      });
    });

    logger?.info?.("gpt.dispatch.ok", {
      requestId,
      gptId: trimmedGptId,
      module: activeEntry.module,
      action,
      timeoutMs,
      timeoutSource,
      durationMs: Date.now() - dispatchStartedAt,
    });

    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: activeEntry.module,
      route: activeEntry.route,
      handler: 'module-dispatcher',
      outcome: 'ok',
    });
    recordDispatchPromptDebugTrace(promptDebugRequestId, 'response', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: activeEntry.route,
      selectedModule: activeEntry.module,
      responseReturned: result,
    }, suppressPromptDebugTrace);
    return {
      ok: true,
      result,
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        action,
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  } catch (err: any) {
      const errorMessage = String(err?.message ?? err);
      const isDispatchCancellation = isDispatchCancellationError(err);
      const isDispatchTimeout = !isDispatchCancellation && isDispatchTimeoutError(err, timeoutMs);
      const dispatchLogEvent = isDispatchTimeout ? "gpt.dispatch.timeout" : "gpt.dispatch.error";
      const dispatchErrorMessage = isDispatchTimeout
        ? buildDispatchTimeoutMessage(timeoutMs)
        : isDispatchCancellation
        ? 'GPT job cancellation requested.'
        : err?.message ?? "Module dispatch failed";

    logger?.error?.("gpt.dispatch.error", {
      requestId,
      gptId: trimmedGptId,
      module: activeEntry.module,
      action,
      matchMethod,
      error: errorMessage,
      timeoutMs,
      timeoutSource,
      durationMs: Date.now() - dispatchStartedAt,
    });
      if (isDispatchTimeout) {
      logger?.error?.(dispatchLogEvent, {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action,
        matchMethod,
        error: errorMessage,
        timeoutMs,
        timeoutSource,
        durationMs: Date.now() - dispatchStartedAt,
      });
      }

      if (isDispatchCancellation) {
        return {
          ok: false,
          error: {
            code: 'REQUEST_ABORTED',
            message: dispatchErrorMessage
          },
          _route: {
            ...baseRoute,
            module: activeEntry.module,
            action,
            matchMethod,
            route: activeEntry.route,
            availableActions,
            moduleVersion: (moduleMetadata as any)?.version ?? null,
          },
        };
      }

      if (
        isDispatchTimeout &&
        !suppressTimeoutFallback &&
        activeEntry.module === 'ARCANOS:CORE' &&
        action === 'query' &&
        typeof prompt === 'string' &&
        prompt.length > 0
      ) {
        const timeoutPhase = resolveArcanosCoreTimeoutPhase(err) ?? 'module-dispatch';
        const timeoutFallback = buildArcanosCoreTimeoutFallbackEnvelope({
          prompt,
          gptId: trimmedGptId,
          requestId,
          route: activeEntry.route,
          timeoutPhase,
        });
        recordDispatcherRoute({
          gptId: trimmedGptId,
          module: activeEntry.module,
          route: activeEntry.route,
          handler: 'module-dispatcher',
          outcome: 'timeout',
        });
        recordDispatcherFallback({
          gptId: trimmedGptId,
          module: activeEntry.module,
          reason: 'module_timeout_static_fallback',
        });
        logger?.warn?.('gpt.dispatch.timeout_fallback', {
          requestId,
          gptId: trimmedGptId,
          module: activeEntry.module,
          action,
          route: activeEntry.route,
          errorType: 'module_timeout_static_fallback',
          error: errorMessage,
          timeoutPhase,
          timeoutMs,
          timeoutSource,
          durationMs: Date.now() - dispatchStartedAt,
        });
        recordDispatchPromptDebugTrace(promptDebugRequestId, 'response', {
          traceId: request?.traceId ?? null,
          endpoint: requestEndpoint ?? '/gpt/:gptId',
          method: request?.method ?? null,
          rawPrompt,
          normalizedPrompt,
          selectedRoute: activeEntry.route,
          selectedModule: activeEntry.module,
          responseReturned: timeoutFallback.result,
          fallbackPathUsed: 'module-timeout-static-fallback',
          fallbackReason: dispatchErrorMessage,
        }, suppressPromptDebugTrace);
        return {
          ok: true,
          result: timeoutFallback.result,
          _route: {
            ...baseRoute,
            ...timeoutFallback._route,
            module: activeEntry.module,
            action,
            matchMethod,
            route: activeEntry.route,
            availableActions,
            moduleVersion: (moduleMetadata as any)?.version ?? null,
          },
        };
      }

    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: activeEntry.module,
      route: activeEntry.route,
      handler: 'module-dispatcher',
      outcome: isDispatchTimeout ? 'timeout' : 'error',
    });
    recordDispatchPromptDebugTrace(promptDebugRequestId, 'fallback', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: activeEntry.route,
      selectedModule: activeEntry.module,
      fallbackPathUsed: 'module-dispatcher',
      fallbackReason: dispatchErrorMessage,
    }, suppressPromptDebugTrace);
    return {
      ok: false,
      error: {
        code: isDispatchTimeout ? "MODULE_TIMEOUT" : "MODULE_ERROR",
        message: dispatchErrorMessage,
        ...(buildDispatchTimeoutDetails(activeEntry.module, errorMessage)
          ? { details: buildDispatchTimeoutDetails(activeEntry.module, errorMessage) }
          : {})
      },
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        action,
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
    };
  }
}
