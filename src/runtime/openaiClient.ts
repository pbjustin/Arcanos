import type OpenAI from 'openai';
import type { RuntimeBudget } from './runtimeBudget.js';
import { getSafeRemainingMs } from './runtimeBudget.js';
import { RuntimeBudgetExceededError } from './runtimeErrors.js';
import type { TrinityStructuredReasoning } from '../core/logic/trinitySchema.js';
import { TRINITY_STRUCTURED_REASONING_SCHEMA } from '../core/logic/trinitySchema.js';

interface ParsedReasoningResponse {
  output_parsed: TrinityStructuredReasoning | null;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      refusal?: string;
    }>;
  }>;
}

function extractRefusalReason(response: ParsedReasoningResponse): string | null {
  const outputItems = Array.isArray(response.output) ? response.output : [];
  for (const item of outputItems) {
    //audit Assumption: refusals are emitted as message content items with type=refusal; risk: refusal text missed and hidden behind generic error; invariant: refusal surfaces as explicit error reason; handling: scan all output content parts.
    const contentParts = Array.isArray(item.content) ? item.content : [];
    for (const contentPart of contentParts) {
      if (contentPart.type === 'refusal' && typeof contentPart.refusal === 'string' && contentPart.refusal.length > 0) {
        return contentPart.refusal;
      }
    }
  }

  return null;
}

function isStructuredReasoningPayload(value: unknown): value is TrinityStructuredReasoning {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const isStringArray = (field: unknown) => Array.isArray(field) && field.every(item => typeof item === 'string');
  return (
    isStringArray(candidate.reasoning_steps) &&
    isStringArray(candidate.assumptions) &&
    isStringArray(candidate.constraints) &&
    isStringArray(candidate.tradeoffs) &&
    isStringArray(candidate.alternatives_considered) &&
    typeof candidate.chosen_path_justification === 'string' &&
    typeof candidate.final_answer === 'string'
  );
}

/**
 * Runs a schema-constrained reasoning call and returns validated structured output.
 * Input: OpenAI client, model, prompt, and runtime budget.
 * Output: TrinityStructuredReasoning object parsed from schema-constrained response.
 * Edge case: throws RuntimeBudgetExceededError when safe budget is exhausted, and throws explicit errors for refusal/missing structured output.
 */
export async function runStructuredReasoning(
  client: OpenAI,
  model: string,
  prompt: string,
  budget: RuntimeBudget
): Promise<TrinityStructuredReasoning> {
  const safeRemainingMs = getSafeRemainingMs(budget);
  //audit Assumption: remaining budget must be positive before network call; risk: timeout after deadline; invariant: no invocation starts without safe window; handling: throw RuntimeBudgetExceededError.
  if (safeRemainingMs <= 0) {
    throw new RuntimeBudgetExceededError();
  }

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), safeRemainingMs);

  try {
    const response = await (client.responses as any).parse(
      {
        model,
        input: prompt,
        text: {
          format: {
            type: 'json_schema',
            ...TRINITY_STRUCTURED_REASONING_SCHEMA
          }
        }
      },
      { signal: abortController.signal }
    ) as ParsedReasoningResponse;

    const refusalReason = extractRefusalReason(response);
    //audit Assumption: refusal and structured output are mutually exclusive for parse flow; risk: null output_parsed dereference in callers; invariant: return value is a valid structured object; handling: fail-fast with explicit refusal reason.
    if (refusalReason) {
      throw new Error(`Model refusal: ${refusalReason}`);
    }

    //audit Assumption: successful parse must produce non-null structured payload; risk: malformed/empty model output causes runtime type errors; invariant: caller receives complete TrinityStructuredReasoning object; handling: validate parsed object and throw deterministic error.
    if (!isStructuredReasoningPayload(response.output_parsed)) {
      throw new Error('Model failed to provide structured reasoning output.');
    }

    return response.output_parsed;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
