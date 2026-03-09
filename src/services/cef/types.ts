/**
 * Shared CEF command and handler types.
 */

export type CommandName = 'audit-safe:set-mode' | 'audit-safe:interpret' | 'ai:prompt';

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
  httpStatusCode: number;
  details?: Record<string, unknown>;
}

export interface CommandExecutionMetadata {
  executedAt: string;
  auditSafeMode: string;
  commandTraceId: string;
  traceId: string | null;
  executionId: string | null;
  capabilityId: string | null;
  stepId: string | null;
  source: string | null;
}

export interface CommandExecutionResult<TOutput = Record<string, unknown> | null> {
  success: boolean;
  command: CommandName;
  message: string;
  output: TOutput | null;
  error: CommandExecutionError | null;
  metadata: CommandExecutionMetadata;
}

export interface CommandDefinition {
  name: CommandName;
  description: string;
  requiresConfirmation: boolean;
  payloadExample?: Record<string, unknown>;
  inputSchemaName: string;
  outputSchemaName: string;
  errorSchemaName: string;
  handlerDomain: string;
  handlerMethod: string;
}

export interface CefHandlerContext extends CommandExecutionContext {
  command: CommandName;
  commandTraceId: string;
  domain: string;
  handlerMethod: string;
}

export interface ValidatedHandlerOutcome<TOutput extends Record<string, unknown>> {
  message: string;
  output: TOutput;
}

export interface WhitelistedHandlerDispatchResult<TOutput extends Record<string, unknown>> {
  success: boolean;
  message: string;
  output: TOutput | null;
  error: CommandExecutionError | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface CefHandlerRetryPolicy {
  maxAttempts: number;
  shouldRetry?: (error: unknown, attemptNumber: number) => boolean;
}

export type CefTraceStatus =
  | 'start'
  | 'success'
  | 'error'
  | 'fallback'
  | 'retry'
  | 'rejected';
