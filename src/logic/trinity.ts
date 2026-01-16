/**
 * Trinity Brain - Core AI Processing Pipeline
 * 
 * Implements the ARCANOS Trinity architecture, a three-stage AI processing workflow:
 * 
 * 1. **ARCANOS Intake**: Prepares and frames user requests with memory context
 * 2. **GPT-5.2 Reasoning**: Performs advanced reasoning and deep analysis (always invoked)
 * 3. **ARCANOS Execution**: Synthesizes results and generates final responses
 * 
 * Key Features:
 * - Automatic model validation with intelligent fallback
 * - Memory-aware context integration for enhanced responses
 * - Audit-safe constraint application for secure processing
 * - Comprehensive routing stage tracking and logging
 * - Task lineage tracking for debugging and analysis
 * - Pattern storage for continuous learning
 * 
 * The Trinity pipeline is the primary entry point for all AI processing in ARCANOS.
 * 
 * @module trinity
 */

import OpenAI from 'openai';
import { logArcanosRouting, logGPT5Invocation, logRoutingSummary } from '../utils/aiLogger.js';
import { getDefaultModel, getGPT5Model, createChatCompletionWithFallback, createGPT5Reasoning } from '../services/openai.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import { ARCANOS_SYSTEM_PROMPTS } from '../config/prompts.js';
import type { ChatCompletionMessageParam } from '../services/openai/types.js';
import {
  getAuditSafeConfig,
  applyAuditSafeConstraints,
  logAITaskLineage,
  validateAuditSafeOutput,
  createAuditSummary,
  type AuditLogEntry
} from '../services/auditSafe.js';
import { getMemoryContext, storePattern } from '../services/memoryAware.js';
import { logger } from '../utils/structuredLogging.js';

/**
 * Comprehensive result from the Trinity processing pipeline.
 * Includes the AI-generated response, metadata, audit information, and routing details.
 */
interface TrinityResult {
  result: string;
  module: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
  activeModel: string;
  fallbackFlag: boolean;
  routingStages?: string[];
  gpt5Used?: boolean;
  gpt5Model?: string;
  gpt5Error?: string;
  dryRun: boolean;
  dryRunPreview?: TrinityDryRunPreview;
  fallbackSummary: {
    intakeFallbackUsed: boolean;
    gpt5FallbackUsed: boolean;
    finalFallbackUsed: boolean;
    fallbackReasons: string[];
  };
  auditSafe: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
    maxRelevanceScore: number;
    averageRelevanceScore: number;
  };
  taskLineage: {
    requestId: string;
    logged: boolean;
  };
}

interface TrinityRunOptions {
  dryRun?: boolean;
  dryRunReason?: string;
}

interface TrinityDryRunPreview {
  requestId: string;
  intakeModelCandidate: string;
  finalModelCandidate: string;
  gpt5ModelCandidate: string;
  routingPlan: string[];
  auditSafeMode: boolean;
  memoryEntryCount: number;
  auditFlags: string[];
  notes: string[];
}

interface TrinityIntakeOutput {
  framedRequest: string;
  activeModel: string;
  fallbackUsed: boolean;
  usage?: TrinityResult['meta']['tokens'];
  responseId?: string;
  created?: number;
}

interface TrinityReasoningOutput {
  output: string;
  model: string;
  fallbackUsed: boolean;
  error?: string;
}

interface TrinityFinalOutput {
  output: string;
  activeModel: string;
  fallbackUsed: boolean;
  usage?: TrinityResult['meta']['tokens'];
  responseId?: string;
  created?: number;
}

/**
 * Validates the availability of the configured AI model
 * Attempts to retrieve the default model (typically fine-tuned) from OpenAI
 * Falls back to GPT-4 if the primary model is unavailable
 * 
 * @param client - OpenAI client instance
 * @returns Promise<string> - The validated model name (either default or 'gpt-4')
 */
