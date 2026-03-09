import { z } from 'zod';
import { sanitizeInput } from '@platform/runtime/security.js';
import { createCentralizedCompletion, generateMockResponse, hasValidAPIKey } from '@services/openai.js';
import { dispatchValidatedHandler, enforceAllowedHandlerMethod } from '../handlerRuntime.js';
import type { CefHandlerContext, WhitelistedHandlerDispatchResult } from '../types.js';
import { buildCommandError } from '../commandErrors.js';

export const AiPromptInputSchema = z.object({
  prompt: z.string().trim().min(1)
});

export const AiPromptOutputSchema = z.object({
  result: z.unknown().nullable(),
  meta: z.record(z.unknown()).optional(),
  fallback: z.boolean().optional(),
  usage: z.unknown().nullable().optional(),
  model: z.string().optional(),
  streaming: z.boolean().optional()
});

export const allowedHandlers = ['prompt'] as const;

export type AiHandlerMethod = (typeof allowedHandlers)[number];

function buildMissingApiKeyError(): Error {
  const error = new Error('OpenAI API key not configured.');
  (error as Error & { code?: string }).code = 'OPENAI_API_KEY_MISSING';
  return error;
}

/**
 * Dispatch one whitelisted AI handler method.
 *
 * Purpose:
 * - Route AI CEF commands through explicit handler allow-lists, schema validation, and fallback-aware tracing.
 *
 * Inputs/outputs:
 * - Input: handler method name, raw payload, and CEF handler context.
 * - Output: structured handler dispatch result.
 *
 * Edge case behavior:
 * - Uses a traced fallback mock response when the OpenAI API key is unavailable instead of silently returning ad-hoc data.
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

  switch (method as AiHandlerMethod) {
    case 'prompt':
      return dispatchValidatedHandler(rawPayload, context, {
        inputSchemaName: 'AiPromptInputSchema',
        outputSchemaName: 'AiPromptOutputSchema',
        inputSchema: AiPromptInputSchema,
        outputSchema: AiPromptOutputSchema,
        async invokeValidatedMethod(payload) {
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
        async invokeFallback(payload) {
          const sanitizedPrompt = sanitizeInput(payload.prompt);
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
      });
    default:
      //audit Assumption: whitelist enforcement makes the default branch unreachable; failure risk: a future method addition forgets to wire a dispatcher branch; expected invariant: every allowed handler has an explicit case; handling strategy: fail closed with a typed internal mapping error.
      return {
        success: false,
        message: 'AI handler method is not wired to a dispatcher branch.',
        output: null,
        error: buildCommandError('HANDLER_METHOD_NOT_IMPLEMENTED', 'AI handler method is not wired to a dispatcher branch.', {
          method
        }),
        fallbackUsed: false,
        fallbackReason: null
      };
  }
}
