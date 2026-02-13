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

import type OpenAI from 'openai';
import { logArcanosRouting, logRoutingSummary } from "@platform/logging/aiLogger.js";
import { generateRequestId } from "@shared/idGenerator.js";
import { getTrinityMessages } from "@platform/runtime/prompts.js";
import { MidLayerTranslator } from "@services/midLayerTranslator.js";
import {
  getAuditSafeConfig,
  applyAuditSafeConstraints,
  logAITaskLineage,
  validateAuditSafeOutput,
  type AuditLogEntry
} from "@services/auditSafe.js";
import { getMemoryContext, storePattern } from "@services/memoryAware.js";
import { getGPT5Model } from "@services/openai.js";
import { logger } from "@platform/logging/structuredLogging.js";
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
import { TRINITY_HARD_TOKEN_CAP } from './trinityConstants.js';
import { detectTier, buildReasoningConfig, getInvocationBudget, runReflection, recordLatency, detectLatencyDrift } from './trinityTier.js';
import {
  acquireTierSlot,
  Watchdog,
  InvocationBudget,
  recordSessionTokens,
  getSessionTokenUsage,
  registerRetry,
  detectDowngrade,
  logTrinityTelemetry
} from './trinityGuards.js';

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
  const start = Date.now();

  // --- Tier detection ---
  const tier = detectTier(prompt);
  const reasoningConfig = buildReasoningConfig(tier);
  const maxBudget = getInvocationBudget(tier);
  const budget = new InvocationBudget(maxBudget);

  // --- Retry lineage check ---
  registerRetry(requestId);

  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  logger.info('Trinity audit-safe mode', {
    module: 'trinity', operation: 'audit-safe',
    mode: auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED',
    tier
  });

  const memoryContext = getMemoryContext(prompt, sessionId);
  logger.info('Trinity memory context', {
    module: 'trinity', operation: 'memory',
    entries: memoryContext.relevantEntries.length
  });

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

  // --- Concurrency governor + watchdog ---
  const [release] = await acquireTierSlot(tier);
  const watchdog = new Watchdog();

  try {
    // --- Stage 1: Intake ---
    budget.increment();
    watchdog.check();

    const arcanosModel = await validateModel(client);
    logArcanosRouting('INTAKE', arcanosModel, `Tier: ${tier}, Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
    routingStages.push(`ARCANOS-INTAKE:${arcanosModel}`);

    const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    const cognitiveDomain = options.cognitiveDomain;

    const intakeOutput = await runIntakeStage(client, arcanosModel, auditSafePrompt, memoryContext.contextSummary, cognitiveDomain);
    const framedRequest = intakeOutput.framedRequest;
    const actualModel = intakeOutput.activeModel;

    // --- Stage 2: Reasoning ---
    budget.increment();
    watchdog.check();

    routingStages.push('GPT5-REASONING');
    const reasoningOutput = await runReasoningStage(client, framedRequest);
    let gpt5Output = reasoningOutput.output;
    const gpt5ModelUsed = reasoningOutput.model;

    // --- Stage 2.5: Reflection (critical tier only) ---
    let reflectionApplied = false;
    if (tier === 'critical') {
      budget.increment();
      watchdog.check();

      const critique = await runReflection(client, gpt5Output, tier);
      if (critique) {
        gpt5Output += '\n\n--- CRITICAL REVIEW ---\n' + critique;
        reflectionApplied = true;
        routingStages.push('GPT5-REFLECTION');
      }
    }

    // --- Stage 3: Final ---
    watchdog.check();

    logArcanosRouting('FINAL_FILTERING', actualModel, 'Processing GPT-5.1 output through ARCANOS');
    routingStages.push('ARCANOS-FINAL');
    const finalOutput = await runFinalStage(client, memoryContext.contextSummary, auditSafePrompt, gpt5Output, cognitiveDomain);

    // Mid-layer translation: strip system/audit artifacts, humanize the response
    const userIntent = MidLayerTranslator.detectIntentFromUserMessage(prompt);
    const finalText = MidLayerTranslator.translate({ raw: finalOutput.output }, userIntent);

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

    // --- Post-execution guards ---
    const totalTokens = (finalOutput.usage?.total_tokens ?? 0) +
      (intakeOutput.usage?.total_tokens ?? 0);

    if (sessionId) {
      recordSessionTokens(sessionId, totalTokens);
    }

    const downgradeDetected = detectDowngrade(getGPT5Model(), gpt5ModelUsed);

    const latencyMs = Date.now() - start;
    recordLatency(latencyMs);
    const latencyDriftDetected = detectLatencyDrift();

    logTrinityTelemetry({
      tier,
      totalTokens,
      downgradeDetected,
      latencyMs,
      reflectionApplied,
      requestId
    });

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

    const result = buildTrinityResult(
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

    // Attach tier and guard metadata
    result.tierInfo = {
      tier,
      reasoningEffort: reasoningConfig?.effort,
      reflectionApplied,
      invocationsUsed: budget.used(),
      invocationBudget: budget.limit(),
      utalReason: "UTAL Keyword Density"
    };
    result.guardInfo = {
      watchdogMs: watchdog.elapsed(),
      tokenCapApplied: TRINITY_HARD_TOKEN_CAP,
      sessionTokensUsed: sessionId ? getSessionTokenUsage(sessionId) : undefined,
      downgradeDetected,
      latencyMs,
      latencyDriftDetected
    };

    return result;

  } finally {
    release();
  }
}
