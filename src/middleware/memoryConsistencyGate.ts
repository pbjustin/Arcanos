import type { NextFunction, Request, Response } from 'express';
import config from '../config/index.js';
import {
  DISPATCH_BINDINGS_VERSION,
  DISPATCH_PATTERN_BINDINGS,
  DISPATCH_V9_EXEMPT_ROUTES
} from '../config/dispatchPatterns.js';
import { DISPATCH_V9_ERROR_CODES, DISPATCH_V9_LOG_MESSAGES } from '../config/dispatchMessages.js';
import {
  decideAction,
  resolveBinding,
  validateAgainstSnapshot
} from '../services/dispatchControllerV9.js';
import { routeMemorySnapshotStore } from '../services/routeMemorySnapshotStore.js';
import { emitSafetyAuditEvent } from '../services/safety/auditEvents.js';
import { interpreterSupervisor } from '../services/safety/interpreterSupervisor.js';
import {
  activateUnsafeCondition,
  buildUnsafeToProceedPayload
} from '../services/safety/runtimeState.js';
import { logger } from '../utils/structuredLogging.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import { resolveHeader } from '../utils/requestHeaders.js';
import type {
  DispatchAttemptV9,
  DispatchConflictReasonV9,
  DispatchDecisionV9,
  DispatchMemorySnapshotV9,
  DispatchPatternBindingV9
} from '../types/dispatchV9.js';

interface MemoryConsistencyGateDependencies {
  enabled: boolean;
  shadowOnly: boolean;
  bindings: DispatchPatternBindingV9[];
  bindingsVersion: string;
  policyTimeoutMs: number;
  defaultRerouteTarget: string;
  readonlyBindingId: string;
  now: () => Date;
  recordTrace: typeof recordTraceEvent;
  dispatchLogger: typeof logger;
  snapshotStore: {
    getSnapshot: (options?: { forceRefresh?: boolean }) => Promise<{
      snapshot: DispatchMemorySnapshotV9;
      memoryVersion: string;
      loadedFrom: 'cache' | 'db' | 'created';
    }>;
    upsertRouteState: (
      routeAttempted: string,
      expectedRoute: string,
      options?: { hardConflict?: boolean; updatedBy?: string }
    ) => Promise<unknown>;
    getCachedSnapshot?: () => {
      snapshot: DispatchMemorySnapshotV9;
      memoryVersion: string;
      loadedFrom: 'cache' | 'db' | 'created';
    } | null;
    getCachedTrustedSnapshot?: () => DispatchMemorySnapshotV9 | null;
    rememberTrustedSnapshot?: (snapshot: DispatchMemorySnapshotV9) => Promise<void>;
    rollbackToTrustedSnapshot?: (updatedBy?: string) => Promise<{
      snapshot: DispatchMemorySnapshotV9;
      memoryVersion: string;
      loadedFrom: 'cache' | 'db' | 'created';
    } | null>;
  };
}

interface RequestStateSnapshot {
  method: string;
  url: string;
  body: unknown;
  dispatchDecision?: DispatchDecisionV9;
  memoryVersion?: string;
  dispatchRerouted?: boolean;
  dispatchConflictCode?: string;
}

const MAX_BODY_SERIALIZATION_BYTES = 1_000_000;
const STATUS_CONFLICT = 409;
const STATUS_SERVICE_UNAVAILABLE = 503;
const POLICY_SUPERVISOR_ENTITY_ID = 'dispatch-v9-policy-gate';

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function cloneJsonSafe<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_BODY_SERIALIZATION_BYTES) {
      try {
        return structuredClone(value);
      } catch {
        return value;
      }
    }
    return JSON.parse(serialized) as T;
  } catch {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
}

