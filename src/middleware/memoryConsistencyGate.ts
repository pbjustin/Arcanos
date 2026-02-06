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
    // Always parse back to guarantee a true deep clone, even for large payloads
    return JSON.parse(serialized) as T;
  } catch {
    // structuredClone handles circular refs and non-JSON types that JSON.stringify cannot
    try {
      return structuredClone(value);
    } catch {
      return value;
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

function buildDispatchDecisionPayload(options: {
  timestamp: string;
  routeAttempted: string;
  memoryVersion: string;
  bindingId: string;
  decision: DispatchDecisionV9;
  clientMemoryVersion?: string;
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
    const clientMemoryVersion = resolveHeader(req.headers as Record<string, string | string[] | undefined>, 'x-memory-version');

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
        rerouteTarget: options.rerouteTarget,
        conflictReason: options.conflictReason
      });
      dispatchLogger.info(options.logMessage || DISPATCH_V9_LOG_MESSAGES.decision, payload);
      deps.recordTrace('dispatch.v9.decision', payload);
    };

    //audit Assumption: read-only endpoints should bypass consistency checks; risk: unnecessary latency on health paths; invariant: exemption list enforced; handling: allow + audit.
    if (isExemptRoute(req)) {
      const memoryVersion = deps.now().toISOString();
      setRequestDispatchContext(req, 'allow', memoryVersion, false);
      setDispatchHeaders(res, 'allow', memoryVersion, 'api.readonly');
      emitDecision('allow', 'api.readonly', memoryVersion, {
        conflictReason: 'none'
      });
      return next();
    }

    const binding = resolveBinding(attempt, deps.bindings);
    let snapshotRecord: Awaited<ReturnType<MemoryConsistencyGateDependencies['snapshotStore']['getSnapshot']>> | null = null;
    let snapshotLoaded = false;

    try {
      snapshotRecord = await deps.snapshotStore.getSnapshot();
      snapshotLoaded = true;
    } catch (error) {
      //audit Assumption: snapshot load errors should fail safely; risk: executing without governance state; invariant: fail-safe response; handling: return 503.
      const fallbackMemoryVersion = deps.now().toISOString();
      const fallbackBindingId = binding?.id || 'unknown';
      setRequestDispatchContext(req, 'block', fallbackMemoryVersion, false, DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE);
      setDispatchHeaders(res, 'block', fallbackMemoryVersion, fallbackBindingId);
      emitDecision('block', fallbackBindingId, fallbackMemoryVersion, {
        conflictReason: 'none',
        logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
      });
      dispatchLogger.error(
        DISPATCH_V9_LOG_MESSAGES.failsafe,
        {
          route_attempted: attempt.routeAttempted,
          reason: 'snapshot_load_failed'
        },
        undefined,
        error instanceof Error ? error : undefined
      );
      res.status(503).json(
        buildFailsafePayload({
          routeAttempted: attempt.routeAttempted,
          memoryVersion: fallbackMemoryVersion,
          bindingId: fallbackBindingId,
          reason: 'snapshot_load_failed'
        })
      );
      return;
    }

    let validation = validateAgainstSnapshot(
      binding,
      attempt,
      snapshotRecord.snapshot,
      clientMemoryVersion
    );
    let decision = decideAction(
      validation,
      binding?.sensitivity || 'sensitive',
      binding?.conflictPolicy || 'strict_block'
    );

    //audit Assumption: one forced refresh can resolve transient staleness; risk: repeated DB load cost; invariant: max one refresh attempt; handling: refresh once on invalid.
    if (!validation.valid) {
      try {
        snapshotRecord = await deps.snapshotStore.getSnapshot({ forceRefresh: true });
        validation = validateAgainstSnapshot(
          binding,
          attempt,
          snapshotRecord.snapshot,
          clientMemoryVersion
        );
        decision = decideAction(
          validation,
          binding?.sensitivity || 'sensitive',
          binding?.conflictPolicy || 'strict_block'
        );
      } catch (error) {
        setRequestDispatchContext(req, 'block', snapshotRecord.memoryVersion, false, DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE);
        setDispatchHeaders(res, 'block', snapshotRecord.memoryVersion, binding?.id || 'unknown');
        emitDecision('block', binding?.id || 'unknown', snapshotRecord.memoryVersion, {
          conflictReason: validation.reason,
          logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
        });
        dispatchLogger.error(
          DISPATCH_V9_LOG_MESSAGES.failsafe,
          {
            route_attempted: attempt.routeAttempted,
            reason: 'snapshot_refresh_failed'
          },
          undefined,
          error instanceof Error ? error : undefined
        );
        res.status(503).json(
          buildFailsafePayload({
            routeAttempted: attempt.routeAttempted,
            memoryVersion: snapshotRecord.memoryVersion,
            bindingId: binding?.id || 'unknown',
            reason: 'snapshot_refresh_failed'
          })
        );
        return;
      }
    }

    const memoryVersion = snapshotRecord.memoryVersion;
    const bindingId = binding?.id || 'unknown';

    //audit Assumption: shadow mode must not mutate request flow; risk: accidental enforcement in rollout; invariant: always allow in shadow; handling: log + continue.
    if (deps.shadowOnly) {
      setRequestDispatchContext(req, 'allow', memoryVersion, false, validation.reason === 'none' ? undefined : DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT);
      setDispatchHeaders(res, 'allow', memoryVersion, bindingId);
      emitDecision('allow', bindingId, memoryVersion, {
        conflictReason: validation.reason,
        logMessage: DISPATCH_V9_LOG_MESSAGES.shadowAllow
      });
      return next();
    }

    //audit Assumption: valid route checks should seed missing route_state entries; risk: snapshot drift; invariant: route state eventually populated; handling: best-effort upsert.
    if (decision === 'allow') {
      setRequestDispatchContext(req, 'allow', memoryVersion, false);
      setDispatchHeaders(res, 'allow', memoryVersion, bindingId);
      emitDecision('allow', bindingId, memoryVersion, {
        conflictReason: validation.reason
      });

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

      return next();
    }

    if (decision === 'block') {
      setRequestDispatchContext(req, 'block', memoryVersion, false, DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT);
      setDispatchHeaders(res, 'block', memoryVersion, bindingId);
      emitDecision('block', bindingId, memoryVersion, {
        conflictReason: validation.reason,
        logMessage: DISPATCH_V9_LOG_MESSAGES.blocked
      });
      res.status(409).json(
        buildConflictResponsePayload({
          routeAttempted: attempt.routeAttempted,
          memoryVersion,
          bindingId,
          reason: validation.reason
        })
      );
      return;
    }

    const rerouteTarget = binding?.rerouteTarget || '/api/ask';
    const isRegisteredRerouteTarget = deps.bindings.some(candidate =>
      (candidate.exactPaths || []).some(path => normalizePath(path) === normalizePath(rerouteTarget))
    );
    const checks = runFailsafeChecks(
      binding,
      snapshotLoaded,
      memoryVersion,
      rerouteTarget,
      isRegisteredRerouteTarget
    );
    //audit Assumption: reroute preconditions must pass before mutation; risk: invalid reroute state; invariant: checks pass; handling: failsafe response on failure.
    if (!checks.ok) {
      setRequestDispatchContext(req, 'block', memoryVersion, false, DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE);
      setDispatchHeaders(res, 'block', memoryVersion, bindingId);
      emitDecision('block', bindingId, memoryVersion, {
        conflictReason: validation.reason,
        logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
      });
      res.status(503).json(
        buildFailsafePayload({
          routeAttempted: attempt.routeAttempted,
          memoryVersion,
          bindingId,
          reason: checks.reason || 'failsafe_check_failed'
        })
      );
      return;
    }

    const stateSnapshot = snapshotRequestState(req);
    try {
      const rerouteMessage = buildRerouteMessage(req, attempt.routeAttempted, validation.reason);
      const body = isObjectBody(req.body) ? req.body : {};

      req.method = 'POST';
      req.url = rerouteTarget;
      req.body = {
        ...body,
        message: rerouteMessage,
        dispatchReroute: {
          originalRoute: attempt.routeAttempted,
          reason: validation.reason,
          memoryVersion
        }
      };

      //audit Assumption: rerouted request body must contain a message for the target handler; risk: target receives invalid payload; invariant: message is non-empty string; handling: restore + failsafe on invalid.
      if (typeof req.body.message !== 'string' || !req.body.message.trim()) {
        restoreRequestState(req, stateSnapshot);
        setRequestDispatchContext(req, 'block', memoryVersion, false, DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE);
        setDispatchHeaders(res, 'block', memoryVersion, bindingId);
        emitDecision('block', bindingId, memoryVersion, {
          conflictReason: validation.reason,
          logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
        });
        res.status(503).json(
          buildFailsafePayload({
            routeAttempted: attempt.routeAttempted,
            memoryVersion,
            bindingId,
            reason: 'reroute_payload_invalid'
          })
        );
        return;
      }

      setRequestDispatchContext(req, 'reroute', memoryVersion, true, DISPATCH_V9_ERROR_CODES.MEMORY_ROUTE_CONFLICT);
      setDispatchHeaders(res, 'reroute', memoryVersion, bindingId);
      emitDecision('reroute', bindingId, memoryVersion, {
        conflictReason: validation.reason,
        rerouteTarget,
        logMessage: DISPATCH_V9_LOG_MESSAGES.rerouted
      });

      return next();
    } catch (error) {
      //audit Assumption: reroute mutation failures should restore original request state; risk: partial state commit; invariant: request restored; handling: restore + failsafe.
      restoreRequestState(req, stateSnapshot);
      dispatchLogger.error(
        DISPATCH_V9_LOG_MESSAGES.failsafe,
        {
          route_attempted: attempt.routeAttempted,
          reason: 'reroute_execution_failed'
        },
        undefined,
        error instanceof Error ? error : undefined
      );
      setRequestDispatchContext(req, 'block', memoryVersion, false, DISPATCH_V9_ERROR_CODES.DISPATCH_FAILSAFE);
      setDispatchHeaders(res, 'block', memoryVersion, bindingId);
      emitDecision('block', bindingId, memoryVersion, {
        conflictReason: validation.reason,
        logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
      });
      res.status(503).json(
        buildFailsafePayload({
          routeAttempted: attempt.routeAttempted,
          memoryVersion,
          bindingId,
          reason: 'reroute_execution_failed'
        })
      );
      return;
    }
  };
}

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const memoryConsistencyGate = createMemoryConsistencyGate();
