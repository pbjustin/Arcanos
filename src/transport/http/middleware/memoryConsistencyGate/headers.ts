import type { Request, Response } from 'express';
import type { DispatchDecisionV9 } from '@shared/types/dispatchV9.js';

export function setDispatchHeaders(
  res: Response,
  decision: DispatchDecisionV9,
  memoryVersion: string,
  bindingId: string
): void {
  res.setHeader('x-dispatch-memory-version', memoryVersion);
  res.setHeader('x-dispatch-decision', decision);
  res.setHeader('x-dispatch-binding', bindingId);
}

export function setRequestDispatchContext(
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

export function applyDispatchDecisionContext(options: {
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
