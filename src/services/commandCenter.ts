import { getAuditSafeMode } from '@services/auditSafeToggle.js';
import { generateRequestId } from '@shared/idGenerator.js';
import { traceCefBoundary } from './cef/boundaryTrace.js';
import { buildCommandError } from './cef/commandErrors.js';
import { dispatchAiHandler } from './cef/handlers/ai.handler.js';
import { dispatchAuditSafeHandler } from './cef/handlers/auditSafe.handler.js';
import type {
  CefHandlerContext,
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutionResult,
  CommandName
} from './cef/types.js';

export type {
  CommandDefinition,
  CommandExecutionContext,
  CommandExecutionError,
  CommandExecutionMetadata,
  CommandExecutionResult,
  CommandName
} from './cef/types.js';

interface RoutedCommandDefinition extends CommandDefinition {
  description: string;
}

const COMMAND_DEFINITIONS: Record<CommandName, RoutedCommandDefinition> = {
  'audit-safe:set-mode': {
    name: 'audit-safe:set-mode',
    description: 'Directly set the Audit-Safe enforcement mode.',
    requiresConfirmation: true,
    payloadExample: { mode: 'true' },
    inputSchemaName: 'AuditSafeSetModeInputSchema',
    outputSchemaName: 'AuditSafeSetModeOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    handlerDomain: 'audit-safe',
    handlerMethod: 'set-mode'
  },
  'audit-safe:interpret': {
    name: 'audit-safe:interpret',
    description: 'Interpret a natural-language instruction to adjust Audit-Safe mode.',
    requiresConfirmation: true,
    payloadExample: { instruction: 'Enable strict audit safe mode' },
    inputSchemaName: 'AuditSafeInterpretInputSchema',
    outputSchemaName: 'AuditSafeInterpretOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    handlerDomain: 'audit-safe',
    handlerMethod: 'interpret'
  },
  'ai:prompt': {
    name: 'ai:prompt',
    description: 'Execute an AI command through the centralized OpenAI routing pipeline.',
    requiresConfirmation: true,
    payloadExample: { prompt: 'Summarize current system status' },
    inputSchemaName: 'AiPromptInputSchema',
    outputSchemaName: 'AiPromptOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    handlerDomain: 'ai',
    handlerMethod: 'prompt'
  }
};

