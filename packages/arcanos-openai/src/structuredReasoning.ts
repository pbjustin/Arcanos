import type OpenAI from 'openai';
import {
  callStructuredResponse,
  OpenAIResponseMalformedJsonError,
} from './responses.js';
import type { RuntimeBudget } from '@arcanos/runtime';
import {
  createLinkedAbortController,
  getRequestAbortSignal,
  getRequestRemainingMs,
  isAbortError,
  getSafeRemainingMs,
  RuntimeBudgetExceededError,
  OpenAIAbortError
} from '@arcanos/runtime';

export interface JsonSchemaFormat {
  type: 'json_schema';
  name: string;
  schema: unknown;
  strict?: boolean;
}

export interface StructuredReasoningOptions<T> {
  model: string;
  prompt: string;
  budget: RuntimeBudget;
  schema: { type: 'json_schema' } & Record<string, unknown>;
  validate: (value: unknown) => value is T;
  extractRefusal?: (response: any) => string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeCall?: (signal: AbortSignal) => Promise<void>;
}

/**
 * Generic helper for OpenAI Responses API schema parsing with runtime budget + abort translation.
 * You provide the json_schema object and a type-guard validator.
 */
export async function runStructuredReasoning<T>(
  client: OpenAI,
  opts: StructuredReasoningOptions<T>
): Promise<T> {
  const requestRemainingMs = getRequestRemainingMs();
  const safeRemainingMs = getSafeRemainingMs(opts.budget);
  if (safeRemainingMs <= 0) throw new RuntimeBudgetExceededError();
  const preferredTimeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.trunc(opts.timeoutMs)
      : safeRemainingMs;
  const requestTimeoutMs = Math.max(
    1,
    Math.min(
      preferredTimeoutMs,
      safeRemainingMs,
      requestRemainingMs ?? safeRemainingMs
    )
  );
  const requestScope = createLinkedAbortController({
    timeoutMs: requestTimeoutMs,
    parentSignal: opts.signal ?? getRequestAbortSignal(),
    abortMessage: `Structured reasoning timed out after ${requestTimeoutMs}ms`
  });

  try {
    if (opts.beforeCall) {
      await opts.beforeCall(requestScope.signal);
    }

    const { outputParsed } = await callStructuredResponse(
      client as any,
      {
        model: opts.model,
        input: opts.prompt,
        text: { format: opts.schema as any }
      },
      { signal: requestScope.signal },
      {
        validate: opts.validate,
        extractRefusal: opts.extractRefusal,
        source: 'structured reasoning'
      }
    );

    return outputParsed;
  } catch (err) {
    if (requestScope.signal.aborted || isAbortError(err)) throw new OpenAIAbortError();
    if (err instanceof OpenAIResponseMalformedJsonError) {
      const detail = err.message.includes(': ')
        ? err.message.slice(err.message.indexOf(': ') + 2)
        : err.message;
      throw new Error(`Model returned malformed structured reasoning JSON: ${detail}`);
    }
    throw err;
  } finally {
    requestScope.cleanup();
  }
}

