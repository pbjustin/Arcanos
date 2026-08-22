import type { RequestHandler } from 'express';

import {
  resolveDispatchLaneForRequest,
} from '@shared/dispatch/dispatchGptIdentifierBoundary.js';

export {
  dispatchGptIdentifierBoundary,
  resolveDispatchLaneForRequest,
} from '@shared/dispatch/dispatchGptIdentifierBoundary.js';

import { dagExecutionHttpBoundary } from './dagHttpBoundary.js';

/** Apply canonical DAG execution policy only when the compatibility lane is DAG. */
export const dispatchDagCompatibilityBoundary: RequestHandler = (req, res, next): void => {
  const resolution = resolveDispatchLaneForRequest(req);
  if (resolution.lane !== 'dag') {
    next();
    return;
  }

  dagExecutionHttpBoundary(req, res, next);
};
