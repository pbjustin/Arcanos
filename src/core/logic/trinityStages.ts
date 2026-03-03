/**
 * Trinity pipeline stage runners and pure helpers.
 * Internal implementation; consumers should use runThroughBrain from trinity.js only.
 */

import type OpenAI from 'openai';
import { logGPT5Invocation } from "@platform/logging/aiLogger.js";
import { getDefaultModel, getGPT5Model, getComplexModel, createChatCompletionWithFallback } from "@services/openai.js";
import { getTokenParameter } from "@shared/tokenParameterHelper.js";
import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import {
  ARCANOS_SYSTEM_PROMPTS,
  buildFinalGpt5AnalysisMessage,
  buildFinalOriginalRequestMessage,
  getFinalResponseInstruction,
  getTrinityMessages
} from "@platform/runtime/prompts.js";
import type { ChatCompletionMessageParam } from "@services/openai/types.js";
import {
  getAuditSafeConfig,
  createAuditSummary,
  type AuditLogEntry
} from "@services/auditSafe.js";
import { getMemoryContext } from "@services/memoryAware.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { calculateMemoryScoreSummary, logFallbackEvent } from './trinityHelpers.js';
import type {
  TrinityIntakeOutput,
  TrinityReasoningOutput,
  TrinityFinalOutput,
  TrinityDryRunPreview,
  ReasoningLedger
} from './trinityTypes.js';
import type { CognitiveDomain } from "@shared/types/cognitiveDomain.js";
import { TRINITY_INTAKE_TOKEN_LIMIT, TRINITY_STAGE_TEMPERATURE, TRINITY_PREVIEW_SNIPPET_LENGTH, TRINITY_HARD_TOKEN_CAP } from './trinityConstants.js';
import { enforceTokenCap } from './trinityGuards.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import type { Tier } from './trinityTier.js';
import type { RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { assertBudgetAvailable } from '@platform/resilience/runtimeBudget.js';
import { runStructuredReasoning } from '@services/openai.js';

function resolveTemperature(cognitiveDomain?: CognitiveDomain): number {
  switch (cognitiveDomain) {
    case 'creative':
      return 0.9;
    case 'diagnostic':
      return 0.2;
    case 'code':
      return 0.1;
    case 'execution':
      return 0.0;
    case 'natural':
      return 0.5;
    default:
      return TRINITY_STAGE_TEMPERATURE;
  }
}

export { TRINITY_INTAKE_TOKEN_LIMIT, TRINITY_STAGE_TEMPERATURE, TRINITY_PREVIEW_SNIPPET_LENGTH };
export { calculateMemoryScoreSummary };

/**
 * Validates the availability of the configured AI model.
 * Falls back to GPT-4.1-mini if the primary model is unavailable.
 */
export async function validateModel(client: OpenAI, runtimeBudget?: RuntimeBudget): Promise<string> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const defaultModel = getDefaultModel();
  try {
    await client.models.retrieve(defaultModel);
    logger.info('Fine-tuned model validation successful', {
      module: 'trinity',
      operation: 'model-validation',
      model: defaultModel,
      status: 'available'
    });
    return defaultModel;
  } catch (err) {
    logger.warn('Model unavailable, falling back to GPT-4.1-mini', {
      module: 'trinity',
      operation: 'model-fallback',
      requestedModel: defaultModel,
      fallbackModel: APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI,
      reason: resolveErrorMessage(err)
    });
    return APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI;
  }
}

function ensureStringContent(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

export function buildFinalArcanosMessages(
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string,
  systemPromptOverride?: string
): ChatCompletionMessageParam[] {
  const systemContent = systemPromptOverride || ensureStringContent(ARCANOS_SYSTEM_PROMPTS.FINAL_REVIEW(memoryContextSummary)) || 'Review and respond.';
  const userRequestContent = ensureStringContent(buildFinalOriginalRequestMessage(auditSafePrompt)) || 'No request provided.';
  const assistantContent = ensureStringContent(buildFinalGpt5AnalysisMessage(gpt5Output)) || 'No analysis provided.';
  const finalInstructionContent = ensureStringContent(getFinalResponseInstruction()) || 'Provide the final response.';
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userRequestContent },
    { role: 'assistant', content: assistantContent },
    { role: 'user', content: finalInstructionContent }
  ];
}

