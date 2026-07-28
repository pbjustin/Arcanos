import { getAuditSafeMode } from '@services/auditSafeToggle.js';
import { generateRequestId } from '@shared/idGenerator.js';
import { traceCefBoundary } from './cef/boundaryTrace.js';
import { buildCommandError } from './cef/commandErrors.js';
import {
  assertCefSchemaRegistered,
  listRegisteredCommandSchemaCoverage,
  validateCefSchema
} from './cef/schemaRegistry.js';
import { dispatchWhitelistedCefHandler } from './cef/handlers/index.js';
import { consumeCefExecutionPermit } from './cef/executionPermit.js';
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

export type CommandExecutionValidationResult =
  | {
      ok: true;
      command: CommandName;
      payload: Record<string, unknown>;
    }
  | {
      ok: false;
      errorCode: 'INVALID_COMMAND_PAYLOAD' | 'UNSUPPORTED_COMMAND';
    };

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

function assertCommandDefinitionSchemasRegistered(): void {
  for (const definition of Object.values(COMMAND_DEFINITIONS)) {
    //audit Assumption: every public CEF command must declare registered input, output, and error schemas; failure risk: handlers execute without runtime validation coverage; expected invariant: command registration fails when any declared schema is missing; handling strategy: assert each schema name during command-center initialization and access.
    assertCefSchemaRegistered(definition.inputSchemaName);
    assertCefSchemaRegistered(definition.outputSchemaName);
    assertCefSchemaRegistered(definition.errorSchemaName);
  }
}

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
  const { executionPermit: _executionPermit, ...safeContext } = context;
  return {
    ...safeContext,
    command: definition.name,
    commandTraceId,
    domain: definition.handlerDomain,
    handlerMethod: definition.handlerMethod
  };
}

