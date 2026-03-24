import { sanitizeInput } from '@platform/runtime/security.js';
import { createCentralizedCompletion, generateMockResponse, hasValidAPIKey } from '@services/openai.js';
import { dispatchValidatedHandler, enforceAllowedHandlerMethod } from '../handlerRuntime.js';
import type { CefHandlerContext, WhitelistedHandlerDispatchResult } from '../types.js';
import { buildCommandError } from '../commandErrors.js';

interface AiPromptPayload extends Record<string, unknown> {
  prompt: string;
}

interface AiPromptOutput extends Record<string, unknown> {
  result: unknown | null;
  meta?: Record<string, unknown>;
  fallback?: boolean;
  usage?: unknown | null;
  model?: string;
  streaming?: boolean;
}

interface RetryableError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
}

type AiHandlerActionDefinition = {
  inputSchemaName: 'AiPromptInputSchema';
  outputSchemaName: 'AiPromptOutputSchema';
  errorSchemaName: 'CommandErrorSchema';
  retryPolicy: {
    maxAttempts: number;
    shouldRetry(error: unknown, attemptNumber: number): boolean;
  };
  invokeValidatedMethod: (
    payload: AiPromptPayload,
    context: CefHandlerContext
  ) => Promise<{ message: string; output: AiPromptOutput }>;
  invokeFallback: (
    payload: AiPromptPayload,
    context: CefHandlerContext
  ) => Promise<{ message: string; output: AiPromptOutput }>;
};

function buildMissingApiKeyError(): RetryableError {
  const error = new Error('OpenAI API key not configured.') as RetryableError;
  error.code = 'OPENAI_API_KEY_MISSING';
  return error;
}

function isRetryableAiError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as RetryableError;
  const normalizedMessage = error.message.toLowerCase();
  const normalizedCode = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  const statusCode = typeof candidate.statusCode === 'number'
    ? candidate.statusCode
    : typeof candidate.status === 'number'
      ? candidate.status
      : null;

  //audit Assumption: credential gaps should use the explicit fallback path instead of retrying; failure risk: repeated retries hide a deterministic configuration error; expected invariant: missing-api-key errors never schedule retries; handling strategy: short-circuit before any transient error checks.
  if (normalizedCode === 'openai_api_key_missing') {
    return false;
  }

  return Boolean(
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 429 ||
    (statusCode !== null && statusCode >= 500) ||
    normalizedCode.includes('timeout') ||
    normalizedCode.includes('tempor') ||
    normalizedCode.includes('rate') ||
    normalizedCode.includes('retry') ||
    normalizedCode.includes('econnreset') ||
    normalizedCode.includes('etimedout') ||
    normalizedMessage.includes('timeout') ||
    normalizedMessage.includes('tempor') ||
    normalizedMessage.includes('rate limit') ||
    normalizedMessage.includes('connection reset') ||
    normalizedMessage.includes('network')
  );
}

const allowedHandlerActions = {
  prompt: {
    inputSchemaName: 'AiPromptInputSchema',
    outputSchemaName: 'AiPromptOutputSchema',
    errorSchemaName: 'CommandErrorSchema',
    retryPolicy: {
      maxAttempts: 2,
      shouldRetry(error: unknown) {
        return isRetryableAiError(error);
      }
    },
    async invokeValidatedMethod(payload: AiPromptPayload) {
      const sanitizedPrompt = sanitizeInput(payload.prompt);

      //audit Assumption: live OpenAI execution should happen only when credentials are present; failure risk: handler silently degrades without a traceable reason; expected invariant: missing credentials trigger the explicit fallback path; handling strategy: throw a typed fallback signal and let the shared runtime emit `cef.handler.fallback`.
      if (!hasValidAPIKey()) {
        throw buildMissingApiKeyError();
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
    },
    async invokeFallback(payload: AiPromptPayload) {
      const sanitizedPrompt = sanitizeInput(payload.prompt);
      const mock = generateMockResponse(sanitizedPrompt, 'query');
      return {
        message: 'OpenAI API key not configured - returning mock response.',
        output: {
          result: mock.result,
          meta: mock.meta,
          fallback: true
        }
      };
    }
  }
} as const satisfies Record<string, AiHandlerActionDefinition>;

export const allowedHandlers = Object.freeze(
  Object.keys(allowedHandlerActions)
) as ReadonlyArray<keyof typeof allowedHandlerActions>;

export type AiHandlerMethod = keyof typeof allowedHandlerActions;

/**
 * Dispatch one whitelisted AI handler action.
 *
 * Purpose:
 * - Route AI CEF commands through explicit action allow-lists, schema validation, retries, and fallback-aware tracing.
 *
 * Inputs/outputs:
 * - Input: handler action name, raw payload, and CEF handler context.
 * - Output: structured handler dispatch result.
 *
 * Edge case behavior:
 * - Uses a traced fallback mock response when credentials are unavailable instead of silently returning ad-hoc data.
 */
export async function dispatchAiHandler(
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

  const actionDefinition = allowedHandlerActions[method as AiHandlerMethod];

  //audit Assumption: whitelist enforcement guarantees an action definition exists; failure risk: an allowed action key is added without a dispatch config and silently bypasses the handler; expected invariant: every allowlisted action resolves to one config entry; handling strategy: fail closed with a typed internal mapping error.
  if (!actionDefinition) {
    return {
      success: false,
      message: 'AI handler action is not wired to a dispatcher mapping.',
      output: null,
      error: buildCommandError('HANDLER_ACTION_NOT_IMPLEMENTED', 'AI handler action is not wired to a dispatcher mapping.', {
        action: method
      }),
      fallbackUsed: false,
      fallbackReason: null
    };
  }

  return dispatchValidatedHandler<AiPromptPayload, AiPromptOutput>(
    rawPayload,
    context,
    actionDefinition
  );
}