export function buildInternalArchitecturalMessages(
  internalDirective: string,
  auditSafePrompt: string,
  gpt5Output?: string
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: internalDirective },
    { role: 'user', content: auditSafePrompt }
  ];

  if (gpt5Output) {
    messages.push({ role: 'assistant', content: gpt5Output });
    messages.push({ role: 'user', content: 'Complete the structured analysis based on the reasoning above.' });
  }

  return messages;
}

export async function runIntakeStage(
  client: OpenAI,
  arcanosModel: string,
  auditSafePrompt: string,
  memoryContextSummary: string,
  cognitiveDomain?: CognitiveDomain,
  systemPromptOverride?: string,
  runtimeBudget?: RuntimeBudget
): Promise<TrinityIntakeOutput> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const intakeSystemPrompt = systemPromptOverride || ARCANOS_SYSTEM_PROMPTS.INTAKE(memoryContextSummary);
  const intakeTokenParams = getTokenParameter(arcanosModel, TRINITY_INTAKE_TOKEN_LIMIT);
  const temperature = resolveTemperature(cognitiveDomain);
  const intakeResponse = await createChatCompletionWithFallback(client, {
    messages: [
      { role: 'system', content: intakeSystemPrompt },
      { role: 'user', content: auditSafePrompt }
    ],
    temperature,
    ...intakeTokenParams
  });

  const framedRequest = intakeResponse.choices[0]?.message?.content || auditSafePrompt;
  const actualModel = intakeResponse.activeModel || arcanosModel;
  const isFallback = intakeResponse.fallbackFlag || false;

  if (isFallback) {
    logFallbackEvent('ARCANOS-INTAKE', arcanosModel, actualModel, 'Fallback flag set by intake completion');
  }

  return {
    framedRequest,
    activeModel: actualModel,
    fallbackUsed: isFallback,
    usage: intakeResponse.usage || undefined,
    responseId: intakeResponse.id,
    created: intakeResponse.created
  };
}

/**
 * Executes the Trinity reasoning stage using schema-constrained decoding.
 * Input: framed request and shared runtime budget. Output: deterministic reasoning output.
 * Edge case: throws when runtime budget is missing/exhausted because no fallback path exists.
 */
export async function runReasoningStage(
  client: OpenAI,
  framedRequest: string,
  tier?: Tier,
  runtimeBudget?: RuntimeBudget
): Promise<TrinityReasoningOutput> {
  //audit Assumption: reasoning stage requires a shared runtime budget; risk: unbounded model call if missing; invariant: one RuntimeBudget governs each job; handling: fail-fast.
  if (!runtimeBudget) {
    throw new Error('Runtime budget is required for schema-constrained reasoning.');
  }
  assertBudgetAvailable(runtimeBudget);

  logGPT5Invocation('Primary reasoning stage', framedRequest);
  const gpt5ModelUsed = getGPT5Model();
  const structuredReasoning = await runStructuredReasoning(client, gpt5ModelUsed, framedRequest, runtimeBudget);
  //audit Assumption: structured reasoning helper enforces non-null payload; risk: downstream field access crash if contract regresses; invariant: reasoning payload exists before ledger mapping; handling: explicit guard.
  if (!structuredReasoning) {
    throw new Error('Model failed to provide structured reasoning.');
  }

  const reasoningLedger: ReasoningLedger = {
    steps: structuredReasoning.reasoning_steps,
    assumptions: structuredReasoning.assumptions,
    constraints: structuredReasoning.constraints,
    tradeoffs: structuredReasoning.tradeoffs,
    alternatives: structuredReasoning.alternatives_considered,
    justification: structuredReasoning.chosen_path_justification
  };

  logger.info('GPT-5 reasoning confirmed with schema-constrained output', {
    module: 'trinity',
    operation: 'gpt5-reasoning',
    model: gpt5ModelUsed,
    tier: tier ?? 'simple',
    structured: true
  });

  return {
    output: structuredReasoning.final_answer,
    model: gpt5ModelUsed,
    fallbackUsed: false,
    reasoningLedger
  };
}