function buildUnsupportedCommandContext(
  command: string,
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CefHandlerContext {
  return {
    ...context,
    command: command as CommandName,
    commandTraceId,
    domain: 'unknown',
    handlerMethod: 'unknown'
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
  return dispatchWhitelistedCefHandler(definition, payload, handlerContext);
}

/**
 * Validate command identity and payload without executing handler code.
 *
 * HTTP callers use this inspection before issuing confirmation challenges so
 * malformed or unsupported requests keep their existing 400 semantics.
 */
export function validateCommandForExecution(
  command: string,
  payload: Record<string, unknown> = {}
): CommandExecutionValidationResult {
  assertCommandDefinitionSchemasRegistered();
  const definition = COMMAND_DEFINITIONS[command as CommandName];
  if (!definition) {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_COMMAND',
    };
  }

  const parsedPayload = validateCefSchema<Record<string, unknown>>(
    definition.inputSchemaName,
    payload
  );
  if (!parsedPayload.success || !parsedPayload.data) {
    return {
      ok: false,
      errorCode: 'INVALID_COMMAND_PAYLOAD',
    };
  }

  return {
    ok: true,
    command: definition.name,
    payload: Object.freeze({
      ...parsedPayload.data,
    }),
  };
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
 * - Unsupported commands, blocked handler actions, invalid payloads, invalid outputs, retries, and fallback paths all remain typed and observable.
 */
export async function executeCommand(
  command: CommandName,
  payload: Record<string, unknown> = {},
  context: CommandExecutionContext = {}
): Promise<CommandExecutionResult> {
  assertCommandDefinitionSchemasRegistered();

  const commandTraceId = generateRequestId('cef');
  const definition = COMMAND_DEFINITIONS[command];
  const dispatchStartedAtMs = Date.now();

  //audit Assumption: planner/capability callers may only target declared CEF commands; failure risk: a fabricated command name reaches the handler layer and bypasses routing guarantees; expected invariant: every dispatched command exists in `COMMAND_DEFINITIONS`; handling strategy: reject unknown commands before handler routing and trace the rejection.
  if (!definition) {
    const unsupportedError = buildCommandError('UNSUPPORTED_COMMAND', 'Unsupported command.', {
      payloadKeys: Object.keys(payload ?? {})
    });
    await traceCefBoundary('warn', 'cef.dispatch.rejected', buildUnsupportedCommandContext(command, commandTraceId, context), {
      status: 'rejected',
      startedAtMs: dispatchStartedAtMs,
      errorCode: unsupportedError.code,
      fallbackUsed: false,
      retryCount: 0,
      metadata: {
        payloadKeys: Object.keys(payload ?? {})
      }
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
  const parsedPayload = validateCefSchema<Record<string, unknown>>(
    definition.inputSchemaName,
    payload
  );
  if (!parsedPayload.success || !parsedPayload.data) {
    const invalidPayloadError = buildCommandError(
      'INVALID_COMMAND_PAYLOAD',
      'Command payload failed schema validation.',
      {
        schemaName: definition.inputSchemaName,
        issues: parsedPayload.issues,
      }
    );
    await traceCefBoundary(
      'warn',
      'cef.schema.invalid_payload',
      handlerContext,
      {
        status: 'error',
        errorCode: invalidPayloadError.code,
        fallbackUsed: false,
        retryCount: 0,
        metadata: {
          schemaName: definition.inputSchemaName,
          issueCount: parsedPayload.issues.length,
          issues: parsedPayload.issues,
        },
      }
    );
    return buildFailureResult(
      definition,
      invalidPayloadError,
      commandTraceId,
      context
    );
  }

  if (
    definition.requiresConfirmation
    && !consumeCefExecutionPermit(
      context.executionPermit,
      definition.name,
      parsedPayload.data,
      context
    )
  ) {
    const confirmationError = buildCommandError(
      'CONFIRMATION_REQUIRED',
      'Command execution requires a consumed one-use confirmation permit.',
      {
        command: definition.name,
      }
    );
    await traceCefBoundary(
      'warn',
      'cef.dispatch.rejected',
      handlerContext,
      {
        status: 'rejected',
        startedAtMs: dispatchStartedAtMs,
        errorCode: confirmationError.code,
        fallbackUsed: false,
        retryCount: 0,
        metadata: {
          confirmationRequired: true,
        },
      }
    );
    return buildFailureResult(
      definition,
      confirmationError,
      commandTraceId,
      context
    );
  }

  await traceCefBoundary('info', 'cef.dispatch.start', handlerContext, {
    status: 'start',
    startedAtMs: dispatchStartedAtMs,
    fallbackUsed: false,
    retryCount: 0,
    metadata: {
      payloadKeys: Object.keys(payload ?? {}),
      handlerDomain: definition.handlerDomain
    }
  });

  const handlerResult = await routeCommandToHandler(
    definition,
    parsedPayload.data,
    handlerContext
  );

  //audit Assumption: command-level success should reflect the normalized handler result instead of duplicating handler internals; failure risk: command and handler traces disagree on success/failure; expected invariant: command completion mirrors handler completion exactly; handling strategy: emit command completion or failure after handler dispatch resolves.
  if (!handlerResult.success || !handlerResult.output) {
    const error = handlerResult.error ?? buildCommandError('COMMAND_HANDLER_FAILED', handlerResult.message);
    await traceCefBoundary('warn', 'cef.dispatch.error', handlerContext, {
      status: 'error',
      startedAtMs: dispatchStartedAtMs,
      errorCode: error.code,
      fallbackUsed: handlerResult.fallbackUsed,
      retryCount: 0,
      metadata: {
        error: error.message,
        fallbackReason: handlerResult.fallbackReason
      }
    });
    return buildFailureResult(definition, error, commandTraceId, context);
  }

  await traceCefBoundary('info', 'cef.dispatch.success', handlerContext, {
    status: 'success',
    startedAtMs: dispatchStartedAtMs,
    fallbackUsed: handlerResult.fallbackUsed,
    retryCount: 0,
    metadata: {
      fallbackReason: handlerResult.fallbackReason,
      outputKeys: Object.keys(handlerResult.output)
    }
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
  assertCommandDefinitionSchemasRegistered();

  return Object.values(COMMAND_DEFINITIONS)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(definition => ({
      ...definition
    }));
}

/**
 * List per-command schema coverage for the registered CEF surface.
 *
 * Purpose:
 * - Expose deterministic schema coverage for tests, diagnostics, and final verification output.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: command-to-schema coverage map.
 *
 * Edge case behavior:
 * - Returns only registered command coverage and throws if command definitions reference missing schemas.
 */
export function listCommandSchemaCoverage(): Record<string, {
  inputSchemaName: string;
  outputSchemaName: string;
  errorSchemaName: string;
}> {
  assertCommandDefinitionSchemasRegistered();
  return listRegisteredCommandSchemaCoverage();
}

export default {
  executeCommand,
  listAvailableCommands,
  listCommandSchemaCoverage
};
