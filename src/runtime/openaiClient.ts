import OpenAI from 'openai';
import type { RuntimeBudget } from './runtimeBudget.js';
import { getSafeRemainingMs } from './runtimeBudget.js';
import { RuntimeBudgetExceededError } from './runtimeErrors.js';
import type { TrinityStructuredReasoning } from '../core/logic/trinitySchema.js';
import { TRINITY_STRUCTURED_REASONING_SCHEMA } from '../core/logic/trinitySchema.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Runs a schema-constrained reasoning call and returns validated structured output.
 * Input: user prompt and runtime budget. Output: TrinityStructuredReasoning object.
 * Edge case: throws RuntimeBudgetExceededError when safe budget is exhausted.
 */
export async function runStructuredReasoning(
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
    const response = await (client.responses as any).create(
      {
        model: 'gpt-5',
        input: prompt,
        response_format: {
          type: 'json_schema',
          json_schema: TRINITY_STRUCTURED_REASONING_SCHEMA
        }
      },
      { signal: abortController.signal }
    );

    return response.output_parsed as TrinityStructuredReasoning;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