export async function runFinalStage(
  client: OpenAI,
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string,
  cognitiveDomain?: CognitiveDomain,
  systemPromptOverride?: string,
  runtimeBudget?: RuntimeBudget
): Promise<TrinityFinalOutput> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const complexModel = getComplexModel();
  const cappedLimit = enforceTokenCap(APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT);
  const finalTokenParams = getTokenParameter(complexModel, cappedLimit);
  const temperature = resolveTemperature(cognitiveDomain);
  const finalResponse = await createChatCompletionWithFallback(client, {
    messages: buildFinalArcanosMessages(memoryContextSummary, auditSafePrompt, gpt5Output, systemPromptOverride),
    temperature,
    model: complexModel,
    ...finalTokenParams
  });
  const finalText = finalResponse.choices[0]?.message?.content || '';
  const finalModel = finalResponse.activeModel || complexModel;
  const finalFallback = finalResponse.fallbackFlag || false;

  if (finalFallback) {
    logFallbackEvent('ARCANOS-FINAL', complexModel, finalModel, 'Fallback flag set by final completion');
  }

  return {
    output: finalText,
    activeModel: finalModel,
    fallbackUsed: finalFallback,
    usage: finalResponse.usage || undefined,
    responseId: finalResponse.id,
    created: finalResponse.created
  };
}

export function buildDryRunPreview(
  requestId: string,
  prompt: string,
  auditSafePrompt: string,
  auditFlags: string[],
  memoryEntryCount: number,
  auditSafeMode: boolean,
  dryRunReason?: string
): TrinityDryRunPreview {
  const intakeModelCandidate = getDefaultModel();
  const finalModelCandidate = getComplexModel();
  const gpt5ModelCandidate = getGPT5Model();
  const routingPlan = [
    `ARCANOS-INTAKE:${intakeModelCandidate}`,
    `GPT5-REASONING:${gpt5ModelCandidate}`,
    `ARCANOS-FINAL:${finalModelCandidate}`
  ];
  const msg = getTrinityMessages();
  const dryRunNote = dryRunReason ? `Dry run reason: ${dryRunReason}.` : msg.dry_run_reason_placeholder;

  return {
    requestId,
    intakeModelCandidate,
    finalModelCandidate,
    gpt5ModelCandidate,
    routingPlan,
    auditSafeMode,
    memoryEntryCount,
    auditFlags,
    notes: [
      `Dry run only: prompt length ${prompt.length}, audit-safe prompt length ${auditSafePrompt.length}.`,
      dryRunNote
    ]
  };
}

export function buildAuditLogEntry(
  requestId: string,
  prompt: string,
  finalText: string,
  auditConfig: ReturnType<typeof getAuditSafeConfig>,
  memoryContext: ReturnType<typeof getMemoryContext>,
  actualModel: string,
  gpt5ModelUsed: string,
  finalProcessedSafely: boolean,
  auditFlags: string[]
): AuditLogEntry {
  return {
    timestamp: new Date().toISOString(),
    requestId,
    endpoint: getTrinityMessages().audit_endpoint_name,
    auditSafeMode: auditConfig.auditSafeMode,
    overrideUsed: !!auditConfig.explicitOverride,
    overrideReason: auditConfig.overrideReason,
    inputSummary: createAuditSummary(prompt),
    outputSummary: createAuditSummary(finalText),
    modelUsed: `${actualModel}+${gpt5ModelUsed}`,
    gpt5Delegated: true,
    memoryAccessed: memoryContext.accessLog,
    processedSafely: finalProcessedSafely,
    auditFlags
  };
}
