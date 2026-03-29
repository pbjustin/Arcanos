import {
  listAiRoutingDebugSnapshots,
  type AiRoutingDebugSnapshot,
} from '@services/aiRoutingDebugService.js';
import {
  listPromptDebugTraces,
  type PromptDebugTraceRecord,
} from '@services/promptDebugTraceService.js';
import {
  buildPredictiveHealingStatusSnapshot,
} from '@services/selfImprove/predictiveHealingService.js';
import {
  buildSelfHealTelemetrySnapshot,
  inferSelfHealComponentFromAction,
  type SelfHealEvent,
  type SelfHealTelemetrySnapshot,
} from '@services/selfImprove/selfHealTelemetry.js';
import { getSelfHealingControlLoopStatus } from '@services/selfImprove/controlLoop.js';
import { getSelfHealingLoopStatus } from '@services/selfImprove/selfHealingLoop.js';
import { getTrinitySelfHealingStatus } from '@services/selfImprove/selfHealingV2.js';
import { getPromptRouteMitigationState } from '@services/openai/promptRouteMitigation.js';

const DEFAULT_EVENTS_LIMIT = 20;
const MAX_EVENTS_LIMIT = 100;
const DEFAULT_INSPECTION_LIMIT = 12;
const MAX_INSPECTION_LIMIT = 25;
const SELF_HEAL_EVENT_SOURCE = '/api/self-heal/events';
const SELF_HEAL_RUNTIME_SOURCE = '/api/self-heal/runtime';
const PROMPT_DEBUG_SOURCE = '/api/prompt-debug/events';
const AI_ROUTING_SOURCE = 'runtimeInspectionRoutingService';

type SelfHealCompactEvidence = {
  ts: string;
  type: string;
  payload: Record<string, unknown> | null;
  source: string;
  eventId?: string;
  requestId?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
};

type SelfHealInspectionEvidence = {
  selfHealRuntimeSnapshot: ReturnType<typeof buildSelfHealRuntimeSnapshot>;
  recentSelfHealEvents: SelfHealCompactEvidence[];
  recentPromptDebugEvents: SelfHealCompactEvidence[];
  recentAIRoutingEvents: SelfHealCompactEvidence[];
  recentWorkerEvidence: SelfHealCompactEvidence[];
};

const WORKER_EVIDENCE_EVENT_TYPES = new Set([
  'ACTION_DISPATCH_ATTEMPT',
  'ACTION_DISPATCH_RESULT',
  'WORKER_RECEIPT',
  'HEAL_RESULT',
  'ACTION_EXECUTED',
  'success',
  'failure',
]);

const INSPECTION_PROMPT_PATTERN = /\b(self[-\s]?heal|healing|repair|worker-helper|worker runtime|live runtime|runtime inspection|loop)\b/i;
const SELF_HEAL_TOOL_PATTERN = /^\/api\/self-heal\/|^\/status\/safety\/self-heal$|^\/worker-helper\/health$|^\/workers\/status$|^cli:inspect_self_heal$/i;

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(max, Math.trunc(limit as number))) : fallback;
}

function getEventTimestamp(event: { timestamp?: string | null } | null | undefined): string | null {
  return event?.timestamp ?? null;
}

function pickLatestTimestamp(...timestamps: Array<string | null | undefined>): string | null {
  let latestTimestamp: string | null = null;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;

  for (const timestamp of timestamps) {
    if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
      continue;
    }

    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < latestTimestampMs) {
      continue;
    }

    latestTimestamp = timestamp;
    latestTimestampMs = timestampMs;
  }

  return latestTimestamp;
}

function getLastMatchingEvent(
  recentEvents: Array<Pick<SelfHealEvent, 'kind' | 'timestamp' | 'actionTaken' | 'healedComponent' | 'details' | 'reason'>>,
  kinds: string[],
): SelfHealEvent | null {
  for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
    const event = recentEvents[index];
    if (event && kinds.includes(event.kind)) {
      return event as SelfHealEvent;
    }
  }

  return null;
}

function getLastSelfHealResultEvent(recentEvents: SelfHealEvent[]): SelfHealEvent | null {
  return getLastMatchingEvent(recentEvents, ['HEAL_RESULT', 'success', 'failure', 'noop', 'fallback']);
}