const validateModel = async (client: OpenAI): Promise<string> => {
  const defaultModel = getDefaultModel();
  try {
    const modelToCheck = defaultModel;
    await client.models.retrieve(modelToCheck);
    logger.info('Fine-tuned model validation successful', { 
      module: 'trinity',
      operation: 'model-validation',
      model: defaultModel,
      status: 'available'
    });
    return defaultModel;
  } catch (err) {
    //audit Assumption: model fetch can fail transiently; Failure risk: default model unavailable; Expected invariant: fallback model is usable; Handling: log and switch to GPT-4.
    logger.warn('Model unavailable, falling back to GPT-4', {
      module: 'trinity',
      operation: 'model-fallback',
      requestedModel: defaultModel,
      fallbackModel: APPLICATION_CONSTANTS.MODEL_GPT_4,
      reason: err instanceof Error ? err.message : 'Unknown error'
    });
    return APPLICATION_CONSTANTS.MODEL_GPT_4;
  }
};

function calculateMemoryScoreSummary(relevanceScores: number[]): { maxScore: number; averageScore: number } {
  //audit Assumption: relevanceScores may be empty; Failure risk: divide-by-zero; Expected invariant: averageScore is finite; Handling: default to 0.
  if (relevanceScores.length === 0) {
    return { maxScore: 0, averageScore: 0 };
  }

  const maxScore = Math.max(...relevanceScores);
  const totalScore = relevanceScores.reduce((sum, value) => sum + value, 0);
  const averageScore = totalScore / relevanceScores.length;
  return { maxScore, averageScore };
}

function buildFinalArcanosMessages(
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string
): ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: ARCANOS_SYSTEM_PROMPTS.FINAL_REVIEW(memoryContextSummary) },
    { role: 'user', content: `Original request: ${auditSafePrompt}` },
    { role: 'assistant', content: `GPT-5.2 analysis: ${gpt5Output}` },
    { role: 'user', content: 'Provide the final ARCANOS response.' }
  ];
}

function logFallbackEvent(stage: string, requestedModel: string, fallbackModel: string, reason: string) {
  //audit Assumption: fallback is a controlled resiliency behavior; Failure risk: silent model swap; Expected invariant: fallback logs remain auditable; Handling: structured warning log.
  logger.warn('Trinity fallback invoked', {
    module: 'trinity',
    operation: 'model-fallback',
    stage,
    requestedModel,
    fallbackModel,
    reason
  });
}

