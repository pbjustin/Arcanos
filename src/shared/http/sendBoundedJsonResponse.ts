import type { Request, Response } from 'express';

import { prepareBoundedClientJsonPayload } from './clientJsonPayload.js';
import { sendPreparedJsonResponse } from './sendPreparedJsonResponse.js';

export function sendBoundedJsonResponse<T extends object>(
  req: Request,
  res: Response,
  payload: T,
  options: {
    logEvent: string;
    statusCode?: number;
    maxBytes?: number;
    maxBytesCeiling?: number;
    overflowPayload?: Record<string, unknown>;
    overflowStatusCode?: number;
  }
) {
  const preparedPayload = prepareBoundedClientJsonPayload(payload as Record<string, unknown>, {
    logger: req.logger,
    logEvent: options.logEvent,
    maxBytes: options.maxBytes,
    maxBytesCeiling: options.maxBytesCeiling,
    overflowPayload: options.overflowPayload,
  });

  const statusCode = preparedPayload.truncated
    && options.overflowPayload
    && options.overflowStatusCode !== undefined
    ? options.overflowStatusCode
    : options.statusCode;
  const targetResponse = statusCode === undefined
    ? res
    : res.status(statusCode);

  return sendPreparedJsonResponse(targetResponse, preparedPayload);
}