function buildTelemetrySnapshot(): SelfHealTelemetrySnapshot {
  const loopStatus = getSelfHealingLoopStatus();
  const controlLoop = getSelfHealingControlLoopStatus();
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const currentHealedComponent =
    inferSelfHealComponentFromAction(loopStatus.lastAction) ??
    inferSelfHealComponentFromAction(controlLoop.lastAction);

  return buildSelfHealTelemetrySnapshot({
    enabled: loopStatus.loopRunning || trinityStatus.enabled || controlLoop.active || controlLoop.loopRunning,
    active: Boolean(
      loopStatus.inFlight ||
      loopStatus.activeMitigation ||
      promptRouteMitigation.active ||
      controlLoop.incidentActive ||
      controlLoop.executionStatus === 'running' ||
      controlLoop.mitigation.activeAction
    ),
    currentActionTaken: loopStatus.lastAction,
    currentHealedComponent,
  });
}

function buildSystemState(params: {
  loopStatus: ReturnType<typeof getSelfHealingLoopStatus>;
  controlLoop: ReturnType<typeof getSelfHealingControlLoopStatus>;
}): {
  errorRate: number;
  latency: number;
  lastCheck: string | null;
  operationalRequests: number;
} {
  const { loopStatus, controlLoop } = params;
  const hasControlLoopObservation = controlLoop.lastObservedAt !== null;
  const boundedLoopErrorRate =
    loopStatus.lastVerificationResult?.current.errorRate ??
    loopStatus.lastVerificationResult?.baseline.errorRate ??
    0;
  const boundedLoopLatency =
    loopStatus.lastLatencySnapshot?.avgLatencyMs ??
    loopStatus.lastVerificationResult?.current.avgLatencyMs ??
    loopStatus.lastVerificationResult?.baseline.avgLatencyMs ??
    0;
  const boundedLoopOperationalRequests =
    loopStatus.lastLatencySnapshot?.requestCount ??
    loopStatus.lastVerificationResult?.current.promptRoute?.requestCount ??
    0;

  return {
    errorRate: hasControlLoopObservation ? controlLoop.errorRate : boundedLoopErrorRate,
    latency: hasControlLoopObservation ? controlLoop.avgLatencyMs : boundedLoopLatency,
    lastCheck: controlLoop.lastObservedAt ?? loopStatus.lastTick ?? null,
    operationalRequests: hasControlLoopObservation ? controlLoop.operationalRequests : boundedLoopOperationalRequests,
  };
}

function compactPayloadFromSelfHealEvent(event: SelfHealEvent): Record<string, unknown> | null {
  return event.payload ?? {
    trigger: event.trigger,
    reason: event.reason,
    actionTaken: event.actionTaken,
    healedComponent: event.healedComponent,
    ...(event.details ?? {}),
  };
}

function mapSelfHealEventToEvidence(event: SelfHealEvent): SelfHealCompactEvidence {
  return {
    ts: event.timestamp,
    type: event.type ?? event.kind,
    payload: compactPayloadFromSelfHealEvent(event),
    source: SELF_HEAL_EVENT_SOURCE,
    eventId: event.id,
    requestId: event.requestId,
    traceId: event.traceId,
    correlationId: event.correlationId,
  };
}

function isSelfHealPromptDebugTrace(trace: PromptDebugTraceRecord): boolean {
  const promptText = `${trace.rawPrompt} ${trace.normalizedPrompt}`;
  return (
    trace.runtimeInspectionChosen &&
    (trace.selectedTools.some(tool => SELF_HEAL_TOOL_PATTERN.test(tool)) || INSPECTION_PROMPT_PATTERN.test(promptText))
  );
}

function mapPromptDebugTrace(trace: PromptDebugTraceRecord): SelfHealCompactEvidence {
  return {
    ts: trace.updatedAt,
    type: 'PROMPT_DEBUG_TRACE',
    payload: {
      requestId: trace.requestId,
      traceId: trace.traceId,
      runtimeInspectionChosen: trace.runtimeInspectionChosen,
      selectedTools: trace.selectedTools,
      selectedRoute: trace.selectedRoute,
      fallbackPathUsed: trace.fallbackPathUsed,
      fallbackReason: trace.fallbackReason,
    },
    source: PROMPT_DEBUG_SOURCE,
    requestId: trace.requestId,
    traceId: trace.traceId,
  };
}

