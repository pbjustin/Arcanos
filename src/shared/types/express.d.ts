/**
 * Type definitions for Express Request extensions
 */
import type { DispatchDecisionV9 } from './dispatchV9.js';
import type {
  ActionPlanPrincipal,
  LocalAgentExecutorPrincipal,
} from '../../services/actionPlanExecution/auth.js';
import type { ControlPlaneHttpPrincipal } from '../../services/controlPlane/types.js';

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
       * Legacy request-scoped daemon context used by compatibility surfaces.
       * Dedicated daemon-plane HTTP authentication never assigns this field.
       */
      daemonToken?: string;
      /**
       * Operator actor label used in safety audit events.
       */
      operatorActor?: string;
      /**
       * Canonical opaque actor key assigned only after route authentication
       * succeeds. Never contains the presented credential.
       */
      authenticatedActorKey?: string;
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
       * Stable trace id attached by requestContext middleware and propagated in headers/logs.
       */
      traceId?: string;
      /**
       * Request-scoped structured logger attached by requestContext middleware.
       */
      logger?: RequestLogger;
      /**
       * Convenience request log helper attached by requestContext middleware.
       */
      log?: (event: string, data?: Record<string, unknown>, level?: RequestLogLevel) => void;
      /**
       * Optional signed user context attached by identity middleware when enabled.
       */
      authUser?: {
        id: number;
        email: string;
        role: string;
        plan: string;
        profileId: number | null;
        source: 'jwt' | 'header' | 'session';
        externalSubject?: string | null;
      };
      /** Purpose-bound Phase 2E principal; never contains presented credential material. */
      actionPlanPrincipal?: ActionPlanPrincipal;
      /** Purpose-bound local-agent protocol principal; never contains credential material. */
      localAgentExecutorPrincipal?: LocalAgentExecutorPrincipal;
      /** Purpose-bound HTTP control-plane principal; never contains credential material. */
      controlPlanePrincipal?: ControlPlaneHttpPrincipal;
    }
  }
}

export {};
