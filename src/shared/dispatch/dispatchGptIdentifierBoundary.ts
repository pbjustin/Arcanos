import type { Request, RequestHandler } from 'express';

import {
  resolveDispatchLane,
  type DispatchLaneResolution,
} from './universalDispatch.js';
import { validateGptIdentifier } from '../gpt/gptIdentifier.js';
import { sendBoundedJsonResponse } from '../http/sendBoundedJsonResponse.js';

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

/** Reject an explicit GPT-lane identifier before provider admission or GPT work. */
export const dispatchGptIdentifierBoundary: RequestHandler = (req, res, next) => {
  const resolution = resolveDispatchLaneForRequest(req);
  if (resolution.lane !== 'gpt' || resolution.input.gptId === null) {
    next();
    return;
  }

  const validation = validateGptIdentifier(resolution.input.gptId);
  if (validation.ok) {
    next();
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  return sendBoundedJsonResponse(req, res, {
    ok: false,
    error: validation.error,
    _route: {
      requestId: req.requestId,
      traceId: req.traceId ?? null,
      gptId: validation.value,
      timestamp: new Date().toISOString(),
    },
    target: 'gpt',
    routeFamily: 'dispatch',
    gptId: validation.value,
    // action is intentionally omitted: this fixed rejection must not reflect unbounded metadata.
    executionMode: 'gpt',
    _dispatch: {
      target: resolution.input.target,
      executionMode: resolution.input.executionMode,
      reason: resolution.reason,
    },
  }, {
    logEvent: 'dispatch.response.gpt_id_boundary',
    statusCode: 400,
  });
};
