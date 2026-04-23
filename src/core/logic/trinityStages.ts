/**
 * Trinity pipeline stage runners and pure helpers.
 * Internal implementation; production callers should use the Trinity writing facade.
 */

import type OpenAI from 'openai';
import { logGPT5Invocation } from "@platform/logging/aiLogger.js";
import {
  getDefaultModel,
  getGPT5Model,
  getComplexModel,
  getFallbackModel,
  createSingleChatCompletion
} from "@services/openai.js";
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
import { getAuditSafeConfig, createAuditSummary, type AuditLogEntry } from "@services/auditSafe.js";
import { getMemoryContext } from "@services/memoryAware.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { calculateMemoryScoreSummary, logFallbackEvent } from './trinityHelpers.js';
import type {
  TrinityIntakeOutput,
  TrinityReasoningOutput,
  TrinityFinalOutput,
  TrinityDryRunPreview,
  TrinityOutputControls,
  ReasoningLedger
} from './trinityTypes.js';
import type { CognitiveDomain } from "@shared/types/cognitiveDomain.js";
import type { PreviewAskChaosHook } from '@shared/ask/previewChaos.js';
import { TRINITY_INTAKE_TOKEN_LIMIT, TRINITY_STAGE_TEMPERATURE, TRINITY_PREVIEW_SNIPPET_LENGTH } from './trinityConstants.js';
import { enforceTokenCap } from './trinityGuards.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import type { Tier } from './trinityTier.js';
import type { RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { assertBudgetAvailable, getSafeRemainingMs } from '@platform/resilience/runtimeBudget.js';
import { runStructuredReasoning } from '@services/openai.js';
import {
  getRequestAbortSignal,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import {
  buildFinalHonestyInstruction,
  buildFinalStageInstruction,
  buildIntakeCapabilityEnvelope,
  buildReasoningStagePrompt,
  buildTrinityStageContractBlock,
  createDefaultTrinityReasoningHonesty,
  type TrinityCapabilityFlags,
  type TrinityReasoningHonesty
} from './trinityHonesty.js';
import {
  buildTrinityDirectAnswerSystemInstruction,
  resolveTrinityDirectAnswerTokenLimit
} from './trinityDirectAnswerMode.js';

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

const DEFAULT_TRINITY_DIRECT_ANSWER_STAGE_TIMEOUT_MS = 12_000;
const DEFAULT_TRINITY_MODEL_VALIDATION_TIMEOUT_MS = 4_000;
const DEFAULT_TRINITY_INTAKE_STAGE_TIMEOUT_MS = 6_000;
const DEFAULT_TRINITY_REASONING_STAGE_TIMEOUT_MS = 20_000;
const DEFAULT_TRINITY_FINAL_STAGE_TIMEOUT_MS = 4_000;
const MODEL_VALIDATION_CACHE_TTL_MS = 10 * 60_000;
const validatedModelCache = new Map<string, number>();

function resolveStageTimeoutMs(
  envName: string,
  fallbackMs: number,
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  const configuredTimeoutMs = Number.parseInt(process.env[envName] ?? '', 10);
  const normalizedConfiguredTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.trunc(configuredTimeoutMs)
      : fallbackMs;
  const preferredTimeoutMs =
    typeof explicitTimeoutMs === 'number' && Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
      ? Math.trunc(explicitTimeoutMs)
      : normalizedConfiguredTimeoutMs;

  if (!runtimeBudget) {
    return preferredTimeoutMs;
  }

  return Math.max(1, Math.min(preferredTimeoutMs, getSafeRemainingMs(runtimeBudget)));
}

function resolveDirectAnswerStageTimeoutMs(
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  return resolveStageTimeoutMs(
    'TRINITY_DIRECT_ANSWER_STAGE_TIMEOUT_MS',
    DEFAULT_TRINITY_DIRECT_ANSWER_STAGE_TIMEOUT_MS,
    runtimeBudget,
    explicitTimeoutMs
  );
}

function resolveModelValidationTimeoutMs(
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  return resolveStageTimeoutMs(
    'TRINITY_MODEL_VALIDATION_TIMEOUT_MS',
    DEFAULT_TRINITY_MODEL_VALIDATION_TIMEOUT_MS,
    runtimeBudget,
    explicitTimeoutMs
  );
}

function resolveIntakeStageTimeoutMs(
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  return resolveStageTimeoutMs(
    'TRINITY_INTAKE_STAGE_TIMEOUT_MS',
    DEFAULT_TRINITY_INTAKE_STAGE_TIMEOUT_MS,
    runtimeBudget,
    explicitTimeoutMs
  );
}

function resolveReasoningStageTimeoutMs(
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  return resolveStageTimeoutMs(
    'TRINITY_REASONING_STAGE_TIMEOUT_MS',
    DEFAULT_TRINITY_REASONING_STAGE_TIMEOUT_MS,
    runtimeBudget,
    explicitTimeoutMs
  );
}

function resolveFinalStageTimeoutMs(
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): number {
  return resolveStageTimeoutMs(
    'TRINITY_FINAL_STAGE_TIMEOUT_MS',
    DEFAULT_TRINITY_FINAL_STAGE_TIMEOUT_MS,
    runtimeBudget,
    explicitTimeoutMs
  );
}

/**
 * Validates the availability of the configured AI model.
 * Falls back to GPT-4.1-mini if the primary model is unavailable.
 */
export async function validateModel(
  client: OpenAI,
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): Promise<string> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const defaultModel = getDefaultModel();
  const cachedValidationExpiresAt = validatedModelCache.get(defaultModel) ?? 0;
  if (cachedValidationExpiresAt > Date.now()) {
    return defaultModel;
  }
  try {
    const timeoutMs = resolveModelValidationTimeoutMs(runtimeBudget, explicitTimeoutMs);
    await runWithRequestAbortTimeout(
      {
        timeoutMs,
        parentSignal: getRequestAbortSignal(),
        abortMessage: `Trinity model validation timed out after ${timeoutMs}ms`
      },
      async () => {
        await client.models.retrieve(defaultModel, {
          signal: getRequestAbortSignal()
        } as any);
      }
    );
    logger.info('Fine-tuned model validation successful', {
      module: 'trinity',
      operation: 'model-validation',
      model: defaultModel,
      status: 'available'
    });
    validatedModelCache.set(defaultModel, Date.now() + MODEL_VALIDATION_CACHE_TTL_MS);
    return defaultModel;
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }

    logger.warn('MODEL_FALLBACK_TRIGGERED', {
      module: 'trinity',
      operation: 'model-fallback',
      stage: 'TRINITY-MODEL-VALIDATION',
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

/**
 * Build the final-stage chat messages with explicit honesty metadata and output-control instructions.
 */
export function buildFinalArcanosMessages(
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string,
  capabilityFlags: TrinityCapabilityFlags,
  reasoningHonesty: TrinityReasoningHonesty,
  outputControls: TrinityOutputControls,
  systemPromptOverride?: string,
  finalInstructionOverride?: string
): ChatCompletionMessageParam[] {
  const systemContent =
    systemPromptOverride ||
    ensureStringContent(ARCANOS_SYSTEM_PROMPTS.FINAL_REVIEW(memoryContextSummary)) ||
    'Review and respond.';
  const userRequestContent =
    ensureStringContent(buildFinalOriginalRequestMessage(auditSafePrompt)) ||
    'No request provided.';
  const assistantContent =
    ensureStringContent(buildFinalGpt5AnalysisMessage(gpt5Output)) ||
    'No analysis provided.';
  const honestyInstructionContent = buildFinalHonestyInstruction(
    capabilityFlags,
    reasoningHonesty,
    outputControls.intentMode ?? outputControls.requestIntent ?? 'EXECUTE_TASK'
  );
  const finalInstructionContent = ensureStringContent(
    [getFinalResponseInstruction(), finalInstructionOverride].filter(Boolean).join('\n\n')
  ) || 'Provide the final response.';

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userRequestContent },
    { role: 'assistant', content: assistantContent },
    { role: 'user', content: honestyInstructionContent },
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

/**
 * Build the single-pass direct-answer messages used by Trinity core when simulation must be suppressed.
 * Inputs/outputs: memory context summary + sanitized user prompt -> strict chat message array.
 * Edge cases: blank prompt content falls back to a deterministic placeholder so OpenAI always receives string content.
 */
export function buildTrinityDirectAnswerMessages(
  memoryContextSummary: string,
  auditSafePrompt: string
): ChatCompletionMessageParam[] {
  const systemContent = ensureStringContent(
    buildTrinityDirectAnswerSystemInstruction(memoryContextSummary, auditSafePrompt)
  ) || 'Answer the request directly.';
  const userRequestContent = ensureStringContent(auditSafePrompt) || 'No request provided.';

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userRequestContent }
  ];
}

/**
 * Execute the intake stage while attaching hard capability constraints and output controls to the framed request.
 */
export async function runIntakeStage(
  client: OpenAI,
  arcanosModel: string,
  auditSafePrompt: string,
  memoryContextSummary: string,
  capabilityFlags: TrinityCapabilityFlags,
  outputControls: TrinityOutputControls,
  cognitiveDomain?: CognitiveDomain,
  systemPromptOverride?: string,
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): Promise<TrinityIntakeOutput> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const intakeSystemPrompt = systemPromptOverride || ARCANOS_SYSTEM_PROMPTS.INTAKE(memoryContextSummary);
  const intakeTokenParams = getTokenParameter(arcanosModel, TRINITY_INTAKE_TOKEN_LIMIT);
  const temperature = resolveTemperature(cognitiveDomain);
  const intakeResponse = await createSingleChatCompletion(client, {
    messages: [
      { role: 'system', content: intakeSystemPrompt },
      {
        role: 'user',
        content: [
          buildIntakeCapabilityEnvelope(
            auditSafePrompt,
            capabilityFlags,
            outputControls.intentMode ?? outputControls.requestIntent ?? 'EXECUTE_TASK'
          ),
          '',
          buildTrinityStageContractBlock({
            stage: 'intake',
            capabilityFlags,
            outputControls
          })
        ].join('\n')
      }
    ],
    temperature,
    timeoutMs: resolveIntakeStageTimeoutMs(runtimeBudget, explicitTimeoutMs),
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
    capabilityFlags,
    activeModel: actualModel,
    fallbackUsed: isFallback,
    usage: intakeResponse.usage || undefined,
    responseId: intakeResponse.id,
    created: intakeResponse.created
  };
}

/**
 * Executes the Trinity reasoning stage using schema-constrained decoding.
 */
export async function runReasoningStage(
  client: OpenAI,
  framedRequest: string,
  capabilityFlags: TrinityCapabilityFlags,
  outputControls: TrinityOutputControls,
  tier?: Tier,
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number,
  previewChaosHook?: PreviewAskChaosHook
): Promise<TrinityReasoningOutput> {
  //audit Assumption: reasoning stage requires a shared runtime budget; risk: unbounded model call if missing; invariant: one RuntimeBudget governs each job; handling: fail-fast.
  if (!runtimeBudget) {
    throw new Error('Runtime budget is required for schema-constrained reasoning.');
  }
  assertBudgetAvailable(runtimeBudget);

  const reasoningPrompt = [
    ARCANOS_SYSTEM_PROMPTS.GPT5_REASONING(),
    '',
    buildReasoningStagePrompt({
      framedRequest,
      capabilityFlags,
      outputControls
    })
  ].join('\n');

  logGPT5Invocation('Primary reasoning stage', reasoningPrompt);
  const gpt5ModelUsed = getGPT5Model();
  const schemaVariant = tier === 'simple' ? 'compact' : 'full';
  const structuredReasoning = await runStructuredReasoning(
    client,
    gpt5ModelUsed,
    reasoningPrompt,
    runtimeBudget,
    resolveReasoningStageTimeoutMs(runtimeBudget, explicitTimeoutMs),
    {
      schemaVariant,
      previewChaosHook
    }
  );
  if (!structuredReasoning) {
    throw new Error('Model failed to provide structured reasoning.');
  }

  const reasoningLedger: ReasoningLedger = {
    steps: 'reasoning_steps' in structuredReasoning ? structuredReasoning.reasoning_steps : [],
    assumptions: 'assumptions' in structuredReasoning ? structuredReasoning.assumptions : [],
    constraints: 'constraints' in structuredReasoning ? structuredReasoning.constraints : [],
    tradeoffs: 'tradeoffs' in structuredReasoning ? structuredReasoning.tradeoffs : [],
    alternatives: 'alternatives_considered' in structuredReasoning ? structuredReasoning.alternatives_considered : [],
    justification: 'chosen_path_justification' in structuredReasoning ? structuredReasoning.chosen_path_justification : '',
    responseMode: structuredReasoning.response_mode,
    achievableSubtasks: structuredReasoning.achievable_subtasks,
    blockedSubtasks: structuredReasoning.blocked_subtasks,
    userVisibleCaveats: structuredReasoning.user_visible_caveats,
    evidenceTags: structuredReasoning.claim_tags.map(claimTag => ({
      claimText: claimTag.claim_text,
      sourceType: claimTag.source_type,
      confidence: claimTag.confidence,
      verificationStatus: claimTag.verification_status
    }))
  };
  const reasoningHonesty: TrinityReasoningHonesty = {
    responseMode: reasoningLedger.responseMode,
    achievableSubtasks: reasoningLedger.achievableSubtasks,
    blockedSubtasks: reasoningLedger.blockedSubtasks,
    userVisibleCaveats: reasoningLedger.userVisibleCaveats,
    evidenceTags: reasoningLedger.evidenceTags
  };

  logger.info('GPT-5 reasoning confirmed with schema-constrained output', {
    module: 'trinity',
    operation: 'gpt5-reasoning',
    model: gpt5ModelUsed,
    tier: tier ?? 'simple',
    schemaVariant,
    structured: true
  });

  return {
    output: structuredReasoning.final_answer,
    model: gpt5ModelUsed,
    fallbackUsed: false,
    reasoningLedger,
    reasoningHonesty
  };
}

/**
 * Execute the final stage with honesty metadata and output controls attached as hard review constraints.
 */
export async function runFinalStage(
  client: OpenAI,
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string,
  capabilityFlags: TrinityCapabilityFlags,
  outputControls: TrinityOutputControls,
  reasoningHonesty: TrinityReasoningHonesty = createDefaultTrinityReasoningHonesty(),
  cognitiveDomain?: CognitiveDomain,
  systemPromptOverride?: string,
  runtimeBudget?: RuntimeBudget,
  explicitTimeoutMs?: number
): Promise<TrinityFinalOutput> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const complexModel = getComplexModel();
  const cappedLimit = enforceTokenCap(APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT);
  const finalTokenParams = getTokenParameter(complexModel, cappedLimit);
  const temperature = resolveTemperature(cognitiveDomain);
  const finalResponse = await createSingleChatCompletion(client, {
    messages: buildFinalArcanosMessages(
      memoryContextSummary,
      auditSafePrompt,
      gpt5Output,
      capabilityFlags,
      reasoningHonesty,
      outputControls,
      systemPromptOverride,
      buildFinalStageInstruction({
        capabilityFlags,
        outputControls,
        reasoningHonesty
      })
    ),
    temperature,
    model: complexModel,
    timeoutMs: resolveFinalStageTimeoutMs(runtimeBudget, explicitTimeoutMs),
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

/**
 * Execute Trinity's strict direct-answer mode as a single model call.
 * Inputs: shared OpenAI client, memory context summary, sanitized user prompt, optional cognitive domain, and runtime budget.
 * Outputs: normalized final-stage style payload with model, usage, and fallback metadata.
 * Edge cases: enforces a smaller token budget for explicit list-shaped direct answers to reduce verbosity and timeout pressure.
 */
export async function runDirectAnswerStage(
  client: OpenAI,
  memoryContextSummary: string,
  auditSafePrompt: string,
  cognitiveDomain?: CognitiveDomain,
  runtimeBudget?: RuntimeBudget,
  requestId?: string,
  directAnswerModelOverride?: string,
  explicitTimeoutMs?: number
): Promise<TrinityFinalOutput> {
  if (runtimeBudget) assertBudgetAvailable(runtimeBudget);

  const directAnswerModel =
    typeof directAnswerModelOverride === 'string' && directAnswerModelOverride.trim().length > 0
      ? directAnswerModelOverride.trim()
      : getFallbackModel();
  const directAnswerTokenLimit = resolveTrinityDirectAnswerTokenLimit(
    auditSafePrompt,
    APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT
  );
  const cappedTokenLimit = enforceTokenCap(directAnswerTokenLimit);
  const directAnswerTokenParams = getTokenParameter(directAnswerModel, cappedTokenLimit);
  const temperature = Math.min(resolveTemperature(cognitiveDomain), 0.2);
  const stageTimeoutMs = resolveDirectAnswerStageTimeoutMs(runtimeBudget, explicitTimeoutMs);

  logger.info('trinity.direct_answer.execution_plan', {
    module: 'trinity',
    operation: 'direct-answer-stage',
    requestId,
    model: directAnswerModel,
    timeoutMs: stageTimeoutMs,
    tokenLimit: cappedTokenLimit
  });

  let directAnswerResponse: Awaited<ReturnType<typeof createSingleChatCompletion>>;
  try {
    directAnswerResponse = await runWithRequestAbortTimeout(
      {
        timeoutMs: stageTimeoutMs,
        requestId,
        parentSignal: getRequestAbortSignal(),
        abortMessage: `Trinity direct-answer stage timed out after ${stageTimeoutMs}ms using ${directAnswerModel}.`
      },
      () =>
        createSingleChatCompletion(client, {
          messages: buildTrinityDirectAnswerMessages(memoryContextSummary, auditSafePrompt),
          temperature,
          model: directAnswerModel,
          signal: getRequestAbortSignal(),
          ...directAnswerTokenParams
        })
    );
  } catch (error) {
    const errorMessage = resolveErrorMessage(error);
    logger.warn(
      errorMessage.includes(`timed out after ${stageTimeoutMs}ms`)
        ? 'trinity.direct_answer.stage_timeout'
        : 'trinity.direct_answer.stage_error',
      {
        module: 'trinity',
        operation: 'direct-answer-stage',
        requestId,
        model: directAnswerModel,
        timeoutMs: stageTimeoutMs,
        promptLength: auditSafePrompt.length,
        error: errorMessage
      }
    );
    throw error;
  }

  const directAnswerText = directAnswerResponse.choices[0]?.message?.content || '';
  const actualModel = directAnswerResponse.activeModel || directAnswerModel;
  const fallbackUsed = directAnswerResponse.fallbackFlag || false;

  if (fallbackUsed) {
    logFallbackEvent(
      'ARCANOS-DIRECT-ANSWER',
      directAnswerModel,
      actualModel,
      'Fallback flag set by direct-answer completion'
    );
  }

  return {
    output: directAnswerText,
    activeModel: actualModel,
    fallbackUsed,
    usage: directAnswerResponse.usage || undefined,
    responseId: directAnswerResponse.id,
    created: directAnswerResponse.created
  };
}

/**
 * Build a dry-run preview of the Trinity route including capability constraints.
 */
export function buildDryRunPreview(
  requestId: string,
  prompt: string,
  auditSafePrompt: string,
  capabilityFlags: TrinityCapabilityFlags,
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
    capabilityFlags,
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
