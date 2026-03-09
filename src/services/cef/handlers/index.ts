import { buildCommandError } from '../commandErrors.js';
import type {
  CefHandlerContext,
  CommandName,
  WhitelistedHandlerDispatchResult
} from '../types.js';
import {
  dispatchAiHandler,
  type AiHandlerMethod
} from './ai.handler.js';
import {
  dispatchAuditSafeHandler,
  type AuditSafeHandlerMethod
} from './auditSafe.handler.js';

interface RoutedHandlerDefinition {
  name: CommandName;
  handlerDomain: string;
  handlerMethod: string;
}

type HandlerActionDispatcher = (
  payload: Record<string, unknown>,
  context: CefHandlerContext
) => Promise<WhitelistedHandlerDispatchResult<Record<string, unknown>>>;

const auditSafeActionDispatchers: Record<AuditSafeHandlerMethod, HandlerActionDispatcher> = {
  'set-mode': (payload, context) => dispatchAuditSafeHandler('set-mode', payload, context),
  interpret: (payload, context) => dispatchAuditSafeHandler('interpret', payload, context)
};

const aiActionDispatchers: Record<AiHandlerMethod, HandlerActionDispatcher> = {
  prompt: (payload, context) => dispatchAiHandler('prompt', payload, context)
};

const domainActionDispatchers = {
  'audit-safe': auditSafeActionDispatchers,
  ai: aiActionDispatchers
} as const;

function buildBlockedActionResult(
  definition: RoutedHandlerDefinition
): WhitelistedHandlerDispatchResult<Record<string, unknown>> {
  const blockedActionError = buildCommandError(
    'HANDLER_ACTION_NOT_ALLOWED',
    'Handler action is not allowed.',
    {
      command: definition.name,
      handlerDomain: definition.handlerDomain,
      attemptedAction: definition.handlerMethod
    },
    403
  );

  return {
    success: false,
    message: blockedActionError.message,
    output: null,
    error: blockedActionError,
    fallbackUsed: false,
    fallbackReason: null
  };
}

/**
 * Dispatch one CEF command to an explicit domain/action handler map.
 *
 * Purpose:
 * - Remove generic handler dispatch so every reachable CEF action is declared in a closed action map.
 *
 * Inputs/outputs:
 * - Input: routed command metadata, raw payload, and the typed CEF handler context.
 * - Output: structured handler dispatch result.
 *
 * Edge case behavior:
 * - Unknown domains fail as an internal routing error; unknown actions fail closed with `HANDLER_ACTION_NOT_ALLOWED`.
 */
export async function dispatchWhitelistedCefHandler(
  definition: RoutedHandlerDefinition,
  payload: Record<string, unknown>,
  context: CefHandlerContext
): Promise<WhitelistedHandlerDispatchResult<Record<string, unknown>>> {
  const domainDispatcher = domainActionDispatchers[
    definition.handlerDomain as keyof typeof domainActionDispatchers
  ] as Record<string, HandlerActionDispatcher> | undefined;

  //audit Assumption: every command definition must point at one explicit domain dispatcher map; failure risk: internal routing drift leaves a command without a real handler and silently weakens the CEF boundary; expected invariant: each handlerDomain resolves to one static map; handling strategy: fail closed with a typed internal routing error.
  if (!domainDispatcher) {
    return {
      success: false,
      message: 'Command handler domain is not wired to the CEF router.',
      output: null,
      error: buildCommandError(
        'UNSUPPORTED_HANDLER_DOMAIN',
        'Command handler domain is not wired to the CEF router.',
        {
          handlerDomain: definition.handlerDomain,
          command: definition.name
        }
      ),
      fallbackUsed: false,
      fallbackReason: null
    };
  }

  const actionDispatcher = domainDispatcher[definition.handlerMethod];

  //audit Assumption: only explicitly mapped handler actions may be dispatched from the CEF router; failure risk: a loose method string bypasses the allowlisted action surface; expected invariant: every routed handlerMethod exists in the static action map; handling strategy: reject unmapped actions with `HANDLER_ACTION_NOT_ALLOWED`.
  if (!actionDispatcher) {
    return buildBlockedActionResult(definition);
  }

  return actionDispatcher(payload, context);
}
