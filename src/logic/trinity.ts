/**
 * Trinity Brain - Core AI Processing Pipeline
 *
 * Implements the ARCANOS Trinity architecture, a three-stage AI processing workflow:
 *
 * 1. **ARCANOS Intake**: Prepares and frames user requests with memory context
 * 2. **GPT-5.1 Reasoning**: Performs advanced reasoning and deep analysis (always invoked)
 * 3. **ARCANOS Execution**: Synthesizes results and generates final responses
 *
 * The Trinity pipeline is the primary entry point for all AI processing in ARCANOS.
 * Import only from this module; do not import trinityTypes or trinityStages from app/route code.
 *
 * @module trinity
 */

import OpenAI from 'openai';
import { logArcanosRouting, logRoutingSummary } from '../utils/aiLogger.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { getTrinityMessages } from '../config/prompts.js';
import {
  getAuditSafeConfig,
  applyAuditSafeConstraints,
  logAITaskLineage,
  validateAuditSafeOutput,
  type AuditLogEntry
} from '../services/auditSafe.js';
import { getMemoryContext, storePattern } from '../services/memoryAware.js';
import type { TrinityResult, TrinityRunOptions, TrinityDryRunPreview } from './trinityTypes.js';
import {
  TRINITY_PREVIEW_SNIPPET_LENGTH,
  validateModel,
  calculateMemoryScoreSummary,
  runIntakeStage,
  runReasoningStage,
  runFinalStage,
  buildDryRunPreview,
  buildAuditLogEntry
} from './trinityStages.js';

// Re-export public types so callers import from trinity.js only
export type { TrinityResult, TrinityRunOptions, TrinityDryRunPreview } from './trinityTypes.js';

function buildDryRunTrinityResult(
  requestId: string,
  dryRunPreview: TrinityDryRunPreview,
  memoryContext: ReturnType<typeof getMemoryContext>,
  auditConfig: ReturnType<typeof getAuditSafeConfig>,
  auditFlags: string[],
  memoryScoreSummary: { maxScore: number; averageScore: number },
  gpt5Used: boolean
): TrinityResult {
  const msg = getTrinityMessages();
  return {
    result: msg.dry_run_result_message,
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
      fallbackReasons: [msg.dry_run_no_invocation_reason]
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

function buildTrinityResult(
  finalText: string,
  actualModel: string,
  requestId: string,
  routingStages: string[],
  gpt5Used: boolean,
  gpt5ModelUsed: string,
  gpt5Error: string | undefined,
  fallbackSummary: TrinityResult['fallbackSummary'],
  auditConfig: ReturnType<typeof getAuditSafeConfig>,
  auditFlags: string[],
  finalProcessedSafely: boolean,
  memoryContext: ReturnType<typeof getMemoryContext>,
  memoryScoreSummary: { maxScore: number; averageScore: number },
  usage: TrinityResult['meta']['tokens'],
  responseId: string | undefined,
  created: number | undefined
): TrinityResult {
  return {
    result: finalText,
    module: actualModel,
    activeModel: actualModel,
    fallbackFlag: fallbackSummary.intakeFallbackUsed || fallbackSummary.gpt5FallbackUsed || fallbackSummary.finalFallbackUsed,
    routingStages,
    gpt5Used,
    gpt5Model: gpt5ModelUsed,
    gpt5Error,
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
      memoryEnhanced: memoryContext.relevantEntries.length > 0,
      maxRelevanceScore: memoryScoreSummary.maxScore,
      averageRelevanceScore: memoryScoreSummary.averageScore
    },
    taskLineage: {
      requestId,
      logged: true
    },
    meta: {
      tokens: usage ?? undefined,
      id: responseId ?? requestId,
      created: created ?? Date.now()
    }
  };
}

/**
 * Universal Trinity pipeline - Core AI processing workflow for ARCANOS
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
  const gpt5Used = true;

  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  console.log(`[🔒 TRINITY AUDIT-SAFE] Mode: ${auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED'}`);

  const memoryContext = getMemoryContext(prompt, sessionId);
  console.log(`[🧠 TRINITY MEMORY] Retrieved ${memoryContext.relevantEntries.length} relevant entries`);

  const relevanceScores = memoryContext.relevantEntries.map(entry => entry.relevanceScore ?? 0);
  const memoryScoreSummary = calculateMemoryScoreSummary(relevanceScores);

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
    return buildDryRunTrinityResult(
      requestId,
      dryRunPreview,
      memoryContext,
      auditConfig,
      auditFlags,
      memoryScoreSummary,
      gpt5Used
    );
  }

  const arcanosModel = await validateModel(client);
  logArcanosRouting('INTAKE', arcanosModel, `Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
  routingStages.push(`ARCANOS-INTAKE:${arcanosModel}`);

  const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);

  const intakeOutput = await runIntakeStage(client, arcanosModel, auditSafePrompt, memoryContext.contextSummary);
  const framedRequest = intakeOutput.framedRequest;
  const actualModel = intakeOutput.activeModel;

  routingStages.push('GPT5-REASONING');
  const reasoningOutput = await runReasoningStage(client, framedRequest);
  const gpt5Output = reasoningOutput.output;
  const gpt5ModelUsed = reasoningOutput.model;

  logArcanosRouting('FINAL_FILTERING', actualModel, 'Processing GPT-5.1 output through ARCANOS');
  routingStages.push('ARCANOS-FINAL');
  const finalOutput = await runFinalStage(client, actualModel, memoryContext.contextSummary, auditSafePrompt, gpt5Output);
  const finalText = finalOutput.output;

  const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
  if (!finalProcessedSafely) {
    auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
  }

  if (finalProcessedSafely && !intakeOutput.fallbackUsed && !finalOutput.fallbackUsed) {
    storePattern(
      getTrinityMessages().pattern_storage_label,
      [
        `Input pattern: ${auditSafePrompt.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
        `GPT-5.1 output pattern: ${gpt5Output.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
        `Final output pattern: ${finalText.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`
      ],
      sessionId
    );
  }

  logRoutingSummary(arcanosModel, true, 'ARCANOS-FINAL');

  const auditLogEntry: AuditLogEntry = buildAuditLogEntry(
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

  const fallbackSummary = {
    intakeFallbackUsed: intakeOutput.fallbackUsed,
    gpt5FallbackUsed: reasoningOutput.fallbackUsed,
    finalFallbackUsed: finalOutput.fallbackUsed,
    fallbackReasons: [
      ...(intakeOutput.fallbackUsed ? ['Intake fallback used'] : []),
      ...(reasoningOutput.fallbackUsed ? ['GPT-5.1 fallback used'] : []),
      ...(finalOutput.fallbackUsed ? ['Final fallback used'] : [])
    ]
  };

  return buildTrinityResult(
    finalText,
    actualModel,
    requestId,
    routingStages,
    gpt5Used,
    gpt5ModelUsed,
    reasoningOutput.error,
    fallbackSummary,
    auditConfig,
    auditFlags,
    finalProcessedSafely,
    memoryContext,
    memoryScoreSummary,
    finalOutput.usage,
    finalOutput.responseId,
    finalOutput.created
  );
}