function resolveExpectedBaselineMonotonicTs(
  headers: Record<string, string | string[] | undefined>,
  clientMemoryVersion?: string
): number | undefined {
  const baselineHeader = resolveHeader(headers, 'x-memory-baseline-ts');
  if (baselineHeader) {
    const parsed = Number(baselineHeader);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  if (clientMemoryVersion) {
    const parsedVersionTime = Date.parse(clientMemoryVersion);
    if (!Number.isNaN(parsedVersionTime)) {
      return parsedVersionTime;
    }
  }

  return undefined;
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { timedOut: false, value: await operation() };
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<{ timedOut: true }>(resolve => {
      timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const operationPromise = operation().then(value => ({ timedOut: false as const, value }));
    const result = await Promise.race([operationPromise, timeoutPromise]);
    return result;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function readIntentHints(req: Request): string[] {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    return [];
  }

  const hints: string[] = [];
  const candidates = [
    body.domain,
    body.module,
    body.command,
    body.updateType,
    body.source
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      hints.push(candidate.trim().toLowerCase());
    }
  }

  return Array.from(new Set(hints));
}

function buildRouteAttempt(req: Request): DispatchAttemptV9 {
  const method = req.method.toUpperCase();
  const path = normalizePath(req.path);
  return {
    method,
    path,
    routeAttempted: `${method} ${path}`,
    intentHints: readIntentHints(req)
  };
}

function isExemptRoute(req: Request): boolean {
  const method = req.method.toUpperCase();
  const path = normalizePath(req.path);

  for (const exemption of DISPATCH_V9_EXEMPT_ROUTES) {
    //audit Assumption: exemption method must match to avoid over-bypass; risk: skipping required checks; invariant: method equality; handling: continue when mismatch.
    if (method !== exemption.method.toUpperCase()) {
      continue;
    }
    //audit Assumption: exact path exemptions are strongest bypass signal; risk: stale exact route; invariant: exact equality required; handling: return true.
    if (exemption.exactPath && normalizePath(exemption.exactPath) === path) {
      return true;
    }
    //audit Assumption: prefix exemptions cover read-only route families; risk: broad bypass; invariant: prefix bounded by path boundary; handling: return true on exact or slash-delimited match.
    const normalizedPrefix = exemption.prefixPath ? normalizePath(exemption.prefixPath) : undefined;
    if (normalizedPrefix && (path === normalizedPrefix || path.startsWith(normalizedPrefix + '/'))) {
      return true;
    }
  }

  return false;
}

function setDispatchHeaders(
  res: Response,
  decision: DispatchDecisionV9,
  memoryVersion: string,
  bindingId: string
): void {
  res.setHeader('x-dispatch-memory-version', memoryVersion);
  res.setHeader('x-dispatch-decision', decision);
  res.setHeader('x-dispatch-binding', bindingId);
}

function setRequestDispatchContext(
  req: Request,
  decision: DispatchDecisionV9,
  memoryVersion: string,
  rerouted: boolean,
  conflictCode?: string
): void {
  req.dispatchDecision = decision;
  req.memoryVersion = memoryVersion;
  req.dispatchRerouted = rerouted;
  req.dispatchConflictCode = conflictCode;
}

function applyDispatchDecisionContext(options: {
  req: Request;
  res: Response;
  decision: DispatchDecisionV9;
  memoryVersion: string;
  bindingId: string;
  rerouted: boolean;
  conflictCode?: string;
}): void {
  setRequestDispatchContext(
    options.req,
    options.decision,
    options.memoryVersion,
    options.rerouted,
    options.conflictCode
  );
  setDispatchHeaders(options.res, options.decision, options.memoryVersion, options.bindingId);
}

function buildDispatchDecisionPayload(options: {
  timestamp: string;
  routeAttempted: string;
  memoryVersion: string;
  bindingId: string;
  decision: DispatchDecisionV9;
  clientMemoryVersion?: string;
  expectedBaselineTsMs?: number;
  rerouteTarget?: string;
  conflictReason?: DispatchConflictReasonV9;
}): Record<string, unknown> {
  return {
    timestamp: options.timestamp,
    route_attempted: options.routeAttempted,
    memory_version: options.memoryVersion,
    binding_id: options.bindingId,
    decision: options.decision,
    client_memory_version: options.clientMemoryVersion,
    expected_baseline_ts_ms: options.expectedBaselineTsMs,
    reroute_target: options.rerouteTarget,
    conflict_reason: options.conflictReason
  };
}

function snapshotRequestState(req: Request): RequestStateSnapshot {
  return {
    method: req.method,
    url: req.url,
    body: cloneJsonSafe(req.body),
    dispatchDecision: req.dispatchDecision,
    memoryVersion: req.memoryVersion,
    dispatchRerouted: req.dispatchRerouted,
    dispatchConflictCode: req.dispatchConflictCode
  };
}

function restoreRequestState(req: Request, snapshot: RequestStateSnapshot): void {
  req.method = snapshot.method;
  req.url = snapshot.url;
  req.body = snapshot.body;
  req.dispatchDecision = snapshot.dispatchDecision;
  req.memoryVersion = snapshot.memoryVersion;
  req.dispatchRerouted = snapshot.dispatchRerouted;
  req.dispatchConflictCode = snapshot.dispatchConflictCode;
}

function buildRerouteMessage(req: Request, routeAttempted: string, conflictReason: DispatchConflictReasonV9): string {
  const body = req.body as Record<string, unknown> | undefined;
  const candidates = [
    body?.message,
    body?.prompt,
    body?.userInput,
    body?.content,
    body?.text,
    body?.query
  ];

  for (const candidate of candidates) {
    //audit Assumption: existing textual prompt should be preserved when rerouting; risk: losing user intent; invariant: first non-empty prompt reused; handling: return candidate.
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return `Dispatch reroute request for ${routeAttempted}. Conflict reason: ${conflictReason}.`;
}

function runFailsafeChecks(
  binding: DispatchPatternBindingV9 | null,
  snapshotLoaded: boolean,
  memoryVersion: string,
  rerouteTarget?: string,
  isRegisteredTarget?: boolean
): { ok: boolean; reason?: string } {
  //audit Assumption: binding is required for policy-safe reroute decisions; risk: undefined routing policy; invariant: binding present; handling: fail-fast.
  if (!binding) {
    return { ok: false, reason: 'binding_missing' };
  }
  //audit Assumption: reroute requires loaded snapshot context; risk: stale/unknown state; invariant: snapshot loaded; handling: fail-fast.
  if (!snapshotLoaded) {
    return { ok: false, reason: 'snapshot_missing' };
  }
  //audit Assumption: memory version must be parseable for traceability; risk: unverifiable state timeline; invariant: valid ISO; handling: fail-fast.
  if (Number.isNaN(Date.parse(memoryVersion))) {
    return { ok: false, reason: 'memory_version_invalid' };
  }
  //audit Assumption: reroute target must correspond to a registered binding path; risk: open redirect-like path mutation; invariant: target is registered; handling: fail-fast.
  if (!rerouteTarget || !isRegisteredTarget) {
    return { ok: false, reason: 'reroute_target_unregistered' };
  }
  return { ok: true };
}

function buildConflictResponsePayload(options: {
  routeAttempted: string;
  memoryVersion: string;
  bindingId: string;
  reason: DispatchConflictReasonV9;
}): Record<string, unknown> {
  return {
    error: 'Memory route conflict',
    code: DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT,
    route_attempted: options.routeAttempted,
    memory_version: options.memoryVersion,
    binding_id: options.bindingId,
    conflict_reason: options.reason,
    timestamp: new Date().toISOString()
  };
}

function buildFailsafePayload(options: {
  routeAttempted: string;
  memoryVersion: string;
  bindingId: string;
  reason: string;
}): Record<string, unknown> {
  return {
    error: 'Dispatch failsafe triggered',
    code: DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE,
    route_attempted: options.routeAttempted,
    memory_version: options.memoryVersion,
    binding_id: options.bindingId,
    failsafe_reason: options.reason,
    timestamp: new Date().toISOString()
  };
}

function respondWithFailsafe(options: {
  req: Request;
  res: Response;
  emitDecision: (
    decision: DispatchDecisionV9,
    bindingId: string,
    memoryVersion: string,
    options?: { rerouteTarget?: string; conflictReason?: DispatchConflictReasonV9; logMessage?: string }
  ) => void;
  memoryVersion: string;
  bindingId: string;
  routeAttempted: string;
  conflictReason: DispatchConflictReasonV9;
  reason: string;
  logMessage: string;
}): void {
  applyDispatchDecisionContext({
    req: options.req,
    res: options.res,
    decision: 'block',
    memoryVersion: options.memoryVersion,
    bindingId: options.bindingId,
    rerouted: false,
    conflictCode: DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE
  });
  options.emitDecision('block', options.bindingId, options.memoryVersion, {
    conflictReason: options.conflictReason,
    logMessage: options.logMessage
  });
  options.res.status(STATUS_SERVICE_UNAVAILABLE).json(
    buildFailsafePayload({
      routeAttempted: options.routeAttempted,
      memoryVersion: options.memoryVersion,
      bindingId: options.bindingId,
      reason: options.reason
    })
  );
}

function respondWithConflict(options: {
  req: Request;
  res: Response;
  emitDecision: (
    decision: DispatchDecisionV9,
    bindingId: string,
    memoryVersion: string,
    options?: { rerouteTarget?: string; conflictReason?: DispatchConflictReasonV9; logMessage?: string }
  ) => void;
  memoryVersion: string;
  bindingId: string;
  routeAttempted: string;
  reason: DispatchConflictReasonV9;
  logMessage: string;
}): void {
  applyDispatchDecisionContext({
    req: options.req,
    res: options.res,
    decision: 'block',
    memoryVersion: options.memoryVersion,
    bindingId: options.bindingId,
    rerouted: false,
    conflictCode: DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT
  });
  options.emitDecision('block', options.bindingId, options.memoryVersion, {
    conflictReason: options.reason,
    logMessage: options.logMessage
  });
  options.res.status(STATUS_CONFLICT).json(
    buildConflictResponsePayload({
      routeAttempted: options.routeAttempted,
      memoryVersion: options.memoryVersion,
      bindingId: options.bindingId,
      reason: options.reason
    })
  );
}

function respondWithUnsafe(options: {
  req: Request;
  res: Response;
  emitDecision: (
    decision: DispatchDecisionV9,
    bindingId: string,
    memoryVersion: string,
    options?: { rerouteTarget?: string; conflictReason?: DispatchConflictReasonV9; logMessage?: string }
  ) => void;
  bindingId: string;
  memoryVersion: string;
  conflictReason: DispatchConflictReasonV9;
  logMessage: string;
}): void {
  applyDispatchDecisionContext({
    req: options.req,
    res: options.res,
    decision: 'block',
    memoryVersion: options.memoryVersion,
    bindingId: options.bindingId,
    rerouted: false,
    conflictCode: 'UNSAFE_TO_PROCEED'
  });
  options.emitDecision('block', options.bindingId, options.memoryVersion, {
    conflictReason: options.conflictReason,
    logMessage: options.logMessage
  });
  options.res.status(STATUS_SERVICE_UNAVAILABLE).json(buildUnsafeToProceedPayload());
}

async function handleRerouteDecision(options: {
  req: Request;
  res: Response;
  next: NextFunction;
  binding: DispatchPatternBindingV9 | null;
  attempt: DispatchAttemptV9;
  validation: ReturnType<typeof validateAgainstSnapshot>;
  rerouteTarget: string;
  snapshotLoaded: boolean;
  memoryVersion: string;
  bindingId: string;
  deps: MemoryConsistencyGateDependencies;
  emitDecision: (
    decision: DispatchDecisionV9,
    bindingId: string,
    memoryVersion: string,
    options?: { rerouteTarget?: string; conflictReason?: DispatchConflictReasonV9; logMessage?: string }
  ) => void;
  dispatchLogger: typeof logger;
}): Promise<void> {
  const checks = runFailsafeChecks(
    options.binding,
    options.snapshotLoaded,
    options.memoryVersion,
    options.rerouteTarget,
    options.deps.bindings.some(candidate =>
      (candidate.exactPaths || []).some(path => normalizePath(path) === normalizePath(options.rerouteTarget))
    )
  );
  //audit Assumption: reroute preconditions must pass before mutation; risk: invalid reroute state; invariant: checks pass; handling: failsafe response on failure.
  if (!checks.ok) {
    respondWithFailsafe({
      req: options.req,
      res: options.res,
      emitDecision: options.emitDecision,
      memoryVersion: options.memoryVersion,
      bindingId: options.bindingId,
      routeAttempted: options.attempt.routeAttempted,
      conflictReason: options.validation.reason,
      reason: checks.reason || 'failsafe_check_failed',
      logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
    });
    return;
  }

  const stateSnapshot = snapshotRequestState(options.req);
  try {
    const rerouteMessage = buildRerouteMessage(
      options.req,
      options.attempt.routeAttempted,
      options.validation.reason
    );
    const body = isObjectBody(options.req.body) ? options.req.body : {};

    options.req.method = 'POST';
    options.req.url = options.rerouteTarget;
    options.req.body = {
      ...body,
      message: rerouteMessage,
      dispatchReroute: {
        originalRoute: options.attempt.routeAttempted,
        reason: options.validation.reason,
        memoryVersion: options.memoryVersion
      }
    };

    //audit Assumption: rerouted request body must contain a message for the target handler; risk: target receives invalid payload; invariant: message is non-empty string; handling: restore + failsafe on invalid.
    if (typeof options.req.body.message !== 'string' || !options.req.body.message.trim()) {
      restoreRequestState(options.req, stateSnapshot);
      respondWithFailsafe({
        req: options.req,
        res: options.res,
        emitDecision: options.emitDecision,
        memoryVersion: options.memoryVersion,
        bindingId: options.bindingId,
        routeAttempted: options.attempt.routeAttempted,
        conflictReason: options.validation.reason,
        reason: 'reroute_payload_invalid',
        logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
      });
      return;
    }
    applyDispatchDecisionContext({
      req: options.req,
      res: options.res,
      decision: 'reroute',
      memoryVersion: options.memoryVersion,
      bindingId: options.bindingId,
      rerouted: true,
      conflictCode: DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT
    });
    options.emitDecision('reroute', options.bindingId, options.memoryVersion, {
      conflictReason: options.validation.reason,
      rerouteTarget: options.rerouteTarget,
      logMessage: DISPATCH_V9_LOG_MESSAGES.rerouted
    });

    options.next();
    return;
  } catch (error) {
    //audit Assumption: reroute mutation failures should restore original request state; risk: partial state commit; invariant: request restored; handling: restore + failsafe.
    restoreRequestState(options.req, stateSnapshot);
    options.dispatchLogger.error(
      DISPATCH_V9_LOG_MESSAGES.failsafe,
      {
        route_attempted: options.attempt.routeAttempted,
        reason: 'reroute_execution_failed'
      },
      undefined,
      error instanceof Error ? error : undefined
    );
    respondWithFailsafe({
      req: options.req,
      res: options.res,
      emitDecision: options.emitDecision,
      memoryVersion: options.memoryVersion,
      bindingId: options.bindingId,
      routeAttempted: options.attempt.routeAttempted,
      conflictReason: options.validation.reason,
      reason: 'reroute_execution_failed',
      logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
    });
    return;
  }
}

/**
 * Purpose: Create memory consistency middleware for dispatch-v9 governance.
 * Inputs/Outputs: optional dependency overrides; returns Express middleware.
 * Edge cases: disabled/shadow modes bypass enforcement while still emitting audits.
 */
export function createMemoryConsistencyGate(
  overrides: Partial<MemoryConsistencyGateDependencies> = {}
) {
  const deps: MemoryConsistencyGateDependencies = {
    enabled: overrides.enabled ?? config.dispatchV9.enabled,
    shadowOnly: overrides.shadowOnly ?? config.dispatchV9.shadowOnly,
    bindings: overrides.bindings ?? DISPATCH_PATTERN_BINDINGS,
    bindingsVersion: overrides.bindingsVersion ?? DISPATCH_BINDINGS_VERSION,
    policyTimeoutMs: overrides.policyTimeoutMs ?? config.dispatchV9.policyTimeoutMs,
    defaultRerouteTarget: overrides.defaultRerouteTarget ?? config.dispatchV9.defaultRerouteTarget,
    readonlyBindingId: overrides.readonlyBindingId ?? config.dispatchV9.readonlyBindingId,
    now: overrides.now ?? (() => new Date()),
    recordTrace: overrides.recordTrace ?? recordTraceEvent,
    dispatchLogger: overrides.dispatchLogger ?? logger,
    snapshotStore: overrides.snapshotStore ?? routeMemorySnapshotStore
  };

  const dispatchLogger = deps.dispatchLogger.child({ module: 'dispatch-v9' });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    //audit Assumption: feature flag controls rollout safety; risk: accidental enforcement; invariant: disabled mode no-op; handling: immediate next.
    if (!deps.enabled) {
      return next();
    }

    const attempt = buildRouteAttempt(req);
    const policyCycleId = interpreterSupervisor.beginCycle(POLICY_SUPERVISOR_ENTITY_ID, {
      category: 'policy',
      metadata: {
        routeAttempted: attempt.routeAttempted
      }
    });
    let cycleSettled = false;
    const completeCycle = (): void => {
      if (!cycleSettled) {
        interpreterSupervisor.completeCycle(policyCycleId);
        cycleSettled = true;
      }
    };
    const failCycle = (reason: string): void => {
      if (!cycleSettled) {
        interpreterSupervisor.failCycle(policyCycleId, reason);
        cycleSettled = true;
      }
    };
    const heartbeatCycle = (): void => {
      interpreterSupervisor.heartbeat(policyCycleId);
    };
    let clientMemoryVersion: string | undefined;
    let expectedBaselineTsMs: number | undefined;

    const emitDecision = (
      decision: DispatchDecisionV9,
      bindingId: string,
      memoryVersion: string,
      options: { rerouteTarget?: string; conflictReason?: DispatchConflictReasonV9; logMessage?: string } = {}
    ): void => {
      const timestamp = deps.now().toISOString();
      const payload = buildDispatchDecisionPayload({
        timestamp,
        routeAttempted: attempt.routeAttempted,
        memoryVersion,
        bindingId,
        decision,
        clientMemoryVersion,
        expectedBaselineTsMs,
        rerouteTarget: options.rerouteTarget,
        conflictReason: options.conflictReason
      });
      dispatchLogger.info(options.logMessage || DISPATCH_V9_LOG_MESSAGES.decision, payload);
      deps.recordTrace('dispatch.v9.decision', payload);
    };

    try {
      const requestHeaders = req.headers as Record<string, string | string[] | undefined>;
      clientMemoryVersion = resolveHeader(requestHeaders, 'x-memory-version');
      expectedBaselineTsMs = resolveExpectedBaselineMonotonicTs(
        requestHeaders,
        clientMemoryVersion
      );

      //audit Assumption: read-only endpoints should bypass consistency checks; risk: unnecessary latency on health paths; invariant: exemption list enforced; handling: allow + audit.
      if (isExemptRoute(req)) {
        const memoryVersion = deps.now().toISOString();
        applyDispatchDecisionContext({
          req,
          res,
          decision: 'allow',
          memoryVersion,
          bindingId: deps.readonlyBindingId,
          rerouted: false
        });
        emitDecision('allow', deps.readonlyBindingId, memoryVersion, {
          conflictReason: 'none'
        });
        completeCycle();
        next();
        return;
      }

      const binding = resolveBinding(attempt, deps.bindings);
      const evaluateDecision = (snapshot: DispatchMemorySnapshotV9) => {
        const validationResult = validateAgainstSnapshot(
          binding,
          attempt,
          snapshot,
          clientMemoryVersion,
          expectedBaselineTsMs
        );
        const decisionResult = decideAction(
          validationResult,
          binding?.sensitivity || 'sensitive',
          binding?.conflictPolicy || 'strict_block'
        );
        return { validation: validationResult, decision: decisionResult };
      };

      const loadSnapshotRecord = async (
        options: { forceRefresh?: boolean } = {}
      ): Promise<
        Awaited<ReturnType<MemoryConsistencyGateDependencies['snapshotStore']['getSnapshot']>> | null
      > => {
        const timeoutResult = await withTimeout(deps.policyTimeoutMs, () =>
          deps.snapshotStore.getSnapshot(options)
        );
        if (!timeoutResult.timedOut) {
          return timeoutResult.value;
        }

        const cachedSnapshot = deps.snapshotStore.getCachedSnapshot?.() || null;
        //audit Assumption: timeout fallback must use deterministic cached snapshot when available; risk: policy deadlock; invariant: cached snapshot drives temporary continuation; handling: fallback to cache and audit.
        if (cachedSnapshot) {
          emitSafetyAuditEvent({
            event: 'policy_timeout_using_cached_snapshot',
            severity: 'warn',
            details: {
              routeAttempted: attempt.routeAttempted,
              forceRefresh: Boolean(options.forceRefresh)
            }
          });
          return cachedSnapshot;
        }

        activateUnsafeCondition({
          code: 'POLICY_ENGINE_TIMEOUT_NO_FALLBACK',
          message: 'Policy evaluation timed out without cached snapshot fallback',
          metadata: {
            routeAttempted: attempt.routeAttempted,
            timeoutMs: deps.policyTimeoutMs
          }
        });
        emitSafetyAuditEvent({
          event: 'policy_timeout_no_fallback',
          severity: 'error',
          details: {
            routeAttempted: attempt.routeAttempted,
            timeoutMs: deps.policyTimeoutMs
          }
        });
        return null;
      };

      heartbeatCycle();
      const initialSnapshotRecord = await loadSnapshotRecord();
      if (!initialSnapshotRecord) {
        failCycle('policy_timeout_no_fallback');
        respondWithUnsafe({
          req,
          res,
          emitDecision,
          bindingId: binding?.id || 'unknown',
          memoryVersion: deps.now().toISOString(),
          conflictReason: 'none',
          logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
        });
        return;
      }

      let snapshotRecord = initialSnapshotRecord;
      let snapshotLoaded = true;
      let { validation, decision } = evaluateDecision(snapshotRecord.snapshot);

      //audit Assumption: one forced refresh can resolve transient staleness; risk: repeated DB load cost; invariant: max one refresh attempt; handling: refresh once on invalid.
      if (!validation.valid) {
        heartbeatCycle();
        const refreshedSnapshotRecord = await loadSnapshotRecord({ forceRefresh: true });
        if (!refreshedSnapshotRecord) {
          failCycle('policy_timeout_no_fallback');
          respondWithUnsafe({
            req,
            res,
            emitDecision,
            bindingId: binding?.id || 'unknown',
            memoryVersion: snapshotRecord.memoryVersion,
            conflictReason: validation.reason,
            logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
          });
          return;
        }
        snapshotRecord = refreshedSnapshotRecord;
        const refreshed = evaluateDecision(snapshotRecord.snapshot);
        validation = refreshed.validation;
        decision = refreshed.decision;
      }

      //audit Assumption: stale version mismatch requires trusted rollback and one re-evaluation; risk: acting on stale memory baseline; invariant: rollback attempted once then re-evaluate; handling: unsafe block if unresolved.
      if (validation.reason === 'stale_version') {
        emitSafetyAuditEvent({
          event: 'memory_version_mismatch_detected',
          severity: 'warn',
          details: {
            routeAttempted: attempt.routeAttempted,
            expectedBaselineTsMs,
            snapshotMonotonicTsMs: snapshotRecord.snapshot.monotonic_ts_ms
          }
        });

        const rolledBackSnapshot = deps.snapshotStore.rollbackToTrustedSnapshot
          ? await deps.snapshotStore.rollbackToTrustedSnapshot('memory-consistency-gate')
          : null;

        if (!rolledBackSnapshot) {
          activateUnsafeCondition({
            code: 'MEMORY_VERSION_MISMATCH',
            message: 'Memory version mismatch with no trusted rollback snapshot available',
            metadata: {
              routeAttempted: attempt.routeAttempted
            }
          });
          failCycle('memory_version_mismatch_no_trusted_snapshot');
          respondWithUnsafe({
            req,
            res,
            emitDecision,
            bindingId: binding?.id || 'unknown',
            memoryVersion: snapshotRecord.memoryVersion,
            conflictReason: validation.reason,
            logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
          });
          return;
        }

        emitSafetyAuditEvent({
          event: 'memory_rollback_to_trusted_snapshot',
          severity: 'warn',
          details: {
            routeAttempted: attempt.routeAttempted,
            rolledBackVersionId: rolledBackSnapshot.snapshot.version_id
          }
        });

        snapshotRecord = rolledBackSnapshot;
        const postRollback = evaluateDecision(snapshotRecord.snapshot);
        validation = postRollback.validation;
        decision = postRollback.decision;

        if (validation.reason === 'stale_version') {
          activateUnsafeCondition({
            code: 'MEMORY_VERSION_MISMATCH',
            message: 'Memory version mismatch persisted after trusted rollback',
            metadata: {
              routeAttempted: attempt.routeAttempted,
              expectedBaselineTsMs,
              snapshotMonotonicTsMs: snapshotRecord.snapshot.monotonic_ts_ms
            }
          });
          failCycle('memory_version_mismatch_persisted');
          respondWithUnsafe({
            req,
            res,
            emitDecision,
            bindingId: binding?.id || 'unknown',
            memoryVersion: snapshotRecord.memoryVersion,
            conflictReason: validation.reason,
            logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
          });
          return;
        }
      }

      const memoryVersion = snapshotRecord.memoryVersion;
      const bindingId = binding?.id || 'unknown';

      //audit Assumption: shadow mode must not mutate request flow; risk: accidental enforcement in rollout; invariant: always allow in shadow; handling: log + continue.
      if (deps.shadowOnly) {
        applyDispatchDecisionContext({
          req,
          res,
          decision: 'allow',
          memoryVersion,
          bindingId,
          rerouted: false,
          conflictCode:
            validation.reason === 'none' ? undefined : DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT
        });
        emitDecision('allow', bindingId, memoryVersion, {
          conflictReason: validation.reason,
          logMessage: DISPATCH_V9_LOG_MESSAGES.shadowAllow
        });
        completeCycle();
        next();
        return;
      }

      //audit Assumption: valid route checks should seed missing route_state entries; risk: snapshot drift; invariant: route state eventually populated; handling: best-effort upsert.
      if (decision === 'allow') {
        applyDispatchDecisionContext({
          req,
          res,
          decision: 'allow',
          memoryVersion,
          bindingId,
          rerouted: false
        });
        emitDecision('allow', bindingId, memoryVersion, {
          conflictReason: validation.reason
        });

        if (deps.snapshotStore.rememberTrustedSnapshot) {
          try {
            await deps.snapshotStore.rememberTrustedSnapshot(snapshotRecord.snapshot);
          } catch (error) {
            dispatchLogger.warn(
              'Failed to persist trusted snapshot after allow decision',
              {
                route_attempted: attempt.routeAttempted,
                binding_id: bindingId
              },
              undefined,
              error instanceof Error ? error : undefined
            );
          }
        }

        if (validation.requiresSnapshotUpdate) {
          try {
            await deps.snapshotStore.upsertRouteState(
              attempt.routeAttempted,
              attempt.routeAttempted,
              { updatedBy: 'middleware' }
            );
          } catch (error) {
            dispatchLogger.warn(
              'Dispatch v9 failed to upsert route state after allow decision',
              {
                route_attempted: attempt.routeAttempted,
                binding_id: bindingId
              },
              undefined,
              error instanceof Error ? error : undefined
            );
          }
        }

        completeCycle();
        next();
        return;
      }

      if (decision === 'block') {
        completeCycle();
        respondWithConflict({
          req,
          res,
          emitDecision,
          memoryVersion,
          bindingId,
          routeAttempted: attempt.routeAttempted,
          reason: validation.reason,
          logMessage: DISPATCH_V9_LOG_MESSAGES.blocked
        });
        return;
      }

      const rerouteTarget = binding?.rerouteTarget || deps.defaultRerouteTarget;
      heartbeatCycle();
      await handleRerouteDecision({
        req,
        res,
        next,
        binding,
        attempt,
        validation,
        rerouteTarget,
        snapshotLoaded,
        memoryVersion,
        bindingId,
        deps,
        emitDecision,
        dispatchLogger
      });
      completeCycle();
      return;
    } catch (error) {
      failCycle(error instanceof Error ? error.message : String(error));
      dispatchLogger.error(
        DISPATCH_V9_LOG_MESSAGES.failsafe,
        {
          route_attempted: attempt.routeAttempted,
          reason: 'middleware_unhandled_error'
        },
        undefined,
        error instanceof Error ? error : undefined
      );
      respondWithFailsafe({
        req,
        res,
        emitDecision,
        memoryVersion: deps.now().toISOString(),
        bindingId: 'unknown',
        routeAttempted: attempt.routeAttempted,
        conflictReason: 'none',
        reason: 'middleware_unhandled_error',
        logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
      });
      return;
    } finally {
      if (!cycleSettled) {
        completeCycle();
      }
    }
  };
}

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const memoryConsistencyGate = createMemoryConsistencyGate();
