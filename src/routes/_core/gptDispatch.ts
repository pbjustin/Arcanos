import getGptModuleMap, {
  rebuildGptModuleMap,
  validateGptRegistry,
  type GptModuleEntry
} from "@platform/runtime/gptRouterConfig.js";
import { dispatchModuleAction, getModuleMetadata } from "../modules.js";
import type { GptMatchMethod } from "@platform/logging/gptLogger.js";
import { persistModuleConversation } from "@services/moduleConversationPersistence.js";
import { arcanosMcpService, type ArcanosMcpService, type ArcanosMcpToolCallResult, type ArcanosMcpToolListResult } from "@services/arcanosMcp.js";
import {
  executeNaturalLanguageMemoryCommand,
  extractNaturalLanguageSessionId,
  extractNaturalLanguageStorageLabel,
  hasDagOrchestrationIntentCue,
  hasNaturalLanguageMemoryCue,
  parseNaturalLanguageMemoryCommand
} from "@services/naturalLanguageMemory.js";
import { detectBackstageBookerIntent } from "@services/backstageBookerRouteShortcut.js";
import {
  buildRepoInspectionAnswer,
  collectRepoImplementationEvidence,
  shouldInspectRepoPrompt,
} from "@services/repoImplementationEvidence.js";
import { recordAiRoutingDebugSnapshot } from "@services/aiRoutingDebugService.js";
import { extractDiagnosticTextInput, isDiagnosticRequest } from "@shared/http/diagnosticRequest.js";
import { isRecord } from "@shared/typeGuards.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import type { Request } from "express";
import {
  buildDagRunFollowUpPaths,
  shouldTreatPromptAsDagExecution,
} from "@shared/dag/dagExecutionRouting.js";
import {
  getRequestAbortContext,
  getRequestRemainingMs,
  isAbortError,
  runWithRequestAbortTimeout
} from "@arcanos/runtime";
import {
  recordDagTraceTimeout,
  recordDispatcherFallback,
  recordDispatcherMisroute,
  recordDispatcherRoute,
  recordMcpAutoInvoke,
  recordMemoryDispatchIgnored,
  recordUnknownGpt,
} from "@platform/observability/appMetrics.js";
import { SystemStateConflictError } from "@services/systemState.js";
import {
  recordPromptDebugTrace,
  shouldInspectRuntimePrompt,
} from "@services/promptDebugTraceService.js";
import {
  classifyRuntimeInspectionPrompt,
  executeRuntimeInspection,
} from "@services/runtimeInspectionRoutingService.js";
import { tryExecuteDeterministicDagTools, type DagDeterministicExecutionResult } from "../ask/dagTools.js";

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
    if (isRecord(explicitPayload) && Object.prototype.hasOwnProperty.call(explicitPayload, 'gptId')) {
      const sanitizedPayload = { ...explicitPayload };
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

type McpDispatchIntent =
  | {
      action: 'mcp.invoke';
      toolName: string;
      toolArguments: Record<string, unknown>;
      dispatchMode: 'automatic' | 'explicit';
      reason: string;
      followLatestRunWithTrace?: boolean;
    }
  | {
      action: 'mcp.list_tools';
      dispatchMode: 'automatic' | 'explicit';
      reason: string;
    };

type PromptIntentClassification = {
  intent: 'dag' | 'memory' | 'generic';
  reason: string;
  bypassMemoryDispatcher: boolean;
};

function getRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getRecordObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function normalizeMcpDispatchAction(rawAction: string | undefined): 'mcp.invoke' | 'mcp.list_tools' | null {
  if (!rawAction) {
    return null;
  }

  const normalizedAction = normalize(rawAction);
  if (normalizedAction === 'mcp.invoke' || normalizedAction === 'mcp.run') {
    return 'mcp.invoke';
  }
  if (
    normalizedAction === 'mcp.list_tools' ||
    normalizedAction === 'mcp.listtools' ||
    normalizedAction === 'mcp.list-tools'
  ) {
    return 'mcp.list_tools';
  }

  return null;
}

/**
 * Resolve explicit dispatcher requests for the internal ARCANOS MCP service.
 * Inputs/Outputs: requested action plus normalized payload; returns MCP intent, validation error, or null.
 * Edge cases: ignores payload.mcp when a non-MCP action was explicitly requested.
 */
function parseMcpDispatchIntent(
  requestedAction: string | undefined,
  payload: unknown
): { intent: McpDispatchIntent | null; error?: string } {
  const normalizedRequestedAction = normalizeMcpDispatchAction(requestedAction);

  //audit Assumption: explicit non-MCP actions must keep existing dispatcher semantics; failure risk: payload fields accidentally reroute normal module calls into MCP; expected invariant: MCP branch only activates for explicit MCP actions or when no action was requested and payload.mcp is present; handling strategy: short-circuit on non-MCP requested actions.
  if (requestedAction && !normalizedRequestedAction) {
    return { intent: null };
  }

  const payloadRecord = isRecord(payload) ? payload : null;
  const embeddedEnvelope = payloadRecord ? getRecordObject(payloadRecord, 'mcp') : undefined;
  const envelope = embeddedEnvelope ?? payloadRecord;

  if (!envelope) {
    return { intent: null };
  }

  const normalizedEnvelopeAction =
    normalizedRequestedAction ??
    normalizeMcpDispatchAction(getRecordString(envelope, 'action') ?? getRecordString(envelope, 'operation'));

  if (!normalizedEnvelopeAction) {
    return { intent: null };
  }

  if (normalizedEnvelopeAction === 'mcp.list_tools') {
    return {
      intent: {
        action: 'mcp.list_tools',
        dispatchMode: 'explicit',
        reason: 'payload_mcp_list_tools',
      }
    };
  }

  const toolName =
    getRecordString(envelope, 'toolName') ??
    getRecordString(envelope, 'name');

  //audit Assumption: MCP invoke dispatch requires a concrete tool identifier; failure risk: opening a dispatcher MCP session with an empty target creates opaque downstream errors; expected invariant: every MCP invoke request names one tool; handling strategy: reject malformed requests at dispatcher boundary.
  if (!toolName) {
    return { intent: null, error: 'MCP invoke dispatch requires payload.toolName (or payload.mcp.toolName).' };
  }

  const toolArguments =
    getRecordObject(envelope, 'toolArguments') ??
    getRecordObject(envelope, 'arguments') ??
    {};

  return {
    intent: {
      action: 'mcp.invoke',
      toolName,
      toolArguments,
      dispatchMode: 'explicit',
      reason: 'payload_mcp_invoke',
    }
  };
}

const automaticMcpListToolsPattern =
  /\b(?:list|show|get|what(?:\s+are)?)\b[^.!?\n]{0,24}\b(?:mcp\s+)?tools?\b|\bmcp\s+tools?\b/i;
const automaticMcpModulesListPattern =
  /\b(?:list|show|get)\b[^.!?\n]{0,20}\bmodules?\b|\bmodules?\b[^.!?\n]{0,20}\b(?:list|show|get)\b/i;
const automaticMcpHealthReportPattern =
  /\b(?:ops|system|backend|service|deployment|railway)\b[^.!?\n]{0,28}\bhealth\b|\bhealth\b[^.!?\n]{0,28}\b(?:ops|system|backend|service|deployment|railway)\b|\bhealth\s+report\b/i;
const automaticMcpDagLatestRunPattern =
  /\b(?:latest|recent|most recent)\b[^.!?\n]{0,40}\b(?:dag(?:\s+run)?|workflow(?:\s+run)?|orchestration(?:\s+run)?)\b|\b(?:dag(?:\s+run)?|workflow(?:\s+run)?|orchestration(?:\s+run)?)\b[^.!?\n]{0,40}\b(?:latest|recent|most recent)\b/i;
const automaticMcpDagTraceSelectorPattern =
  /\b(?:full\s+trace|trace|lineage|nodes?|events?|metrics?|verification)\b/i;
const automaticMcpDagRunIdPattern = /\b(dagrun[-_][a-z0-9_-]+)\b/i;
const automaticMcpDagExplicitCommandPattern = /^\s*module\s*:\s*dag\b/i;
const automaticMcpDagApiRoutePattern = /\/api\/arcanos\/dag\b/i;
const automaticMcpStrongCuePattern = /\b(?:use|via|through)\s+mcp\b|\bmcp\s+(?:server|tools?|tooling)\b/i;
const automaticMcpOpsVerbPattern =
  /\b(?:diagnose|debug|inspect|audit|analyze|check|report|trace|verify|investigate|orchestrate|manage)\b/i;
const automaticMcpBackendNounPattern =
  /\b(?:backend|system|deployment|service|worker|queue|database|postgres|redis|railway|dag|workflow|plan|plans|agent|agents|module|modules|research|memory)\b/i;
const automaticRuntimeVerificationVerbPattern =
  /\b(?:verify|check|confirm|validate|inspect|test|probe)\b/i;
const automaticRuntimeVerificationStrongCuePattern =
  /\b(?:verify\s+in\s+production|currently\s+active|system\s+health|health\s+probe|live\s+verification)\b/i;

function shouldAutoInspectRuntimeVerificationPrompt(prompt: string | null): boolean {
  if (!prompt || !shouldInspectRuntimePrompt(prompt)) {
    return false;
  }

  return (
    automaticRuntimeVerificationStrongCuePattern.test(prompt) ||
    automaticRuntimeVerificationVerbPattern.test(prompt)
  );
}

function isRuntimeInspectionMcpIntent(intent: McpDispatchIntent | null): boolean {
  return intent?.action === 'mcp.invoke' && intent.toolName === 'ops.health_report';
}

function shouldPreferAutomaticDagExecution(params: {
  moduleName: string;
  prompt: string | null;
  requestedAction: string | undefined;
  actionCandidate: string | null;
  promptIntent: PromptIntentClassification['intent'];
}): boolean {
  const { moduleName, prompt, requestedAction, actionCandidate, promptIntent } = params;

  if (!prompt) {
    return false;
  }

  if (requestedAction && requestedAction !== 'query') {
    return false;
  }

  if (moduleName !== 'ARCANOS:CORE') {
    return false;
  }

  if (actionCandidate && actionCandidate !== 'query') {
    return false;
  }

  if (promptIntent !== 'dag') {
    return false;
  }

  return shouldTreatPromptAsDagExecution(prompt, { requireDagTokenForArtifact: true });
}

function resolveAiRoutingDetectedIntent(params: {
  promptIntent: PromptIntentClassification['intent'];
  dagExecutionPreferred: boolean;
  runtimeInspectionRequired: boolean;
}): 'RUNTIME_INSPECTION_REQUIRED' | 'DAG_EXECUTION_REQUIRED' | 'STANDARD' {
  const { promptIntent, dagExecutionPreferred, runtimeInspectionRequired } = params;

  if (promptIntent === 'dag' && dagExecutionPreferred) {
    return 'DAG_EXECUTION_REQUIRED';
  }

  return runtimeInspectionRequired ? 'RUNTIME_INSPECTION_REQUIRED' : 'STANDARD';
}

function mapDagToolNameToDispatcherAction(toolName: string): string {
  switch (toolName) {
    case 'create_dag_run':
      return 'dag.run.create';
    case 'get_latest_dag_run':
      return 'dag.run.latest';
    case 'get_dag_run':
      return 'dag.run.get';
    case 'get_dag_trace':
      return 'dag.run.trace';
    case 'get_dag_tree':
      return 'dag.run.tree';
    case 'get_dag_node':
      return 'dag.run.node';
    case 'get_dag_events':
      return 'dag.run.events';
    case 'get_dag_metrics':
      return 'dag.run.metrics';
    case 'get_dag_errors':
      return 'dag.run.errors';
    case 'get_dag_lineage':
      return 'dag.run.lineage';
    case 'cancel_dag_run':
      return 'dag.run.cancel';
    case 'get_dag_verification':
      return 'dag.run.verification';
    default:
      return toolName;
  }
}

function buildAutomaticDagDispatchResult(
  execution: DagDeterministicExecutionResult,
): {
  primaryAction: string;
  selectedTools: string[];
  responsePayload: {
    handledBy: 'dag-dispatcher';
    dag: {
      dispatchMode: 'automatic';
      reason: 'prompt_requests_dag_execution';
      summary: string;
      runId: string | null;
      run: Record<string, unknown> | null;
      artifacts: Record<string, Record<string, unknown>>;
      artifactKeys: string[];
      deferredTools: {
        total: number;
        tools: string[];
      };
      followUp: {
        runId: string;
        trace: string;
        tree: string;
        lineage: string;
        metrics: string;
        errors: string;
        verification: string;
      } | null;
      steps: Array<{
        action: string;
        output: Record<string, unknown>;
      }>;
    };
  };
} {
  const selectedTools = execution.operations.map(operation =>
    mapDagToolNameToDispatcherAction(operation.toolName),
  );
  const primaryAction = execution.operations.some(operation => operation.toolName === 'create_dag_run')
    ? 'dag.run.create'
    : selectedTools[0] ?? 'dag.run.create';
  const runStep =
    execution.operations.find(operation =>
      operation.toolName === 'create_dag_run' ||
      operation.toolName === 'get_dag_run' ||
      operation.toolName === 'get_latest_dag_run',
    ) ?? null;
  const artifacts = Object.fromEntries(
    execution.operations.map(operation => [
      mapDagToolNameToDispatcherAction(operation.toolName),
      operation.output,
    ]),
  );
  const runId = execution.runId;
  const followUp = runId ? buildDagRunFollowUpPaths(runId) : null;

  return {
    primaryAction,
    selectedTools,
    responsePayload: {
      handledBy: 'dag-dispatcher',
      dag: {
        dispatchMode: 'automatic',
        reason: 'prompt_requests_dag_execution',
        summary: execution.summary,
        runId,
        run: runStep?.output ?? null,
        artifacts,
        artifactKeys: Object.keys(artifacts),
        deferredTools: {
          total: execution.deferredToolNames.length,
          tools: execution.deferredToolNames.map(toolName =>
            mapDagToolNameToDispatcherAction(toolName),
          ),
        },
        followUp,
        steps: execution.operations.map(operation => ({
          action: mapDagToolNameToDispatcherAction(operation.toolName),
          output: operation.output,
        })),
      },
    },
  };
}

/**
 * Infer conservative automatic MCP dispatch for query-like operational prompts.
 * Inputs/Outputs: module, action context, prompt text, and session id; returns MCP intent or null.
 * Edge cases: only auto-routes generic tutor-like query flows so domain-specific modules keep their existing handlers.
 */
function inferAutomaticMcpDispatchIntent(params: {
  moduleName: string;
  prompt: string | null;
  requestedAction: string | undefined;
  actionCandidate: string | null;
  sessionId: string | undefined;
}): McpDispatchIntent | null {
  const { moduleName, prompt, requestedAction, actionCandidate, sessionId } = params;

  //audit Assumption: automatic MCP selection should never override explicit non-query actions; failure risk: dispatcher bypasses strict module contracts; expected invariant: auto MCP only applies to query-like traffic; handling strategy: gate on absent/`query` action intent.
  if (requestedAction && requestedAction !== 'query') {
    return null;
  }

  //audit Assumption: auto MCP routing is safest on the primary ARCANOS core path; failure risk: domain-specific modules lose specialized behavior; expected invariant: gaming/booker/etc. keep existing module dispatch unless MCP was explicit; handling strategy: restrict automatic inference to the core module.
  if (moduleName !== 'ARCANOS:CORE') {
    return null;
  }

  //audit Assumption: only query/default-query routes can be safely upgraded to MCP automatically; failure risk: ambiguous modules or non-query actions get rerouted unexpectedly; expected invariant: automatic MCP stays within generic query execution; handling strategy: require null-or-query action candidate.
  if (actionCandidate && actionCandidate !== 'query') {
    return null;
  }

  if (!prompt) {
    return null;
  }

  if (automaticMcpDagExplicitCommandPattern.test(prompt)) {
    const explicitDagRunIdMatch = automaticMcpDagRunIdPattern.exec(prompt);
    if (explicitDagRunIdMatch?.[1]) {
      return {
        action: 'mcp.invoke',
        toolName: 'dag.run.trace',
        toolArguments: {
          runId: explicitDagRunIdMatch[1],
        },
        dispatchMode: 'automatic',
        reason: 'prompt_requests_explicit_dag_trace',
      };
    }

      return {
        action: 'mcp.invoke',
        toolName: 'dag.run.latest',
        toolArguments: {
          ...(sessionId ? { sessionId } : {}),
        },
        dispatchMode: 'automatic',
        reason: 'prompt_requests_latest_dag_run',
        followLatestRunWithTrace: automaticMcpDagTraceSelectorPattern.test(prompt),
      };
    }

  if (automaticMcpListToolsPattern.test(prompt)) {
    return {
      action: 'mcp.list_tools',
      dispatchMode: 'automatic',
      reason: 'prompt_requests_mcp_tools',
    };
  }

  if (automaticMcpModulesListPattern.test(prompt)) {
    return {
      action: 'mcp.invoke',
      toolName: 'modules.list',
      toolArguments: {},
      dispatchMode: 'automatic',
      reason: 'prompt_requests_module_inventory',
    };
  }

  if (shouldAutoInspectRuntimeVerificationPrompt(prompt)) {
    return {
      action: 'mcp.invoke',
      toolName: 'ops.health_report',
      toolArguments: {},
      dispatchMode: 'automatic',
      reason: 'prompt_requests_runtime_verification',
    };
  }

  if (automaticMcpHealthReportPattern.test(prompt)) {
    return {
      action: 'mcp.invoke',
      toolName: 'ops.health_report',
      toolArguments: {},
      dispatchMode: 'automatic',
      reason: 'prompt_requests_ops_health',
    };
  }

  const dagRunIdMatch = automaticMcpDagRunIdPattern.exec(prompt);
  if (dagRunIdMatch?.[1] && automaticMcpDagTraceSelectorPattern.test(prompt)) {
    return {
      action: 'mcp.invoke',
      toolName: 'dag.run.trace',
      toolArguments: {
        runId: dagRunIdMatch[1],
      },
      dispatchMode: 'automatic',
      reason: 'prompt_requests_explicit_dag_trace',
    };
  }

  if (automaticMcpDagLatestRunPattern.test(prompt)) {
    return {
      action: 'mcp.invoke',
      toolName: 'dag.run.latest',
      toolArguments: {
        ...(sessionId ? { sessionId } : {}),
      },
      dispatchMode: 'automatic',
      reason: 'prompt_requests_latest_dag_run',
      followLatestRunWithTrace: automaticMcpDagTraceSelectorPattern.test(prompt),
    };
  }

  if (
    (automaticMcpDagApiRoutePattern.test(prompt) || hasDagOrchestrationIntentCue(prompt)) &&
    automaticMcpDagTraceSelectorPattern.test(prompt)
  ) {
    return {
      action: 'mcp.invoke',
      toolName: 'dag.run.latest',
      toolArguments: {
        ...(sessionId ? { sessionId } : {}),
      },
      dispatchMode: 'automatic',
      reason: 'prompt_requests_dag_orchestration',
      followLatestRunWithTrace: true,
    };
  }

  return null;
}

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
      bypassMemoryDispatcher: false,
    };
  }

  if (hasDagOrchestrationIntentCue(prompt)) {
    return {
      intent: 'dag',
      reason: prompt.includes('/api/arcanos/dag')
        ? 'api_arcanos_dag_reference'
        : /^\s*module\s*:\s*dag\b/i.test(prompt)
        ? 'explicit_module_dag_command'
        : 'dag_orchestration_terms',
      bypassMemoryDispatcher: true,
    };
  }

  if (parsedMemoryCommand.intent !== 'unknown' && hasMemoryCue) {
    return {
      intent: 'memory',
      reason: `memory_${parsedMemoryCommand.intent}`,
      bypassMemoryDispatcher: false,
    };
  }

  return {
    intent: 'generic',
    reason: parsedMemoryCommand.intent !== 'unknown' ? 'memory_cue_not_confirmed' : 'no_specialized_intent',
    bypassMemoryDispatcher: false,
  };
}

