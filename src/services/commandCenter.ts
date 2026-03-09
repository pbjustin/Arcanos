import { z } from 'zod';
import { sanitizeInput } from '@platform/runtime/security.js';
import { createCentralizedCompletion, generateMockResponse, hasValidAPIKey } from './openai.js';
import { getAuditSafeMode, interpretCommand, setAuditSafeMode } from './auditSafeToggle.js';
import { extractTextPrompt } from '@transport/http/payloadNormalization.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { logExecution } from '@core/db/repositories/executionLogRepository.js';
import { generateRequestId } from '@shared/idGenerator.js';

export type CommandName = 'audit-safe:set-mode' | 'audit-safe:interpret' | 'ai:prompt';

const VALID_AUDIT_MODES = ['true', 'false', 'passive', 'log-only'] as const;
const CommandErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  details: z.record(z.unknown()).optional()
});

const AuditSafeSetModeInputSchema = z.object({
  mode: z.enum(VALID_AUDIT_MODES)
});
const AuditSafeSetModeOutputSchema = z.object({
  mode: z.enum(VALID_AUDIT_MODES)
});

const AuditSafeInterpretInputSchema = z.object({
  instruction: z.string().trim().min(1)
});
const AuditSafeInterpretOutputSchema = z.object({
  instruction: z.string().min(1),
  mode: z.string().min(1)
});

const AiPromptInputSchema = z.object({
  prompt: z.string().trim().min(1)
});
const AiPromptOutputSchema = z.object({
  result: z.unknown().nullable(),
  meta: z.record(z.unknown()).optional(),
  fallback: z.boolean().optional(),
  usage: z.unknown().nullable().optional(),
  model: z.string().optional(),
  streaming: z.boolean().optional()
});

type CommandTraceLevel = 'info' | 'warn' | 'error';

export interface CommandExecutionContext {
  traceId?: string;
  executionId?: string;
  capabilityId?: string;
  stepId?: string;
  source?: string;
}

export interface CommandExecutionError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CommandDefinition {
  name: CommandName;
  description: string;
  requiresConfirmation: boolean;
  payloadExample?: Record<string, unknown>;
  inputSchemaName: string;
  outputSchemaName: string;
  errorSchemaName: string;
}

export interface CommandExecutionResult<TOutput = Record<string, unknown> | null> {
  success: boolean;
  command: CommandName;
  message: string;
  output: TOutput | null;
  error: CommandExecutionError | null;
  metadata: {
    executedAt: string;
    auditSafeMode: string;
    commandTraceId: string;
    traceId: string | null;
    executionId: string | null;
    capabilityId: string | null;
    stepId: string | null;
    source: string | null;
  };
}

interface InternalCommandDefinition<TInput extends Record<string, unknown>, TOutput extends Record<string, unknown>> extends CommandDefinition {
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute(payload: TInput): Promise<{ message: string; output: TOutput }>;
}

type AnyInternalCommandDefinition = InternalCommandDefinition<Record<string, unknown>, Record<string, unknown>>;