function buildCommandMetadata(
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CommandExecutionResult['metadata'] {
  return {
    executedAt: new Date().toISOString(),
    auditSafeMode: getAuditSafeMode(),
    commandTraceId,
    traceId: context.traceId ?? null,
    executionId: context.executionId ?? null,
    capabilityId: context.capabilityId ?? null,
    stepId: context.stepId ?? null,
    source: context.source ?? null
  };
}

function buildHandlerContext(
  definition: RoutedCommandDefinition,
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CefHandlerContext {
  return {
    ...context,
    command: definition.name,
    commandTraceId,
    domain: definition.handlerDomain,
    handlerMethod: definition.handlerMethod
  };
}

function buildFailureResult(
  definition: RoutedCommandDefinition,
  error: ReturnType<typeof buildCommandError>,
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CommandExecutionResult {
  return {
    success: false,
    command: definition.name,
    message: error.message,
    output: null,
    error,
    metadata: buildCommandMetadata(commandTraceId, context)
  };
}

function buildSuccessResult<TOutput extends Record<string, unknown>>(
  definition: RoutedCommandDefinition,
  message: string,
  output: TOutput,
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CommandExecutionResult<TOutput> {
  return {
    success: true,
    command: definition.name,
    message,
    output,
    error: null,
    metadata: buildCommandMetadata(commandTraceId, context)
  };
}

async function routeCommandToHandler(
  definition: RoutedCommandDefinition,
  payload: Record<string, unknown>,
  handlerContext: CefHandlerContext
) {
  switch (definition.handlerDomain) {
    case 'audit-safe':
      return dispatchAuditSafeHandler(definition.handlerMethod, payload, handlerContext);
    case 'ai':
      return dispatchAiHandler(definition.handlerMethod, payload, handlerContext);
    default:
      //audit Assumption: every registered command must resolve to a supported handler domain; failure risk: command metadata drifts from the real handler registry and silently bypasses dispatch; expected invariant: all `handlerDomain` values are routed explicitly; handling strategy: fail closed with a typed internal-routing error.
      return {
        success: false,
        message: 'Command handler domain is not wired to the CEF router.',
        output: null,
        error: buildCommandError('UNSUPPORTED_HANDLER_DOMAIN', 'Command handler domain is not wired to the CEF router.', {
          handlerDomain: definition.handlerDomain,
          command: definition.name
        }),
        fallbackUsed: false,
        fallbackReason: null
      };
  }
}

/**
 * Execute one typed CEF command with handler whitelisting, schema validation, and boundary tracing.
 *
 * Purpose:
 * - Enforce the CEF boundary so planner/capability callers dispatch only registered commands through explicit handler modules.
 *
 * Inputs/outputs:
 * - Input: command name, raw payload, and optional tracing context.
 * - Output: structured success or failure result with command metadata.
 *
 * Edge case behavior:
 * - Unsupported commands, blocked handler methods, invalid payloads, invalid outputs, and fallback paths all remain typed and observable.
 */
export async function executeCommand(
  command: CommandName,
  payload: Record<string, unknown> = {},
  context: CommandExecutionContext = {}
): Promise<CommandExecutionResult> {
  const commandTraceId = generateRequestId('cef');
  const definition = COMMAND_DEFINITIONS[command];

  //audit Assumption: planner/capability callers may only target declared CEF commands; failure risk: a fabricated command name reaches the handler layer and bypasses routing guarantees; expected invariant: every dispatched command exists in `COMMAND_DEFINITIONS`; handling strategy: reject unknown commands before handler routing and trace the rejection.
  if (!definition) {
    const unsupportedError = buildCommandError('UNSUPPORTED_COMMAND', 'Unsupported command.', {
      payloadKeys: Object.keys(payload ?? {})
    });
    await traceCefBoundary('warn', 'cef.command.rejected', {
      command,
      commandTraceId,
      domain: 'unknown',
      handlerMethod: 'unknown',
      ...context
    }, {
      reason: unsupportedError.code
    });
    return {
      success: false,
      command,
      message: unsupportedError.message,
      output: null,
      error: unsupportedError,
      metadata: buildCommandMetadata(commandTraceId, context)
    };
  }

  const handlerContext = buildHandlerContext(definition, commandTraceId, context);
  await traceCefBoundary('info', 'cef.command.started', handlerContext, {
    payloadKeys: Object.keys(payload ?? {}),
    handlerDomain: definition.handlerDomain
  });

  const handlerResult = await routeCommandToHandler(definition, payload, handlerContext);

  //audit Assumption: command-level success should reflect the normalized handler result instead of duplicating handler internals; failure risk: command and handler traces disagree on success/failure; expected invariant: command completion mirrors handler completion exactly; handling strategy: emit command completion or failure after handler dispatch resolves.
  if (!handlerResult.success || !handlerResult.output) {
    const error = handlerResult.error ?? buildCommandError('COMMAND_HANDLER_FAILED', handlerResult.message);
    await traceCefBoundary('warn', 'cef.command.failed', handlerContext, {
      error: error.message,
      fallbackUsed: handlerResult.fallbackUsed,
      fallbackReason: handlerResult.fallbackReason
    });
    return buildFailureResult(definition, error, commandTraceId, context);
  }

  await traceCefBoundary('info', 'cef.command.completed', handlerContext, {
    fallbackUsed: handlerResult.fallbackUsed,
    fallbackReason: handlerResult.fallbackReason,
    outputKeys: Object.keys(handlerResult.output)
  });

  return buildSuccessResult(
    definition,
    handlerResult.message,
    handlerResult.output,
    commandTraceId,
    context
  );
}

/**
 * List registered CEF commands and their schema metadata.
 *
 * Purpose:
 * - Expose the supported command surface to API routes, diagnostics, and tests.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: stable command metadata records sorted by command name.
 *
 * Edge case behavior:
 * - Returns the static registry directly; no fallback commands are invented at runtime.
 */
export function listAvailableCommands(): CommandDefinition[] {
  return Object.values(COMMAND_DEFINITIONS)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(definition => ({
      ...definition
    }));
}

export default {
  executeCommand,
  listAvailableCommands
};
