import { z } from 'zod';

/** Additive opt-in contract; legacy Gaming dispatch and source Actions keep their shapes. */
export const GAMING_HYBRID_CONTRACT_VERSION = 'gaming-hybrid-v1' as const;
export const GAMING_HYBRID_LIMITS = {
  // Existing frontend evidence policy allows one attempt; do not widen it here.
  discoveryRounds: 1, candidates: 3, workflowTtlMs: 10 * 60_000,
  workflows: 128, workflowsPerActor: 8, operationsPerActor: 24,
  rateWindowMs: 5 * 60_000, candidateTimeoutMs: 12_000, polls: 3
} as const;
const version = z.literal(GAMING_HYBRID_CONTRACT_VERSION);
const idempotencyKey = z.string().trim().min(8).max(120).regex(/^[a-zA-Z0-9._:-]+$/u);
export const gamingHybridStoragePolicySchema = z.enum(['transient_only', 'ask_before_store', 'auto_store_approved']);
export const gamingHybridQuerySchema = z.object({
  contractVersion: version, idempotencyKey,
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
}).strict();
export const gamingHybridCandidateSchema = z.object({
  url: z.string().trim().min(1).max(2_048), title: z.string().max(240).optional(),
  discoveredAt: z.string().max(64).optional(), discoveryMethod: z.string().max(64).optional(),
  claimedGame: z.string().max(120).optional(), claimedPatch: z.string().max(64).optional(),
  claimedPublisher: z.string().max(120).optional(), claimedCategory: z.string().max(64).optional()
}).strict();
export const gamingHybridCandidatesSchema = z.object({
  contractVersion: version, workflowId: z.string().uuid(), idempotencyKey,
  candidates: z.array(gamingHybridCandidateSchema).min(1).max(GAMING_HYBRID_LIMITS.candidates)
}).strict();
export const gamingHybridIngestionSchema = z.object({
  contractVersion: version, workflowId: z.string().uuid(), idempotencyKey,
  candidateIds: z.array(z.string().uuid()).min(1).max(GAMING_HYBRID_LIMITS.candidates),
  storagePolicy: gamingHybridStoragePolicySchema, confirmStore: z.boolean().default(false)
}).strict();
export type GamingHybridQuery = z.infer<typeof gamingHybridQuerySchema>;
export type GamingHybridState = 'answer_ready' | 'clarification_required' | 'discovery_required' | 'temporarily_unavailable' | 'ingestion_pending';
export interface GamingHybridResponse {
  contractVersion: typeof GAMING_HYBRID_CONTRACT_VERSION;
  requestId: string;
  workflowId?: string;
  state: GamingHybridState;
  nextAction: 'answer' | 'clarify' | 'search' | 'retry_later' | 'poll_ingestion' | 'stop';
  reason: string;
  sourceKnown: boolean;
  evidenceSelected: boolean;
  freshnessStatus: 'current' | 'stale' | 'unverified' | 'not_applicable' | 'conflicting';
  verifiedAsOf?: string;
  effectivePatch?: string;
  effectiveBuild?: string;
  qualification?: string;
  clarification?: string;
  discovery?: { round: number; maxRounds: number; maxCandidates: number; searchQueries: string[] };
  candidates?: Array<{ candidateId?: string; url?: string; decision: string; reasonCodes: string[]; sourceCategory?: string }>;
  answer?: { response: string; sources: Array<{ url: string; title?: string; sourceId?: string; patchVersion?: string; fetchedAt?: string }>; provenance: 'arcanos-trinity'; requestId: string };
  ingestion?: { ingestionId: string; status: string; statusUrl: string; maxPolls: number };
}
