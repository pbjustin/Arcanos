import { z } from 'zod';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { buildCommandError } from './commandErrors.js';
import { traceCefBoundary } from './boundaryTrace.js';
import type {
  CefHandlerContext,
  CefHandlerRetryPolicy,
  CommandExecutionError,
  ValidatedHandlerOutcome,
  WhitelistedHandlerDispatchResult
} from './types.js';

interface ValidatedHandlerOptions<TInput extends Record<string, unknown>, TOutput extends Record<string, unknown>> {
  inputSchemaName: string;
  outputSchemaName: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  invokeValidatedMethod: (
    payload: TInput,
    context: CefHandlerContext
  ) => Promise<ValidatedHandlerOutcome<TOutput>>;
  invokeFallback?: (
    payload: TInput,
    context: CefHandlerContext,
    error: unknown
  ) => Promise<ValidatedHandlerOutcome<TOutput>>;
  retryPolicy?: CefHandlerRetryPolicy;
}

function mapSchemaIssues(
  issues: z.ZodIssue[]
): Array<{ path: string; message: string }> {
  return issues.map(issue => ({
    path: issue.path.join('.') || 'payload',
    message: issue.message
  }));
}

function buildFailureDispatchResult<TOutput extends Record<string, unknown>>(
  error: CommandExecutionError,
  fallbackUsed = false,
  fallbackReason: string | null = null
): WhitelistedHandlerDispatchResult<TOutput> {
  return {
    success: false,
    message: error.message,
    output: null,
    error,
    fallbackUsed,
    fallbackReason
  };
}

function buildSuccessDispatchResult<TOutput extends Record<string, unknown>>(
  outcome: ValidatedHandlerOutcome<TOutput>,
  fallbackUsed = false,
  fallbackReason: string | null = null
): WhitelistedHandlerDispatchResult<TOutput> {
  return {
    success: true,
    message: outcome.message,
    output: outcome.output,
    error: null,
    fallbackUsed,
    fallbackReason
  };
}

function resolveRetryPolicy(
  retryPolicy?: CefHandlerRetryPolicy
): CefHandlerRetryPolicy {
  return retryPolicy ?? {
    maxAttempts: 1
  };
}

async function validateHandlerOutput<TOutput extends Record<string, unknown>>(
  outcome: ValidatedHandlerOutcome<TOutput>,
  context: CefHandlerContext,
  outputSchemaName: string,
  outputSchema: z.ZodType<TOutput>,
  phase: 'primary' | 'fallback'
): Promise<WhitelistedHandlerDispatchResult<TOutput>> {
  const parsedOutput = outputSchema.safeParse(outcome.output);

  //audit Assumption: handler output must remain schema-stable before crossing the CEF boundary; failure risk: API callers receive malformed output even though a handler "succeeded"; expected invariant: every handler response conforms to its declared output schema; handling strategy: reject invalid outputs with a typed error and an explicit schema trace.
  if (!parsedOutput.success) {
    const invalidOutputError = buildCommandError('INVALID_HANDLER_OUTPUT', 'Handler output failed schema validation.', {
      schemaName: outputSchemaName,
      issues: mapSchemaIssues(parsedOutput.error.issues)
    });
    await traceCefBoundary('error', 'cef.schema.invalid_output', context, {
      phase,
      schemaName: outputSchemaName,
      issueCount: parsedOutput.error.issues.length
    });
    return buildFailureDispatchResult(invalidOutputError, phase === 'fallback', invalidOutputError.message);
  }

  return buildSuccessDispatchResult(
    {
      ...outcome,
      output: parsedOutput.data
    },
    phase === 'fallback',
    phase === 'fallback' ? 'fallback_completed' : null
  );
}

/**
 * Enforce a handler-method whitelist before any schema validation or side effects occur.
 *
 * Purpose:
 * - Fail closed when a caller asks a CEF handler module to execute an undeclared method.
 *
 * Inputs/outputs:
 * - Input: requested handler method, allowed method list, and trace context.
 * - Output: `null` when allowed or a typed error when blocked.
 *
 * Edge case behavior:
 * - Emits `cef.handler.error` for blocked methods so unauthorized handler access is observable.
 */
export async function enforceAllowedHandlerMethod(
  method: string,
  allowedHandlers: readonly string[],
  context: CefHandlerContext
): Promise<CommandExecutionError | null> {
  //audit Assumption: handler modules must reject undeclared methods before payload validation or side effects; failure risk: ad-hoc method names bypass architectural controls; expected invariant: only methods in `allowedHandlers` are reachable; handling strategy: block unknown methods with a typed error and boundary trace.
  if (allowedHandlers.includes(method)) {
    return null;
  }

  const blockedMethodError = buildCommandError('HANDLER_METHOD_NOT_ALLOWED', 'Handler method is not whitelisted.', {
    method,
    allowedHandlers: [...allowedHandlers]
  });
  await traceCefBoundary('error', 'cef.handler.error', context, {
    reason: blockedMethodError.code,
    attemptedMethod: method
  });
  return blockedMethodError;
}

/**
 * Run one validated handler method with schema enforcement, retry visibility, and fallback tracing.
 *
 * Purpose:
 * - Centralize payload validation, output validation, retries, and fallback handling for all CEF handlers.
 *
 * Inputs/outputs:
 * - Input: raw payload, typed handler context, and validated handler callbacks.
 * - Output: structured dispatch success/failure result.
 *
 * Edge case behavior:
 * - Invalid payloads fail fast, retries emit attempt metadata on each failure, and fallback execution is traced separately from primary handler failures.
 */
