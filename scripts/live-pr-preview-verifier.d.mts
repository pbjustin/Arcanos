export const LIVE_PREVIEW_MODE: 'live-backend-v1';
export const LIVE_PREVIEW_ACCEPTANCE_PROFILE: 'grounded-audited-answer-v1';
export type LivePreviewCaseId = 'useful_grounded_guide' | 'incompatible_source' | 'insufficient_evidence'
  | 'acquisition_failure' | 'model_timeout' | 'audit_timeout' | 'exhausted_budget' | 'unauthorized_test_identity';
export type LivePreviewStage = 'authorization' | 'budget' | 'source_acquisition' | 'source_validation'
  | 'generation' | 'answer_audit' | 'delivery';
export type LivePreviewStageStatus = 'not_run' | 'passed' | 'rejected' | 'failed' | 'timed_out' | 'exhausted' | 'unobserved';
export type LivePreviewFailureCode = 'INCOMPATIBLE_SOURCE' | 'INSUFFICIENT_EVIDENCE' | 'ACQUISITION_FAILURE'
  | 'MODEL_TIMEOUT' | 'AUDIT_TIMEOUT' | 'BUDGET_EXHAUSTED' | 'UNAUTHORIZED_TEST_IDENTITY';
export interface LivePreviewIdentity {
  sourceCommit: string;
  approvedSourceCommit: string;
  deploymentId: string;
  moduleId: string;
  mode: 'live-backend-v1';
}
export interface LivePreviewUsage {
  /** Cumulative provider reservations and observed billing for the run. */
  requests: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedTotalTokens: number;
  reservedSpendMicroUsd: number;
  observedInputTokens: number;
  observedOutputTokens: number;
  observedSpendMicroUsd: number;
  elapsedMs: number;
  /** Per-case deltas, so admission failures require exactly zero provider calls. */
  providerCalls: number;
  generationCalls: number;
  auditCalls: number;
  limits: {
    maxRequests: number;
    maxInputTokensPerRequest: number;
    maxOutputTokensPerRequest: number;
    maxTotalTokens: number;
    durationMs: number;
    maxSpendMicroUsd: number;
    maxConcurrency: 1;
    maxRetries: 0;
  };
}
/** Normalized input profile for adapter authors; source-specific public contracts remain unchanged. */
export interface LivePreviewNormalizedAnswer {
  ok: boolean;
  dryRun?: boolean;
  incomplete?: boolean;
  data: {
    response: string;
    sources: Array<{ url: string; snippet?: string; error?: unknown }>;
    grounding?: {
      groundingStatus: 'grounded' | 'insufficient_evidence' | 'unavailable';
      groundedInSuppliedEvidence: boolean;
      fetchedSuppliedSourceCount: number;
      usableSourceCount: number;
      citableSourceCount: number;
      selectedChunkCount: number;
      suppliedEvidenceSourceCount: number;
    };
    fallbackReason?: unknown;
    dryRun?: boolean;
    incomplete?: boolean;
    executionOutcome?: string;
  };
}
export interface LivePreviewEvidenceInput {
  caseId: LivePreviewCaseId;
  /** Adapter-normalized grounded answer; module-specific public contracts remain outside this verifier. */
  result?: unknown;
  /** Backend-owned actual audit observation and binding to the delivered final answer. */
  audit?: { assessmentStatus: 'completed' | 'unavailable' | 'not_run';
    decision: 'accept' | 'partial' | 'reject' | 'clarify' | 'unavailable'; boundToFinalAnswer: boolean };
  usage: LivePreviewUsage;
  failureCode?: LivePreviewFailureCode | null;
  stages: Partial<Record<LivePreviewStage, LivePreviewStageStatus>>;
}
export interface LivePreviewEvidence {
  schemaVersion: 1;
  acceptanceProfile: 'grounded-audited-answer-v1';
  identity: LivePreviewIdentity;
  caseId: LivePreviewCaseId;
  failureCode: LivePreviewFailureCode | 'UNOBSERVED_FAILURE' | null;
  stages: Record<LivePreviewStage, LivePreviewStageStatus>;
  audit: { assessmentStatus: 'completed' | 'unavailable' | 'not_run' | 'unobserved';
    decision: 'accept' | 'partial' | 'reject' | 'clarify' | 'unavailable' | 'unobserved'; boundToFinalAnswer: boolean };
  result: {
    ok: boolean;
    answerPresent: boolean;
    fallback: boolean;
    dryRun: boolean;
    incomplete: boolean;
    acceptedAnswer: boolean;
    grounding: { status: 'grounded' | 'insufficient_evidence' | 'unavailable' | 'unobserved';
      groundedInSuppliedEvidence: boolean; fetchedSuppliedSourceCount: number | null; usableSourceCount: number | null;
      citableSourceCount: number | null; selectedChunkCount: number | null; suppliedEvidenceSourceCount: number | null };
    sources: Array<{ index: number; url: string | null; documentUrlSha256: string | null; usable: boolean }>;
    citationIndices: number[];
    citationsResolved: boolean;
  };
  usage: { [Field in keyof Omit<LivePreviewUsage, 'limits'>]: number | null } & {
    limits: { [Field in keyof LivePreviewUsage['limits']]: number | null };
  };
  verification: { syntheticPreview: 'unverified'; liveBackend: 'unverified'; installedPluginOAuth: 'unverified' };
  remainingGaps: string[];
}
export interface LivePreviewCaseVerification {
  status: 'PASS' | 'FAIL';
  code: 'LIVE_PREVIEW_CASE_PASS' | 'LIVE_PREVIEW_CASE_FAILED';
  caseId: LivePreviewCaseId | 'unobserved';
  accepted: boolean;
  checks: Array<{ id: string; status: 'PASS' | 'FAIL' }>;
}
export const LIVE_PREVIEW_CASE_MANIFEST: ReadonlyArray<Readonly<{
  caseId: LivePreviewCaseId;
  failureCode: LivePreviewFailureCode | null;
  provider: 'none' | 'generation_only' | 'generation_and_audit';
  stages: Readonly<Record<LivePreviewStage, LivePreviewStageStatus>>;
}>>;
export function createLivePreviewEvidence(identity: LivePreviewIdentity, input: LivePreviewEvidenceInput): LivePreviewEvidence;
export function verifyLivePreviewEvidence(evidence: unknown, expectedIdentity: LivePreviewIdentity): LivePreviewCaseVerification;
export function verifyLivePreviewSuite(evidence: unknown, expectedIdentity: LivePreviewIdentity): {
  status: 'PASS' | 'FAIL'; code: 'LIVE_BACKEND_PREVIEW_CONTRACT_PASS' | 'LIVE_BACKEND_PREVIEW_CONTRACT_FAILED';
  cases: LivePreviewCaseVerification[];
  verification: { syntheticPreview: 'unverified'; liveBackend: 'unverified'; installedPluginOAuth: 'unverified' };
  remainingGaps: string[];
};

/** Closed projection of saved evidence; never retains raw payloads or source paths. */
export function sanitizeLivePreviewEvidence(evidence: unknown): unknown;
