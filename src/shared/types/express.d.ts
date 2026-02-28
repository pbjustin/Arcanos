/**
 * Type definitions for Express Request extensions
 */
import type { DispatchDecisionV9 } from './dispatchV9.js';

export type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RequestLogger {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
}

declare global {
  namespace Express {
    interface Request {
      /**
       * Daemon request token
       * Set by daemon route middleware
       */
      daemonToken?: string;
      /**
       * Operator actor label used in safety audit events.
       */
      operatorActor?: string;
      /**
       * Dispatch governance decision for request lifecycle.
       * Set by memoryConsistencyGate middleware.
       */
      dispatchDecision?: DispatchDecisionV9;
      /**
       * Snapshot memory version observed during dispatch evaluation.
       */
      memoryVersion?: string;
      /**
       * Flag indicating request has been rewritten to a safe reroute target.
       */
      dispatchRerouted?: boolean;
      /**
       * Machine-readable conflict/failsafe code for reroute or block paths.
       */
      dispatchConflictCode?: string;
      /**
       * Correlation id attached by requestContext middleware.
       */
      requestId?: string;
      /**
       * Request-scoped structured logger attached by requestContext middleware.
       */
      logger?: RequestLogger;
      /**
       * Convenience request log helper attached by requestContext middleware.
       */
      log?: (event: string, data?: Record<string, unknown>, level?: RequestLogLevel) => void;
    }
  }
}

export {};
