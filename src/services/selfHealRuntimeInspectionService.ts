import {
  buildPredictiveHealingStatusSnapshot,
} from '@services/selfImprove/predictiveHealingService.js';
import {
  buildSelfHealTelemetrySnapshot,
  inferSelfHealComponentFromAction,
  type SelfHealTelemetrySnapshot,
} from '@services/selfImprove/selfHealTelemetry.js';
import { getSelfHealingControlLoopStatus } from '@services/selfImprove/controlLoop.js';
import { getSelfHealingLoopStatus } from '@services/selfImprove/selfHealingLoop.js';
import { getTrinitySelfHealingStatus } from '@services/selfImprove/selfHealingV2.js';
import { getPromptRouteMitigationState } from '@services/openai/promptRouteMitigation.js';

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

function getLastSelfHealResultEvent(
  recentEvents: Array<{
    kind?: string | null;
    timestamp?: string | null;
    actionTaken?: string | null;
    healedComponent?: string | null;
  }>
) {
  for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
    const event = recentEvents[index];
    if (event.kind === 'success' || event.kind === 'failure' || event.kind === 'noop' || event.kind === 'fallback') {
      return event;
    }
  }

  return null;
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

export function buildSelfHealRuntimeSnapshot() {
  const timestamp = new Date().toISOString();
  const loopStatus = getSelfHealingLoopStatus();
  const controlLoop = getSelfHealingControlLoopStatus();
  const trinityStatus = getTrinitySelfHealingStatus();
  const promptRouteMitigation = getPromptRouteMitigationState();
  const telemetry = buildTelemetrySnapshot();
  const predictiveHealing = buildPredictiveHealingStatusSnapshot();

  return {
    status: 'ok' as const,
    timestamp,
    loopStatus,
    controlLoop,
    trinityStatus,
    promptRouteMitigation,
    telemetry,
    predictiveHealing,
  };
}

export function buildSelfHealEventsSnapshot(limit = 20) {
  const runtimeSnapshot = buildSelfHealRuntimeSnapshot();
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;

  return {
    status: 'ok' as const,
    timestamp: runtimeSnapshot.timestamp,
    count: runtimeSnapshot.telemetry.recentEvents.length,
    events: runtimeSnapshot.telemetry.recentEvents.slice(-boundedLimit),
    lastTrigger: runtimeSnapshot.telemetry.lastTrigger,
    lastAttempt: runtimeSnapshot.telemetry.lastAttempt,
    lastSuccess: runtimeSnapshot.telemetry.lastSuccess,
    lastFailure: runtimeSnapshot.telemetry.lastFailure,
    lastFallback: runtimeSnapshot.telemetry.lastFallback,
  };
}

export function buildSafetySelfHealSnapshot() {
  const runtimeSnapshot = buildSelfHealRuntimeSnapshot();
  const { loopStatus, controlLoop, telemetry, predictiveHealing } = runtimeSnapshot;
  const lastHealResultEvent = getLastSelfHealResultEvent(telemetry.recentEvents);
  const combinedEnabled = Boolean(
    telemetry.enabled ||
    controlLoop.active ||
    controlLoop.loopRunning
  );
  const combinedActive = Boolean(
    telemetry.active ||
    loopStatus.inFlight ||
    controlLoop.incidentActive ||
    controlLoop.executionStatus === 'running' ||
    controlLoop.mitigation.activeAction
  );
  const lastTriggerAt = getEventTimestamp(telemetry.lastTrigger) ?? controlLoop.lastObservedAt;
  const lastHealAttemptAt = getEventTimestamp(telemetry.lastAttempt) ?? controlLoop.lastActionAt;
  const lastHealAction = lastHealResultEvent?.actionTaken ?? telemetry.actionTaken ?? controlLoop.lastAction;
  const lastHealResult =
    lastHealResultEvent?.kind ??
    controlLoop.executionStatus ??
    controlLoop.lastResult ??
    null;
  const lastTriggerReason =
    telemetry.lastTrigger?.reason ??
    telemetry.triggerReason ??
    controlLoop.lastDiagnosis;
  const lastHealedComponent =
    lastHealResultEvent?.healedComponent ??
    telemetry.healedComponent ??
    inferSelfHealComponentFromAction(controlLoop.lastAction);
  const lastHealRun = pickLatestTimestamp(
    lastHealAttemptAt,
    getEventTimestamp(telemetry.lastSuccess),
    getEventTimestamp(telemetry.lastFailure),
    controlLoop.lastActionAt,
    loopStatus.lastActionAt,
  );
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
  const systemState = {
    errorRate: hasControlLoopObservation ? controlLoop.errorRate : boundedLoopErrorRate,
    latency: hasControlLoopObservation ? controlLoop.avgLatencyMs : boundedLoopLatency,
    lastCheck: controlLoop.lastObservedAt ?? loopStatus.lastTick ?? null,
    operationalRequests: hasControlLoopObservation ? controlLoop.operationalRequests : boundedLoopOperationalRequests,
  };

  return {
    status: 'ok' as const,
    timestamp: runtimeSnapshot.timestamp,
    enabled: combinedEnabled,
    active: combinedActive,
    isHealing: combinedActive,
    lastTriggerAt,
    lastHealAttemptAt,
    lastHealSuccessAt: getEventTimestamp(telemetry.lastSuccess),
    lastHealFailureAt: getEventTimestamp(telemetry.lastFailure),
    lastTriggerReason,
    lastHealedComponent,
    lastHealAction,
    lastHealResult,
    lastHealRun,
    systemState,
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
  };
}
