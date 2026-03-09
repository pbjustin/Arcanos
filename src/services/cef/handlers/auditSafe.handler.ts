import { z } from 'zod';
import { sanitizeInput } from '@platform/runtime/security.js';
import { getAuditSafeMode, interpretCommand, setAuditSafeMode } from '@services/auditSafeToggle.js';
import { dispatchValidatedHandler, enforceAllowedHandlerMethod } from '../handlerRuntime.js';
import type { CefHandlerContext, WhitelistedHandlerDispatchResult } from '../types.js';
import { buildCommandError } from '../commandErrors.js';

const VALID_AUDIT_MODES = ['true', 'false', 'passive', 'log-only'] as const;

export const AuditSafeSetModeInputSchema = z.object({
  mode: z.enum(VALID_AUDIT_MODES)
});

export const AuditSafeSetModeOutputSchema = z.object({
  mode: z.enum(VALID_AUDIT_MODES)
});

export const AuditSafeInterpretInputSchema = z.object({
  instruction: z.string().trim().min(1)
});

export const AuditSafeInterpretOutputSchema = z.object({
  instruction: z.string().min(1),
  mode: z.string().min(1)
});

export const allowedHandlers = ['set-mode', 'interpret'] as const;

export type AuditSafeHandlerMethod = (typeof allowedHandlers)[number];

/**
 * Dispatch one whitelisted audit-safe handler method.
 *
 * Purpose:
 * - Route audit-safe CEF commands through explicit method allow-lists and schema-validated handlers.
 *
 * Inputs/outputs:
 * - Input: handler method name, raw payload, and CEF handler context.
 * - Output: structured handler dispatch result.
 *
 * Edge case behavior:
 * - Blocks undeclared methods before validation or side effects and returns a typed error when a method is unreachable.
 */
export async function dispatchAuditSafeHandler(
  method: string,
  rawPayload: Record<string, unknown>,
  context: CefHandlerContext
): Promise<WhitelistedHandlerDispatchResult<Record<string, unknown>>> {
  const whitelistError = await enforceAllowedHandlerMethod(method, allowedHandlers, context);
  if (whitelistError) {
    return {
      success: false,
      message: whitelistError.message,
      output: null,
      error: whitelistError,
      fallbackUsed: false,
      fallbackReason: null
    };
  }

  switch (method as AuditSafeHandlerMethod) {
    case 'set-mode':
      return dispatchValidatedHandler(rawPayload, context, {
        inputSchemaName: 'AuditSafeSetModeInputSchema',
        outputSchemaName: 'AuditSafeSetModeOutputSchema',
        inputSchema: AuditSafeSetModeInputSchema,
        outputSchema: AuditSafeSetModeOutputSchema,
        async invokeValidatedMethod(payload) {
          setAuditSafeMode(payload.mode);
          return {
            message: `Audit-Safe mode set to ${payload.mode}.`,
            output: {
              mode: payload.mode
            }
          };
        }
      });
    case 'interpret':
      return dispatchValidatedHandler(rawPayload, context, {
        inputSchemaName: 'AuditSafeInterpretInputSchema',
        outputSchemaName: 'AuditSafeInterpretOutputSchema',
        inputSchema: AuditSafeInterpretInputSchema,
        outputSchema: AuditSafeInterpretOutputSchema,
        async invokeValidatedMethod(payload) {
          const instruction = sanitizeInput(payload.instruction);
          await interpretCommand(instruction);
          return {
            message: 'Instruction processed. Audit-Safe mode updated if recognized.',
            output: {
              instruction,
              mode: getAuditSafeMode()
            }
          };
        }
      });
    default:
      //audit Assumption: whitelist enforcement makes the default branch unreachable; failure risk: a future method addition forgets to wire a dispatcher branch; expected invariant: every allowed handler has an explicit case; handling strategy: fail closed with a typed internal mapping error.
      return {
        success: false,
        message: 'Audit-safe handler method is not wired to a dispatcher branch.',
        output: null,
        error: buildCommandError('HANDLER_METHOD_NOT_IMPLEMENTED', 'Audit-safe handler method is not wired to a dispatcher branch.', {
          method
        }),
        fallbackUsed: false,
        fallbackReason: null
      };
  }
}
