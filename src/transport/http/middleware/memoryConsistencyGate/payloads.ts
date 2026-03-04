import type { Request, Response } from 'express';
import { DISPATCH_V9_ERROR_CODES } from '@platform/runtime/dispatchMessages.js';
import { buildUnsafeToProceedPayload } from '@services/safety/runtimeState.js';
import type { DispatchConflictReasonV9, DispatchDecisionV9 } from '@shared/types/dispatchV9.js';
import { STATUS_CONFLICT, STATUS_SERVICE_UNAVAILABLE } from './constants.js';
import { applyDispatchDecisionContext } from './headers.js';

export function buildDispatchDecisionPayload(options: {
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

export function buildConflictResponsePayload(options: {
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

export function buildFailsafePayload(options: {
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

export function respondWithFailsafe(options: {
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

export function respondWithConflict(options: {
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

export function respondWithUnsafe(options: {
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
