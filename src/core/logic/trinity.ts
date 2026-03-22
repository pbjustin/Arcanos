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
  createAuditSummary,
  validateAuditSafeOutput,
  type AuditLogEntry
} from "@services/auditSafe.js";
import { getMemoryContext, storePattern } from "@services/memoryAware.js";
import { getGPT5Model } from "@services/openai.js";
import { logger } from "@platform/logging/structuredLogging.js";
import type {
  TrinityResult,
  TrinityRunOptions,
  TrinityDryRunPreview,
  TrinityCapabilityFlags,
  TrinityToolBackedCapabilities,
  TrinityOutputControls,
  TrinityReasoningHonesty
} from './trinityTypes.js';
import {
  TRINITY_PREVIEW_SNIPPET_LENGTH,
  validateModel,
  calculateMemoryScoreSummary,
  runIntakeStage,
  runReasoningStage,
  runFinalStage,
  runDirectAnswerStage,
  buildDryRunPreview,
  buildAuditLogEntry
} from './trinityStages.js';
import { TRINITY_HARD_TOKEN_CAP } from './trinityConstants.js';
import { type Tier, detectTier, buildReasoningConfig, getInvocationBudget, runReflection, recordLatency, detectLatencyDrift } from './trinityTier.js';
import {
  acquireTierSlot,
  InvocationBudget,
  recordSessionTokens,
  getSessionTokenUsage,
  registerRetry,
  detectDowngrade,
  logTrinityTelemetry,
  createTrinityWatchdog
} from './trinityGuards.js';
import { getInternalArchitecturalEvaluationPrompt } from "@platform/runtime/prompts.js";
import { runClearAudit, type ClearAuditResult } from '../audit/runClearAudit.js';
import { trackEscalation } from '@analytics/escalationTracker.js';
import { getClearMinThreshold, recordRun } from '@analytics/clearAutoTuner.js';
import { runSelfImproveCycle } from '@services/selfImprove/controller.js';
import { recordTrinityJudgedFeedback } from './trinityJudgedFeedback.js';
import type { RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { createRuntimeBudget, assertBudgetAvailable, getSafeRemainingMs } from '@platform/resilience/runtimeBudget.js';
import { tryExtractExactLiteralPromptShortcut } from '@services/exactLiteralPromptShortcut.js';
import {
  deriveTrinityCapabilityFlags,
  deriveTrinityOutputControls,
  enforceFinalStageHonesty,
  enforceFinalStageHonestyAndMinimalism
} from './trinityHonesty.js';
import { resolveTrinityDirectAnswerPreference } from '@services/directAnswerMode.js';
import {
  applyTrinityDirectAnswerOutputContract,
  TRINITY_DIRECT_ANSWER_AUDIT_FLAG,
  TRINITY_DIRECT_ANSWER_STAGE
} from './trinityDirectAnswerMode.js';

const MIN_ESCALATION_BUDGET_MS = 5000;
const EXACT_LITERAL_DISPATCH_MODULE = 'exact-literal-dispatcher';
const EXACT_LITERAL_DISPATCH_STAGE = 'EXACT-LITERAL-DISPATCH';
const EXACT_LITERAL_AUDIT_FLAG = 'EXACT_LITERAL_SHORTCUT_ACTIVE';

function isInternalArchitecturalMode(prompt: string): boolean {
  const keywords = ['system directive', 'internal', 'evaluate', 'architectural'];
  const normalized = prompt.toLowerCase();
  return keywords.some(k => normalized.includes(k));
}

// Re-export public types so callers import from trinity.js only
export type {
  TrinityResult,
  TrinityRunOptions,
  TrinityDryRunPreview,
  TrinityCapabilityFlags,
  TrinityToolBackedCapabilities,
  TrinityOutputControls,
  TrinityReasoningHonesty,
  TrinityPipelineDebug,
  TrinityAnswerMode,
  TrinityRequestedVerbosity
} from './trinityTypes.js';

function buildDryRunTrinityResult(
  requestId: string,
  dryRunPreview: TrinityDryRunPreview,
  memoryContext: ReturnType<typeof getMemoryContext>,
  auditConfig: ReturnType<typeof getAuditSafeConfig>,
  auditFlags: string[],
  memoryScoreSummary: { maxScore: number; averageScore: number },
  gpt5Used: boolean,
  capabilityFlags: TrinityCapabilityFlags,
  outputControls: TrinityOutputControls,
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
    capabilityFlags,
    outputControls,
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

function truncateStructuredLogValue(value: string, maxLength = 320): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 16))}...[truncated]`;
}

function buildTrinityResult(
  finalText: string,
  actualModel: string,
  requestId: string,
  routingStages: string[],
  gpt5Used: boolean,
  gpt5ModelUsed: string | undefined,
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
  capabilityFlags: TrinityCapabilityFlags,
  outputControls: TrinityOutputControls,
  reasoningHonesty?: TrinityReasoningHonesty,
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
    capabilityFlags,
    outputControls,
    reasoningHonesty,
    reasoningLedgerStored: !!reasoningLedger,
    reasoningLedger,
    clearAudit
  };

  if (clearAudit) {
    const latencyFactor = 1.0; // Placeholder
    result.confidence = (clearAudit.overall / 5) * latencyFactor;
  }

  return result;
}

function buildSingleModelAuditLogEntry(
  requestId: string,
  prompt: string,
  finalText: string,
  auditConfig: ReturnType<typeof getAuditSafeConfig>,
  memoryContext: ReturnType<typeof getMemoryContext>,
  modelUsed: string,
  processedSafely: boolean,
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
    modelUsed,
    gpt5Delegated: false,
    memoryAccessed: memoryContext.accessLog,
    processedSafely,
    auditFlags
  };
}

function buildExactLiteralTrinityResult(params: {
  literal: string;
  requestId: string;
  created: number;
  routingStages: string[];
  auditConfig: ReturnType<typeof getAuditSafeConfig>;
  auditFlags: string[];
  finalProcessedSafely: boolean;
  memoryContext: ReturnType<typeof getMemoryContext>;
  memoryScoreSummary: { maxScore: number; averageScore: number };
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
  tier: Tier;
  reasoningConfig?: { effort: 'high' };
  budgetLimit: number;
  internalMode: boolean;
  clarificationAllowed: boolean;
}): TrinityResult {
  return {
    result: params.literal,
    module: EXACT_LITERAL_DISPATCH_MODULE,
    activeModel: EXACT_LITERAL_DISPATCH_MODULE,
    fallbackFlag: false,
    routingStages: params.routingStages,
    gpt5Used: false,
    dryRun: false,
    fallbackSummary: {
      intakeFallbackUsed: false,
      gpt5FallbackUsed: false,
      finalFallbackUsed: false,
      fallbackReasons: []
    },
    auditSafe: {
      mode: params.auditConfig.auditSafeMode,
      overrideUsed: !!params.auditConfig.explicitOverride,
      overrideReason: params.auditConfig.overrideReason,
      auditFlags: params.auditFlags,
      processedSafely: params.finalProcessedSafely
    },
    memoryContext: {
      entriesAccessed: params.memoryContext.relevantEntries.length,
      contextSummary: params.memoryContext.contextSummary,
      memoryEnhanced: params.memoryContext.relevantEntries.length > 0,
      maxRelevanceScore: params.memoryScoreSummary.maxScore,
      averageRelevanceScore: params.memoryScoreSummary.averageScore
    },
    taskLineage: {
      requestId: params.requestId,
      logged: true
    },
    meta: {
      tokens: undefined,
      id: params.requestId,
      created: params.created
    },
    capabilityFlags: params.capabilityFlags,
    outputControls: params.outputControls,
    tierInfo: {
      tier: params.tier,
      reasoningEffort: params.reasoningConfig?.effort,
      reflectionApplied: false,
      invocationsUsed: 0,
      invocationBudget: params.budgetLimit,
      internalMode: params.internalMode,
      clarificationAllowed: params.clarificationAllowed
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
 * @param runtimeBudget - Shared worker runtime budget; Trinity must operate within this budget
 * @returns Promise<TrinityResult> - Comprehensive result with AI response and metadata
 */
export async function runThroughBrain(
  client: OpenAI,
  prompt: string,
  sessionId?: string,
  overrideFlag?: string,
  options: TrinityRunOptions = {},
  runtimeBudget: RuntimeBudget = createRuntimeBudget(),
  internalContext?: { escalated: boolean; originalTier: Tier }
): Promise<TrinityResult> {
  assertBudgetAvailable(runtimeBudget);

  const requestId = generateRequestId('trinity');
  const routingStages: string[] = [];
  const gpt5Used = true;
  const start = Date.now();
  const effectiveMemorySessionId = options.memorySessionId ?? sessionId;
  const effectiveTokenAuditSessionId = options.tokenAuditSessionId ?? sessionId;
  const outputControls = deriveTrinityOutputControls(prompt, options);

  // --- Tier detection ---
  const tier = internalContext?.originalTier ? getNextTier(internalContext.originalTier) : detectTier(prompt);
  const reasoningConfig = buildReasoningConfig(tier);
  const maxBudget = getInvocationBudget(tier);
  const budget = new InvocationBudget(maxBudget);
  const capabilityFlags = deriveTrinityCapabilityFlags(options.toolBackedCapabilities);

  const internalMode = options.internalMode ?? isInternalArchitecturalMode(prompt);
  const internalDirective = internalMode ? getInternalArchitecturalEvaluationPrompt() : undefined;
  const clarificationAllowed = !internalMode;
  const directAnswerPreferenceReason = internalMode
    ? null
    : resolveTrinityDirectAnswerPreference(prompt);
  const prefersDirectAnswerMode = directAnswerPreferenceReason !== null;

  // --- Retry lineage check ---
  registerRetry(requestId);

  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  logger.info('Trinity audit-safe mode', {
    module: 'trinity', operation: 'audit-safe',
    mode: auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED',
    tier,
    escalated: !!internalContext?.escalated
  });

  const memoryContext = getMemoryContext(prompt, effectiveMemorySessionId);
  const relevanceScores = memoryContext.relevantEntries.map(entry => entry.relevanceScore ?? 0);
  const memoryScoreSummary = calculateMemoryScoreSummary(relevanceScores);

  if (options.dryRun) {
    const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    const dryRunPreview = buildDryRunPreview(requestId, prompt, auditSafePrompt, capabilityFlags, auditFlags, memoryContext.relevantEntries.length, auditConfig.auditSafeMode, options.dryRunReason);
    return buildDryRunTrinityResult(
      requestId,
      dryRunPreview,
      memoryContext,
      auditConfig,
      auditFlags,
      memoryScoreSummary,
      gpt5Used,
      capabilityFlags,
      outputControls,
      tier,
      reasoningConfig,
      budget.used(),
      budget.limit(),
      internalMode,
      clarificationAllowed
    );
  }

  const exactLiteralShortcut = tryExtractExactLiteralPromptShortcut(prompt);
  //audit Assumption: explicit exact-literal prompts should bypass generative model stages to preserve strict caller-visible output contracts; failure risk: queued and direct `/ask` responses add explanatory text or formatting around required literals; expected invariant: recognized exact-literal prompts return the extracted literal verbatim and skip model invocation; handling strategy: short-circuit before concurrency, OpenAI calls, and translation layers.
  if (exactLiteralShortcut) {
    const createdAt = Date.now();
    const { auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    routingStages.push(EXACT_LITERAL_DISPATCH_STAGE);
    auditFlags.push(EXACT_LITERAL_AUDIT_FLAG);

    const finalProcessedSafely = validateAuditSafeOutput(exactLiteralShortcut.literal, auditConfig);
    if (!finalProcessedSafely) {
      auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
    }

    const auditLogEntry = buildSingleModelAuditLogEntry(
      requestId,
      prompt,
      exactLiteralShortcut.literal,
      auditConfig,
      memoryContext,
      EXACT_LITERAL_DISPATCH_MODULE,
      finalProcessedSafely,
      auditFlags
    );
    logAITaskLineage(auditLogEntry);

    const latencyMs = createdAt - start;
    recordLatency(latencyMs);
    logTrinityTelemetry({
      tier,
      totalTokens: 0,
      downgradeDetected: false,
      latencyMs,
      reflectionApplied: false,
      requestId
    });
    recordRun(!!internalContext?.escalated);

    const shortcutResult = buildExactLiteralTrinityResult({
      literal: exactLiteralShortcut.literal,
      requestId,
      created: createdAt,
      routingStages,
      auditConfig,
      auditFlags,
      finalProcessedSafely,
      memoryContext,
      memoryScoreSummary,
      capabilityFlags,
      outputControls,
      tier,
      reasoningConfig,
      budgetLimit: budget.limit(),
      internalMode,
      clarificationAllowed
    });
    shortcutResult.judgedFeedback = await recordTrinityJudgedFeedback({
      requestId,
      prompt,
      response: exactLiteralShortcut.literal,
      tier,
      sessionId: effectiveMemorySessionId,
      sourceEndpoint: options.sourceEndpoint,
      internalMode,
      remainingBudgetMs: getSafeRemainingMs(runtimeBudget)
    });
    return shortcutResult;
  }

  // --- Concurrency governor + watchdog ---
  const [release] = await acquireTierSlot(tier);
  const { watchdog, tierSoftCap, effectiveLimit } = createTrinityWatchdog(
    tier,
    runtimeBudget,
    getGPT5Model(),
    options.watchdogModelTimeoutMs
  );
  const checkWatchdog = () => {
    assertBudgetAvailable(runtimeBudget);
    watchdog.check();
  };

  try {
    const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);
    const cognitiveDomain = options.cognitiveDomain;

    //audit Assumption: explicit anti-simulation prompts on the main Trinity route should bypass persona-heavy multi-stage framing; failure risk: the normal intake/final pipeline or translator reintroduces theatrical language after the operator asked for a direct answer; expected invariant: direct-answer mode performs one guarded model call with strict output cleanup while preserving telemetry, audit, and budget controls; handling strategy: branch inside the guarded execution window when the prompt explicitly requests direct, non-simulated output.
    if (prefersDirectAnswerMode) {
      budget.increment();
      checkWatchdog();

      logger.info('trinity.direct_answer.auto_selected', {
        module: 'trinity',
        operation: 'direct-answer-selection',
        requestId,
        tier,
        reason: directAnswerPreferenceReason
      });

      logArcanosRouting('DIRECT_ANSWER', getGPT5Model(), `Tier: ${tier}, Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
      routingStages.push(TRINITY_DIRECT_ANSWER_STAGE);
      auditFlags.push(TRINITY_DIRECT_ANSWER_AUDIT_FLAG);

      const directAnswerOutput = await runDirectAnswerStage(
        client,
        memoryContext.contextSummary,
        auditSafePrompt,
        cognitiveDomain,
        runtimeBudget,
        requestId
      );
      checkWatchdog();

      const finalText = applyTrinityDirectAnswerOutputContract(directAnswerOutput.output, prompt);
      const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
      if (!finalProcessedSafely) {
        auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
      }

      if (finalProcessedSafely && !directAnswerOutput.fallbackUsed) {
        storePattern(getTrinityMessages().pattern_storage_label, [
          `Input pattern: ${auditSafePrompt.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
          `Final output pattern: ${finalText.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`
        ], effectiveMemorySessionId);
      }

      logRoutingSummary(directAnswerOutput.activeModel, false, TRINITY_DIRECT_ANSWER_STAGE);

      const auditLogEntry = buildSingleModelAuditLogEntry(
        requestId,
        prompt,
        finalText,
        auditConfig,
        memoryContext,
        directAnswerOutput.activeModel,
        finalProcessedSafely,
        auditFlags
      );
      logAITaskLineage(auditLogEntry);

      const totalTokens = directAnswerOutput.usage?.total_tokens ?? 0;
      if (effectiveTokenAuditSessionId) {
        recordSessionTokens(effectiveTokenAuditSessionId, totalTokens);
      }

      const latencyMs = Date.now() - start;
      recordLatency(latencyMs);
      const latencyDriftDetected = detectLatencyDrift();
      logTrinityTelemetry({
        tier,
        totalTokens,
        downgradeDetected: false,
        latencyMs,
        reflectionApplied: false,
        requestId
      });
      recordRun(!!internalContext?.escalated);

      const directAnswerFallbackSummary = {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: directAnswerOutput.fallbackUsed,
        fallbackReasons: [
          ...(directAnswerOutput.fallbackUsed ? ['Direct-answer fallback used'] : [])
        ]
      };

      const result = buildTrinityResult(
        finalText,
        directAnswerOutput.activeModel,
        requestId,
        routingStages,
        false,
        undefined,
        undefined,
        directAnswerFallbackSummary,
        auditConfig,
        auditFlags,
        finalProcessedSafely,
        memoryContext,
        memoryScoreSummary,
        directAnswerOutput.usage,
        directAnswerOutput.responseId,
        directAnswerOutput.created,
        capabilityFlags,
        outputControls
      );

      result.tierInfo = {
        tier,
        originalTier: internalContext?.originalTier,
        reasoningEffort: reasoningConfig?.effort,
        reflectionApplied: false,
        invocationsUsed: budget.used(),
        invocationBudget: budget.limit(),
        utalReason: "UTAL Keyword Density",
        internalMode,
        clarificationAllowed,
        escalated: !!internalContext?.escalated,
        escalationReason: internalContext?.escalated ? 'low_clear_score' : undefined
      };
      result.guardInfo = {
        elapsedMs: watchdog.elapsed(),
        remainingBudgetMs: getSafeRemainingMs(runtimeBudget),
        tierSoftCap,
        effectiveLimit,
        tokenCapApplied: TRINITY_HARD_TOKEN_CAP,
        sessionTokensUsed: effectiveTokenAuditSessionId ? getSessionTokenUsage(effectiveTokenAuditSessionId) : undefined,
        downgradeDetected: false,
        latencyMs,
        latencyDriftDetected
      };
      result.judgedFeedback = await recordTrinityJudgedFeedback({
        requestId,
        prompt: auditSafePrompt,
        response: finalText,
        tier,
        sessionId: effectiveMemorySessionId,
        sourceEndpoint: options.sourceEndpoint,
        internalMode,
        remainingBudgetMs: result.guardInfo.remainingBudgetMs
      });

      return result;
    }

    // --- Stage 1: Intake ---
    budget.increment();
    checkWatchdog();

    const arcanosModel = await validateModel(client, runtimeBudget);
    logArcanosRouting('INTAKE', arcanosModel, `Tier: ${tier}, Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
    routingStages.push(`ARCANOS-INTAKE:${arcanosModel}`);

    const intakeOutput = await runIntakeStage(
      client,
      arcanosModel,
      auditSafePrompt,
      memoryContext.contextSummary,
      capabilityFlags,
      outputControls,
      cognitiveDomain,
      internalDirective,
      runtimeBudget
    );
    const framedRequest = intakeOutput.framedRequest;
    const actualModel = intakeOutput.activeModel;

    // --- Stage 2: Reasoning ---
    budget.increment();
    checkWatchdog();

    routingStages.push('GPT5-REASONING');
    const reasoningOutput = await runReasoningStage(
      client,
      framedRequest,
      capabilityFlags,
      outputControls,
      tier,
      runtimeBudget
    );
    let gpt5Output = reasoningOutput.output;
    const gpt5ModelUsed = reasoningOutput.model;
    const reasoningLedger = reasoningOutput.reasoningLedger;
    const reasoningHonesty = reasoningOutput.reasoningHonesty;

    //audit Assumption: blocked subtasks should remain visible to later stages and observability; failure risk: a partially impossible request is treated as fully answerable downstream; expected invariant: mixed-feasibility requests set an explicit audit flag; handling strategy: record a stable flag when reasoning identifies blocked work.
    if (reasoningHonesty.blockedSubtasks.length > 0) {
      auditFlags.push('PARTIAL_REFUSAL_ACTIVE');
    }

    // --- CLEAR Audit & Escalation Logic ---
    let clearAudit: ClearAuditResult | undefined = undefined;
    if (reasoningLedger) {
      checkWatchdog();
      clearAudit = await runClearAudit(client, reasoningLedger);
      // Self-improve loop trigger (non-blocking): feed CLEAR into controller.
      try {
        void runSelfImproveCycle({
          trigger: 'clear',
          clearOverall: clearAudit.overall,
          clearMin: getClearMinThreshold(),
          context: { requestId, tier }
        }).catch(() => {});
      } catch {
        // ignore
      }

      checkWatchdog();

      if (clearAudit.overall < getClearMinThreshold() && 
          tier !== 'critical' && 
          !internalContext?.escalated && 
          getSafeRemainingMs(runtimeBudget) > MIN_ESCALATION_BUDGET_MS) {
        
        logger.info('Low CLEAR score detected, triggering single-hop escalation', {
          requestId, tier, clearScore: clearAudit.overall, threshold: getClearMinThreshold()
        });

        // Release current slot before escalating
        // Release current slot before escalating - removed as finally block handles it

        const escalatedResult = await runThroughBrain(client, prompt, sessionId, overrideFlag, options, runtimeBudget, {
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
      checkWatchdog();

      const critique = await runReflection(client, gpt5Output, tier, runtimeBudget);
      if (critique) {
        gpt5Output += '\n\n--- CRITICAL REVIEW ---\n' + critique;
        reflectionApplied = true;
        routingStages.push('GPT5-REFLECTION');
      }
    }

    // --- Stage 3: Final ---
    checkWatchdog();

    logArcanosRouting('FINAL_FILTERING', actualModel, 'Processing GPT-5.1 output through ARCANOS');
    routingStages.push('ARCANOS-FINAL');
    const finalOutput = await runFinalStage(
      client,
      memoryContext.contextSummary,
      auditSafePrompt,
      gpt5Output,
      capabilityFlags,
      outputControls,
      reasoningHonesty,
      cognitiveDomain,
      internalDirective,
      runtimeBudget
    );
    checkWatchdog();

    const userIntent = MidLayerTranslator.detectIntentFromUserMessage(prompt);
    const translatedFinalText = MidLayerTranslator.translate({ raw: finalOutput.output }, userIntent);
    const honestyFilteredFinal = enforceFinalStageHonesty(
      translatedFinalText,
      reasoningHonesty,
      capabilityFlags,
    );
    const enforcedFinalOutput = enforceFinalStageHonestyAndMinimalism({
      text: honestyFilteredFinal.text,
      userPrompt: prompt,
      capabilityFlags,
      outputControls,
      reasoningHonesty
    });
    const finalText = enforcedFinalOutput.text;

    //audit Assumption: verification-stage regressions are easiest to diagnose when the raw final model output and post-honesty result are logged together; failure risk: worker logs show only a generic DAG failure while hiding the exact guard rewrite; expected invariant: DAG audit nodes emit one bounded structured trace around final-stage enforcement; handling strategy: log only for the audit source endpoint and truncate large text fields.
    if (options.sourceEndpoint === 'dag.agent.audit') {
      logger.info('Trinity DAG verification enforcement', {
        module: 'trinity',
        operation: 'dag-verification-enforcement',
        requestId,
        sourceEndpoint: options.sourceEndpoint,
        responseMode: reasoningHonesty.responseMode,
        rawModelOutputPreview: truncateStructuredLogValue(finalOutput.output),
        translatedOutputPreview: truncateStructuredLogValue(translatedFinalText),
        finalUserVisiblePreview: truncateStructuredLogValue(finalText),
        blockedCategories: honestyFilteredFinal.blockedCategories,
        blockedOrRewrittenClaims: enforcedFinalOutput.blockedOrRewrittenClaims
      });
    }

    //audit Assumption: final-stage honesty rewrites must remain traceable for postmortems even when user-visible output is compressed.
    if (honestyFilteredFinal.blocked) {
      auditFlags.push('FINAL_UNSUPPORTED_CLAIM_BLOCKED');
      for (const blockedCategory of honestyFilteredFinal.blockedCategories) {
        auditFlags.push(`FINAL_UNSUPPORTED_${blockedCategory.toUpperCase()}_BLOCKED`);
      }
    }

    const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
    if (!finalProcessedSafely) {
      auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
    }
    if (reasoningHonesty.responseMode === 'partial_refusal') {
      auditFlags.push('PARTIAL_REFUSAL_ACTIVE');
    }
    //audit Assumption: final-stage rewrites should be observable internally without leaking user-facing debug data; failure risk: unsupported-claim blockers become invisible in postmortems; expected invariant: audit flags record any deterministic final-stage intervention; handling strategy: stamp one flag per intervention type when changes occur.
    if (enforcedFinalOutput.removedMetaSections.length > 0) {
      auditFlags.push('FINAL_UNREQUESTED_META_REMOVED');
    }
    if (enforcedFinalOutput.blockedOrRewrittenClaims.length > 0) {
      auditFlags.push('FINAL_UNSUPPORTED_CLAIM_REWRITTEN');
      reasoningHonesty.blockedOrRewrittenClaims = enforcedFinalOutput.blockedOrRewrittenClaims;
    }

    if (finalProcessedSafely && !intakeOutput.fallbackUsed && !finalOutput.fallbackUsed) {
      storePattern(getTrinityMessages().pattern_storage_label, [
        `Input pattern: ${auditSafePrompt.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
        `GPT-5.1 output pattern: ${gpt5Output.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`,
        `Final output pattern: ${finalText.substring(0, TRINITY_PREVIEW_SNIPPET_LENGTH)}...`
      ], effectiveMemorySessionId);
    }

    logRoutingSummary(arcanosModel, true, 'ARCANOS-FINAL');

    const auditLogEntry: AuditLogEntry = buildAuditLogEntry(requestId, prompt, finalText, auditConfig, memoryContext, actualModel, gpt5ModelUsed, finalProcessedSafely, auditFlags);
    logAITaskLineage(auditLogEntry);

    // --- Post-execution guards ---
    const totalTokens = (finalOutput.usage?.total_tokens ?? 0) + (intakeOutput.usage?.total_tokens ?? 0);
    //audit Assumption: DAG and worker flows may need a shared memory session but isolated token-audit buckets; failure risk: large multi-node runs exhaust one conversational token ceiling despite independent node work; expected invariant: memory continuity and token auditing can use different session identifiers when explicitly provided; handling strategy: audit against the optional token session id while preserving the original memory session for context lookup and storage.
    if (effectiveTokenAuditSessionId) {
      recordSessionTokens(effectiveTokenAuditSessionId, totalTokens);
    }

    const downgradeDetected = detectDowngrade(getGPT5Model(), gpt5ModelUsed);
    if (internalMode && downgradeDetected) {
      logger.warn('Model downgrade detected in Internal Architectural Mode - proceeding with degraded model', {
        module: 'trinity',
        operation: 'downgrade-guard',
        requested: getGPT5Model(),
        actual: gpt5ModelUsed
      });
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
      finalOutput.created,
      capabilityFlags,
      outputControls,
      reasoningHonesty,
      reasoningLedger,
      clearAudit
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
      elapsedMs: watchdog.elapsed(),
      remainingBudgetMs: getSafeRemainingMs(runtimeBudget),
      tierSoftCap,
      effectiveLimit,
      tokenCapApplied: TRINITY_HARD_TOKEN_CAP,
      sessionTokensUsed: effectiveTokenAuditSessionId ? getSessionTokenUsage(effectiveTokenAuditSessionId) : undefined,
      downgradeDetected,
      latencyMs,
      latencyDriftDetected
    };

    result.judgedFeedback = await recordTrinityJudgedFeedback({
      requestId,
      prompt: auditSafePrompt,
      response: finalText,
      clearAudit,
      tier,
      sessionId: effectiveMemorySessionId,
      sourceEndpoint: options.sourceEndpoint,
      internalMode,
      remainingBudgetMs: result.guardInfo.remainingBudgetMs
    });

    if (outputControls.debugPipeline) {
      result.pipelineDebug = {
        capabilityFlags,
        outputControls,
        intakeOutput: {
          framedRequest,
          activeModel: actualModel,
          fallbackUsed: intakeOutput.fallbackUsed
        },
        reasoningOutput: {
          output: gpt5Output,
          model: gpt5ModelUsed,
          fallbackUsed: reasoningOutput.fallbackUsed,
          honesty: reasoningHonesty,
          reasoningLedger
        },
        finalOutput: {
          rawModelOutput: finalOutput.output,
          translatedOutput: translatedFinalText,
          userVisibleResult: finalText,
          removedMetaSections: enforcedFinalOutput.removedMetaSections,
          blockedOrRewrittenClaims: enforcedFinalOutput.blockedOrRewrittenClaims
        }
      };
    }

    return result;

  } finally {
    release();
  }
}
