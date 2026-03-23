import type OpenAI from 'openai';
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
  const requestTimeoutMs = Math.max(
    1,
    Math.min(
      opts.timeoutMs ?? 8_000,
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
    const response = await (client.responses as any).parse(
      {
        model: opts.model,
        input: opts.prompt,
        text: { format: { ...opts.schema } }
      },
      { signal: requestScope.signal }
    );

    const refusalReason = opts.extractRefusal ? opts.extractRefusal(response) : null;
    if (refusalReason) throw new Error(`Model refusal: ${refusalReason}`);

    if (!opts.validate((response as any).output_parsed)) {
      throw new Error('Model failed to provide structured reasoning output.');
    }
    return (response as any).output_parsed as T;
  } catch (err) {
    if (requestScope.signal.aborted || isAbortError(err)) throw new OpenAIAbortError();
    throw err;
  } finally {
    requestScope.cleanup();
  }
}