function isSelfHealAiRoutingSnapshot(snapshot: AiRoutingDebugSnapshot): boolean {
  const promptText = `${snapshot.rawPrompt} ${snapshot.normalizedPrompt}`;
  return (
    snapshot.runtimeEndpointsQueried.some(endpoint => SELF_HEAL_TOOL_PATTERN.test(endpoint)) ||
    snapshot.toolsSelected.some(tool => SELF_HEAL_TOOL_PATTERN.test(tool)) ||
    INSPECTION_PROMPT_PATTERN.test(promptText)
  );
}

function mapAiRoutingSnapshot(snapshot: AiRoutingDebugSnapshot): SelfHealCompactEvidence {
  return {
    ts: snapshot.timestamp,
    type: 'AI_ROUTING_DEBUG',
    payload: {
      requestId: snapshot.requestId,
      detectedIntent: snapshot.detectedIntent,
      routingDecision: snapshot.routingDecision,
      toolsSelected: snapshot.toolsSelected,
      runtimeEndpointsQueried: snapshot.runtimeEndpointsQueried,
      cliUsed: snapshot.cliUsed,
      repoFallbackUsed: snapshot.repoFallbackUsed,
      constraintViolations: snapshot.constraintViolations,
    },
    source: AI_ROUTING_SOURCE,
    requestId: snapshot.requestId,
  };
}

function buildRecentSelfHealEvidence(events: SelfHealEvent[], limit: number): SelfHealCompactEvidence[] {
  return events.slice(-limit).map(mapSelfHealEventToEvidence);
}

