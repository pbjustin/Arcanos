import { z } from 'zod';

/** Additive opt-in contract; legacy Gaming dispatch and source Actions keep their shapes. */
export const GAMING_HYBRID_CONTRACT_VERSION = 'gaming-hybrid-v1' as const;
export const GAMING_HYBRID_V2_CONTRACT_VERSION = 'gaming-hybrid-v2' as const;
export type GamingHybridContractVersion = typeof GAMING_HYBRID_CONTRACT_VERSION | typeof GAMING_HYBRID_V2_CONTRACT_VERSION;
export const GAMING_HYBRID_LIMITS = {
  // Gameplay discovery and official corroboration are distinct, non-renewable operations.
  discoveryRounds: 1, currentnessRounds: 1, candidates: 3, workflowTtlMs: 10 * 60_000,
  workflows: 128, workflowsPerActor: 8, operationsPerActor: 24,
  rateWindowMs: 5 * 60_000, candidateTimeoutMs: 12_000, polls: 3
} as const;
// V1 limits remain unchanged. Gameplay recovery is an explicit v2 opt-in.
export const GAMING_HYBRID_V2_LIMITS = {
  ...GAMING_HYBRID_LIMITS, discoveryRounds: 2, totalCandidateUrls: 6, totalCandidateTimeoutMs: 24_000
} as const;
export const gamingHybridLimitsForVersion = (version: GamingHybridContractVersion) =>
  version === GAMING_HYBRID_V2_CONTRACT_VERSION ? GAMING_HYBRID_V2_LIMITS : GAMING_HYBRID_LIMITS;
