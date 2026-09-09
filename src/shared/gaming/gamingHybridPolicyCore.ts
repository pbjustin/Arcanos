/** These pure decisions are shared by normal services and the sealed preview. */
export const GAMING_HYBRID_RETAINED_ARTIFACT_CHARS = 12_000_000;

export interface GamingHybridCandidateAttemptInput {
  operationKey?: string;
  requestedKey: string;
  round: number;
  nextAction?: string;
  maxRounds: number;
}

/** Payload binding and concurrent promise reuse remain the caller's responsibility. */
export function resolveGamingHybridCandidateAttempt(input: GamingHybridCandidateAttemptInput): 'begin' | 'resume' | 'deny' {
  if (input.operationKey === input.requestedKey) return 'resume';
  return input.round >= input.maxRounds || input.nextAction !== 'search' ? 'deny' : 'begin';
}

export interface GamingHybridPublicCandidateDecision {
  candidateId?: string;
  url?: string;
  decision: string;
  reasonCodes: string[];
  sourceCategory?: string;
}

/** Retention capacity does not decide whether bounded transient evidence can answer. */
export function projectGamingHybridCandidateRetention(input: {
  retainedChars: number;
  candidateChars: number;
  decisions: readonly GamingHybridPublicCandidateDecision[];
}): { retainArtifacts: boolean; decisions: GamingHybridPublicCandidateDecision[] } {
  const retainArtifacts = input.retainedChars + input.candidateChars <= GAMING_HYBRID_RETAINED_ARTIFACT_CHARS;
  const decisions = input.decisions.map(({ candidateId, url, decision, reasonCodes, sourceCategory }) => ({
    ...(retainArtifacts && candidateId ? { candidateId } : {}), url,
    decision: !retainArtifacts && candidateId ? 'accepted_transient' : decision,
    reasonCodes: (!retainArtifacts && candidateId ? ['ARTIFACT_CAPACITY_REACHED', ...reasonCodes] : reasonCodes).slice(0, 8),
    sourceCategory
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
