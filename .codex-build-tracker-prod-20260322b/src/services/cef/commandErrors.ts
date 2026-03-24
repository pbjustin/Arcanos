import type { CommandExecutionError } from './types.js';
import { validateCefSchema } from './schemaRegistry.js';

function resolveCommandErrorHttpStatusCode(errorCode: string): number {
  switch (errorCode) {
    case 'HANDLER_ACTION_NOT_ALLOWED':
      return 403;
    case 'INVALID_COMMAND_PAYLOAD':
    case 'UNSUPPORTED_COMMAND':
      return 400;
    default:
      return 500;
  }
}

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
  details?: Record<string, unknown>,
  httpStatusCode = resolveCommandErrorHttpStatusCode(code)
): CommandExecutionError {
  const candidateError = {
    code,
    message,
    httpStatusCode,
    ...(details ? { details } : {})
  };
  const parsedError = validateCefSchema<CommandExecutionError>('CommandErrorSchema', candidateError);

  //audit Assumption: command and handler errors must remain machine-readable across all CEF paths; failure risk: ad-hoc error objects leak into API responses and traces; expected invariant: every exposed error matches `CommandErrorSchema`; handling strategy: downgrade invalid error shapes to a minimal internal-schema violation payload.
  if (!parsedError.success || !parsedError.data) {
    return {
      code: 'COMMAND_ERROR_SCHEMA_INVALID',
      message: 'Command error payload violated the declared schema.',
      httpStatusCode: 500
    };
  }

  return parsedError.data;
}
