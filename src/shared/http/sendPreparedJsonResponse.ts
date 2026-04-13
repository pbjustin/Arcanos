import type { Response } from 'express';

import type { PreparedClientJsonPayload } from './clientResponseCommon.js';

export function sendPreparedJsonResponse<T extends Record<string, unknown>>(
  res: Response,
  preparedPayload: PreparedClientJsonPayload<T>
) {
  res.setHeader('x-response-bytes', String(preparedPayload.responseBytes));
  if (preparedPayload.truncated) {
    res.setHeader('x-response-truncated', 'true');
  }

  return res.json(preparedPayload.payload);
}
