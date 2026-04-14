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
  }
) {
  const preparedPayload = prepareBoundedClientJsonPayload(payload as Record<string, unknown>, {
    logger: req.logger,
    logEvent: options.logEvent,
    maxBytes: options.maxBytes,
  });

  const targetResponse = options.statusCode === undefined
    ? res
    : res.status(options.statusCode);

  return sendPreparedJsonResponse(targetResponse, preparedPayload);
}
