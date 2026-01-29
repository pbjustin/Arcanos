/**
 * Trinity pipeline stage runners and pure helpers.
 * Internal implementation; consumers should use runThroughBrain from trinity.js only.
 */

import OpenAI from 'openai';
import { logGPT5Invocation } from '../utils/aiLogger.js';
import { getDefaultModel, getGPT5Model, getComplexModel, createChatCompletionWithFallback, createGPT5Reasoning } from '../services/openai.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import {
  ARCANOS_SYSTEM_PROMPTS,
  buildFinalGpt5AnalysisMessage,
  buildFinalOriginalRequestMessage,
  getFinalResponseInstruction,
  getTrinityMessages
} from '../config/prompts.js';
import type { ChatCompletionMessageParam } from '../services/openai/types.js';
import {
  getAuditSafeConfig,
  createAuditSummary,
  type AuditLogEntry
} from '../services/auditSafe.js';
import { getMemoryContext } from '../services/memoryAware.js';
import { logger } from '../utils/structuredLogging.js';
import { calculateMemoryScoreSummary, logFallbackEvent } from './trinityHelpers.js';
import type {
  TrinityIntakeOutput,
  TrinityReasoningOutput,
  TrinityFinalOutput,
  TrinityDryRunPreview
} from './trinityTypes.js';
import { TRINITY_INTAKE_TOKEN_LIMIT, TRINITY_STAGE_TEMPERATURE, TRINITY_PREVIEW_SNIPPET_LENGTH } from './trinityConstants.js';

export { TRINITY_INTAKE_TOKEN_LIMIT, TRINITY_STAGE_TEMPERATURE, TRINITY_PREVIEW_SNIPPET_LENGTH };
export { calculateMemoryScoreSummary };

/**
 * Validates the availability of the configured AI model.
 * Falls back to GPT-4 if the primary model is unavailable.
 */
export async function validateModel(client: OpenAI): Promise<string> {
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
    logger.warn('Model unavailable, falling back to GPT-4', {
      module: 'trinity',
      operation: 'model-fallback',
      requestedModel: defaultModel,
      fallbackModel: APPLICATION_CONSTANTS.MODEL_GPT_4,
      reason: err instanceof Error ? err.message : 'Unknown error'
    });
    return APPLICATION_CONSTANTS.MODEL_GPT_4;
  }
}

export function buildFinalArcanosMessages(
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string
): ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: ARCANOS_SYSTEM_PROMPTS.FINAL_REVIEW(memoryContextSummary) },
    { role: 'user', content: buildFinalOriginalRequestMessage(auditSafePrompt) },
    { role: 'assistant', content: buildFinalGpt5AnalysisMessage(gpt5Output) },
    { role: 'user', content: getFinalResponseInstruction() }
  ];
}

export async function runIntakeStage(
  client: OpenAI,
  arcanosModel: string,
  auditSafePrompt: string,
  memoryContextSummary: string
): Promise<TrinityIntakeOutput> {
  const intakeSystemPrompt = ARCANOS_SYSTEM_PROMPTS.INTAKE(memoryContextSummary);
  const intakeTokenParams = getTokenParameter(arcanosModel, TRINITY_INTAKE_TOKEN_LIMIT);
  const intakeResponse = await createChatCompletionWithFallback(client, {
    messages: [
      { role: 'system', content: intakeSystemPrompt },
      { role: 'user', content: auditSafePrompt }
    ],
    temperature: TRINITY_STAGE_TEMPERATURE,
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

export async function runReasoningStage(client: OpenAI, framedRequest: string): Promise<TrinityReasoningOutput> {
  logGPT5Invocation('Primary reasoning stage', framedRequest);
  const gpt5Result = await createGPT5Reasoning(client, framedRequest, ARCANOS_SYSTEM_PROMPTS.GPT5_REASONING());
  const gpt5ModelUsed = gpt5Result.model || getGPT5Model();
  const fallbackUsed = Boolean(gpt5Result.error);

  if (fallbackUsed) {
    logger.warn('GPT-5.1 reasoning fallback in Trinity pipeline', {
      module: 'trinity',
      operation: 'gpt5-reasoning',
      error: gpt5Result.error
    });
  } else {
    logger.info('GPT-5.1 reasoning confirmed', {
      module: 'trinity',
      operation: 'gpt5-reasoning',
      model: gpt5ModelUsed
    });
  }

  return {
    output: gpt5Result.content,
    model: gpt5ModelUsed,
    fallbackUsed,
    error: gpt5Result.error
  };
}

export async function runFinalStage(
  client: OpenAI,
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string
): Promise<TrinityFinalOutput> {
  const complexModel = getComplexModel();
  const finalTokenParams = getTokenParameter(complexModel, APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT);
  const finalResponse = await createChatCompletionWithFallback(client, {
    messages: buildFinalArcanosMessages(memoryContextSummary, auditSafePrompt, gpt5Output),
    temperature: TRINITY_STAGE_TEMPERATURE,
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