function buildCommandMetadata(commandTraceId: string, context: CommandExecutionContext = {}): CommandExecutionResult['metadata'] {
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

function buildCommandError(
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

  //audit Assumption: command errors must always conform to one stable schema for API callers and planners; failure risk: handlers leak ad-hoc error objects that clients cannot classify; expected invariant: every error payload matches `CommandErrorSchema`; handling strategy: fall back to a minimal internal error when validation fails.
  if (!parsedError.success) {
    return {
      code: 'COMMAND_ERROR_SCHEMA_INVALID',
      message: 'Command error payload violated the declared schema.'
    };
  }

  return parsedError.data;
}

function buildFailureResult(
  command: CommandName,
  error: CommandExecutionError,
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CommandExecutionResult {
  return {
    success: false,
    command,
    message: error.message,
    output: null,
    error,
    metadata: buildCommandMetadata(commandTraceId, context)
  };
}

function buildSuccessResult<TOutput extends Record<string, unknown>>(
  command: CommandName,
  message: string,
  output: TOutput,
  commandTraceId: string,
  context: CommandExecutionContext = {}
): CommandExecutionResult<TOutput> {
  return {
    success: true,
    command,
    message,
    output,
    error: null,
    metadata: buildCommandMetadata(commandTraceId, context)
  };
}

async function traceCefBoundary(
  level: CommandTraceLevel,
  message: string,
  command: CommandName,
  commandTraceId: string,
  context: CommandExecutionContext,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await logExecution('cef-boundary', level, message, {
    command,
    commandTraceId,
    traceId: context.traceId ?? null,
    executionId: context.executionId ?? null,
    capabilityId: context.capabilityId ?? null,
    stepId: context.stepId ?? null,
    source: context.source ?? null,
    ...metadata
  });
}

const COMMAND_DEFINITIONS: Record<CommandName, AnyInternalCommandDefinition> = {
  'audit-safe:set-mode': {
    name: 'audit-safe:set-mode',
    description: 'Directly set the Audit-Safe enforcement mode.',
    requiresConfirmation: true,
    payloadExample: { mode: 'true' },
    inputSchemaName: 'AuditSafeSetModeInputSchema',
    outputSchemaName: 'AuditSafeSetModeOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    inputSchema: AuditSafeSetModeInputSchema,
    outputSchema: AuditSafeSetModeOutputSchema,
    async execute(payload) {
      const typedPayload = payload as z.infer<typeof AuditSafeSetModeInputSchema>;
      setAuditSafeMode(typedPayload.mode);
      return {
        message: `Audit-Safe mode set to ${typedPayload.mode}.`,
        output: {
          mode: typedPayload.mode
        }
      };
    }
  },
  'audit-safe:interpret': {
    name: 'audit-safe:interpret',
    description: 'Interpret a natural-language instruction to adjust Audit-Safe mode.',
    requiresConfirmation: true,
    payloadExample: { instruction: 'Enable strict audit safe mode' },
    inputSchemaName: 'AuditSafeInterpretInputSchema',
    outputSchemaName: 'AuditSafeInterpretOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    inputSchema: AuditSafeInterpretInputSchema,
    outputSchema: AuditSafeInterpretOutputSchema,
    async execute(payload) {
      const typedPayload = payload as z.infer<typeof AuditSafeInterpretInputSchema>;
      const instruction = sanitizeInput(typedPayload.instruction);
      await interpretCommand(instruction);
      return {
        message: 'Instruction processed. Audit-Safe mode updated if recognized.',
        output: {
          instruction,
          mode: getAuditSafeMode()
        }
      };
    }
  },
  'ai:prompt': {
    name: 'ai:prompt',
    description: 'Execute an AI command through the centralized OpenAI routing pipeline.',
    requiresConfirmation: true,
    payloadExample: { prompt: 'Summarize current system status' },
    inputSchemaName: 'AiPromptInputSchema',
    outputSchemaName: 'AiPromptOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    inputSchema: AiPromptInputSchema,
    outputSchema: AiPromptOutputSchema,
    async execute(payload) {
      const typedPayload = payload as z.infer<typeof AiPromptInputSchema>;
      const sanitizedPrompt = sanitizeInput(typedPayload.prompt);

      if (!hasValidAPIKey()) {
        const mock = generateMockResponse(sanitizedPrompt, 'ask');
        return {
          message: 'OpenAI API key not configured - returning mock response.',
          output: {
            result: mock.result,
            meta: mock.meta,
            fallback: true
          }
        };
      }

      const response = await createCentralizedCompletion([
        { role: 'user', content: sanitizedPrompt }
      ]);

      if ('choices' in response) {
        const firstChoice = response.choices[0];
        const content = firstChoice?.message?.content ?? '';
        return {
          message: 'AI command executed successfully.',
          output: {
            result: content,
            usage: response.usage ?? null,
            model: response.model
          }
        };
      }

      return {
        message: 'Streaming response started.',
        output: {
          result: null,
          streaming: true
        }
      };
    }
  }
};

/**
 * Execute one typed CEF command with schema validation and boundary tracing.
 *
 * Purpose:
 * - Enforce the CEF boundary so planner/capability callers dispatch only validated commands and every execution is observable.
 *
 * Inputs/outputs:
 * - Input: command name, unknown payload, and optional tracing context.
 * - Output: structured success or failure result validated against the command contract.
 *
 * Edge case behavior:
 * - Unsupported commands, invalid payloads, invalid outputs, and handler failures all return typed error envelopes instead of throwing.
 */
export async function executeCommand(
  command: CommandName,
  payload: Record<string, unknown> = {},
  context: CommandExecutionContext = {}
): Promise<CommandExecutionResult> {
  const commandTraceId = generateRequestId('cef');
  const definition = COMMAND_DEFINITIONS[command];

  //audit Assumption: all planner/capability dispatch must resolve to a registered CEF command; failure risk: callers bypass the command registry and attempt undefined behavior; expected invariant: every dispatched command is present in `COMMAND_DEFINITIONS`; handling strategy: return a typed unsupported-command error and trace it at the boundary.
  if (!definition) {
    const unsupportedError = buildCommandError('UNSUPPORTED_COMMAND', 'Unsupported command.', {
      payloadKeys: Object.keys(payload ?? {})
    });
    await traceCefBoundary('warn', 'cef.command.rejected', command, commandTraceId, context, {
      reason: unsupportedError.code
    });
    return buildFailureResult(command, unsupportedError, commandTraceId, context);
  }

  const parsedInput = definition.inputSchema.safeParse(payload ?? {});

  //audit Assumption: CEF input validation must occur before any handler logic or infrastructure access; failure risk: malformed payloads reach OpenAI, DB-backed toggles, or other side effects; expected invariant: only schema-valid payloads execute handlers; handling strategy: reject invalid inputs with a typed schema error and trace the rejection.
  if (!parsedInput.success) {
    const invalidPayloadError = buildCommandError('INVALID_COMMAND_PAYLOAD', 'Command payload failed schema validation.', {
      issues: parsedInput.error.issues.map(issue => ({
        path: issue.path.join('.') || 'payload',
        message: issue.message
      }))
    });
    await traceCefBoundary('warn', 'cef.command.invalid_payload', command, commandTraceId, context, {
      issueCount: parsedInput.error.issues.length
    });
    return buildFailureResult(command, invalidPayloadError, commandTraceId, context);
  }

  await traceCefBoundary('info', 'cef.command.started', command, commandTraceId, context, {
    payloadKeys: Object.keys(parsedInput.data)
  });

  try {
    const handlerResult = await definition.execute(parsedInput.data);
    const parsedOutput = definition.outputSchema.safeParse(handlerResult.output);

    //audit Assumption: command handlers must not leak ad-hoc output shapes across the CEF boundary; failure risk: planner and API layers receive unstable result contracts; expected invariant: every successful handler output conforms to the declared output schema; handling strategy: convert schema drift into a typed failure instead of returning malformed data.
    if (!parsedOutput.success) {
      const invalidOutputError = buildCommandError('INVALID_COMMAND_OUTPUT', 'Command output failed schema validation.', {
        issues: parsedOutput.error.issues.map(issue => ({
          path: issue.path.join('.') || 'output',
          message: issue.message
        }))
      });
      await traceCefBoundary('error', 'cef.command.invalid_output', command, commandTraceId, context, {
        issueCount: parsedOutput.error.issues.length
      });
      return buildFailureResult(command, invalidOutputError, commandTraceId, context);
    }

    const successResult = buildSuccessResult(
      command,
      handlerResult.message,
      parsedOutput.data,
      commandTraceId,
      context
    );
    await traceCefBoundary('info', 'cef.command.completed', command, commandTraceId, context, {
      outputKeys: Object.keys(parsedOutput.data)
    });
    return successResult;
  } catch (error: unknown) {
    const handlerFailure = buildCommandError('COMMAND_HANDLER_FAILED', resolveErrorMessage(error, 'Command handler failed.'), {
      errorType: error instanceof Error ? error.name : typeof error
    });
    await traceCefBoundary('error', 'cef.command.failed', command, commandTraceId, context, {
      error: handlerFailure.message
    });
    return buildFailureResult(command, handlerFailure, commandTraceId, context);
  }
}

export function listAvailableCommands(): CommandDefinition[] {
  return Object.values(COMMAND_DEFINITIONS).map(definition => ({
    name: definition.name,
    description: definition.description,
    requiresConfirmation: definition.requiresConfirmation,
    payloadExample: definition.payloadExample,
    inputSchemaName: definition.inputSchemaName,
    outputSchemaName: definition.outputSchemaName,
    errorSchemaName: definition.errorSchemaName
  }));
}

export default {
  executeCommand,
  listAvailableCommands
};
