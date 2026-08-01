import type { RequestHandler } from 'express';

import { validateGptIdentifier } from '@shared/gpt/gptIdentifier.js';
import { GPT_QUERY_ACTION } from '@shared/gpt/gptJobResult.js';
import { applyCanonicalGptRouteHeaders } from '@shared/http/gptRouteHeaders.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';

const GPT_DISPATCHER_ROUTE = '/gpt/:gptId';

/** Reject unsafe GPT identifiers before admission, routing, GPT-specific logging, or metrics. */
export const canonicalGptIdentifierBoundary: RequestHandler = (req, res, next) => {
  const validation = validateGptIdentifier(req.params.gptId);
  if (validation.ok) {
    req.params.gptId = validation.value;
    next();
    return;
  }

  const requestId = req.requestId ?? req.traceId ?? 'unknown';
  const traceId = req.traceId ?? requestId;
  applyCanonicalGptRouteHeaders(res);

  return sendBoundedJsonResponse(req, res, {
    ok: false,
    requestId,
    gptId: validation.value,
    action: GPT_QUERY_ACTION,
    route: GPT_DISPATCHER_ROUTE,
    code: validation.error.code,
    traceId,
    error: {
      code: validation.error.code,
      message: validation.error.message,
    },
    _route: {
      requestId,
      traceId,
      gptId: validation.value,
      action: GPT_QUERY_ACTION,
      route: 'gpt_id_boundary',
      timestamp: new Date().toISOString(),
    },
  }, {
    logEvent: 'gpt.response.gpt_id_boundary',
    statusCode: 400,
  });
};
