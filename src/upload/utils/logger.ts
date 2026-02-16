import pino from "pino";

/**
 * Purpose: Provide structured logging for upload service operations.
 * Inputs/Outputs: Reads `LOG_LEVEL` and returns a configured Pino logger instance.
 * Edge cases: Missing LOG_LEVEL defaults to `info` for predictable verbosity.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info"
});
