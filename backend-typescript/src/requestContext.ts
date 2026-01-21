/**
 * Request context typing extensions for daemon metadata.
 */

declare global {
  namespace Express {
    interface Request {
      daemonGptId?: string;
    }
  }
}

export {};
