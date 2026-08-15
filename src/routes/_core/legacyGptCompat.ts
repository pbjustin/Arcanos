import type { NextFunction, Request, Response } from 'express';
import { routeGptRequest } from './gptDispatch.js';
import { applyLegacyRouteDeprecationHeaders, buildCanonicalGptRoute } from '@shared/http/gptRouteHeaders.js';
import {
  applyAIDegradedResponseHeaders,
  extractAIDegradedResponseMetadata
} from '@shared/http/aiDegradedHeaders.js';
import { sendBoundedJsonResponse } from '@shared/http/sendBoundedJsonResponse.js';
import { BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE } from '@shared/backstage/backstageRoster.js';
import { BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE } from '@services/backstageBookerContracts.js';
import { resolveBackstageCanonDomainErrorHttpStatus } from '@core/db/repositories/backstageBookerRepository.js';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';

type BodyTransform = (body: unknown, req: Request) => unknown;
type SuccessBodyTransform = (
  result: unknown,
  req: Request,
  envelope: {
    ok: true;
    result: unknown;
    _route: unknown;
  }
) => unknown;

const LEGACY_ROUTE_ERROR_STATUS_CODES: Record<string, number> = {
  UNKNOWN_GPT: 404,
  MEMORY_AUTH_REQUIRED: 401,
  MEMORY_AUTH_UNAVAILABLE: 503,
  [BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE]: 503,
  SYSTEM_STATE_CONFLICT: 409,
  MODULE_TIMEOUT: 504,
};

export async function dispatchLegacyRouteToGpt(
  req: Request,
  res: Response,
  next: NextFunction,
  options: {
    legacyRoute: string;
    gptId: string;
    bodyTransform?: BodyTransform;
    successBodyTransform?: SuccessBodyTransform;
    applyDeprecationHeaders?: boolean;
  }
): Promise<void> {
  try {
    const effectiveBody = options.bodyTransform
      ? options.bodyTransform(req.body, req)
      : req.body;
    const canonicalRoute = buildCanonicalGptRoute(options.gptId);

    if (options.applyDeprecationHeaders !== false) {
      applyLegacyRouteDeprecationHeaders(res, canonicalRoute);
    }

    req.logger?.info?.('legacy.route.compat_dispatch', {
      legacyRoute: options.legacyRoute,
      canonicalRoute,
      gptId: options.gptId,
      requestId: req.requestId
    });

    const abortScope = createClientDisconnectAbortScope(
      req,
      res,
      'Legacy GPT compatibility client disconnected',
    );
    let envelope: Awaited<ReturnType<typeof routeGptRequest>>;
    try {
      envelope = await routeGptRequest({
        gptId: options.gptId,
        body: effectiveBody,
        requestId: req.requestId,
        logger: req.logger,
        request: req,
        researchClientAbortSignal: abortScope.signal,
      });
    } finally {
      abortScope.cleanup();
    }

    if (!envelope.ok) {
      applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.error.details));
      const statusCode = resolveBackstageCanonDomainErrorHttpStatus(envelope.error.code)
        ?? LEGACY_ROUTE_ERROR_STATUS_CODES[envelope.error.code]
        ?? (envelope.error.code === BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE ? 503 : 400);
      sendBoundedJsonResponse(req, res, envelope, {
        logEvent: 'legacy.route.error.response',
        statusCode,
      });
      return;
    }

    applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.result));
    const responseBody = options.successBodyTransform
      ? options.successBodyTransform(envelope.result, req, envelope)
      : envelope;
    if (
      responseBody &&
      typeof responseBody === 'object' &&
      !Array.isArray(responseBody)
    ) {
      sendBoundedJsonResponse(req, res, responseBody as Record<string, unknown>, {
        logEvent: 'legacy.route.response',
        statusCode: 200,
      });
      return;
    }

    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
}
