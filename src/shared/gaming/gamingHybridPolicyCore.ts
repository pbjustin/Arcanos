/** These pure decisions are shared by normal services and the sealed preview. */
export const GAMING_HYBRID_RETAINED_ARTIFACT_CHARS = 12_000_000;

/** Missing official proof can continue; conflicting proof or stale gameplay alone cannot. */
export function resolveGamingHybridCurrentnessReason(input: {
  classification: 'stable' | 'patch_sensitive' | 'seasonal' | 'live_status';
  freshnessStatus: 'current' | 'stale' | 'unverified' | 'not_applicable' | 'conflicting';
  hasGameplayEvidence: boolean;
  reasons: readonly string[];
}): string | undefined {
  if (!input.hasGameplayEvidence || input.classification === 'stable' || input.freshnessStatus === 'conflicting') return undefined;
  const permittedReasons = input.classification === 'live_status' ? ['LIVE_OFFICIAL_STATUS_REQUIRED']
    : ['CURRENT_OFFICIAL_INDEX_REQUIRED', 'REVALIDATION_DUE', 'CURRENT_BUILD_UNVERIFIED'];
  return permittedReasons.find(reason => input.reasons.includes(reason));
}

export interface GamingHybridCandidateAttemptInput {
  operationKey?: string;
  requestedKey: string;
  round: number;
  nextAction?: string;
  maxRounds: number;
  expectedAction?: 'search' | 'verify_currentness';
}

/** Payload binding and concurrent promise reuse remain the caller's responsibility. */
export function resolveGamingHybridCandidateAttempt(input: GamingHybridCandidateAttemptInput): 'begin' | 'resume' | 'deny' {
  if (input.operationKey === input.requestedKey) return 'resume';
  return input.round >= input.maxRounds || input.nextAction !== (input.expectedAction ?? 'search') ? 'deny' : 'begin';
}

export interface GamingHybridPublicCandidateDecision {
  candidateId?: string;
  url?: string;
  decision: string;
  reasonCodes: string[];
  sourceCategory?: string;
  origin?: 'submitted' | 'required_official_article';
}

/** Retention capacity does not decide whether bounded transient evidence can answer. */
export function projectGamingHybridCandidateRetention(input: {
  retainedChars: number;
  candidateChars: number;
  decisions: readonly GamingHybridPublicCandidateDecision[];
}): { retainArtifacts: boolean; decisions: GamingHybridPublicCandidateDecision[] } {
  const retainArtifacts = input.retainedChars + input.candidateChars <= GAMING_HYBRID_RETAINED_ARTIFACT_CHARS;
  const decisions = input.decisions.map(({ candidateId, url, decision, reasonCodes, sourceCategory, origin }) => ({
    ...(retainArtifacts && candidateId ? { candidateId } : {}), url,
    decision: !retainArtifacts && candidateId ? 'accepted_transient' : decision,
    reasonCodes: (!retainArtifacts && candidateId ? ['ARTIFACT_CAPACITY_REACHED', ...reasonCodes] : reasonCodes).slice(0, 8),
    sourceCategory, ...(origin ? { origin } : {})
  }));
  return { retainArtifacts, decisions };
}

/** Hash equality cannot approve a newly truncated or instruction-filtered refetch. */
export function isGamingApprovedArtifactCurrent(input: {
  approvedContentHash: string;
  documentContentHash: string;
  instructionFiltered: boolean;
  truncated: boolean;
}): boolean {
  return input.approvedContentHash === input.documentContentHash && !input.instructionFiltered && !input.truncated;
}