export async function dispatchValidatedHandler<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>
>(
  rawPayload: Record<string, unknown>,
  context: CefHandlerContext,
  options: ValidatedHandlerOptions<TInput, TOutput>
): Promise<WhitelistedHandlerDispatchResult<TOutput>> {
  const parsedInput = options.inputSchema.safeParse(rawPayload ?? {});

  //audit Assumption: payload validation must happen before any handler code runs; failure risk: invalid shapes reach DB, queue, or external API logic through CEF handlers; expected invariant: only schema-valid payloads execute; handling strategy: reject invalid input with a typed error and a schema trace event.
  if (!parsedInput.success) {
    const invalidPayloadError = buildCommandError('INVALID_COMMAND_PAYLOAD', 'Command payload failed schema validation.', {
      schemaName: options.inputSchemaName,
      issues: mapSchemaIssues(parsedInput.error.issues)
    });
    await traceCefBoundary('warn', 'cef.schema.invalid_payload', context, {
      schemaName: options.inputSchemaName,
      issueCount: parsedInput.error.issues.length
    });
    return buildFailureDispatchResult(invalidPayloadError);
  }

  const retryPolicy = resolveRetryPolicy(options.retryPolicy);
  let attemptNumber = 1;

  while (attemptNumber <= retryPolicy.maxAttempts) {
    await traceCefBoundary('info', 'cef.handler.start', context, {
      attemptNumber,
      maxAttempts: retryPolicy.maxAttempts,
      payloadKeys: Object.keys(parsedInput.data)
    });

    try {
      const primaryOutcome = await options.invokeValidatedMethod(parsedInput.data, context);
      const validatedPrimaryOutput = await validateHandlerOutput(
        primaryOutcome,
        context,
        options.outputSchemaName,
        options.outputSchema,
        'primary'
      );

      //audit Assumption: only fully validated handler results should emit success traces; failure risk: malformed outputs appear successful in observability; expected invariant: `cef.handler.success` follows successful output validation only; handling strategy: emit success trace after output validation and return the normalized result.
      if (validatedPrimaryOutput.success) {
        await traceCefBoundary('info', 'cef.handler.success', context, {
          attemptNumber,
          maxAttempts: retryPolicy.maxAttempts,
          outputKeys: Object.keys(validatedPrimaryOutput.output ?? {})
        });
      }

      return validatedPrimaryOutput;
    } catch (error: unknown) {
      const errorMessage = resolveErrorMessage(error, 'Handler execution failed.');
      const shouldRetry = attemptNumber < retryPolicy.maxAttempts &&
        (retryPolicy.shouldRetry?.(error, attemptNumber) ?? false);

      await traceCefBoundary('error', 'cef.handler.error', context, {
        attemptNumber,
        maxAttempts: retryPolicy.maxAttempts,
        willRetry: shouldRetry,
        error: errorMessage
      });

      //audit Assumption: retries should only occur when explicitly requested by the handler policy; failure risk: hidden duplicate side effects or silent retry storms; expected invariant: each retry decision is deterministic and observable; handling strategy: continue only when `shouldRetry` explicitly opts in and attempts remain.
      if (shouldRetry) {
        attemptNumber += 1;
        continue;
      }

      if (options.invokeFallback) {
        try {
          const fallbackOutcome = await options.invokeFallback(parsedInput.data, context, error);
          const validatedFallbackOutput = await validateHandlerOutput(
            fallbackOutcome,
            context,
            options.outputSchemaName,
            options.outputSchema,
            'fallback'
          );

          if (validatedFallbackOutput.success) {
            await traceCefBoundary('warn', 'cef.handler.fallback', context, {
              attemptNumber,
              maxAttempts: retryPolicy.maxAttempts,
              reason: errorMessage,
              outputKeys: Object.keys(validatedFallbackOutput.output ?? {})
            });
            return validatedFallbackOutput;
          }

          return validatedFallbackOutput;
        } catch (fallbackError: unknown) {
          const fallbackErrorMessage = resolveErrorMessage(fallbackError, 'Handler fallback failed.');
          await traceCefBoundary('error', 'cef.handler.error', context, {
            attemptNumber,
            maxAttempts: retryPolicy.maxAttempts,
            phase: 'fallback',
            error: fallbackErrorMessage
          });
          return buildFailureDispatchResult(
            buildCommandError('COMMAND_HANDLER_FAILED', fallbackErrorMessage, {
              phase: 'fallback'
            })
          );
        }
      }

      return buildFailureDispatchResult(
        buildCommandError('COMMAND_HANDLER_FAILED', errorMessage, {
          attemptNumber,
          maxAttempts: retryPolicy.maxAttempts
        })
      );
    }
  }

  const exhaustedRetryError = buildCommandError('COMMAND_HANDLER_FAILED', 'Handler exhausted retry policy without producing a terminal result.');
  await traceCefBoundary('error', 'cef.handler.error', context, {
    phase: 'retry-exhausted',
    maxAttempts: retryPolicy.maxAttempts
  });
  return buildFailureDispatchResult(exhaustedRetryError);
}
