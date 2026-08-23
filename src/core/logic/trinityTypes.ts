/**
 * Trinity pipeline type definitions.
 * Used by trinity.ts and trinityStages.ts; consumers should import from trinity.js only.
 */

import type { PreviewAskChaosHook } from '@shared/ask/previewChaos.js';
import type { IntentMode } from '@shared/text/intentModeClassifier.js';
import type {
  TrinityCapabilityFlags,
  TrinityEvidenceTag,
  TrinityReasoningHonesty,
  TrinityResponseMode,
  TrinityToolBackedCapabilities
} from './trinityHonestyTypes.js';

export type {
  TrinityCapabilityFlags,
  TrinityConfidence,
  TrinityEvidenceTag,
  TrinityReasoningHonesty,
  TrinityResponseMode,
  TrinitySourceType,
  TrinityToolBackedCapabilities,
  TrinityVerificationStatus
} from './trinityHonestyTypes.js';

export interface TrinityMetaTokens {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface TrinityProviderCompletionMetadata {
  finishReason?: string | null;
  responseStatus?: string | null;
  incompleteReason?: string | null;
  incomplete?: boolean;
  emptyOutput?: boolean;
  truncated?: boolean;
  lengthTruncated?: boolean;
  contentFiltered?: boolean;
}

export type TrinityRequestedVerbosity = 'minimal' | 'normal' | 'detailed';
export type TrinityAnswerMode = 'direct' | 'explained' | 'audit' | 'debug';
export type TrinityIntentMode = IntentMode;

export interface TrinityOutputControls {
  requestedVerbosity: TrinityRequestedVerbosity;
  maxWords: number | null;
  answerMode: TrinityAnswerMode;
  debugPipeline: boolean;
  strictUserVisibleOutput: boolean;
  intentMode?: TrinityIntentMode;
}

export interface TrinityPipelineDebug {
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
  intakeOutput: {
    framedRequest: string;
    activeModel: string;
    fallbackUsed: boolean;
  };
  reasoningOutput: {
    output: string;
    model: string;
    fallbackUsed: boolean;
    honesty: TrinityReasoningHonesty;
    reasoningLedger?: ReasoningLedger;
  };
  finalOutput: {
    rawModelOutput: string;
    translatedOutput: string;
    userVisibleResult: string;
    removedMetaSections: string[];
    blockedOrRewrittenClaims: string[];
  };
}

/**
 * Comprehensive result from the Trinity processing pipeline.
 * Includes the AI-generated response, metadata, audit information, and routing details.
 */
export interface ReasoningLedger {
  steps: string[];
  assumptions: string[];
  constraints: string[];
  tradeoffs: string[];
  alternatives: string[];
  justification: string;
  responseMode: TrinityResponseMode;
  achievableSubtasks: string[];
  blockedSubtasks: string[];
  userVisibleCaveats: string[];
  evidenceTags: TrinityEvidenceTag[];
}

export interface TrinityResult {
  result: string;
  module: string;
  meta: {
    tokens?: TrinityMetaTokens | undefined;
    id: string;
    created: number;
    pipeline?: 'trinity';
    bypass?: false;
    sourceEndpoint?: string;
    classification?: 'writing';
    gptId?: string;
    moduleId?: string;
    requestedAction?: string | null;
    executionMode?: string;
    tokenLimit?: number;
    outputLimit?: number;
    background?: Record<string, unknown>;
    provider?: TrinityProviderCompletionMetadata;
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
  tierInfo?: {
    tier: 'simple' | 'complex' | 'critical';
    originalTier?: 'simple' | 'complex' | 'critical';
    reasoningEffort?: 'high';
    reflectionApplied: boolean;
    invocationsUsed: number;
    invocationBudget: number;
    utalReason?: string;
    downgradedBy?: string | null;
    internalMode?: boolean;
    clarificationAllowed?: boolean;
    escalated?: boolean;
    escalationReason?: string;
  };
  guardInfo?: {
    elapsedMs: number;
    remainingBudgetMs: number;
    tierSoftCap: number;
    effectiveLimit: number;
    tokenCapApplied: number;
    sessionTokensUsed?: number;
    downgradeDetected: boolean;
    latencyMs: number;
    latencyDriftDetected: boolean;
  };
  reasoningLedgerStored?: boolean;
  reasoningLedger?: ReasoningLedger;
  clearAudit?: {
    clarity: number;
    leverage: number;
    efficiency: number;
    alignment: number;
    resilience: number;
    overall: number;
  };
  judgedFeedback?: {
    enabled: boolean;
    attempted: boolean;
    source: 'clear_audit';
    reason?: string;
    traceId?: string;
    accepted?: boolean;
    score?: number;
    scoreScale?: import('@shared/types/reinforcement.js').ClearScoreScale;
    normalizedScore?: number;
    persisted?: boolean;
  };
  confidence?: number;
  capabilityFlags?: TrinityCapabilityFlags;
  outputControls?: TrinityOutputControls;
  reasoningHonesty?: TrinityReasoningHonesty;
  pipelineDebug?: TrinityPipelineDebug;
  timeoutKind?: 'pipeline_timeout' | 'provider_timeout' | 'worker_timeout' | 'budget_abort';
  timeoutPhase?: string;
  degradedModeReason?: string;
  bypassedSubsystems?: string[];
}

export interface TrinityRunOptions {
  dryRun?: boolean;
  dryRunReason?: string;
  /** Disable non-essential feedback and self-improvement writes for tightly bounded workflows. */
  disableOptionalSideEffects?: boolean;
  /**
   * Preserve the caller-owned ambient AbortSignal/deadline as the sole
   * cancellation context and await cooperative stage drain on abort.
   */
  preserveAggregateAbortContext?: boolean;
  cognitiveDomain?: import('@shared/types/cognitiveDomain.js').CognitiveDomain;
  internalMode?: boolean;
  sourceEndpoint?: string;
  memorySessionId?: string;
  tokenAuditSessionId?: string;
  /** Overall Trinity watchdog model cap. Existing callers also use it as the stage cap unless overridden below. */
  watchdogModelTimeoutMs?: number;
  /** Optional per-model-stage cap when it must differ from the overall Trinity watchdog. */
  modelStageTimeoutMs?: number;
  /** Abort and drain a timed direct-answer provider call before the stage settles. */
  cooperativeModelStageTimeout?: boolean;
  toolBackedCapabilities?: TrinityToolBackedCapabilities;
  requestedVerbosity?: TrinityRequestedVerbosity;
  maxWords?: number | null;
  answerMode?: TrinityAnswerMode;
  debugPipeline?: boolean;
  strictUserVisibleOutput?: boolean;
  intentMode?: TrinityIntentMode;
  /** @deprecated Backward-compatible alias; normalize through `resolveIntentMode()` and prefer `intentMode`. */
  requestIntent?: TrinityIntentMode;
  directAnswerModelOverride?: string;
  /** Optional caller-owned direct-answer output budget; Trinity enforces the effective direct-answer cap. */
  directAnswerTokenLimitOverride?: number;
  /** Optional trusted direct-answer cap exception; invalid values fall back to Trinity's 1,200-token cap and valid values never exceed 8,000. */
  directAnswerTokenCapOverride?: number;
  /** Original user directive for honesty checks when the execution prompt contains trusted context. */
  directAnswerUserIntentPrompt?: string;
  /** Internal caller-owned directive used for policy parsing when the execution prompt contains untrusted context. */
  trustedPolicyPrompt?: string;
  /** Internal caller-owned policy appended to the direct-answer system instruction. */
  directAnswerSystemPolicyPrompt?: string;
  /** Untrusted supplemental data delivered before the primary user message; requires a nonblank system policy. */
  directAnswerUntrustedContextPrompt?: string;
  /** Redact sensitive audit/provider diagnostics and force stateless provider execution. */
  redactAuditContent?: boolean;
  reasoningStagePreviewChaosHook?: PreviewAskChaosHook;
}

export interface TrinityDryRunPreview {
  requestId: string;
  intakeModelCandidate: string;
  finalModelCandidate: string;
  gpt5ModelCandidate: string;
  routingPlan: string[];
  capabilityFlags: TrinityCapabilityFlags;
  auditSafeMode: boolean;
  memoryEntryCount: number;
  auditFlags: string[];
  notes: string[];
}

export interface TrinityIntakeOutput {
  framedRequest: string;
  capabilityFlags: TrinityCapabilityFlags;
  activeModel: string;
  fallbackUsed: boolean;
  usage?: TrinityMetaTokens | undefined;
  responseId?: string;
  created?: number;
}

export interface TrinityReasoningOutput {
  output: string;
  model: string;
  fallbackUsed: boolean;
  error?: string;
  reasoningLedger?: ReasoningLedger;
  reasoningHonesty: TrinityReasoningHonesty;
}

export interface TrinityFinalOutput {
  output: string;
  activeModel: string;
  fallbackUsed: boolean;
  usage?: TrinityMetaTokens | undefined;
  responseId?: string;
  created?: number;
  provider?: TrinityProviderCompletionMetadata;
}
