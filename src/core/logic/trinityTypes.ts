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
} from './trinityHonesty.js';

export type {
  TrinityCapabilityFlags,
  TrinityEvidenceTag,
  TrinityReasoningHonesty,
  TrinityResponseMode,
  TrinityToolBackedCapabilities
} from './trinityHonesty.js';

export interface TrinityMetaTokens {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
  degradedModeReason?: string;
  bypassedSubsystems?: string[];
}

export interface TrinityRunOptions {
  dryRun?: boolean;
  dryRunReason?: string;
  cognitiveDomain?: import('@shared/types/cognitiveDomain.js').CognitiveDomain;
  internalMode?: boolean;
  sourceEndpoint?: string;
  memorySessionId?: string;
  tokenAuditSessionId?: string;
  watchdogModelTimeoutMs?: number;
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
}
