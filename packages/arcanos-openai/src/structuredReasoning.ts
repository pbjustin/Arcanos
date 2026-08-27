import type OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import {
  callTextResponse,
  parseStructuredJson,
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

export type StructuredReasoningEffort = Exclude<ReasoningEffort, null>;
export type StructuredReasoningUsage = ResponseUsage;

export interface StructuredReasoningOptions<T> {
  model: string;
  prompt: string;
  budget: RuntimeBudget;
  schema: { type: 'json_schema' } & Record<string, unknown>;
  validate: (value: unknown) => value is T;
  extractRefusal?: (response: any) => string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  reasoningEffort?: StructuredReasoningEffort;
  maxOutputTokens?: number;
  onUsage?: (usage: StructuredReasoningUsage) => void | Promise<void>;
  beforeCall?: (signal: AbortSignal) => Promise<void>;
}

function normalizeMaxOutputTokens(maxOutputTokens?: number): number | undefined {
  if (maxOutputTokens === undefined) return undefined;
  if (!Number.isFinite(maxOutputTokens) || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new RangeError('Structured reasoning maxOutputTokens must be a positive integer.');
  }
  return maxOutputTokens;
}

function reportUsageSafely(
  onUsage: StructuredReasoningOptions<unknown>['onUsage'],
  usage: StructuredReasoningUsage | null | undefined
): void {
  if (!onUsage || !usage) return;

  // Usage observers are accounting side effects and must not change the provider response outcome.
  try {
    const result = onUsage(usage);
    if (result) {
      void result.catch(() => undefined);
    }
  } catch {
    // Deliberately best-effort: callers retain the model result or original parse failure.
  }
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
  const maxOutputTokens = normalizeMaxOutputTokens(opts.maxOutputTokens);
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

    const { response } = await callTextResponse(
      client as any,
      {
        model: opts.model,
        input: opts.prompt,
        text: { format: opts.schema as any },
        ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
        ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {})
      },
      { signal: requestScope.signal }
    );

    // Capture billed usage before parsing so incomplete, refused, malformed, and schema-invalid
    // Responses still reach accounting while preserving the original parse error.
    reportUsageSafely(opts.onUsage as StructuredReasoningOptions<unknown>['onUsage'], response.usage);

    const outputParsed = parseStructuredJson<T>(response, {
      validate: opts.validate,
      extractRefusal: opts.extractRefusal,
      source: 'structured reasoning'
    });

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

