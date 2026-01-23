/**
 * Type definitions for Express Request extensions
 */

declare global {
  namespace Express {
    interface Request {
      /**
       * Daemon Bearer token extracted from Authorization header
       * Set by requireDaemonAuth middleware
       */
      daemonToken?: string;
    }
  }
}

export {};
