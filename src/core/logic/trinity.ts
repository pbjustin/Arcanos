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
import { detectTier, buildReasoningConfig, getInvocationBudget, runReflection, recordLatency, detectLatencyDrift, type Tier } from './trinityTier.js';
import {
  acquireTierSlot,
  Watchdog,
  InvocationBudget,
  recordSessionTokens,
  getSessionTokenUsage,
  registerRetry,
  detectDowngrade,
  logTrinityTelemetry,
  computeWatchdog
} from './trinityGuards.js';
import { getInternalArchitecturalEvaluationPrompt } from "@platform/runtime/prompts.js";
import { runClearAudit, type ClearAuditResult } from '../audit/runClearAudit.js';
import { trackEscalation } from '../../analytics/escalationTracker.js';
import { getClearMinThreshold, recordRun } from '../../analytics/clearAutoTuner.js';

function isInternalArchitecturalMode(prompt: string): boolean {
  const keywords = ['system directive', 'internal', 'evaluate', 'architectural'];
  const normalized = prompt.toLowerCase();
  return keywords.some(k => normalized.includes(k));
}

// Re-export public types so callers import from trinity.js only
export type { TrinityResult, TrinityRunOptions, TrinityDryRunPreview } from './trinityTypes.js';

function buildDryRunTrinityResult(
  requestId: string,
  dryRunPreview: TrinityDryRunPreview,
  memoryContext: ReturnType<typeof getMemoryContext>,
  auditConfig: ReturnType<typeof getAuditSafeConfig>,
  auditFlags: string[],
  memoryScoreSummary: { maxScore: number; averageScore: number },
  gpt5Used: boolean,
  tier?: Tier,
  reasoningConfig?: { effort: 'high' },
  budgetUsed?: number,
  budgetLimit?: number,
  internalMode?: boolean,
  clarificationAllowed?: boolean
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
    },
    tierInfo: tier ? {
      tier,
      reasoningEffort: reasoningConfig?.effort,
      reflectionApplied: false,
      invocationsUsed: budgetUsed ?? 0,
      invocationBudget: budgetLimit ?? 0,
      internalMode,
      clarificationAllowed
    } : undefined
  };
}