async function runIntakeStage(
  client: OpenAI,
  arcanosModel: string,
  auditSafePrompt: string,
  memoryContextSummary: string
): Promise<TrinityIntakeOutput> {
  const intakeSystemPrompt = ARCANOS_SYSTEM_PROMPTS.INTAKE(memoryContextSummary);
  const intakeTokenParams = getTokenParameter(arcanosModel, 500);
  const intakeResponse = await createChatCompletionWithFallback(client, {
    messages: [
      { role: 'system', content: intakeSystemPrompt },
      { role: 'user', content: auditSafePrompt }
    ],
    temperature: 0.2,
    ...intakeTokenParams
  });

  const framedRequest = intakeResponse.choices[0]?.message?.content || auditSafePrompt;
  const actualModel = intakeResponse.activeModel || arcanosModel;
  const isFallback = intakeResponse.fallbackFlag || false;

  //audit Assumption: intake response exists or fallback to audit-safe prompt; Failure risk: undefined output; Expected invariant: framedRequest is non-empty; Handling: default to auditSafePrompt.
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

async function runReasoningStage(
  client: OpenAI,
  framedRequest: string
): Promise<TrinityReasoningOutput> {
  logGPT5Invocation('Primary reasoning stage', framedRequest);
  const gpt5Result = await createGPT5Reasoning(client, framedRequest, ARCANOS_SYSTEM_PROMPTS.GPT5_REASONING());
  const gpt5ModelUsed = gpt5Result.model || getGPT5Model();
  const fallbackUsed = Boolean(gpt5Result.error);

  //audit Assumption: GPT-5.2 may fail and return fallback text; Failure risk: degraded reasoning quality; Expected invariant: gpt5Result.content is non-empty; Handling: log fallback and mark.
  if (fallbackUsed) {
    logger.warn('GPT-5.2 reasoning fallback in Trinity pipeline', {
      module: 'trinity',
      operation: 'gpt5-reasoning',
      error: gpt5Result.error
    });
  } else {
    logger.info('GPT-5.2 reasoning confirmed', {
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

async function runFinalStage(
  client: OpenAI,
  activeModel: string,
  memoryContextSummary: string,
  auditSafePrompt: string,
  gpt5Output: string
): Promise<TrinityFinalOutput> {
  const finalTokenParams = getTokenParameter(activeModel, APPLICATION_CONSTANTS.DEFAULT_TOKEN_LIMIT);
  const finalResponse = await createChatCompletionWithFallback(client, {
    messages: buildFinalArcanosMessages(memoryContextSummary, auditSafePrompt, gpt5Output),
    temperature: 0.2,
    ...finalTokenParams
  });
  const finalText = finalResponse.choices[0]?.message?.content || '';
  const finalModel = finalResponse.activeModel || activeModel;
  const finalFallback = finalResponse.fallbackFlag || false;

  //audit Assumption: final response may be empty on model failure; Failure risk: empty output; Expected invariant: finalText is string; Handling: default to empty string.
  if (finalFallback) {
    logFallbackEvent('ARCANOS-FINAL', activeModel, finalModel, 'Fallback flag set by final completion');
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

function buildDryRunPreview(
  requestId: string,
  prompt: string,
  auditSafePrompt: string,
  auditFlags: string[],
  memoryEntryCount: number,
  auditSafeMode: boolean,
  dryRunReason?: string
): TrinityDryRunPreview {
  const intakeModelCandidate = getDefaultModel();
  const finalModelCandidate = intakeModelCandidate;
  const gpt5ModelCandidate = getGPT5Model();
  const routingPlan = [
    `ARCANOS-INTAKE:${intakeModelCandidate}`,
    `GPT5-REASONING:${gpt5ModelCandidate}`,
    `ARCANOS-FINAL:${finalModelCandidate}`
  ];
  //audit Assumption: dryRunReason may be undefined; Failure risk: unclear dry run intent; Expected invariant: notes always include a reason; Handling: supply a default message.
  const dryRunNote = dryRunReason ? `Dry run reason: ${dryRunReason}.` : 'Dry run reason: not provided.';

  //audit Assumption: dry run should avoid side effects; Failure risk: accidental model calls; Expected invariant: preview contains no model outputs; Handling: only include metadata.
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

function buildAuditLogEntry(
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
  //audit Assumption: audit log is mandatory for non-dry runs; Failure risk: missing lineage; Expected invariant: audit log entry has required fields; Handling: assemble with defaults.
  return {
    timestamp: new Date().toISOString(),
    requestId,
    endpoint: 'trinity_gpt5_universal',
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

/**
 * Universal Trinity pipeline - Core AI processing workflow for ARCANOS
 * 
 * This function implements a three-stage AI processing pipeline:
 * 1. ARCANOS Intake - Initial request processing and model validation
 * 2. GPT-5.2 Reasoning - Advanced reasoning and analysis stage (always invoked)
 * 3. ARCANOS Execution - Final processing and response generation
 * 
 * Features:
 * - Automatic model validation and fallback handling
 * - Audit-safe constraint application for secure processing
 * - Memory context integration for enhanced responses
 * - Comprehensive logging and routing stage tracking
 * - Task lineage tracking for debugging and analysis
 * 
 * @param client - OpenAI client instance for API communication
 * @param prompt - User input prompt to process
 * @param sessionId - Optional session identifier for context continuity
 * @param overrideFlag - Optional audit-safe override flag for special handling
 * @param options - Optional execution options (e.g., dry run preview)
 * @returns Promise<TrinityResult> - Comprehensive result with AI response and metadata
 */
export async function runThroughBrain(
  client: OpenAI,
  prompt: string,
  sessionId?: string,
  overrideFlag?: string,
  options: TrinityRunOptions = {}
): Promise<TrinityResult> {
  const requestId = generateRequestId('trinity');

  const routingStages: string[] = [];
  const gpt5Used = true; // GPT-5.2 is now unconditional

  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  //audit Assumption: audit-safe mode can be toggled; Failure risk: incorrect mode reporting; Expected invariant: log reflects current mode; Handling: log boolean state.
  console.log(`[🔒 TRINITY AUDIT-SAFE] Mode: ${auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED'}`);

  const memoryContext = getMemoryContext(prompt, sessionId);
  console.log(`[🧠 TRINITY MEMORY] Retrieved ${memoryContext.relevantEntries.length} relevant entries`);

  //audit Assumption: relevanceScore may be undefined; Failure risk: NaN in averages; Expected invariant: scores are numeric; Handling: default missing scores to 0.
  const relevanceScores = memoryContext.relevantEntries.map(entry => entry.relevanceScore ?? 0);
  const memoryScoreSummary = calculateMemoryScoreSummary(relevanceScores);

  //audit Assumption: dry run should short-circuit before model calls; Failure risk: unintended API usage; Expected invariant: no model invocations during dry run; Handling: return preview response.
  if (options.dryRun) {
    const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    const dryRunPreview = buildDryRunPreview(
      requestId,
      prompt,
      auditSafePrompt,
      auditFlags,
      memoryContext.relevantEntries.length,
      auditConfig.auditSafeMode,
      options.dryRunReason
    );

    return {
      result: '[Dry run] Trinity pipeline preview generated.',
      module: 'dry_run',
      activeModel: 'dry_run',
      fallbackFlag: false,
      routingStages: dryRunPreview.routingPlan,
      gpt5Used,
      gpt5Model: dryRunPreview.gpt5ModelCandidate,
      dryRun: true,
      dryRunPreview,
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: ['Dry run: no model invocation']
      },
      auditSafe: {
        mode: auditConfig.auditSafeMode,
        overrideUsed: !!auditConfig.explicitOverride,
        overrideReason: auditConfig.overrideReason,
        auditFlags,
        processedSafely: true
      },
      memoryContext: {
        entriesAccessed: memoryContext.relevantEntries.length,
        contextSummary: memoryContext.contextSummary,
        //audit Assumption: memory enhancement indicates any entries present; Failure risk: false positives; Expected invariant: true only when entries exist; Handling: compare length > 0.
        memoryEnhanced: memoryContext.relevantEntries.length > 0,
        maxRelevanceScore: memoryScoreSummary.maxScore,
        averageRelevanceScore: memoryScoreSummary.averageScore
      },
      taskLineage: {
        requestId,
        logged: false
      },
      meta: {
        tokens: undefined,
        id: requestId,
        created: Date.now()
      }
    };
  }

  const arcanosModel = await validateModel(client);
  logArcanosRouting('INTAKE', arcanosModel, `Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
  routingStages.push(`ARCANOS-INTAKE:${arcanosModel}`);

  // Apply audit-safe constraints
  const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);

  // ARCANOS intake prepares framed request for GPT-5.2
  const intakeOutput = await runIntakeStage(client, arcanosModel, auditSafePrompt, memoryContext.contextSummary);
  const framedRequest = intakeOutput.framedRequest;
  const actualModel = intakeOutput.activeModel;

  // GPT-5.2 reasoning stage (always invoked)
  routingStages.push('GPT5-REASONING');
  const reasoningOutput = await runReasoningStage(client, framedRequest);
  const gpt5Output = reasoningOutput.output;
  const gpt5ModelUsed = reasoningOutput.model;

  // Final ARCANOS execution and filtering
  logArcanosRouting('FINAL_FILTERING', actualModel, 'Processing GPT-5.2 output through ARCANOS');
  routingStages.push('ARCANOS-FINAL');
  const finalOutput = await runFinalStage(client, actualModel, memoryContext.contextSummary, auditSafePrompt, gpt5Output);
  const finalText = finalOutput.output;

  const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
  //audit Assumption: output must pass audit safe checks; Failure risk: unsafe output; Expected invariant: auditFlags records failure; Handling: append flag when validation fails.
  if (!finalProcessedSafely) {
    auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
  }

  //audit Assumption: pattern storage should avoid fallback outputs; Failure risk: storing low-quality patterns; Expected invariant: store only safe, non-fallback outputs; Handling: gate on flags.
  if (finalProcessedSafely && !intakeOutput.fallbackUsed && !finalOutput.fallbackUsed) {
    storePattern(
      'Successful Trinity pipeline',
      [
        `Input pattern: ${prompt.substring(0, 50)}...`,
        `GPT-5.2 output pattern: ${gpt5Output.substring(0, 50)}...`,
        `Final output pattern: ${finalText.substring(0, 50)}...`
      ],
      sessionId
    );
  }

  logRoutingSummary(arcanosModel, true, 'ARCANOS-FINAL');

  const auditLogEntry = buildAuditLogEntry(
    requestId,
    prompt,
    finalText,
    auditConfig,
    memoryContext,
    actualModel,
    gpt5ModelUsed,
    finalProcessedSafely,
    auditFlags
  );
  logAITaskLineage(auditLogEntry);

  //audit Assumption: fallback flags reflect upstream behavior; Failure risk: missing fallback visibility; Expected invariant: summary lists all fallbacks; Handling: build summary array.
  const fallbackSummary = {
    intakeFallbackUsed: intakeOutput.fallbackUsed,
    gpt5FallbackUsed: reasoningOutput.fallbackUsed,
    finalFallbackUsed: finalOutput.fallbackUsed,
    fallbackReasons: [
      ...(intakeOutput.fallbackUsed ? ['Intake fallback used'] : []),
      ...(reasoningOutput.fallbackUsed ? ['GPT-5.2 fallback used'] : []),
      ...(finalOutput.fallbackUsed ? ['Final fallback used'] : [])
    ]
  };

  return {
    result: finalText,
    module: actualModel,
    activeModel: actualModel,
    fallbackFlag: intakeOutput.fallbackUsed || reasoningOutput.fallbackUsed || finalOutput.fallbackUsed,
    routingStages,
    gpt5Used,
    gpt5Model: gpt5ModelUsed,
    gpt5Error: reasoningOutput.error,
    dryRun: false,
    fallbackSummary,
    auditSafe: {
      mode: auditConfig.auditSafeMode,
      overrideUsed: !!auditConfig.explicitOverride,
      overrideReason: auditConfig.overrideReason,
      auditFlags,
      processedSafely: finalProcessedSafely
    },
    memoryContext: {
      entriesAccessed: memoryContext.relevantEntries.length,
      contextSummary: memoryContext.contextSummary,
      //audit Assumption: memory enhancement indicates any entries present; Failure risk: false positives; Expected invariant: true only when entries exist; Handling: compare length > 0.
      memoryEnhanced: memoryContext.relevantEntries.length > 0,
      maxRelevanceScore: memoryScoreSummary.maxScore,
      averageRelevanceScore: memoryScoreSummary.averageScore
    },
    taskLineage: {
      requestId,
      logged: true
    },
    meta: {
      tokens: finalOutput.usage || undefined,
      id: finalOutput.responseId || requestId,
      created: finalOutput.created || Date.now()
    }
  };
}