const version = z.enum([GAMING_HYBRID_CONTRACT_VERSION, GAMING_HYBRID_V2_CONTRACT_VERSION]);
const idempotencyKey = z.string().trim().min(8).max(120).regex(/^[a-zA-Z0-9._:-]+$/u);
export const gamingHybridStoragePolicySchema = z.enum(['transient_only', 'ask_before_store', 'auto_store_approved']);
const gamingHybridQueryFields = {
  idempotencyKey,
  question: z.string().trim().min(1).max(4_000), game: z.string().trim().min(1).max(120),
  mode: z.enum(['guide', 'build', 'meta']).default('guide'),
  storagePolicy: gamingHybridStoragePolicySchema.default('transient_only'),
  platform: z.string().trim().min(1).max(64).optional(), edition: z.string().trim().min(1).max(120).optional(),
  version: z.string().trim().min(1).max(64).optional(), requestedVersion: z.string().trim().min(1).max(64).optional(),
  region: z.string().trim().min(1).max(64).optional(), difficulty: z.string().trim().min(1).max(64).optional(),
  currentArea: z.string().trim().min(1).max(160).optional(), lastCompletedObjective: z.string().trim().min(1).max(240).optional(),
  progressPoint: z.string().trim().min(1).max(160).optional(), class: z.string().trim().min(1).max(64).optional(),
  role: z.string().trim().min(1).max(64).optional(), constraints: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  spoilerTolerance: z.enum(['none', 'light', 'full', 'avoid', 'allowed', 'unknown', 'no spoilers', 'ok', 'spoilers ok']).optional(),
  answerDepth: z.enum(['auto', 'concise', 'standard', 'detailed']).optional()
};
export const gamingHybridQuerySchema = z.discriminatedUnion('contractVersion', [
  z.object({ contractVersion: z.literal(GAMING_HYBRID_CONTRACT_VERSION), ...gamingHybridQueryFields }).strict(),
  z.object({ contractVersion: z.literal(GAMING_HYBRID_V2_CONTRACT_VERSION), ...gamingHybridQueryFields }).strict()
]);
export const gamingHybridCandidateSchema = z.object({
  url: z.string().min(1).max(2_048), title: z.string().max(240).optional(),
  discoveredAt: z.string().max(64).optional(), discoveryMethod: z.string().max(64).optional(),
  claimedGame: z.string().max(120).optional(), claimedPatch: z.string().max(64).optional(),
  claimedPublisher: z.string().max(120).optional(), claimedCategory: z.string().max(64).optional()
}).strict();
const gamingHybridCandidatesFields = {
  workflowId: z.string().uuid(), idempotencyKey,
  discoveryType: z.enum(['gameplay_evidence', 'currentness_verification']).optional(),
  candidates: z.array(gamingHybridCandidateSchema).min(1).max(GAMING_HYBRID_LIMITS.candidates)
};
export const gamingHybridCandidatesSchema = z.discriminatedUnion('contractVersion', [
  z.object({ contractVersion: z.literal(GAMING_HYBRID_CONTRACT_VERSION), ...gamingHybridCandidatesFields }).strict(),
  z.object({ contractVersion: z.literal(GAMING_HYBRID_V2_CONTRACT_VERSION), ...gamingHybridCandidatesFields,
    expectedRevision: z.number().int().min(0).max(1_000_000) }).strict()
]);
export const gamingHybridIngestionSchema = z.object({
  contractVersion: version, workflowId: z.string().uuid(), idempotencyKey,
  candidateIds: z.array(z.string().uuid()).min(1).max(GAMING_HYBRID_LIMITS.candidates),
  storagePolicy: gamingHybridStoragePolicySchema, confirmStore: z.boolean().default(false)
}).strict();
export type GamingHybridQuery = z.infer<typeof gamingHybridQuerySchema>;
export type GamingHybridState = 'answer_ready' | 'clarification_required' | 'discovery_required' | 'temporarily_unavailable' | 'ingestion_pending';
export interface GamingHybridResponse {
  contractVersion: GamingHybridContractVersion;
  requestId: string;
  revision?: number;
  selectedCandidateIds?: string[];
  selectedEvidenceIds?: string[];
  coverageSatisfied?: boolean;
  missingCoverage?: string[];
  gapAssessmentStatus?: 'assessed' | 'unknown' | 'not_assessed';
  requirementSupport?: Array<{ requirement: string; candidateIds: string[]; evidenceIds: string[] }>;
  workflowId?: string;
  state: GamingHybridState;
  nextAction: 'answer' | 'clarify' | 'search' | 'verify_currentness' | 'retry_later' | 'poll_ingestion' | 'stop';
  reason: string;
  sourceKnown: boolean;
  evidenceSelected: boolean;
  freshnessStatus: 'current' | 'stale' | 'unverified' | 'not_applicable' | 'conflicting';
  verifiedAsOf?: string;
  effectivePatch?: string;
  effectiveBuild?: string;
  applicabilityStatus?: 'verified_current' | 'partially_verified' | 'stale' | 'conflicting' | 'unverified';
  gameplayEvidenceStatus?: 'accepted_transient' | 'currentness_pending' | 'freshness_verified' | 'stale' | 'unverified';
  acceptedGameplayCandidateCount?: number;
  currentnessRequirements?: Array<'official_source_required' | 'current_patch_or_build_required' | 'hotfix_check_required_if_supported' | 'official_live_status_required'>;
  qualification?: string;
  clarification?: string;
  discovery?: { type?: 'gameplay_evidence' | 'currentness_verification'; round: number; maxRounds: number; maxCandidates: number; searchQueries: string[];
    continuationRequired?: boolean; replacementAllowed?: boolean; recoveryRemaining?: number;
    nextSubmissionCandidateLimit?: number; remainingTotalAcquisitionMs?: number; remainingCandidateUrls?: number;
    acquisitionHints?: Array<{ scope: 'url' | 'domain'; target: string; reasonCode: string; observedAt: string; expiresAt: string }>;
    reviewedSources?: Array<{ url: string; ruleId: string; role: 'current_index' | 'live_status' }> };
  candidates?: Array<{ candidateId?: string; url?: string; decision: string; reasonCodes: string[]; sourceCategory?: string;
    origin?: 'submitted' | 'required_official_article' }>;
  answer?: { response: string; sources: Array<{ url: string; title?: string; sourceId?: string; patchVersion?: string; fetchedAt?: string }>; provenance: 'arcanos-trinity'; requestId: string };
  ingestion?: { ingestionId: string; status: string; statusUrl: string; maxPolls: number };
}
