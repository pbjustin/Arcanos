import type { NextFunction, Request, Response } from 'express';
import { apiLogger } from '../utils/structuredLogging.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { registerTraceEvent } from '../services/contextualReinforcement.js';

interface RequestWithLogger extends Request {
  logger?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    timed: (message: string, duration: number, context?: Record<string, unknown>, metadata?: Record<string, unknown>) => void;
  };
  requestId?: string;
}

interface ResponseWithLocals extends Response {
  locals: Response['locals'] & {
    auditTraceId?: string;
  };
}

export function auditTrace(req: RequestWithLogger, res: ResponseWithLocals, next: NextFunction): void {
  const traceId = generateRequestId('trace');
  const startTime = Date.now();
  const requestId = req.requestId ?? generateRequestId('req');

  res.locals.auditTraceId = traceId;

  const logger = req.logger ?? apiLogger.child({ traceId, requestId, path: req.path, method: req.method });
  logger.info('Audit trace started');

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    registerTraceEvent({
      traceId,
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      timestamp: new Date().toISOString()
    });

    logger.timed('Audit trace completed', duration, { traceId, statusCode: res.statusCode });
  });

  next();
}
