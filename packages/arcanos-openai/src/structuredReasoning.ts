import type OpenAI from 'openai';
import type { RuntimeBudget } from '@arcanos/runtime';
import { getSafeRemainingMs, RuntimeBudgetExceededError, OpenAIAbortError } from '@arcanos/runtime';

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
}

/**
 * Generic helper for OpenAI Responses API schema parsing with runtime budget + abort translation.
 * You provide the json_schema object and a type-guard validator.
 */
export async function runStructuredReasoning<T>(
  client: OpenAI,
  opts: StructuredReasoningOptions<T>
): Promise<T> {
  const safeRemainingMs = getSafeRemainingMs(opts.budget);
  if (safeRemainingMs <= 0) throw new RuntimeBudgetExceededError();

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), safeRemainingMs);

  const isAbortError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const maybe = error as { name?: unknown; message?: unknown; code?: unknown };
    if (typeof maybe.name === 'string' && maybe.name.toLowerCase().includes('abort')) return true;
    if (typeof maybe.message === 'string' && maybe.message.toLowerCase().includes('abort')) return true;
    if (typeof maybe.code === 'string' && maybe.code.toLowerCase().includes('abort')) return true;
    return false;
  };

  try {
    const response = await (client.responses as any).parse(
      {
        model: opts.model,
        input: opts.prompt,
        text: { format: { ...opts.schema } }
      },
      { signal: abortController.signal }
    );

    const refusalReason = opts.extractRefusal ? opts.extractRefusal(response) : null;
    if (refusalReason) throw new Error(`Model refusal: ${refusalReason}`);

    if (!opts.validate((response as any).output_parsed)) {
      throw new Error('Model failed to provide structured reasoning output.');
    }
    return (response as any).output_parsed as T;
  } catch (err) {
    if (abortController.signal.aborted || isAbortError(err)) throw new OpenAIAbortError();
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}


