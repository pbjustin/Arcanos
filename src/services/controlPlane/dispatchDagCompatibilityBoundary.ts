import type { Request, RequestHandler } from 'express';

import {
  resolveDispatchLane,
  type DispatchLaneResolution,
} from '@shared/dispatch/universalDispatch.js';

import { dagExecutionHttpBoundary } from './dagHttpBoundary.js';

const dispatchLaneResolutionKey = Symbol('dispatchLaneResolution');

type DispatchLaneRequest = Request & {
  [dispatchLaneResolutionKey]?: DispatchLaneResolution;
};

/** Resolve and cache the pure lane decision for the lifetime of one request. */
export function resolveDispatchLaneForRequest(req: Request): DispatchLaneResolution {
  const dispatchRequest = req as DispatchLaneRequest;
  dispatchRequest[dispatchLaneResolutionKey] ??= resolveDispatchLane(req.body);
  return dispatchRequest[dispatchLaneResolutionKey];
}

/** Apply canonical DAG execution policy only when the compatibility lane is DAG. */
export const dispatchDagCompatibilityBoundary: RequestHandler = (req, res, next): void => {
  const resolution = resolveDispatchLaneForRequest(req);
  if (resolution.lane !== 'dag') {
    next();
    return;
  }

  dagExecutionHttpBoundary(req, res, next);
};
