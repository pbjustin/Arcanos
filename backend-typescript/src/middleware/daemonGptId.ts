/**
 * Middleware to extract daemon GPT ID from incoming requests.
 */

import { NextFunction, Request, Response } from 'express';
import {
  extractHeaderValue,
  parseDaemonGptId,
  resolveDaemonGptIdConfig
} from '../daemonGptId';

export interface DaemonGptIdLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface DaemonGptIdMiddlewareDependencies {
  headerName?: string;
  maxLength?: number;
  logger?: DaemonGptIdLogger;
}

/**
 * Create middleware to attach daemon GPT ID to the request.
 * Inputs/Outputs: header config and optional logger; returns Express middleware.
 * Edge cases: Invalid headers are ignored and logged as warnings.
 */
export function createDaemonGptIdMiddleware(
  deps: DaemonGptIdMiddlewareDependencies
): (req: Request, res: Response, next: NextFunction) => void {
  const config = resolveDaemonGptIdConfig(deps.headerName, deps.maxLength);
  const logger = deps.logger;

  return (req: Request, res: Response, next: NextFunction) => {
    void res;
    const rawHeader = extractHeaderValue(req, config.headerName);
    const parsed = parseDaemonGptId(rawHeader, config.maxLength);
    if (!parsed.ok) {
      //audit assumption: invalid header should not block request; risk: missing ID; invariant: request continues; strategy: log and continue.
      if (logger) {
        //audit assumption: logger optional; risk: missing diagnostics; invariant: best-effort log; strategy: warn when available.
        logger.warn('Invalid daemon GPT ID header', {
          headerName: config.headerName,
          error: parsed.error
        });
      }
      req.daemonGptId = undefined;
      next();
      return;
    }

    req.daemonGptId = parsed.value;
    next();
  };
}
