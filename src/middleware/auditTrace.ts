/**
 * Audit Trace Middleware
 * 
 * Provides request tracing and timing for audit and observability purposes.
 * Automatically generates trace IDs, logs request lifecycle events, and registers
 * trace events with the contextual reinforcement system for learning and analysis.
 * 
 * Each request is tagged with a unique trace ID stored in res.locals.auditTraceId
 * and linked to the contextual reinforcement system for pattern detection.
 * 
 * @module auditTrace
 */

import type { NextFunction, Request, Response } from 'express';
import { apiLogger } from '../utils/structuredLogging.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { registerTraceEvent } from '../services/contextualReinforcement.js';

/**
 * Extended Request interface with optional logger and request ID.
 */
interface RequestWithLogger extends Request {
  logger?: {
    info: (message: string, context?: Record<string, unknown>) => void;
    timed: (message: string, duration: number, context?: Record<string, unknown>, metadata?: Record<string, unknown>) => void;
  };
  requestId?: string;
}

/**
 * Extended Response interface with audit trace ID in locals.
 */
interface ResponseWithLocals extends Response {
  locals: Response['locals'] & {
    auditTraceId?: string;
  };
}

/**
 * Audit trace middleware that tracks request lifecycle and duration.
 * Generates a unique trace ID, logs start and completion events, and registers
 * the trace with the contextual reinforcement system upon response finish.
 * 
 * @param req - Express request with optional logger and requestId
 * @param res - Express response where trace ID is stored in locals
 * @param next - Next middleware function
 */
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
