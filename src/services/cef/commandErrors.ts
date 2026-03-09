import { z } from 'zod';
import type { CommandExecutionError } from './types.js';

export const CommandErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  details: z.record(z.unknown()).optional()
});

/**
 * Build one typed CEF error payload.
 *
 * Purpose:
 * - Normalize command and handler failures to one stable schema for callers and traces.
 *
 * Inputs/outputs:
 * - Input: error code, message, and optional details.
 * - Output: schema-validated `CommandExecutionError`.
 *
 * Edge case behavior:
 * - Falls back to an internal-schema error when the requested payload violates the shared error schema.
 */
export function buildCommandError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): CommandExecutionError {
  const candidateError = {
    code,
    message,
    ...(details ? { details } : {})
  };
  const parsedError = CommandErrorSchema.safeParse(candidateError);

  //audit Assumption: command and handler errors must remain machine-readable across all CEF paths; failure risk: ad-hoc error objects leak into API responses and traces; expected invariant: every exposed error matches `CommandErrorSchema`; handling strategy: downgrade invalid error shapes to a minimal internal-schema violation payload.
  if (!parsedError.success) {
    return {
      code: 'COMMAND_ERROR_SCHEMA_INVALID',
      message: 'Command error payload violated the declared schema.'
    };
  }

  return parsedError.data;
}
