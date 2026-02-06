/**
 * Type definitions for Express Request extensions
 */
import type { DispatchDecisionV9 } from './dispatchV9.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * Daemon Bearer token extracted from Authorization header
       * Set by requireDaemonAuth middleware
       */
      daemonToken?: string;
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
    }
  }
}

export {};