function getDispatcherMcpService(request: Request | undefined): ArcanosMcpService {
  const requestScopedService = request?.app?.locals?.arcanosMcp;
  //audit Assumption: app.locals may expose a request-scoped MCP facade; failure risk: missing app-local wiring breaks HTTP context reuse; expected invariant: fallback singleton remains available when locals are absent; handling strategy: validate shape and fall back to the shared service instance.
  if (
    requestScopedService &&
    typeof requestScopedService.invokeTool === 'function' &&
    typeof requestScopedService.listTools === 'function'
  ) {
    return requestScopedService as ArcanosMcpService;
  }

  return arcanosMcpService;
}

function extractMcpToolError(result: ArcanosMcpToolCallResult | ArcanosMcpToolListResult): {
  code: string;
  message: string;
  details?: unknown;
} | null {
  if (!('isError' in result) || result.isError !== true) {
    return null;
  }

  const structuredContent = isRecord(result.structuredContent) ? result.structuredContent : null;
  const errorBody = structuredContent && isRecord(structuredContent.error) ? structuredContent.error : null;
  if (!errorBody) {
    return {
      code: 'MCP_TOOL_ERROR',
      message: 'ARCANOS MCP tool returned an error result.',
    };
  }

  return {
    code: typeof errorBody.code === 'string' ? errorBody.code : 'MCP_TOOL_ERROR',
    message: typeof errorBody.message === 'string' ? errorBody.message : 'ARCANOS MCP tool returned an error result.',
    details: errorBody.details,
  };
}