function getNextTier(tier: Tier): Tier {
  if (tier === 'simple') return 'complex';
  return 'critical';
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
  created: number | undefined,
  reasoningLedger?: TrinityResult['reasoningLedger'],
  clearAudit?: ClearAuditResult
): TrinityResult {
  const result: TrinityResult = {
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
    },
    reasoningLedgerStored: !!reasoningLedger,
    reasoningLedger,
    clearAudit
  };

  if (clearAudit) {
    const latencyFactor = 1.0; // Placeholder
    const escalationBonus = 1.1; // Placeholder
    result.confidence = (clearAudit.overall / 5) * latencyFactor;
  }

  return result;
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
  options: TrinityRunOptions = {},
  internalContext?: { escalated: boolean; originalTier: Tier }
): Promise<TrinityResult> {
  const requestId = generateRequestId('trinity');
  const routingStages: string[] = [];
  const gpt5Used = true;
  const start = Date.now();

  // --- Tier detection ---
  const tier = internalContext?.originalTier ? getNextTier(internalContext.originalTier) : detectTier(prompt);
  const reasoningConfig = buildReasoningConfig(tier);
  const maxBudget = getInvocationBudget(tier);
  const budget = new InvocationBudget(maxBudget);

  const internalMode = isInternalArchitecturalMode(prompt);
  const internalDirective = internalMode ? getInternalArchitecturalEvaluationPrompt() : undefined;
  const clarificationAllowed = !internalMode;

  // --- Retry lineage check ---
  registerRetry(requestId);

  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  logger.info('Trinity audit-safe mode', {
    module: 'trinity', operation: 'audit-safe',
    mode: auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED',
    tier,
    escalated: !!internalContext?.escalated
  });

  const memoryContext = getMemoryContext(prompt, sessionId);
  const relevanceScores = memoryContext.relevantEntries.map(entry => entry.relevanceScore ?? 0);
  const memoryScoreSummary = calculateMemoryScoreSummary(relevanceScores);

  if (options.dryRun) {
    const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    const dryRunPreview = buildDryRunPreview(requestId, prompt, auditSafePrompt, auditFlags, memoryContext.relevantEntries.length, auditConfig.auditSafeMode, options.dryRunReason);
    return buildDryRunTrinityResult(requestId, dryRunPreview, memoryContext, auditConfig, auditFlags, memoryScoreSummary, gpt5Used, tier, reasoningConfig, budget.used(), budget.limit(), internalMode, clarificationAllowed);
  }

  // --- Concurrency governor + watchdog ---
  const [release] = await acquireTierSlot(tier);
  const watchdog = new Watchdog(computeWatchdog(tier, !!internalContext?.escalated));

  try {
    // --- Stage 1: Intake ---
    budget.increment();
    watchdog.check();

    const arcanosModel = await validateModel(client);
    logArcanosRouting('INTAKE', arcanosModel, `Tier: ${tier}, Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
    routingStages.push(`ARCANOS-INTAKE:${arcanosModel}`);

    const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    const cognitiveDomain = options.cognitiveDomain;

    const intakeOutput = await runIntakeStage(client, arcanosModel, auditSafePrompt, memoryContext.contextSummary, cognitiveDomain, internalDirective);
    const framedRequest = intakeOutput.framedRequest;
    const actualModel = intakeOutput.activeModel;

    // --- Stage 2: Reasoning ---
    budget.increment();
    watchdog.check();

    routingStages.push('GPT5-REASONING');
    const reasoningOutput = await runReasoningStage(client, framedRequest, tier);
    let gpt5Output = reasoningOutput.output;
    const gpt5ModelUsed = reasoningOutput.model;
    const reasoningLedger = reasoningOutput.reasoningLedger;

    // --- CLEAR Audit & Escalation Logic ---
    let clearAudit: ClearAuditResult | undefined = undefined;
    if (reasoningLedger) {
      clearAudit = await runClearAudit(client, reasoningLedger);
      
      const MIN_ESCALATION_BUDGET = 5000;
      if (clearAudit.overall < getClearMinThreshold() && 
          tier !== 'critical' && 
          !internalContext?.escalated && 
          (watchdog.limit() - watchdog.elapsed()) > MIN_ESCALATION_BUDGET) {
        
        logger.info('Low CLEAR score detected, triggering single-hop escalation', {
          requestId, tier, clearScore: clearAudit.overall, threshold: getClearMinThreshold()
        });

        // Release current slot before escalating
        release();

        const escalatedResult = await runThroughBrain(client, prompt, sessionId, overrideFlag, options, {
          escalated: true,
          originalTier: tier
        });

        // Track escalation analytics
        trackEscalation({
          runId: requestId,
          originalTier: tier,
          escalatedTier: escalatedResult.tierInfo?.tier as Tier,
          clearScoreInitial: clearAudit.overall,
          clearScoreFinal: escalatedResult.clearAudit?.overall ?? 0,
          clearImprovement: (escalatedResult.clearAudit?.overall ?? 0) - clearAudit.overall,
          latencyInitial: watchdog.elapsed(),
          latencyFinal: escalatedResult.guardInfo?.latencyMs ?? 0,
          tokenUsageInitial: (intakeOutput.usage?.total_tokens ?? 0) + (reasoningOutput.fallbackUsed ? 0 : 0), // Partial usage
          tokenUsageFinal: escalatedResult.meta.tokens?.total_tokens ?? 0
        });

        return escalatedResult;
      }
    }

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
    const finalOutput = await runFinalStage(client, memoryContext.contextSummary, auditSafePrompt, gpt5Output, cognitiveDomain, internalDirective);

    const userIntent = MidLayerTranslator.detectIntentFromUserMessage(prompt);
    const finalText = MidLayerTranslator.translate({ raw: finalOutput.output }, userIntent);

    const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
    if (!finalProcessedSafely) {
      auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
    }

    if (finalProcessedSafely && !intakeOutput.fallbackUsed && !finalOutput.fallbackUsed) {
      storePattern(getTrinityMessages().pattern_storage_label, [
        `Input pattern: ${auditSafePrompt.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
        `GPT-5.1 output pattern: ${gpt5Output.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
        `Final output pattern: ${finalText.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`
      ], sessionId);
    }

    logRoutingSummary(arcanosModel, true, 'ARCANOS-FINAL');

    const auditLogEntry: AuditLogEntry = buildAuditLogEntry(requestId, prompt, finalText, auditConfig, memoryContext, actualModel, gpt5ModelUsed, finalProcessedSafely, auditFlags);
    logAITaskLineage(auditLogEntry);

    // --- Post-execution guards ---
    const totalTokens = (finalOutput.usage?.total_tokens ?? 0) + (intakeOutput.usage?.total_tokens ?? 0);
    if (sessionId) {
      recordSessionTokens(sessionId, totalTokens);
    }

    const downgradeDetected = detectDowngrade(getGPT5Model(), gpt5ModelUsed);
    if (internalMode && downgradeDetected) {
      throw new Error('STRICT_EXECUTION_ERROR: Model downgrade not allowed in Internal Architectural Mode.');
    }

    const latencyMs = Date.now() - start;
    recordLatency(latencyMs);
    const latencyDriftDetected = detectLatencyDrift();

    logTrinityTelemetry({ tier, totalTokens, downgradeDetected, latencyMs, reflectionApplied, requestId });

    // Record run for auto-tuning
    recordRun(!!internalContext?.escalated);

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
      finalText, actualModel, requestId, routingStages, gpt5Used, gpt5ModelUsed, reasoningOutput.error, fallbackSummary, auditConfig, auditFlags, finalProcessedSafely, memoryContext, memoryScoreSummary, finalOutput.usage, finalOutput.responseId, finalOutput.created,
      reasoningLedger, clearAudit
    );

    result.tierInfo = {
      tier,
      originalTier: internalContext?.originalTier,
      reasoningEffort: reasoningConfig?.effort,
      reflectionApplied,
      invocationsUsed: budget.used(),
      invocationBudget: budget.limit(),
      utalReason: "UTAL Keyword Density",
      internalMode,
      clarificationAllowed,
      escalated: !!internalContext?.escalated,
      escalationReason: internalContext?.escalated ? 'low_clear_score' : undefined
    };
    result.guardInfo = {
      watchdogMs: watchdog.elapsed(),
      watchdogLimit: watchdog.limit(),
      tokenCapApplied: TRINITY_HARD_TOKEN_CAP,
      sessionTokensUsed: sessionId ? getSessionTokenUsage(sessionId) : undefined,
      downgradeDetected,
      latencyMs,
      latencyDriftDetected,
      latencyUtilization: watchdog.elapsed() / watchdog.limit(),
      latencyMargin: watchdog.limit() - watchdog.elapsed()
    };

    return result;

  } finally {
    release();
  }
}
