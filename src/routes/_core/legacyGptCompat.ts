import type { NextFunction, Request, Response } from 'express';
import { routeGptRequest } from './gptDispatch.js';
import { applyLegacyRouteDeprecationHeaders, buildCanonicalGptRoute } from '@shared/http/gptRouteHeaders.js';
import {
  applyAIDegradedResponseHeaders,
  extractAIDegradedResponseMetadata
} from '@shared/http/aiDegradedHeaders.js';

type BodyTransform = (body: unknown, req: Request) => unknown;

export async function dispatchLegacyRouteToGpt(
  req: Request,
  res: Response,
  next: NextFunction,
  options: {
    legacyRoute: string;
    gptId: string;
    bodyTransform?: BodyTransform;
  }
): Promise<void> {
  try {
    const effectiveBody = options.bodyTransform
      ? options.bodyTransform(req.body, req)
      : req.body;
    const canonicalRoute = buildCanonicalGptRoute(options.gptId);

    applyLegacyRouteDeprecationHeaders(res, canonicalRoute);

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
      const statusCode =
        envelope.error.code === 'UNKNOWN_GPT'
          ? 404
          : envelope.error.code === 'SYSTEM_STATE_CONFLICT'
          ? 409
          : envelope.error.code === 'MODULE_TIMEOUT'
          ? 504
          : 400;
      res.status(statusCode).json(envelope);
      return;
    }

    applyAIDegradedResponseHeaders(res, extractAIDegradedResponseMetadata(envelope.result));
    res.status(200).json(envelope);
  } catch (error) {
    next(error);
  }
}
