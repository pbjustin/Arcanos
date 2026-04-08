import type { NextFunction, Request, Response } from 'express';
import { routeGptRequest } from './gptDispatch.js';
import { applyLegacyRouteDeprecationHeaders, buildCanonicalGptRoute } from '@shared/http/gptRouteHeaders.js';
import {
  applyAIDegradedResponseHeaders,
  extractAIDegradedResponseMetadata
} from '@shared/http/aiDegradedHeaders.js';

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

    const envelope = await routeGptRequest({
      gptId: options.gptId,
      body: effectiveBody,
      requestId: req.requestId,
      logger: req.logger,
      request: req,
    });

    if (!envelope.ok) {
      applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.error.details));
      const statusCode = LEGACY_ROUTE_ERROR_STATUS_CODES[envelope.error.code] ?? 400;
      res.status(statusCode).json(envelope);
      return;
    }

    applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.result));
    const responseBody = options.successBodyTransform
      ? options.successBodyTransform(envelope.result, req, envelope)
      : envelope;
    res.status(200).json(responseBody);
  } catch (error) {
    next(error);
  }
}
