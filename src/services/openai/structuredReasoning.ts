import type OpenAI from 'openai';
import type { RuntimeBudget } from '@arcanos/runtime/runtimeBudget';
import type { TrinityStructuredReasoning } from '../../core/logic/trinitySchema.js';
import { TRINITY_STRUCTURED_REASONING_SCHEMA } from '../../core/logic/trinitySchema.js';
import { runStructuredReasoning as runStructuredReasoningGeneric } from '@arcanos/openai/structuredReasoning';

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

export async function runStructuredReasoning(
  client: OpenAI,
  model: string,
  prompt: string,
  budget: RuntimeBudget
): Promise<TrinityStructuredReasoning> {
  return runStructuredReasoningGeneric(client, {
    model,
    prompt,
    budget,
    schema: { type: 'json_schema', ...TRINITY_STRUCTURED_REASONING_SCHEMA } as any,
    validate: isStructuredReasoningPayload,
    extractRefusal: extractRefusalReason as any
  });
}
