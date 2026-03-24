import type { Request } from 'express';
import type { RequestStateSnapshot } from './types.js';
import { cloneJsonSafe } from './utils.js';

export function snapshotRequestState(req: Request): RequestStateSnapshot {
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
export function restoreRequestState(req: Request, snapshot: RequestStateSnapshot): void {
  req.method = snapshot.method;
  req.url = snapshot.url;
  req.body = snapshot.body;
  req.dispatchDecision = snapshot.dispatchDecision;
  req.memoryVersion = snapshot.memoryVersion;
  req.dispatchRerouted = snapshot.dispatchRerouted;
  req.dispatchConflictCode = snapshot.dispatchConflictCode;
}
