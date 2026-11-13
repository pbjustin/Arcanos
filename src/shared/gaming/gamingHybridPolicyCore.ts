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
  classification?: 'verified' | 'stored_unverified' | 'reference_only';
  generationEligible?: boolean;
}

/** Retention capacity does not decide whether bounded transient evidence can answer. */
export function projectGamingHybridCandidateRetention(input: {
  retainedChars: number;
  candidateChars: number;
  decisions: readonly GamingHybridPublicCandidateDecision[];
}): { retainArtifacts: boolean; decisions: GamingHybridPublicCandidateDecision[] } {
  const retainArtifacts = input.retainedChars + input.candidateChars <= GAMING_HYBRID_RETAINED_ARTIFACT_CHARS;
  const decisions = input.decisions.map(({ candidateId, url, decision, reasonCodes, sourceCategory, origin, generationEligible }) => ({
    ...(retainArtifacts && candidateId ? { candidateId } : {}), url,
    decision: !retainArtifacts && candidateId ? generationEligible === false ? 'rejected' : 'accepted_transient' : decision,
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

const MARKDOWN_HTTP_START = /^\s*(<)?(https?:\/\/)/iu;
const MARKDOWN_LINK_END = /^(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?\s*\)/u;

/** Read the HTTP destination and closing delimiter after a Markdown link's opening parenthesis. */
export function readGamingMarkdownCitationDestination(value: string): { url: string; end: number } | undefined {
  const start = MARKDOWN_HTTP_START.exec(value);
  if (!start) return undefined;
  const bracketed = start[1] !== undefined;
  let index = start[0].length;
  let depth = 0;
  for (; index < value.length; index++) {
    const character = value[index];
    if (/[\s<>]/u.test(character)) break;
    if (!bracketed && character === ')') {
      if (depth === 0) break;
      depth--;
    } else if (!bracketed && character === '(') {
      depth++;
    }
  }
  if (index === start[0].length || depth !== 0 || (bracketed && value[index] !== '>')) return undefined;
  const url = value.slice(start[0].length - start[2].length, index);
  const tailStart = index + (bracketed ? 1 : 0);
  const end = MARKDOWN_LINK_END.exec(value.slice(tailStart));
  return end ? { url, end: tailStart + end[0].length } : undefined;
}

/** Parse targets without rewriting approved source URLs or swallowing sentence punctuation. */
export function gamingHybridCitationTargets(answer: string): string[] {
  const targets: string[] = [];
  const link = /\[[^\[\]\r\n]*\]\(/gu;
  let offset = 0;
  const bareText: string[] = [];
  for (const match of answer.matchAll(link)) {
    if (match.index < offset) continue;
    const start = match.index + match[0].length;
    const destination = readGamingMarkdownCitationDestination(answer.slice(start));
    if (!destination) continue;
    targets.push(destination.url);
    bareText.push(answer.slice(offset, match.index));
    offset = start + destination.end;
  }
  bareText.push(answer.slice(offset));
  for (const value of bareText.join(' ').match(/https?:\/\/[^\s<>]+/gu) ?? []) {
    const url = value.replace(/[,.;!?]+$/gu, '');
    const excessClosers = (url.match(/\)/gu)?.length ?? 0) - (url.match(/\(/gu)?.length ?? 0);
    const trailingClosers = url.match(/\)+$/u)?.[0].length ?? 0;
    const end = url.length - Math.min(trailingClosers, Math.max(0, excessClosers));
    targets.push(url.slice(0, end).replace(/[,.;!?]+$/gu, ''));
  }
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
