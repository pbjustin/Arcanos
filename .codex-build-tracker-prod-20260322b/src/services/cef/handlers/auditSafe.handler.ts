import { sanitizeInput } from '@platform/runtime/security.js';
import { getAuditSafeMode, interpretCommand, setAuditSafeMode } from '@services/auditSafeToggle.js';
import { dispatchValidatedHandler, enforceAllowedHandlerMethod } from '../handlerRuntime.js';
import type { CefHandlerContext, WhitelistedHandlerDispatchResult } from '../types.js';
import { buildCommandError } from '../commandErrors.js';

const VALID_AUDIT_MODES = ['true', 'false', 'passive', 'log-only'] as const;

interface AuditSafeSetModePayload extends Record<string, unknown> {
  mode: (typeof VALID_AUDIT_MODES)[number];
}

interface AuditSafeInterpretPayload extends Record<string, unknown> {
  instruction: string;
}

interface AuditSafeSetModeOutput extends Record<string, unknown> {
  mode: (typeof VALID_AUDIT_MODES)[number];
}

interface AuditSafeInterpretOutput extends Record<string, unknown> {
  instruction: string;
  mode: (typeof VALID_AUDIT_MODES)[number];
}

type AuditSafeHandlerActionDefinition =
  | {
      inputSchemaName: 'AuditSafeSetModeInputSchema';
      outputSchemaName: 'AuditSafeSetModeOutputSchema';
      errorSchemaName: 'CommandErrorSchema';
      invokeValidatedMethod: (
        payload: AuditSafeSetModePayload,
        context: CefHandlerContext
      ) => Promise<{ message: string; output: AuditSafeSetModeOutput }>;
    }
  | {
      inputSchemaName: 'AuditSafeInterpretInputSchema';
      outputSchemaName: 'AuditSafeInterpretOutputSchema';
      errorSchemaName: 'CommandErrorSchema';
      invokeValidatedMethod: (
        payload: AuditSafeInterpretPayload,
        context: CefHandlerContext
      ) => Promise<{ message: string; output: AuditSafeInterpretOutput }>;
    };

const allowedHandlerActions = {
  'set-mode': {
    inputSchemaName: 'AuditSafeSetModeInputSchema',
    outputSchemaName: 'AuditSafeSetModeOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    async invokeValidatedMethod(payload: AuditSafeSetModePayload) {
      setAuditSafeMode(payload.mode);
      return {
        message: `Audit-Safe mode set to ${payload.mode}.`,
        output: {
          mode: payload.mode
        }
      };
    }
  },
  interpret: {
    inputSchemaName: 'AuditSafeInterpretInputSchema',
    outputSchemaName: 'AuditSafeInterpretOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    async invokeValidatedMethod(payload: AuditSafeInterpretPayload) {
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
  }
} as const satisfies Record<string, AuditSafeHandlerActionDefinition>;

export const allowedHandlers = Object.freeze(
  Object.keys(allowedHandlerActions)
) as ReadonlyArray<keyof typeof allowedHandlerActions>;

export type AuditSafeHandlerMethod = keyof typeof allowedHandlerActions;

/**
 * Dispatch one whitelisted audit-safe handler action.
 *
 * Purpose:
 * - Route audit-safe CEF commands through explicit action allow-lists and schema-validated handlers.
 *
 * Inputs/outputs:
 * - Input: handler action name, raw payload, and CEF handler context.
 * - Output: structured handler dispatch result.
 *
 * Edge case behavior:
 * - Blocks undeclared actions before validation or side effects and returns a typed error when an action is unreachable.
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

  //audit Assumption: whitelist enforcement guarantees an action definition exists; failure risk: an allowed action key is added without a dispatch config and silently bypasses the handler; expected invariant: every allowlisted action resolves to one config entry; handling strategy: fail closed with a typed internal mapping error.
  if (method !== 'set-mode' && method !== 'interpret') {
    return {
      success: false,
      message: 'Audit-safe handler action is not wired to a dispatcher mapping.',
      output: null,
      error: buildCommandError('HANDLER_ACTION_NOT_IMPLEMENTED', 'Audit-safe handler action is not wired to a dispatcher mapping.', {
        action: method
      }),
      fallbackUsed: false,
      fallbackReason: null
    };
  }

  if (method === 'set-mode') {
    return dispatchValidatedHandler<AuditSafeSetModePayload, AuditSafeSetModeOutput>(
      rawPayload,
      context,
      allowedHandlerActions['set-mode']
    );
  }

  return dispatchValidatedHandler<AuditSafeInterpretPayload, AuditSafeInterpretOutput>(
    rawPayload,
    context,
    allowedHandlerActions.interpret
  );
}