function extractMcpToolOutput(
  result: ArcanosMcpToolCallResult | ArcanosMcpToolListResult
): Record<string, unknown> | ArcanosMcpToolCallResult | ArcanosMcpToolListResult {
  return isRecord(result) && isRecord(result.structuredContent)
    ? result.structuredContent
    : result;
}

function extractDagRunIdFromMcpOutput(output: unknown): string | null {
  if (!isRecord(output)) {
    return null;
  }

  const directRunId = typeof output.runId === 'string' ? output.runId.trim() : '';
  if (directRunId) {
    return directRunId;
  }

  const run = isRecord(output.run) ? output.run : null;
  const nestedRunId = run && typeof run.runId === 'string' ? run.runId.trim() : '';
  return nestedRunId || null;
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

function resolvePositiveTimeoutMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveDispatchTimeout(
  body: unknown,
  moduleMetadata: { defaultTimeoutMs?: number } | null
): { timeoutMs: number; timeoutSource: "request" | "module-default" | "dispatcher-default" | "request-cap" } {
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

  const moduleTimeoutMs = resolvePositiveTimeoutMs(moduleMetadata?.defaultTimeoutMs);
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
  const { gptId, body, requestId, logger, request } = input;
  const trimmedGptId = (gptId ?? "").trim();
  const requestEndpoint = request?.originalUrl ?? request?.url ?? request?.path;
  const preDispatchPayload = buildDispatchPayload(body);
  const diagnosticTextInput = extractPrompt(preDispatchPayload) ?? extractDiagnosticTextInput(body as Record<string, unknown> | undefined);
  const promptDebugRequestId = requestId ?? `gpt-${trimmedGptId || 'unknown'}`;
  const rawPrompt = extractPrompt(body) ?? diagnosticTextInput ?? '';
  const normalizedPrompt = extractPrompt(preDispatchPayload) ?? diagnosticTextInput ?? '';
  recordPromptDebugTrace(promptDebugRequestId, 'ingress', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
  });
  recordPromptDebugTrace(promptDebugRequestId, 'preprocess', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
    normalizedPrompt,
  });

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
    recordPromptDebugTrace(promptDebugRequestId, 'response', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: 'diagnostic',
      selectedModule: 'diagnostic',
      responseReturned: buildDiagnosticRouteResult(),
    });
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

  const forcedDirectResolved = resolveForcedDirectGptEntry(trimmedGptId);
  const forceDirectModuleRouting = Boolean(forcedDirectResolved);
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
  });
  const rawRequestedAction = typeof body?.action === "string" ? body.action.trim() : undefined;
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

  const mcpDispatch = forceDirectModuleRouting
    ? { intent: null as McpDispatchIntent | null, error: undefined }
    : parseMcpDispatchIntent(requestedAction, payload);
  if (mcpDispatch.error) {
    return {
      ok: false,
      error: { code: "BAD_REQUEST", message: mcpDispatch.error },
      _route: {
        ...baseRoute,
        module: activeEntry.module,
        action: requestedAction ?? "mcp.invoke",
        matchMethod,
        route: activeEntry.route,
        availableActions,
        moduleVersion: (moduleMetadata as any)?.version ?? null,
      },
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
  const runtimeInspectionClassification = classifyRuntimeInspectionPrompt(prompt);
  const runtimeInspectionRequired =
    runtimeInspectionClassification.detectedIntent === 'RUNTIME_INSPECTION_REQUIRED';
  const automaticDagExecutionPreferred =
    !forceDirectModuleRouting &&
    !mcpDispatch.intent &&
    shouldPreferAutomaticDagExecution({
      moduleName: activeEntry.module,
      prompt,
      requestedAction,
      actionCandidate: initialActionCandidate,
      promptIntent: promptIntentClassification.intent,
    });
  const routingDetectedIntent = resolveAiRoutingDetectedIntent({
    promptIntent: promptIntentClassification.intent,
    dagExecutionPreferred: automaticDagExecutionPreferred,
    runtimeInspectionRequired,
  });
  const runtimeInspectionChosenInRoutingTrace =
    runtimeInspectionRequired && routingDetectedIntent === 'RUNTIME_INSPECTION_REQUIRED';
  const repoInspectionAllowed = !runtimeInspectionClassification.repoInspectionDisabled;
  const repoInspectionRequested = repoInspectionAllowed && shouldInspectRepoPrompt(prompt);

  logger?.info?.("gpt.dispatch.intent_classification", {
    requestId,
    gptId: trimmedGptId,
    endpoint: requestEndpoint,
    selectedModule: activeEntry.module,
    selectedRoute: activeEntry.route,
    promptIntent: promptIntentClassification.intent,
    classificationReason: promptIntentClassification.reason,
    routingDetectedIntent,
    runtimeInspectionDetectedIntent: runtimeInspectionClassification.detectedIntent,
    dagExecutionPreferred: automaticDagExecutionPreferred,
    bypassMemoryDispatcher: promptIntentClassification.bypassMemoryDispatcher,
    memoryIntent: parsedMemoryCommand.intent !== "unknown" ? parsedMemoryCommand.intent : null,
    fallbackReason: null,
  });
  recordPromptDebugTrace(promptDebugRequestId, 'routing', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
    normalizedPrompt,
    selectedRoute: activeEntry.route,
    selectedModule: activeEntry.module,
    repoInspectionChosen: repoInspectionRequested,
    runtimeInspectionChosen: runtimeInspectionChosenInRoutingTrace,
    intentTags: [
      promptIntentClassification.intent,
      ...(parsedMemoryCommand.intent !== "unknown" ? [`memory:${parsedMemoryCommand.intent}`] : []),
      ...(routingDetectedIntent === 'DAG_EXECUTION_REQUIRED' ? ['dag_execution_requested'] : []),
      ...(runtimeInspectionChosenInRoutingTrace ? ['runtime_inspection_requested'] : []),
      ...(runtimeInspectionClassification.repoInspectionDisabled ? ['repo_inspection_disabled'] : []),
    ],
  });

  const shouldInterceptMemoryInDispatcher =
    typeof prompt === "string" &&
    parsedMemoryCommand.intent !== "unknown" &&
    !promptIntentClassification.bypassMemoryDispatcher &&
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

      if (
        memoryResult.operation === "ignored" &&
        typeof prompt === "string" &&
        hasDagOrchestrationIntentCue(prompt)
      ) {
        recordMemoryDispatchIgnored({
          gptId: trimmedGptId,
          module: activeEntry.module,
          reason: 'memory_ignored_retry_dag',
        });
        recordDispatcherMisroute({
          gptId: trimmedGptId,
          module: activeEntry.module,
          reason: 'memory_ignored_retry_dag',
        });
        recordDispatcherFallback({
          gptId: trimmedGptId,
          module: activeEntry.module,
          reason: 'memory_ignored_retry_dag',
        });
        logger?.warn?.("gpt.dispatch.intent_fallback", {
          requestId,
          gptId: trimmedGptId,
          endpoint: requestEndpoint,
          promptIntent: promptIntentClassification.intent,
          selectedModule: activeEntry.module,
          fallbackReason: "memory_ignored_retry_dag",
        });
      } else {
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
        recordPromptDebugTrace(promptDebugRequestId, 'response', {
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
        });
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
      }
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

  if (
    !forceDirectModuleRouting &&
    !mcpDispatch.intent &&
    shouldPreferAutomaticDagExecution({
      moduleName: activeEntry.module,
      prompt,
      requestedAction,
      actionCandidate,
      promptIntent: promptIntentClassification.intent,
    })
  ) {
    try {
      const requestBudgetMs = getRequestRemainingMs();
      const deterministicDagExecution = await tryExecuteDeterministicDagTools(prompt!, {
        sessionId,
        requestId: promptDebugRequestId,
        traceId: request?.traceId,
        logger,
        ...(typeof requestBudgetMs === 'number' ? { requestBudgetMs } : {}),
      });

      if (deterministicDagExecution) {
        const dagDispatch = buildAutomaticDagDispatchResult(deterministicDagExecution);

        recordAiRoutingDebugSnapshot({
          requestId: promptDebugRequestId,
          timestamp: new Date().toISOString(),
          rawPrompt,
          normalizedPrompt,
          detectedIntent: runtimeInspectionRequired ? 'RUNTIME_INSPECTION_REQUIRED' : 'STANDARD',
          detectedIntent: resolveAiRoutingDetectedIntent({
            promptIntent: promptIntentClassification.intent,
            dagExecutionPreferred: true,
            runtimeInspectionRequired,
          }),
          routingDecision: 'dag_execution_completed',
          toolsAvailable: dagDispatch.selectedTools,
          toolsSelected: dagDispatch.selectedTools,
          cliUsed: false,
          runtimeEndpointsQueried: [],
          repoFallbackUsed: false,
          constraintViolations: [],
        });

        await persistModuleConversation({
          moduleName: activeEntry.module,
          route: activeEntry.route,
          action: dagDispatch.primaryAction,
          gptId: trimmedGptId,
          sessionId,
          requestId,
          requestPayload: payload,
          responsePayload: dagDispatch.responsePayload,
        }).catch((error: unknown) => {
          logger?.warn?.("gpt.dispatch.dag_execution.persistence_failed", {
            requestId,
            gptId: trimmedGptId,
            module: activeEntry.module,
            action: dagDispatch.primaryAction,
            error: String((error as Error)?.message ?? error),
          });
        });

        logger?.info?.("gpt.dispatch.dag_execution.ok", {
          requestId,
          gptId: trimmedGptId,
          module: activeEntry.module,
          action: dagDispatch.primaryAction,
          selectedTools: dagDispatch.selectedTools,
          runId: deterministicDagExecution.runId,
        });

        recordDispatcherRoute({
          gptId: trimmedGptId,
          module: activeEntry.module,
          route: activeEntry.route,
          handler: 'dag-dispatcher',
          outcome: 'ok',
        });
        const dagDispatchTracePayload = {
        const dagDispatchTracePayload = {
          traceId: request?.traceId ?? null,
          endpoint: requestEndpoint ?? '/gpt/:gptId',
          method: request?.method ?? null,
          rawPrompt,
          normalizedPrompt,
          selectedRoute: activeEntry.route,
          selectedModule: activeEntry.module,
          selectedTools: dagDispatch.selectedTools,
          repoInspectionChosen: false,
          runtimeInspectionChosen: false,
          finalExecutorPayload: {
            executor: 'dag-dispatcher',
            prompt,
            runId: deterministicDagExecution.runId,
            selectedTools: dagDispatch.selectedTools,
          },
        };
        recordPromptDebugTrace(promptDebugRequestId, 'executor', dagDispatchTracePayload);
        recordPromptDebugTrace(promptDebugRequestId, 'response', {
          ...dagDispatchTracePayload,
          responseReturned: dagDispatch.responsePayload,
        });
        return {
          ok: true,
          result: dagDispatch.responsePayload,
          _route: {
            ...baseRoute,
            module: activeEntry.module,
            action: dagDispatch.primaryAction,
            matchMethod,
            route: activeEntry.route,
            availableActions,
            moduleVersion: (moduleMetadata as any)?.version ?? null,
          },
        };
      }
    } catch (error) {
      logger?.error?.("gpt.dispatch.dag_execution.error", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action: 'dag.run.create',
        error: resolveErrorMessage(error),
      });

      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'dag-dispatcher',
        outcome: 'error',
      });
      return {
        ok: false,
        error: {
          code: 'MODULE_ERROR',
          message: `DAG execution failed: ${resolveErrorMessage(error)}`,
        },
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: 'dag.run.create',
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null,
        },
      };
    }
  }

  if (
    !forceDirectModuleRouting &&
    !mcpDispatch.intent &&
    activeEntry.module === "ARCANOS:CORE" &&
    (!requestedAction || requestedAction === "query") &&
    (!actionCandidate || actionCandidate === "query") &&
    runtimeInspectionRequired
  ) {
    const runtimeInspection = await executeRuntimeInspection({
      requestId: promptDebugRequestId,
      rawPrompt,
      normalizedPrompt,
      request,
    });

    if (runtimeInspection.ok && runtimeInspection.responsePayload) {
      await persistModuleConversation({
        moduleName: activeEntry.module,
        route: activeEntry.route,
        action: "runtime.inspect",
        gptId: trimmedGptId,
        sessionId,
        requestId,
        requestPayload: payload,
        responsePayload: runtimeInspection.responsePayload,
      }).catch((error: unknown) => {
        logger?.warn?.("gpt.dispatch.runtime_inspection.persistence_failed", {
          requestId,
          gptId: trimmedGptId,
          module: activeEntry.module,
          action: "runtime.inspect",
          error: String((error as Error)?.message ?? error),
        });
      });

      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'runtime-inspection',
        outcome: 'ok',
      });
      recordPromptDebugTrace(promptDebugRequestId, 'executor', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools: runtimeInspection.selectedTools,
        repoInspectionChosen: false,
        runtimeInspectionChosen: true,
        finalExecutorPayload: {
          executor: 'runtime-inspection',
          prompt,
          runtimeEndpointsQueried: runtimeInspection.runtimeEndpointsQueried,
          cliUsed: runtimeInspection.cliUsed,
        },
      });
      recordPromptDebugTrace(promptDebugRequestId, 'response', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools: runtimeInspection.selectedTools,
        repoInspectionChosen: false,
        runtimeInspectionChosen: true,
        finalExecutorPayload: {
          executor: 'runtime-inspection',
          prompt,
          runtimeEndpointsQueried: runtimeInspection.runtimeEndpointsQueried,
          cliUsed: runtimeInspection.cliUsed,
        },
        responseReturned: runtimeInspection.responsePayload,
      });
      return {
        ok: true,
        result: runtimeInspection.responsePayload,
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: "runtime.inspect",
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null,
        },
      };
    }

    if (
      runtimeInspection.error &&
      (!runtimeInspection.repoFallbackAllowed || !repoInspectionRequested)
    ) {
      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'runtime-inspection',
        outcome: 'error',
      });
      recordPromptDebugTrace(promptDebugRequestId, 'fallback', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools: runtimeInspection.selectedTools,
        repoInspectionChosen: false,
        runtimeInspectionChosen: true,
        fallbackPathUsed: 'runtime-inspection',
        fallbackReason: runtimeInspection.error.message,
      });
      return {
        ok: false,
        error: runtimeInspection.error,
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: "runtime.inspect",
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null,
        },
      };
    }

    if (runtimeInspection.error && runtimeInspection.repoFallbackAllowed && repoInspectionRequested) {
      recordAiRoutingDebugSnapshot({
        ...runtimeInspection.routingDebug,
        timestamp: new Date().toISOString(),
        routingDecision: 'repo_inspection_fallback',
        repoFallbackUsed: true,
      });
    }
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
    !mcpDispatch.intent &&
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
          action: "mcp.auto.invoke",
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null,
        },
      };
    }
  }
  if (automaticRepoInspectionResult) {
    if (runtimeInspectionRequired) {
      recordAiRoutingDebugSnapshot({
        requestId: promptDebugRequestId,
        timestamp: new Date().toISOString(),
        rawPrompt,
        normalizedPrompt,
        detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
        routingDecision: 'repo_inspection_fallback',
        toolsAvailable: ['repo-inspection'],
        toolsSelected: ['repo-inspection'],
        cliUsed: false,
        runtimeEndpointsQueried: [],
        repoFallbackUsed: true,
        constraintViolations: repoInspectionAllowed ? [] : ['repo_inspection_used_when_disabled'],
      });
    }

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
    recordPromptDebugTrace(promptDebugRequestId, 'response', {
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
    });
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
  const automaticMcpDispatchIntent = forceDirectModuleRouting || mcpDispatch.intent
    ? null
    : inferAutomaticMcpDispatchIntent({
        moduleName: activeEntry.module,
        prompt,
        requestedAction,
        actionCandidate,
        sessionId,
      });
  const resolvedMcpDispatchIntent =
    mcpDispatch.intent ?? automaticMcpDispatchIntent;

  if (resolvedMcpDispatchIntent) {
    const dispatcherMcpService = getDispatcherMcpService(request);
    const dispatcherAction = resolvedMcpDispatchIntent.action;
    const runtimeInspectionChosen = isRuntimeInspectionMcpIntent(resolvedMcpDispatchIntent);
    const dispatcherRouteAction =
      resolvedMcpDispatchIntent.dispatchMode === "automatic"
        ? `mcp.auto.${dispatcherAction === "mcp.invoke" ? "invoke" : "list_tools"}`
        : dispatcherAction;
    const buildMcpDispatchErrorResponse = (error: { code: string; message: string; details?: unknown }) => {
      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'mcp-dispatcher',
        outcome: 'error',
      });
      recordPromptDebugTrace(promptDebugRequestId, 'fallback', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools:
          resolvedMcpDispatchIntent.action === 'mcp.invoke'
            ? [resolvedMcpDispatchIntent.toolName]
            : ['mcp.list_tools'],
        runtimeInspectionChosen,
        fallbackPathUsed: 'mcp-dispatcher',
        fallbackReason: error.message,
      });
      return {
        ok: false as const,
        error,
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: dispatcherRouteAction,
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null
        }
      };
    };

    if (resolvedMcpDispatchIntent.dispatchMode === "automatic") {
      if (resolvedMcpDispatchIntent.action === 'mcp.invoke') {
        recordMcpAutoInvoke({
          gptId: trimmedGptId,
          module: activeEntry.module,
          toolName: resolvedMcpDispatchIntent.toolName,
          reason: resolvedMcpDispatchIntent.reason,
        });
      }
      logger?.info?.("gpt.dispatch.mcp.auto_selected", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action: dispatcherAction,
        matchMethod,
        reason: resolvedMcpDispatchIntent.reason,
        toolName: resolvedMcpDispatchIntent.action === "mcp.invoke" ? resolvedMcpDispatchIntent.toolName : undefined,
      });
    }

    logger?.info?.("gpt.dispatch.mcp.plan", {
      requestId,
      gptId: trimmedGptId,
      module: activeEntry.module,
      action: dispatcherAction,
      matchMethod,
      dispatchMode: resolvedMcpDispatchIntent.dispatchMode,
      reason: resolvedMcpDispatchIntent.reason,
      toolName: resolvedMcpDispatchIntent.action === "mcp.invoke" ? resolvedMcpDispatchIntent.toolName : undefined,
    });
    recordPromptDebugTrace(promptDebugRequestId, 'executor', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: activeEntry.route,
      selectedModule: activeEntry.module,
      selectedTools:
        resolvedMcpDispatchIntent.action === 'mcp.invoke'
          ? [resolvedMcpDispatchIntent.toolName]
          : ['mcp.list_tools'],
      repoInspectionChosen: false,
      runtimeInspectionChosen,
      finalExecutorPayload:
        resolvedMcpDispatchIntent.action === 'mcp.invoke'
          ? {
              executor: 'mcp.invoke',
              prompt,
              toolName: resolvedMcpDispatchIntent.toolName,
              toolArguments: resolvedMcpDispatchIntent.toolArguments,
              sessionId,
              runtimeInspectionRequested: runtimeInspectionChosen,
            }
          : {
              executor: 'mcp.list_tools',
              prompt,
              sessionId,
              runtimeInspectionRequested: false,
            },
    });

    if (resolvedMcpDispatchIntent.action === "mcp.invoke" && resolvedMcpDispatchIntent.toolName === "trinity.query") {
      logTrinityExecution(logger, {
        requestId,
        gptId: trimmedGptId,
        action: "query",
        handler: "mcp.trinity.query",
        path: `/gpt/${trimmedGptId}`,
        module: activeEntry.module,
        route: activeEntry.route,
      });
    }

    try {
      const mcpResult =
        resolvedMcpDispatchIntent.action === "mcp.invoke"
          ? await dispatcherMcpService.invokeTool({
              toolName: resolvedMcpDispatchIntent.toolName,
              toolArguments: resolvedMcpDispatchIntent.toolArguments,
              request,
              sessionId,
            })
          : await dispatcherMcpService.listTools({
              request,
              sessionId,
            });

      const mcpToolError = extractMcpToolError(mcpResult);
      if (mcpToolError) {
        return buildMcpDispatchErrorResponse(mcpToolError);
      }

      let finalMcpResult = mcpResult;
      let finalToolName =
        resolvedMcpDispatchIntent.action === "mcp.invoke"
          ? resolvedMcpDispatchIntent.toolName
          : undefined;

      if (
        resolvedMcpDispatchIntent.action === "mcp.invoke" &&
        resolvedMcpDispatchIntent.followLatestRunWithTrace
      ) {
        const latestRunOutput = extractMcpToolOutput(mcpResult);
        const resolvedRunId = extractDagRunIdFromMcpOutput(latestRunOutput);

        if (resolvedRunId) {
          logger?.info?.("gpt.dispatch.mcp.follow_up", {
            requestId,
            gptId: trimmedGptId,
            module: activeEntry.module,
            sourceToolName: resolvedMcpDispatchIntent.toolName,
            followUpToolName: "dag.run.trace",
            runId: resolvedRunId,
          });

          const traceResult = await dispatcherMcpService.invokeTool({
            toolName: "dag.run.trace",
            toolArguments: { runId: resolvedRunId },
            request,
            sessionId,
          });

          const traceToolError = extractMcpToolError(traceResult);
          if (traceToolError) {
            return buildMcpDispatchErrorResponse(traceToolError);
          }

          if (resolvedMcpDispatchIntent.dispatchMode === "automatic") {
            recordMcpAutoInvoke({
              gptId: trimmedGptId,
              module: activeEntry.module,
              toolName: "dag.run.trace",
              reason: resolvedMcpDispatchIntent.reason,
            });
          }

          finalMcpResult = traceResult;
          finalToolName = "dag.run.trace";
        } else {
          logger?.warn?.("gpt.dispatch.mcp.follow_up_skipped", {
            requestId,
            gptId: trimmedGptId,
            module: activeEntry.module,
            sourceToolName: resolvedMcpDispatchIntent.toolName,
            reason: "latest_run_missing_run_id",
          });
        }
      }

      const routedMcpResult = {
        handledBy: "mcp-dispatcher",
        mcp:
          resolvedMcpDispatchIntent.action === "mcp.invoke"
            ? {
                action: "invoke",
                toolName: finalToolName,
                dispatchMode: resolvedMcpDispatchIntent.dispatchMode,
                reason: resolvedMcpDispatchIntent.reason,
                output: extractMcpToolOutput(finalMcpResult),
              }
            : {
                action: "list_tools",
                dispatchMode: resolvedMcpDispatchIntent.dispatchMode,
                reason: resolvedMcpDispatchIntent.reason,
                output: mcpResult,
              }
      };

      await persistModuleConversation({
        moduleName: activeEntry.module,
        route: activeEntry.route,
        action: dispatcherRouteAction,
        gptId: trimmedGptId,
        sessionId,
        requestId,
        requestPayload: payload,
        responsePayload: routedMcpResult
      }).catch((error: unknown) => {
        //audit Assumption: MCP dispatch persistence failures should not hide successful dispatcher output; failure risk: conversation history gaps; expected invariant: MCP result still returns to caller; handling strategy: warn and continue.
        logger?.warn?.("gpt.dispatch.mcp.persistence_failed", {
          requestId,
          gptId: trimmedGptId,
          module: activeEntry.module,
          action: dispatcherRouteAction,
          error: String((error as Error)?.message ?? error),
        });
      });

      logger?.info?.("gpt.dispatch.mcp.ok", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action: dispatcherAction,
        dispatchMode: resolvedMcpDispatchIntent.dispatchMode,
        reason: resolvedMcpDispatchIntent.reason,
        toolName: finalToolName,
      });

      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'mcp-dispatcher',
        outcome: 'ok',
      });
      recordPromptDebugTrace(promptDebugRequestId, 'response', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools: finalToolName ? [finalToolName] : ['mcp.list_tools'],
        runtimeInspectionChosen,
        responseReturned: routedMcpResult,
      });
      return {
        ok: true,
        result: routedMcpResult,
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: dispatcherRouteAction,
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null
        },
      };
    } catch (err: any) {
      const activeAbortContext = getRequestAbortContext();
      const isMcpTimeout = isDispatchTimeoutError(err, activeAbortContext?.timeoutMs);
      const mcpErrorMessage = isMcpTimeout
        ? buildDispatchTimeoutMessage(activeAbortContext?.timeoutMs, 'mcp')
        : err?.message ?? "MCP dispatch failed";

      logger?.error?.("gpt.dispatch.mcp.error", {
        requestId,
        gptId: trimmedGptId,
        module: activeEntry.module,
        action: dispatcherAction,
        matchMethod,
        dispatchMode: resolvedMcpDispatchIntent.dispatchMode,
        reason: resolvedMcpDispatchIntent.reason,
        error: String(err?.message ?? err),
        timeoutMs: activeAbortContext?.timeoutMs,
      });

      recordDispatcherRoute({
        gptId: trimmedGptId,
        module: activeEntry.module,
        route: activeEntry.route,
        handler: 'mcp-dispatcher',
        outcome: isMcpTimeout ? 'timeout' : 'error',
      });
      recordPromptDebugTrace(promptDebugRequestId, 'fallback', {
        traceId: request?.traceId ?? null,
        endpoint: requestEndpoint ?? '/gpt/:gptId',
        method: request?.method ?? null,
        rawPrompt,
        normalizedPrompt,
        selectedRoute: activeEntry.route,
        selectedModule: activeEntry.module,
        selectedTools:
          resolvedMcpDispatchIntent.action === 'mcp.invoke'
            ? [resolvedMcpDispatchIntent.toolName]
            : ['mcp.list_tools'],
        runtimeInspectionChosen,
        fallbackPathUsed: 'mcp-dispatcher',
        fallbackReason: mcpErrorMessage,
      });
      return {
        ok: false,
        error: {
          code: isMcpTimeout ? "MODULE_TIMEOUT" : "MODULE_ERROR",
          message: mcpErrorMessage
        },
        _route: {
          ...baseRoute,
          module: activeEntry.module,
          action: dispatcherRouteAction,
          matchMethod,
          route: activeEntry.route,
          availableActions,
          moduleVersion: (moduleMetadata as any)?.version ?? null
        },
      };
    }
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

  const { timeoutMs, timeoutSource } = resolveDispatchTimeout(body, moduleMetadata);

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
  recordPromptDebugTrace(promptDebugRequestId, 'executor', {
    traceId: request?.traceId ?? null,
    endpoint: requestEndpoint ?? '/gpt/:gptId',
    method: request?.method ?? null,
    rawPrompt,
    normalizedPrompt,
    selectedRoute: activeEntry.route,
    selectedModule: activeEntry.module,
    selectedTools: [],
    repoInspectionChosen: repoInspectionRequested,
    runtimeInspectionChosen: runtimeInspectionRequired,
    finalExecutorPayload: {
      executor: 'module-dispatch',
      module: activeEntry.module,
      action,
      payload,
      timeoutMs,
      timeoutSource,
    },
  });

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
        parentSignal: activeAbortContext?.signal,
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
    recordPromptDebugTrace(promptDebugRequestId, 'response', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: activeEntry.route,
      selectedModule: activeEntry.module,
      responseReturned: result,
    });
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
    if (err instanceof SystemStateConflictError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.conflict
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

    const errorMessage = String(err?.message ?? err);
    const isDispatchTimeout = isDispatchTimeoutError(err, timeoutMs);
    const dispatchLogEvent = isDispatchTimeout ? "gpt.dispatch.timeout" : "gpt.dispatch.error";
    const dispatchErrorMessage = isDispatchTimeout
      ? buildDispatchTimeoutMessage(timeoutMs)
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
      if (promptIntentClassification.intent === 'dag') {
        recordDagTraceTimeout({
          handler: 'gpt-dispatch',
          reason: 'module_timeout',
        });
      }
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

    recordDispatcherRoute({
      gptId: trimmedGptId,
      module: activeEntry.module,
      route: activeEntry.route,
      handler: 'module-dispatcher',
      outcome: isDispatchTimeout ? 'timeout' : 'error',
    });
    recordPromptDebugTrace(promptDebugRequestId, 'fallback', {
      traceId: request?.traceId ?? null,
      endpoint: requestEndpoint ?? '/gpt/:gptId',
      method: request?.method ?? null,
      rawPrompt,
      normalizedPrompt,
      selectedRoute: activeEntry.route,
      selectedModule: activeEntry.module,
      fallbackPathUsed: 'module-dispatcher',
      fallbackReason: dispatchErrorMessage,
    });
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
