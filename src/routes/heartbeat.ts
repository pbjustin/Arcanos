import express from 'express';
import { z } from 'zod';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { HEARTBEAT_RESPONSE_TEMPLATE } from "@platform/runtime/serverMessages.js";
import { logger } from '@platform/logging/structuredLogging.js';
import { heartbeatHttpBoundary } from '@services/controlPlane/heartbeatHttpBoundary.js';
import { sendBadRequest } from '@shared/http/index.js';

const boundedText = (maxLength: number) => z.string().min(1).max(maxLength).regex(/^[\x20-\x7E]+$/u);
const heartbeatSchema = z.object({
  timestamp: z.string().max(64).datetime({ offset: true }),
  mode: boundedText(64),
  payload: z.object({
    write_override: z.boolean(),
    db_write_enable: z.boolean(),
    suppression_level: boundedText(64),
    confirmation: boundedText(128),
  }).strict(),
}).strict();
type HeartbeatPayload = z.infer<typeof heartbeatSchema>['payload'];

const router = express.Router();

function formatHeartbeatMessage(mode: string, payload: HeartbeatPayload): string {
  const writeStatus = payload.db_write_enable ? 'enabled' : 'disabled';

  return HEARTBEAT_RESPONSE_TEMPLATE
    .replace('{mode}', mode)
    .replace('{writeStatus}', writeStatus)
    .replace('{suppressionLevel}', payload.suppression_level)
    .replace('{confirmation}', payload.confirmation);
}

router.post('/heartbeat', heartbeatHttpBoundary, (req, res, next) => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendBadRequest(res, 'Invalid heartbeat payload');
  }
  // Retain only the closed contract before confirmation fingerprints the body.
  req.body = parsed.data;
  next();
}, confirmGate, (req, res) => {
  const { mode, payload } = req.body as z.infer<typeof heartbeatSchema>;
  // Heartbeat is acknowledgement telemetry, not an unbounded local audit file.
  // Only fixed event names and boolean metadata reach the existing redacted sink.
  try {
    const metadata = {
      writeOverride: payload.write_override,
      dbWriteEnabled: payload.db_write_enable,
    };
    if (req.logger) {
      req.logger.info('heartbeat.received', metadata);
    } else {
      logger.info('heartbeat.received', {
        requestId: req.requestId ?? 'unknown',
        traceId: req.traceId ?? 'unknown',
        ...metadata,
      });
    }
  } catch {
    // Telemetry failure must not change the acknowledgement response.
  }
  const message = formatHeartbeatMessage(mode, payload);
  res.json({ message });
});

export default router;