function deriveInspectionFields(params: {
  timestamp: string;
  loopStatus: ReturnType<typeof getSelfHealingLoopStatus>;
  controlLoop: ReturnType<typeof getSelfHealingControlLoopStatus>;
  telemetry: SelfHealTelemetrySnapshot;
}) {
  const { timestamp, loopStatus, controlLoop, telemetry } = params;
  const combinedEnabled = Boolean(telemetry.enabled || controlLoop.active || controlLoop.loopRunning);
  const combinedActive = Boolean(
    telemetry.active ||
    loopStatus.inFlight ||
    controlLoop.incidentActive ||
    controlLoop.executionStatus === 'running' ||
    controlLoop.mitigation.activeAction
  );
  const lastHealResultEvent = getLastSelfHealResultEvent(telemetry.recentEvents);
  const lastDispatchAttemptEvent = getLastMatchingEvent(telemetry.recentEvents, ['ACTION_DISPATCH_ATTEMPT']);
  const lastWorkerReceiptEvent = getLastMatchingEvent(telemetry.recentEvents, ['WORKER_RECEIPT']);
  const lastActionDispatchResultEvent = getLastMatchingEvent(telemetry.recentEvents, ['ACTION_DISPATCH_RESULT']);
  const lastMetricsCollectedEvent = getLastMatchingEvent(telemetry.recentEvents, ['METRICS_COLLECTED']);
  const lastLoopTickEvent = getLastMatchingEvent(telemetry.recentEvents, ['LOOP_TICK']);

  const lastHealRun = pickLatestTimestamp(
    loopStatus.lastActionAt,
    loopStatus.lastHealResult?.at,
    getEventTimestamp(lastHealResultEvent),
    getEventTimestamp(telemetry.lastAttempt),
    getEventTimestamp(telemetry.lastSuccess),
    getEventTimestamp(telemetry.lastFailure),
  );

  const timeline = {
    lastLoopTickAt: loopStatus.timeline.lastLoopTickAt ?? getEventTimestamp(lastLoopTickEvent),
    lastMetricsCollectedAt:
      loopStatus.timeline.lastMetricsCollectedAt ?? getEventTimestamp(lastMetricsCollectedEvent),
    lastAIRequestAt: loopStatus.timeline.lastAIRequestAt ?? getEventTimestamp(getLastMatchingEvent(telemetry.recentEvents, ['AI_DIAGNOSIS_REQUEST'])),
    lastAIResultAt: loopStatus.timeline.lastAIResultAt ?? getEventTimestamp(getLastMatchingEvent(telemetry.recentEvents, ['AI_DIAGNOSIS_RESULT'])),
    lastDecisionAt: loopStatus.timeline.lastDecisionAt ?? getEventTimestamp(getLastMatchingEvent(telemetry.recentEvents, ['CONTROLLER_DECISION'])),
    lastActionDispatchAttemptAt:
      loopStatus.timeline.lastActionDispatchAttemptAt ?? getEventTimestamp(lastDispatchAttemptEvent),
    lastActionDispatchResultAt:
      loopStatus.timeline.lastActionDispatchResultAt ?? getEventTimestamp(lastActionDispatchResultEvent),
    lastWorkerReceiptAt: loopStatus.timeline.lastWorkerReceiptAt ?? getEventTimestamp(lastWorkerReceiptEvent),
    lastHealResultAt: loopStatus.timeline.lastHealResultAt ?? getEventTimestamp(lastHealResultEvent),
  };

  const lastDispatchAttempt = loopStatus.lastDispatchAttempt ?? (
    lastDispatchAttemptEvent
      ? {
          at: lastDispatchAttemptEvent.timestamp,
          action: lastDispatchAttemptEvent.actionTaken ?? 'unknown',
          target: lastDispatchAttemptEvent.healedComponent,
          actuatorMode: typeof lastDispatchAttemptEvent.details?.actuatorMode === 'string'
            ? lastDispatchAttemptEvent.details.actuatorMode
            : null,
          baseUrl: typeof lastDispatchAttemptEvent.details?.baseUrl === 'string'
            ? lastDispatchAttemptEvent.details.baseUrl
            : null,
          path: typeof lastDispatchAttemptEvent.details?.path === 'string'
            ? lastDispatchAttemptEvent.details.path
            : null,
          correlationId: lastDispatchAttemptEvent.correlationId,
        }
      : null
  );

  const lastDispatchTarget = loopStatus.lastDispatchTarget ?? (
    lastDispatchAttempt
      ? {
          target: lastDispatchAttempt.target,
          actuatorMode: lastDispatchAttempt.actuatorMode,
          baseUrl: lastDispatchAttempt.baseUrl,
          path: lastDispatchAttempt.path,
        }
      : null
  );

  const lastWorkerReceipt = loopStatus.lastWorkerReceipt ?? (
    lastWorkerReceiptEvent
      ? {
          at: lastWorkerReceiptEvent.timestamp,
          action: lastWorkerReceiptEvent.actionTaken ?? 'unknown',
          target: lastWorkerReceiptEvent.healedComponent,
          actuatorMode: typeof lastWorkerReceiptEvent.details?.actuatorMode === 'string'
            ? lastWorkerReceiptEvent.details.actuatorMode
            : null,
          statusCode: typeof lastWorkerReceiptEvent.details?.statusCode === 'number'
            ? lastWorkerReceiptEvent.details.statusCode
            : null,
          message: typeof lastWorkerReceiptEvent.details?.message === 'string'
            ? lastWorkerReceiptEvent.details.message
            : null,
        }
      : null
  );

  const lastHealResult = loopStatus.lastHealResult ?? (
    lastHealResultEvent
      ? {
          at: lastHealResultEvent.timestamp,
          outcome: (lastHealResultEvent.details?.outcome as 'success' | 'failure' | 'noop' | 'fallback') ??
            (lastHealResultEvent.kind === 'HEAL_RESULT'
              ? 'success'
              : (lastHealResultEvent.kind as 'success' | 'failure' | 'noop' | 'fallback')),
          action: lastHealResultEvent.actionTaken,
          target: lastHealResultEvent.healedComponent,
          message: typeof lastHealResultEvent.details?.message === 'string'
            ? lastHealResultEvent.details.message
            : lastHealResultEvent.reason,
        }
      : null
  );

  return {
    status: 'ok' as const,
    timestamp,
    enabled: combinedEnabled,
    active: combinedActive,
    isHealing: combinedActive,
    lastHealRun,
    systemState: buildSystemState({ loopStatus, controlLoop }),
    lastAIDiagnosis: loopStatus.lastAIDiagnosis,
    lastDecision: loopStatus.lastDecision,
    lastAction: loopStatus.lastAction ?? telemetry.actionTaken ?? controlLoop.lastAction,
    lastResult:
      loopStatus.lastResult ??
      lastHealResult?.outcome ??
      controlLoop.lastResult ??
      controlLoop.executionStatus ??
      null,
    aiUsedInRuntime:
      loopStatus.aiUsedInRuntime ??
      loopStatus.lastAIDiagnosis?.aiUsedInRuntime ??
      (typeof getLastMatchingEvent(telemetry.recentEvents, ['AI_DIAGNOSIS_RESULT'])?.details?.aiUsedInRuntime === 'boolean'
        ? (getLastMatchingEvent(telemetry.recentEvents, ['AI_DIAGNOSIS_RESULT'])?.details?.aiUsedInRuntime as boolean)
        : null),
    lastDispatchAttempt,
    lastDispatchTarget,
    lastWorkerReceipt,
    lastHealResult,
    timeline,
  };
}

