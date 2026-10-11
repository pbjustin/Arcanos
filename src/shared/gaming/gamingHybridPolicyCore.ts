import type { GamingHybridResponse, GamingGuideOutcome } from './gamingHybridContract.js';
import type { GamingFreshnessEvidence } from './gamingFreshnessCore.js';
import type { GamingStoredKnowledgeContext } from './gamingStoredEvidenceCore.js';
import { GAMING_GUIDE_PUBLIC_TOPIC_LEXEMES } from './gamingPreferenceData.js';

/** These pure decisions are shared by normal services and the sealed preview. */
export const GAMING_HYBRID_RETAINED_ARTIFACT_CHARS = 12_000_000;

/** A bounded currentness attempt is distinct from selecting grounded gameplay evidence. */
export function resolveGamingHybridCurrentnessReason(input: {
  classification: 'stable' | 'patch_sensitive' | 'seasonal' | 'live_status';
  freshnessStatus: 'current' | 'stale' | 'unverified' | 'not_applicable' | 'conflicting';
  hasGameplayEvidence: boolean;
  reasons: readonly string[];
}): string | undefined {
  if (!input.hasGameplayEvidence || input.classification === 'stable' || input.freshnessStatus === 'conflicting') return undefined;
  const permittedReasons = input.classification === 'live_status' ? ['LIVE_OFFICIAL_STATUS_REQUIRED']
    : ['CURRENT_OFFICIAL_INDEX_REQUIRED', 'REVALIDATION_DUE', 'CURRENT_BUILD_UNVERIFIED',
      'CURRENT_PATCH_COVERAGE_MISSING', 'NO_LONGER_EFFECTIVE'];
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

/** A successful refetch replaces prior positive evidence at its URL, while contradictions remain evidence. */
export function projectGamingHybridCandidateEvidence(input: {
  prior?: GamingStoredKnowledgeContext;
  knowledge: GamingStoredKnowledgeContext;
  acceptedFreshness: readonly GamingFreshnessEvidence[];
  priorFreshness?: readonly GamingFreshnessEvidence[];
  currentnessEvidence?: readonly GamingFreshnessEvidence[];
}): { knowledge: GamingStoredKnowledgeContext; freshness: GamingFreshnessEvidence[] } {
  const refreshedUrls = new Set(input.acceptedFreshness.map(item => item.url));
  return {
    knowledge: { context: '', sources: [...input.knowledge.sources,
      ...(input.prior?.sources ?? []).filter(source => !refreshedUrls.has(source.url))],
      evidence: [...(input.knowledge.evidence ?? []),
        ...(input.prior?.evidence ?? []).filter(chunk => !refreshedUrls.has(chunk.publicUrl))],
      sourceKnown: input.prior?.sourceKnown },
    freshness: [...input.acceptedFreshness,
      ...(input.priorFreshness ?? []).filter(item => !refreshedUrls.has(item.url)
        || item.metadataConflict || item.currentnessMetadata?.status === 'conflicting'),
      ...(input.currentnessEvidence ?? [])]
  };
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

/** Identity for quota accounting only; admission and acquisition remain authoritative. */
export function normalizeGamingHybridCandidateUrl(value: string): string {
  try { const url = new URL(value); url.hash = ''; return url.href; } catch { return value.trim(); }
}

/** Original supplied links are required evidence, never discovery substitutes. */
export function gamingHybridRequiredGuideUrls(question: string): string[] {
  return [...new Set((question.match(/https?:\/\/[^\s<>\[\]{}]+/giu) ?? [])
    .map(value => value.replace(/[),.;!?]+$/gu, '')).map(normalizeGamingHybridCandidateUrl))].slice(0, 7);
}

/** Parse targets without rewriting approved source URLs or swallowing sentence punctuation. */
export function gamingHybridCitationTargets(answer: string): string[] {
  const targets: string[] = [];
  const withoutLinks = answer.replace(/\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/gu, (_match, target: string) => {
    targets.push(target); return '';
  });
  for (const value of withoutLinks.match(/https?:\/\/[^\s<>]+/gu) ?? []) targets.push(value.replace(/[),.;!?]+$/gu, ''));
  return [...new Set(targets)];
}

/** Backend receipts for the ordinary pipeline's supplied-guide grounding guard. */
export interface GamingHybridSuppliedGuideAcquisition { requestedUrl: string; sourceId: string; publicUrl: string }
export function projectGamingHybridSuppliedGuides(input: {
  requiredUrls: readonly string[];
  accepted: readonly { candidateId: string; actorScopeHash: string; workflowId?: string; expiresAt: number;
    publicUrl: string; document: { requestedUrl: string } }[];
  knowledge: GamingStoredKnowledgeContext; actorScopeHash: string; workflowId: string; now: number;
}): GamingHybridSuppliedGuideAcquisition[] {
  return input.accepted.filter(candidate => candidate.actorScopeHash === input.actorScopeHash
    && candidate.workflowId === input.workflowId && candidate.expiresAt > input.now
    && input.requiredUrls.some(url => normalizeGamingHybridCandidateUrl(url) === normalizeGamingHybridCandidateUrl(candidate.document.requestedUrl))
    && input.knowledge.sources.some(source => source.sourceId === candidate.candidateId && source.url === candidate.publicUrl)
    && input.knowledge.evidence?.some(chunk => chunk.sourceId === candidate.candidateId && chunk.publicUrl === candidate.publicUrl && chunk.text.trim()))
    .map(candidate => ({ requestedUrl: candidate.document.requestedUrl, sourceId: candidate.candidateId, publicUrl: candidate.publicUrl }));
}

/** Product outcomes never grant another acquisition, retry, or storage operation. */
export function projectGamingGuideOutcome(body: GamingHybridResponse): { frontendOutcome?: GamingGuideOutcome; searchHint?: string } {
  if (body.state === 'ingestion_pending') return {};
  const frontendOutcome: GamingGuideOutcome = body.state === 'answer_ready' && body.answer && body.nextAction === 'answer'
    ? 'answer_ready' : body.state === 'clarification_required' && body.nextAction === 'clarify'
      ? 'clarification_required' : body.state === 'discovery_required' ? 'need_new_source' : 'temporarily_unavailable';
  return { frontendOutcome };
}

/** Only public catalog topic words may enter a hint; arbitrary player/account fields are excluded. */
export function gamingGuideSearchHint(input: { game: string; question: string; class?: string }): string {
  const game = input.game.replace(/https?:\/\/\S+|\S+@\S+|\b\d{7,}\b/giu, ' ')
    .replace(/[^\p{L}\p{N} .:'-]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
  const publicTopic = `${input.question} ${input.class ?? ''}`.replace(/-/gu, ' ');
  const selected = GAMING_GUIDE_PUBLIC_TOPIC_LEXEMES.filter(topic => new RegExp(`\\b${topic}\\b`, 'iu').test(publicTopic));
  return `${game} ${selected.join(' ')} guide`.replace(/\s+/gu, ' ').trim().slice(0, 350);
}
