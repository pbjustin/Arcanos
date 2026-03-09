import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { buildCommandError } from './commandErrors.js';
import { traceCefBoundary } from './boundaryTrace.js';
import { validateCefSchema } from './schemaRegistry.js';
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
  errorSchemaName: string;
  invokeValidatedMethod: (
    payload: TInput,
    context: CefHandlerContext
  ) => Promise<ValidatedHandlerOutcome<TOutput>>;
  invokeFallback?: (
    payload: TInput,
    context: CefHandlerContext,
    error: CommandExecutionError
  ) => Promise<ValidatedHandlerOutcome<TOutput>>;
  retryPolicy?: CefHandlerRetryPolicy;
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

function buildHandlerFailureError(error: unknown, details?: Record<string, unknown>): CommandExecutionError {
  const errorMessage = resolveErrorMessage(error, 'Handler execution failed.');
  return buildCommandError('COMMAND_HANDLER_FAILED', errorMessage, details);
}

async function validateHandlerOutput<TOutput extends Record<string, unknown>>(
  outcome: ValidatedHandlerOutcome<TOutput>,
  context: CefHandlerContext,
  outputSchemaName: string,
  errorSchemaName: string,
  phase: 'primary' | 'fallback'
): Promise<WhitelistedHandlerDispatchResult<TOutput>> {
  const parsedOutput = validateCefSchema<TOutput>(outputSchemaName, outcome.output);

  //audit Assumption: handler output must remain schema-stable before crossing the CEF boundary; failure risk: API callers receive malformed output even though a handler "succeeded"; expected invariant: every handler response conforms to its declared output schema; handling strategy: reject invalid outputs with a typed error and an explicit schema trace.
  if (!parsedOutput.success || !parsedOutput.data) {
    const invalidOutputError = buildCommandError('INVALID_HANDLER_OUTPUT', 'Handler output failed schema validation.', {
      schemaName: outputSchemaName,
      issues: parsedOutput.issues
    });
    const validatedError = validateCefSchema<CommandExecutionError>(errorSchemaName, invalidOutputError);
    const normalizedError = validatedError.success && validatedError.data
      ? validatedError.data
      : buildCommandError('COMMAND_ERROR_SCHEMA_INVALID', 'Command error payload violated the declared schema.');

    await traceCefBoundary('error', 'cef.schema.invalid_output', context, {
      status: 'error',
      errorCode: normalizedError.code,
      fallbackUsed: phase === 'fallback',
      retryCount: 0,
      metadata: {
        phase,
        schemaName: outputSchemaName,
        issueCount: parsedOutput.issues.length,
        issues: parsedOutput.issues
      }
    });
    return buildFailureDispatchResult(normalizedError, phase === 'fallback', normalizedError.message);
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
 * - Fail closed when a caller asks a CEF handler module to execute an undeclared action.
 *
 * Inputs/outputs:
 * - Input: requested handler action, allowed action list, and trace context.
 * - Output: `null` when allowed or a typed error when blocked.
 *
 * Edge case behavior:
 * - Emits `cef.handler.error` for blocked actions so unauthorized handler access is observable.
 */
export async function enforceAllowedHandlerMethod(
  method: string,
  allowedHandlers: readonly string[],
  context: CefHandlerContext
): Promise<CommandExecutionError | null> {
  //audit Assumption: handler modules must reject undeclared actions before payload validation or side effects; failure risk: ad-hoc action names bypass architectural controls; expected invariant: only actions in `allowedHandlers` are reachable; handling strategy: block unknown actions with a typed error and boundary trace.
  if (allowedHandlers.includes(method)) {
    return null;
  }

  const blockedMethodError = buildCommandError(
    'HANDLER_ACTION_NOT_ALLOWED',
    'Handler action is not allowed.',
    {
      attemptedAction: method,
      allowedHandlers: [...allowedHandlers]
    },
    403
  );
  await traceCefBoundary('error', 'cef.handler.error', context, {
    status: 'error',
    errorCode: blockedMethodError.code,
    fallbackUsed: false,
    retryCount: 0,
    metadata: {
      attemptedAction: method,
      allowedHandlers: [...allowedHandlers]
    }
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
 * - Invalid payloads fail fast, retries emit explicit retry events, and fallback execution is traced separately from primary handler failures.
 */
export async function dispatchValidatedHandler<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>
>(
  rawPayload: Record<string, unknown>,
  context: CefHandlerContext,
  options: ValidatedHandlerOptions<TInput, TOutput>
): Promise<WhitelistedHandlerDispatchResult<TOutput>> {
  const parsedInput = validateCefSchema<TInput>(options.inputSchemaName, rawPayload ?? {});

  //audit Assumption: payload validation must happen before any handler code runs; failure risk: invalid shapes reach DB, queue, or external API logic through CEF handlers; expected invariant: only schema-valid payloads execute; handling strategy: reject invalid input with a typed error and a schema trace event.
  if (!parsedInput.success || !parsedInput.data) {
    const invalidPayloadError = buildCommandError('INVALID_COMMAND_PAYLOAD', 'Command payload failed schema validation.', {
      schemaName: options.inputSchemaName,
      issues: parsedInput.issues
    });
    const validatedError = validateCefSchema<CommandExecutionError>(options.errorSchemaName, invalidPayloadError);
    const normalizedError = validatedError.success && validatedError.data
      ? validatedError.data
      : buildCommandError('COMMAND_ERROR_SCHEMA_INVALID', 'Command error payload violated the declared schema.');

    await traceCefBoundary('warn', 'cef.schema.invalid_payload', context, {
      status: 'error',
      errorCode: normalizedError.code,
      fallbackUsed: false,
      retryCount: 0,
      metadata: {
        schemaName: options.inputSchemaName,
        issueCount: parsedInput.issues.length,
        issues: parsedInput.issues
      }
    });
    return buildFailureDispatchResult(normalizedError);
  }

  const retryPolicy = resolveRetryPolicy(options.retryPolicy);
  let attemptNumber = 1;

  while (attemptNumber <= retryPolicy.maxAttempts) {
    const attemptStartedAtMs = Date.now();
    await traceCefBoundary('info', 'cef.handler.start', context, {
      status: 'start',
      startedAtMs: attemptStartedAtMs,
      fallbackUsed: false,
      retryCount: attemptNumber - 1,
      metadata: {
        attemptNumber,
        maxAttempts: retryPolicy.maxAttempts,
        payloadKeys: Object.keys(parsedInput.data)
      }
    });

    try {
      const primaryOutcome = await options.invokeValidatedMethod(parsedInput.data, context);
      const validatedPrimaryOutput = await validateHandlerOutput(
        primaryOutcome,
        context,
        options.outputSchemaName,
        options.errorSchemaName,
        'primary'
      );

      //audit Assumption: only fully validated handler results should emit success traces; failure risk: malformed outputs appear successful in observability; expected invariant: `cef.handler.success` follows successful output validation only; handling strategy: emit success trace after output validation and return the normalized result.
      if (validatedPrimaryOutput.success) {
        await traceCefBoundary('info', 'cef.handler.success', context, {
          status: 'success',
          startedAtMs: attemptStartedAtMs,
          fallbackUsed: false,
          retryCount: attemptNumber - 1,
          metadata: {
            attemptNumber,
            maxAttempts: retryPolicy.maxAttempts,
            outputKeys: Object.keys(validatedPrimaryOutput.output ?? {})
          }
        });
      }

      return validatedPrimaryOutput;
    } catch (error: unknown) {
      const handlerError = buildHandlerFailureError(error, {
        attemptNumber,
        maxAttempts: retryPolicy.maxAttempts
      });
      const shouldRetry = attemptNumber < retryPolicy.maxAttempts &&
        (retryPolicy.shouldRetry?.(error, attemptNumber) ?? false);

      await traceCefBoundary('error', 'cef.handler.error', context, {
        status: 'error',
        startedAtMs: attemptStartedAtMs,
        errorCode: handlerError.code,
        fallbackUsed: false,
        retryCount: attemptNumber - 1,
        metadata: {
          attemptNumber,
          maxAttempts: retryPolicy.maxAttempts,
          willRetry: shouldRetry,
          error: handlerError.message
        }
      });

      //audit Assumption: retries should only occur when explicitly requested by the handler policy; failure risk: hidden duplicate side effects or silent retry storms; expected invariant: each retry decision is deterministic and observable; handling strategy: continue only when `shouldRetry` explicitly opts in and attempts remain.
      if (shouldRetry) {
        await traceCefBoundary('warn', 'cef.handler.retry', context, {
          status: 'retry',
          startedAtMs: attemptStartedAtMs,
          errorCode: handlerError.code,
          fallbackUsed: false,
          retryCount: attemptNumber,
          metadata: {
            attemptNumber,
            nextAttemptNumber: attemptNumber + 1,
            maxAttempts: retryPolicy.maxAttempts
          }
        });
        attemptNumber += 1;
        continue;
      }

      if (options.invokeFallback) {
        const fallbackStartedAtMs = Date.now();
        await traceCefBoundary('warn', 'cef.handler.fallback', context, {
          status: 'fallback',
          startedAtMs: fallbackStartedAtMs,
          errorCode: handlerError.code,
          fallbackUsed: true,
          retryCount: attemptNumber - 1,
          metadata: {
            attemptNumber,
            maxAttempts: retryPolicy.maxAttempts,
            reason: handlerError.message
          }
        });

        try {
          const fallbackOutcome = await options.invokeFallback(parsedInput.data, context, handlerError);
          const validatedFallbackOutput = await validateHandlerOutput(
            fallbackOutcome,
            context,
            options.outputSchemaName,
            options.errorSchemaName,
            'fallback'
          );

          if (validatedFallbackOutput.success) {
            await traceCefBoundary('info', 'cef.handler.success', context, {
              status: 'success',
              startedAtMs: fallbackStartedAtMs,
              fallbackUsed: true,
              retryCount: attemptNumber - 1,
              metadata: {
                attemptNumber,
                maxAttempts: retryPolicy.maxAttempts,
                outputKeys: Object.keys(validatedFallbackOutput.output ?? {})
              }
            });
          }

          return validatedFallbackOutput;
        } catch (fallbackError: unknown) {
          const normalizedFallbackError = buildHandlerFailureError(fallbackError, {
            phase: 'fallback',
            attemptNumber,
            maxAttempts: retryPolicy.maxAttempts
          });
          await traceCefBoundary('error', 'cef.handler.error', context, {
            status: 'error',
            startedAtMs: fallbackStartedAtMs,
            errorCode: normalizedFallbackError.code,
            fallbackUsed: true,
            retryCount: attemptNumber - 1,
            metadata: {
              phase: 'fallback',
              attemptNumber,
              maxAttempts: retryPolicy.maxAttempts,
              error: normalizedFallbackError.message
            }
          });
          return buildFailureDispatchResult(normalizedFallbackError, true, normalizedFallbackError.message);
        }
      }

      return buildFailureDispatchResult(handlerError);
    }
  }

  const exhaustedRetryError = buildCommandError(
    'COMMAND_HANDLER_FAILED',
    'Handler exhausted retry policy without producing a terminal result.'
  );
  await traceCefBoundary('error', 'cef.handler.error', context, {
    status: 'error',
    errorCode: exhaustedRetryError.code,
    fallbackUsed: false,
    retryCount: retryPolicy.maxAttempts,
    metadata: {
      phase: 'retry-exhausted',
      maxAttempts: retryPolicy.maxAttempts
    }
  });
  return buildFailureDispatchResult(exhaustedRetryError);
}
