import type OpenAI from 'openai';
import type { RuntimeBudget } from '@arcanos/runtime/runtimeBudget';
import type {
  TrinityCompactStructuredReasoning,
  TrinityStructuredReasoning
} from '@core/logic/trinitySchema.js';
import {
  TRINITY_COMPACT_STRUCTURED_REASONING_SCHEMA,
  TRINITY_STRUCTURED_REASONING_SCHEMA
} from '@core/logic/trinitySchema.js';
import { runStructuredReasoning as runStructuredReasoningGeneric } from '@arcanos/openai/structuredReasoning';

type TrinityResolvedStructuredReasoning = TrinityCompactStructuredReasoning | TrinityStructuredReasoning;

interface ParsedReasoningResponse {
  output_parsed: TrinityResolvedStructuredReasoning | null;
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

function isCompactStructuredReasoningPayload(value: unknown): value is TrinityCompactStructuredReasoning {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const isStringArray = (field: unknown) => Array.isArray(field) && field.every(item => typeof item === 'string');
  const isEnumValue = <T extends string>(field: unknown, allowedValues: readonly T[]): field is T =>
    typeof field === 'string' && allowedValues.includes(field as T);
  const isClaimTagArray = (field: unknown) => Array.isArray(field) && field.every(item => {
    if (!item || typeof item !== 'object') return false;
    const claimTag = item as Record<string, unknown>;
    return (
      typeof claimTag.claim_text === 'string' &&
      isEnumValue(claimTag.source_type, ['tool', 'user_context', 'memory', 'inference', 'template'] as const) &&
      isEnumValue(claimTag.confidence, ['high', 'medium', 'low'] as const) &&
      isEnumValue(claimTag.verification_status, ['verified', 'unverified', 'inferred', 'unavailable'] as const)
    );
  });
  return (
    isEnumValue(candidate.response_mode, ['answer', 'partial_refusal', 'refusal'] as const) &&
    isStringArray(candidate.achievable_subtasks) &&
    isStringArray(candidate.blocked_subtasks) &&
    isStringArray(candidate.user_visible_caveats) &&
    isClaimTagArray(candidate.claim_tags) &&
    typeof candidate.final_answer === 'string'
  );
}

function isStructuredReasoningPayload(value: unknown): value is TrinityStructuredReasoning {
  if (!isCompactStructuredReasoningPayload(value)) return false;
  const candidate = value as unknown as Record<string, unknown>;
  const isStringArray = (field: unknown) => Array.isArray(field) && field.every(item => typeof item === 'string');
  return (
    isStringArray(candidate.reasoning_steps) &&
    isStringArray(candidate.assumptions) &&
    isStringArray(candidate.constraints) &&
    isStringArray(candidate.tradeoffs) &&
    isStringArray(candidate.alternatives_considered) &&
    typeof candidate.chosen_path_justification === 'string'
  );
}

export interface StructuredReasoningSchemaOptions {
  schemaVariant?: 'compact' | 'full';
}

export async function runStructuredReasoning(
  client: OpenAI,
  model: string,
  prompt: string,
  budget: RuntimeBudget,
  timeoutMs?: number,
  options: StructuredReasoningSchemaOptions = {}
): Promise<TrinityResolvedStructuredReasoning> {
  const schemaVariant = options.schemaVariant ?? 'full';
  return runStructuredReasoningGeneric(client, {
    model,
    prompt,
    budget,
    schema: {
      type: 'json_schema',
      ...(schemaVariant === 'compact'
        ? TRINITY_COMPACT_STRUCTURED_REASONING_SCHEMA
        : TRINITY_STRUCTURED_REASONING_SCHEMA)
    } as any,
    validate: schemaVariant === 'compact' ? isCompactStructuredReasoningPayload : isStructuredReasoningPayload,
    extractRefusal: extractRefusalReason as any,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {})
  });
}
