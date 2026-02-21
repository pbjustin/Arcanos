/**
 * Trinity pipeline type definitions.
 * Used by trinity.ts and trinityStages.ts; consumers should import from trinity.js only.
 */

export interface TrinityMetaTokens {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
  confidence?: number;
}

export interface TrinityRunOptions {
  dryRun?: boolean;
  dryRunReason?: string;
  cognitiveDomain?: import('@shared/types/cognitiveDomain.js').CognitiveDomain;
  internalMode?: boolean;
}

export interface TrinityDryRunPreview {
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

export interface TrinityIntakeOutput {
  framedRequest: string;
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
}

export interface TrinityFinalOutput {
  output: string;
  activeModel: string;
  fallbackUsed: boolean;
  usage?: TrinityMetaTokens | undefined;
  responseId?: string;
  created?: number;
}