export function buildSelfHealRuntimeSnapshot() {
  const timestamp = new Date().toISOString();
  const loopStatus = getSelfHealingLoopStatus();
  const controlLoop = getSelfHealingControlLoopStatus();
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const telemetry = buildTelemetrySnapshot();
  const predictiveHealing = buildPredictiveHealingStatusSnapshot();
  const inspection = deriveInspectionFields({
    timestamp,
    loopStatus,
    controlLoop,
    telemetry,
  });

  return {
    ...inspection,
    loopStatus,
    controlLoop,
    trinityStatus,
    promptRouteMitigation,
    telemetry,
    predictiveHealing,
  };
}

export function buildSelfHealEventsSnapshot(limit = DEFAULT_EVENTS_LIMIT) {
  const runtimeSnapshot = buildSelfHealRuntimeSnapshot();
  const boundedLimit = clampLimit(limit, DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
  const events = runtimeSnapshot.telemetry.recentEvents.slice(-boundedLimit);

  return {
    status: 'ok' as const,
    timestamp: runtimeSnapshot.timestamp,
    count: runtimeSnapshot.telemetry.recentEvents.length,
    retentionLimit: MAX_EVENTS_LIMIT,
    events,
    recentSelfHealEvents: buildRecentSelfHealEvidence(events, boundedLimit),
    lastTrigger: runtimeSnapshot.telemetry.lastTrigger,
    lastAttempt: runtimeSnapshot.telemetry.lastAttempt,
    lastSuccess: runtimeSnapshot.telemetry.lastSuccess,
    lastFailure: runtimeSnapshot.telemetry.lastFailure,
    lastFallback: runtimeSnapshot.telemetry.lastFallback,
  };
}

export async function buildSelfHealInspectionSnapshot(limit = DEFAULT_INSPECTION_LIMIT): Promise<{
  status: 'ok';
  timestamp: string;
  summary: string;
  evidence: SelfHealInspectionEvidence;
  limits: {
    selfHealEvents: number;
    promptDebugEvents: number;
    aiRoutingEvents: number;
    workerEvidence: number;
  };
}> {
  const boundedLimit = clampLimit(limit, DEFAULT_INSPECTION_LIMIT, MAX_INSPECTION_LIMIT);
  const runtimeSnapshot = buildSelfHealRuntimeSnapshot();
  const recentSelfHealEvents = buildRecentSelfHealEvidence(
    runtimeSnapshot.telemetry.recentEvents,
    boundedLimit,
  );
  const promptDebugTraces = await listPromptDebugTraces(boundedLimit * 3);
  const recentPromptDebugEvents = promptDebugTraces
    .filter(isSelfHealPromptDebugTrace)
    .slice(0, boundedLimit)
    .map(mapPromptDebugTrace);
  const recentAIRoutingEvents = listAiRoutingDebugSnapshots(boundedLimit * 3)
    .filter(isSelfHealAiRoutingSnapshot)
    .slice(0, boundedLimit)
    .map(mapAiRoutingSnapshot);
  const recentWorkerEvidence = recentSelfHealEvents
    .filter(event => WORKER_EVIDENCE_EVENT_TYPES.has(event.type))
    .slice(0, boundedLimit);

  return {
    status: 'ok',
    timestamp: runtimeSnapshot.timestamp,
    summary: `Collected ${recentSelfHealEvents.length} self-heal runtime events, ${recentPromptDebugEvents.length} prompt-debug traces, and ${recentAIRoutingEvents.length} AI-routing traces.`,
    evidence: {
      selfHealRuntimeSnapshot: runtimeSnapshot,
      recentSelfHealEvents,
      recentPromptDebugEvents,
      recentAIRoutingEvents,
      recentWorkerEvidence,
    },
    limits: {
      selfHealEvents: boundedLimit,
      promptDebugEvents: boundedLimit,
      aiRoutingEvents: boundedLimit,
      workerEvidence: boundedLimit,
    },
  };
}

export function buildSafetySelfHealSnapshot() {
  const runtimeSnapshot = buildSelfHealRuntimeSnapshot();
  const { loopStatus, controlLoop, telemetry, predictiveHealing } = runtimeSnapshot;

  return {
    status: 'ok' as const,
    timestamp: runtimeSnapshot.timestamp,
    enabled: runtimeSnapshot.enabled,
    active: runtimeSnapshot.active,
    isHealing: runtimeSnapshot.isHealing,
    lastTriggerAt: getEventTimestamp(telemetry.lastTrigger) ?? controlLoop.lastObservedAt,
    lastHealAttemptAt: getEventTimestamp(telemetry.lastAttempt) ?? controlLoop.lastActionAt,
    lastHealSuccessAt: getEventTimestamp(telemetry.lastSuccess),
    lastHealFailureAt: getEventTimestamp(telemetry.lastFailure),
    lastTriggerReason:
      telemetry.lastTrigger?.reason ??
      telemetry.triggerReason ??
      controlLoop.lastDiagnosis,
    lastHealedComponent:
      runtimeSnapshot.lastHealResult?.target ??
      telemetry.healedComponent ??
      inferSelfHealComponentFromAction(controlLoop.lastAction),
    lastHealAction: runtimeSnapshot.lastAction,
    lastHealResult: runtimeSnapshot.lastResult,
    lastHealRun: runtimeSnapshot.lastHealRun,
    systemState: runtimeSnapshot.systemState,
    loopRunning: loopStatus.loopRunning,
    inFlight: loopStatus.inFlight,
    lastDiagnosis: loopStatus.lastDiagnosis,
    lastAction: loopStatus.lastAction,
    lastActionAt: loopStatus.lastActionAt,
    lastError: loopStatus.lastError,
    activeMitigation: loopStatus.activeMitigation,
    degradedModeReason: loopStatus.degradedModeReason,
    recentTimeoutCounts: loopStatus.recentTimeoutCounts,
    lastVerificationResult: loopStatus.lastVerificationResult,
    lastTrigger: telemetry.lastTrigger,
    lastAttempt: telemetry.lastAttempt,
    lastSuccess: telemetry.lastSuccess,
    lastFailure: telemetry.lastFailure,
    lastFallback: telemetry.lastFallback,
    triggerReason: telemetry.triggerReason,
    actionTaken: telemetry.actionTaken,
    healedComponent: telemetry.healedComponent,
    recentEvents: telemetry.recentEvents,
    persistence: telemetry.persistence,
    loop: loopStatus,
    controlLoop,
    promptRouteMitigation: runtimeSnapshot.promptRouteMitigation,
    trinity: runtimeSnapshot.trinityStatus,
    predictiveHealing,
    inspection: {
      lastAIDiagnosis: runtimeSnapshot.lastAIDiagnosis,
      lastDecision: runtimeSnapshot.lastDecision,
      aiUsedInRuntime: runtimeSnapshot.aiUsedInRuntime,
      lastDispatchAttempt: runtimeSnapshot.lastDispatchAttempt,
      lastDispatchTarget: runtimeSnapshot.lastDispatchTarget,
      lastWorkerReceipt: runtimeSnapshot.lastWorkerReceipt,
      lastHealResult: runtimeSnapshot.lastHealResult,
      timeline: runtimeSnapshot.timeline,
    },
  };
}
