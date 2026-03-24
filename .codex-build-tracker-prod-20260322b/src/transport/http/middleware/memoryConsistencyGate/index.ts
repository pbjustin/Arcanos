import type { NextFunction, Request, Response } from 'express';
import { config } from "@platform/runtime/config.js";
import {
  DISPATCH_BINDINGS_VERSION,
  DISPATCH_PATTERN_BINDINGS
} from "@platform/runtime/dispatchPatterns.js";
import { DISPATCH_V9_ERROR_CODES, DISPATCH_V9_LOG_MESSAGES } from "@platform/runtime/dispatchMessages.js";
import {
  decideAction,
  resolveBinding,
  validateAgainstSnapshot
} from "@services/dispatchControllerV9.js";
import { routeMemorySnapshotStore } from "@services/routeMemorySnapshotStore.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { resolveHeader } from "@transport/http/requestHeaders.js";
import {
  activateUnsafeCondition,
  buildUnsafeToProceedPayload
} from "@services/safety/runtimeState.js";
import { emitSafetyAuditEvent } from "@services/safety/auditEvents.js";
import { interpreterSupervisor } from "@services/safety/interpreterSupervisor.js";
import type {
  DispatchAttemptV9,
  DispatchConflictReasonV9,
  DispatchDecisionV9,
  DispatchMemorySnapshotV9,
  DispatchPatternBindingV9
} from "@shared/types/dispatchV9.js";

import type { MemoryConsistencyGateDependencies, RequestStateSnapshot } from './types.js';
import { MAX_BODY_SERIALIZATION_BYTES, STATUS_CONFLICT, STATUS_SERVICE_UNAVAILABLE, POLICY_SUPERVISOR_ENTITY_ID } from './constants.js';
import { normalizePath, cloneJsonSafe, resolveExpectedBaselineMonotonicTs, isObjectBody, withTimeout } from './utils.js';
import { buildRouteAttempt, buildRerouteMessage } from './intent.js';
import { isExemptRoute } from './exempt.js';
import { applyDispatchDecisionContext } from './headers.js';
import { buildDispatchDecisionPayload, buildConflictResponsePayload, buildFailsafePayload, respondWithFailsafe, respondWithConflict, respondWithUnsafe } from './payloads.js';
import { snapshotRequestState, restoreRequestState } from './requestState.js';
import { runFailsafeChecks } from './failsafe.js';

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
        reason: 'reroute_message_invalid',
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
      rerouted: true
    });
    options.emitDecision('reroute', options.bindingId, options.memoryVersion, {
      rerouteTarget: options.rerouteTarget,
      conflictReason: options.validation.reason,
      logMessage: DISPATCH_V9_LOG_MESSAGES.rerouted
    });

    options.dispatchLogger.warn(DISPATCH_V9_LOG_MESSAGES.rerouted, {
      route_attempted: options.attempt.routeAttempted,
      reroute_target: options.rerouteTarget,
      conflict_reason: options.validation.reason,
      memory_version: options.memoryVersion,
      binding_id: options.bindingId
    });
    options.deps.recordTrace('dispatch.v9.reroute', {
      route_attempted: options.attempt.routeAttempted,
      reroute_target: options.rerouteTarget,
      conflict_reason: options.validation.reason,
      memory_version: options.memoryVersion,
      binding_id: options.bindingId
    });

    options.next();
  } catch (error) {
    restoreRequestState(options.req, stateSnapshot);
    options.dispatchLogger.error(
      DISPATCH_V9_LOG_MESSAGES.failsafe,
      {
        route_attempted: options.attempt.routeAttempted,
        reason: 'reroute_dispatch_error'
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
      reason: 'reroute_dispatch_error',
      logMessage: DISPATCH_V9_LOG_MESSAGES.failsafe
    });
  }
}

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

export const memoryConsistencyGate = createMemoryConsistencyGate();
