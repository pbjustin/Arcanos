import { createHash, randomUUID } from 'node:crypto';
import { logger } from '@platform/logging/structuredLogging.js';
import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from '@shared/gaming/gamingGameIdentity.js';
import { classifyGamingDocumentQuality, selectGamingSourceAdmissionUrl } from '@shared/gaming/gamingDocumentIngestionCore.js';
import { buildGamingRetrievalTerms, gamingTermCoverage } from '@shared/gaming/gamingRetrievalPolicy.js';
import {
  assessGamingSourcePolicy, extractGamingFreshnessMetadata, classifyGamingQuestionFreshness,
  type GamingFreshnessEvidence
} from '@shared/gaming/gamingFreshnessCore.js';
import {
  selectStoredGamingEvidence, formatStoredGamingEvidence,
  type GamingStoredEvidenceRecord, type GamingStoredKnowledgeContext, type GamingStoredKnowledgeInput
} from '@shared/gaming/gamingStoredEvidenceCore.js';
import { filterGamingDocumentInstructions } from './gamingDocumentExtraction.js';
import { describeGamingDocumentSource, resolveGamingDocument, type ResolvedGamingDocument } from './gamingDocumentResolution.js';
import { chunkGamingDocument, GAMING_DURABLE_DOCUMENT_LIMITS } from './gamingDurableDocumentChunks.js';
import { sanitizeGamingDiscoveryCandidateUrl } from './gamingSourceDiscovery.js';
import { getGamingRagChunkChars, getGamingRagMaxChunks, getGamingRagMaxSources, getGamingWebContextMaxChars, getGamingWebContextFetchTimeoutMs } from './gamingConfig.js';
import { createApprovedGamingSourceIngestion, hashGamingApprovedDocument, type GamingSourceGatewayContext } from './gamingSourceIngestion.js';

export const GAMING_HYBRID_CANDIDATE_POLICY_VERSION = 'gaming-hybrid-candidates/v1';
export const GAMING_HYBRID_CANDIDATE_LIMITS = Object.freeze({ count: 3, artifactTtlMs: 10 * 60_000, totalFetchMs: 12_000 });
export type GamingHybridStoragePolicy = 'transient_only' | 'ask_before_store' | 'auto_store_approved';

/** Every frontend field is only a hint. Only url is used to acquire evidence. */
export interface GamingHybridCandidateInput {
  url: string;
  title?: string;
  discoveredAt?: string;
  discoveryMethod?: string;
  claimedGame?: string;
  claimedPatch?: string;
  claimedPublisher?: string;
  claimedCategory?: string;
}

export interface GamingHybridCandidateDecision {
  submittedIndex: number;
  candidateId?: string;
  url?: string;
  decision: 'accepted_transient' | 'eligible_for_ingestion' | 'already_indexed' | 'rejected' | 'requires_confirmation';
  reasonCodes: string[];
  sourceCategory?: string;
  contentHash?: string;
}

/** Internal request artifact. Never serialize this object into an Action response. */
export interface GamingHybridAcceptedCandidate {
  candidateId: string;
  actorScopeHash: string;
  contentHash: string;
  policyVersion: typeof GAMING_HYBRID_CANDIDATE_POLICY_VERSION;
  expiresAt: number;
  game: string;
  recordType: 'guide' | 'build' | 'meta';
  publicUrl: string;
  document: ResolvedGamingDocument;
  freshness: GamingFreshnessEvidence;
  sourcePolicy: ReturnType<typeof assessGamingSourcePolicy>;
}

interface GamingHybridCandidateDependencies {
  resolveDocument?: typeof resolveGamingDocument;
  sourcePolicy?: typeof assessGamingSourcePolicy;
  extractFreshness?: typeof extractGamingFreshnessMetadata;
  now?: () => Date;
}

const actorHash = (actorKey: string) => createHash('sha256').update(actorKey, 'utf8').digest('hex');
const containsIdentity = (text: string, expected: string) => (`-${normalizeGamingGameIdentity(text)}-`)
  .includes(`-${normalizeGamingGameIdentity(expected)}-`);

function unsafeHints(candidate: GamingHybridCandidateInput): boolean {
  return Object.entries(candidate).some(([key, value]) => key !== 'url' && value !== undefined
    && (typeof value !== 'string' || value.length > 240
      || filterGamingDocumentInstructions(value) !== value.normalize('NFKC').replace(/\s+/gu, ' ').trim()));
}

function identityFailure(document: ResolvedGamingDocument, input: GamingStoredKnowledgeInput): string | undefined {
  const labeledGame = /\bgame\s*:\s*(.{1,160}?)(?=\.(?:\s|$)|;|\n|\s+(?:Edition|Platform|Region|Patch|Build|Published at|Effective from)\s*:|$)/iu.exec(document.text)?.[1]?.trim();
  const expected = new Set([normalizeGamingGameIdentity(input.game), resolveGamingGuideIdentity(input.game, input.edition)]);
  if (labeledGame && !expected.has(normalizeGamingGameIdentity(labeledGame))) return 'GAME_MISMATCH';
  // Broad game-detection aliases intentionally omit some expansions/editions;
  // they cannot authorize source identity. Only a complete requested name plus
  // an ordinary document label, an exact title, or a precise Game label can.
  const documentLabel = /^(?:(?:beginner|boss|build|class|combat|current|endgame|loadout|mechanics|patch|progression|pve|pvp|quest|raid|route|season|strategy|survival|synthetic)-){0,4}(?:guide|build|loadout|walkthrough|wiki|tips|patch-notes|release-notes|update-notes)$/u;
  const metadata = [document.metadata.title, document.metadata.headings].filter((value): value is string => Boolean(value));
  const exactTitle = metadata.some(value => {
    const identity = normalizeGamingGameIdentity(value);
    return [...expected].some(game => identity === game || (identity.startsWith(`${game}-`) && documentLabel.test(identity.slice(game.length + 1))));
  });
  if (!exactTitle && metadata.some(value => /.+\s+(?:guide|build|walkthrough|wiki|patch notes|release notes)$/iu.test(value))) return 'GAME_MISMATCH';
  if (!labeledGame && !exactTitle) return 'GAME_IDENTITY_UNVERIFIED';
  const metadataIdentity = [document.metadata.title, document.metadata.headings, document.text.slice(0, 1_000)].filter(Boolean).join(' ');
  if (input.edition && !containsIdentity(metadataIdentity, input.edition)) return 'EDITION_UNVERIFIED';
  return undefined;
}

/** Safe acquisition happens once. Full documents stay internal; existing chunks and selection bound context. */
export async function evaluateGamingHybridCandidates(
  input: GamingStoredKnowledgeInput & { candidates: readonly GamingHybridCandidateInput[]; region?: string },
  context: { actorKey: string; requestId?: string; traceId?: string; signal?: AbortSignal },
  dependencies: GamingHybridCandidateDependencies = {}
): Promise<{ decisions: GamingHybridCandidateDecision[]; accepted: GamingHybridAcceptedCandidate[]; knowledge: GamingStoredKnowledgeContext }> {
  if (!context.actorKey || input.candidates.length < 1 || input.candidates.length > GAMING_HYBRID_CANDIDATE_LIMITS.count) {
    throw Object.assign(new Error('Submit one to three candidate URLs within an authenticated workflow.'), { code: 'GAMING_HYBRID_CANDIDATE_LIMIT' });
  }
  const now = dependencies.now ?? (() => new Date());
  const deadlineAt = Date.now() + GAMING_HYBRID_CANDIDATE_LIMITS.totalFetchMs;
  const signal = context.signal ?? input.signal;
  const seen = new Set<string>();
  const accepted: GamingHybridAcceptedCandidate[] = [];
  const decisions: GamingHybridCandidateDecision[] = [];
  const allRecords: GamingStoredEvidenceRecord[] = [];
  const terms = buildGamingRetrievalTerms(input).focusTerms;
  for (const [submittedIndex, candidate] of input.candidates.entries()) {
    signal?.throwIfAborted();
    let publicUrl: string | undefined;
    const reject = (reason: string) => decisions.push({ submittedIndex, ...(publicUrl ? { url: publicUrl } : {}),
      decision: 'rejected', reasonCodes: [reason] });
    if (unsafeHints(candidate)) { reject('UNTRUSTED_METADATA_INVALID'); continue; }
    try {
      if (typeof candidate.url !== 'string' || candidate.url.length > 2_048) { reject('INVALID_URL'); continue; }
      const parsedUrl = new URL(candidate.url);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) { reject('URL_BLOCKED'); continue; }
      const admission = sanitizeGamingDiscoveryCandidateUrl(candidate.url);
      if (!admission.url || admission.rejected) { reject('URL_BLOCKED'); continue; }
      const description = describeGamingDocumentSource(admission.url);
      publicUrl = selectGamingSourceAdmissionUrl(admission.url, description);
      if (seen.has(publicUrl)) { reject('DUPLICATE_URL'); continue; }
      seen.add(publicUrl);
      if (Date.now() >= deadlineAt) { reject('FETCH_BUDGET_EXHAUSTED'); continue; }
      const document = await (dependencies.resolveDocument ?? resolveGamingDocument)(publicUrl,
        GAMING_DURABLE_DOCUMENT_LIMITS.documentChars, { documentPurpose: 'durable', signal, deadlineAt,
          timeoutMs: Math.min(5_000, getGamingWebContextFetchTimeoutMs(), Math.max(1, deadlineAt - Date.now())), includeLinks: false });
      signal?.throwIfAborted();
      if (new URL(document.publicUrl).hostname !== new URL(publicUrl).hostname) { reject('RESOLVED_SOURCE_IDENTITY_MISMATCH'); continue; }
      if (document.metrics.instructionFiltered) { reject('SOURCE_INSTRUCTIONS_REJECTED'); continue; }
      const quality = classifyGamingDocumentQuality({ cleanedText: document.text,
        navigationDensity: document.extraction.navigationDensity, truncated: document.metrics.truncated, minUsefulTextChars: 120 });
      if (quality === 'unusable' || quality === 'metadata-only') { reject('INSUFFICIENT_EXTRACTION'); continue; }
      if (/\b(?:no (?:automated|machine) (?:access|use)|automated (?:access|use) (?:is )?prohibited|do not (?:store|redistribute) (?:this|our) content)\b/iu.test(document.text)) {
        reject('SOURCE_USE_RESTRICTED'); continue;
      }
      const identity = identityFailure(document, input);
      if (identity) { reject(identity); continue; }
      const reviewedPolicy = (dependencies.sourcePolicy ?? assessGamingSourcePolicy)(document.publicUrl, input.game);
      const policy = classifyGamingQuestionFreshness({ prompt: input.prompt, mode: input.mode }) === 'live_status'
        ? { ...reviewedPolicy, durableAllowed: false, autoStoreAllowed: false } : reviewedPolicy;
      const freshness = (dependencies.extractFreshness ?? extractGamingFreshnessMetadata)(document, input, now());
      policy.autoStoreAllowed = policy.autoStoreAllowed && freshness.autoStoreAllowed;
      if (normalizeGamingGameIdentity(freshness.game) !== normalizeGamingGameIdentity(input.game)) { reject('GAME_MISMATCH'); continue; }
      if (freshness.metadataConflict) { reject('CONTRADICTORY_SOURCE_METADATA'); continue; }
      if (input.edition && normalizeGamingGameIdentity(freshness.edition ?? '') !== normalizeGamingGameIdentity(input.edition)) { reject('EDITION_UNVERIFIED_OR_MISMATCH'); continue; }
      if (!input.edition && freshness.edition) { reject('EDITION_REQUIRED'); continue; }
      const applies = (values: string[] | undefined, wanted: string | undefined) => !values?.length
        || values.some(value => value.toLowerCase() === 'all' || value.toLowerCase() === wanted?.toLowerCase());
      if (!applies(freshness.platforms, input.platform)) { reject(input.platform ? 'PLATFORM_MISMATCH' : 'PLATFORM_REQUIRED'); continue; }
      if (!applies(freshness.regions, input.region)) { reject(input.region ? 'REGION_MISMATCH' : 'REGION_REQUIRED'); continue; }
      const contentHash = hashGamingApprovedDocument(document);
      const candidateId = randomUUID();
      freshness.id = candidateId;
      const chunks = await chunkGamingDocument(document.text, { signal });
      const records = chunks.chunks.map(chunk => ({
        recordId: `${candidateId}:${chunk.ordinal}`, recordType: input.mode === 'guide' ? 'guide' as const : input.mode === 'build' ? 'build' as const : 'meta' as const,
        title: document.metadata.title ?? null, searchText: chunk.text,
        normalized: { text: chunk.text, chunk: { ordinal: chunk.ordinal, totalChunks: chunk.totalChunks,
          startChar: chunk.startChar, endChar: chunk.endChar, headingPath: chunk.headingPath } },
        sourceId: candidateId, publicUrl: publicUrl!, sourceType: policy.category, revisionId: contentHash,
        fetchedAt: now(), publishedAt: null, provenance: { resolverId: document.resolution.resolverId,
          resolverVersion: document.resolution.resolverVersion, resolutionStrategy: document.resolution.strategy },
        relevance: gamingTermCoverage(chunk.text, terms)
      })).filter(record => record.relevance >= 0.25);
      // An official index/status page can verify applicability even when it does not cover the gameplay anchor.
      if (!records.length && !['current_index', 'live_status'].includes(policy.currentness)) { reject('QUESTION_COVERAGE_INSUFFICIENT'); continue; }
      const artifact: GamingHybridAcceptedCandidate = { candidateId, actorScopeHash: actorHash(context.actorKey), contentHash,
        policyVersion: GAMING_HYBRID_CANDIDATE_POLICY_VERSION, expiresAt: now().getTime() + GAMING_HYBRID_CANDIDATE_LIMITS.artifactTtlMs,
        game: input.edition && resolveGamingGuideIdentity(input.game, input.edition) !== normalizeGamingGameIdentity(input.game)
          ? `${input.game} ${input.edition}` : input.game,
        recordType: input.mode,
        publicUrl, document: { ...document, rawDocument: undefined }, freshness, sourcePolicy: policy };
      accepted.push(artifact);
      allRecords.push(...records);
      decisions.push({ submittedIndex, candidateId, url: publicUrl,
        decision: policy.durableAllowed && !document.metrics.truncated ? 'eligible_for_ingestion' : 'accepted_transient',
        reasonCodes: [records.length ? 'VALIDATED_RELEVANT_CONTENT' : 'VALIDATED_APPLICABILITY_SOURCE',
          ...(document.metrics.truncated ? ['EXTRACTION_PARTIAL'] : [])], sourceCategory: policy.category, contentHash });
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = (error as { response?: { status?: number } })?.response?.status;
      reject(status === 401 || status === 403 ? 'SOURCE_INACCESSIBLE' : status && status >= 300 && status < 400
        ? 'REDIRECT_NOT_ALLOWED' : error instanceof Error && /(?:timeout|deadline|abort)/iu.test(error.name + error.message)
          ? 'SOURCE_TIMEOUT' : 'SOURCE_FETCH_FAILED');
    }
  }
  const limits = { chunkChars: getGamingRagChunkChars(), maxChunks: getGamingRagMaxChunks(),
    maxSources: Math.min(3, getGamingRagMaxSources()), maxContextChars: getGamingWebContextMaxChars(), structuredEvidenceChars: 8_000 };
  // Rank the complete bounded document before the existing selector's top-20 bound.
  allRecords.sort((a, b) => b.relevance - a.relevance || a.recordId.localeCompare(b.recordId));
  const selected = selectStoredGamingEvidence(allRecords, input, limits);
  const knowledge = formatStoredGamingEvidence(selected, input, limits);
  knowledge.context = knowledge.context.replaceAll('Origin: stored gaming knowledge;', 'Origin: backend-validated transient Gaming evidence;');
  logger.info('gaming.hybrid.candidates_evaluated', { requestId: context.requestId, traceId: context.traceId,
    policyVersion: GAMING_HYBRID_CANDIDATE_POLICY_VERSION, candidateCount: input.candidates.length,
    acceptedCount: accepted.length, rejectedCount: decisions.filter(decision => decision.decision === 'rejected').length,
    selectedChunkCount: knowledge.evidence?.length ?? 0, selectedContextChars: knowledge.context.length,
    decisions: decisions.map(decision => ({ candidateId: decision.candidateId, decision: decision.decision, reasons: decision.reasonCodes })) });
  return { decisions, accepted, knowledge };
}

/** Storage eligibility, actor permission, and consent are independent of answer sufficiency. */
export async function createApprovedGamingHybridIngestion(input: {
  candidates: readonly GamingHybridAcceptedCandidate[];
  storagePolicy: GamingHybridStoragePolicy;
  confirmed: boolean;
  idempotencyKey: string;
}, context: GamingSourceGatewayContext & { canStore: boolean; canAutoStore: boolean }) {
  const denied = (code: string, message: string) => ({ statusCode: 403, payload: { ok: false, error: { code, message } } });
  if (!context.canStore || input.storagePolicy === 'transient_only') return denied('GAMING_HYBRID_STORAGE_FORBIDDEN', 'Storage is not authorized for this request.');
  if (input.storagePolicy === 'ask_before_store' && !input.confirmed) return denied('GAMING_HYBRID_CONFIRMATION_REQUIRED', 'Confirm storage before requesting ingestion.');
  if (input.storagePolicy === 'auto_store_approved' && !context.canAutoStore) return denied('GAMING_HYBRID_AUTO_STORAGE_FORBIDDEN', 'Automatic storage requires configured standing permission.');
  if (input.candidates.length < 1 || input.candidates.length > 3) return denied('GAMING_HYBRID_CANDIDATE_LIMIT', 'Select one to three approved candidates.');
  for (const candidate of input.candidates) {
    if (candidate.actorScopeHash !== actorHash(context.actorKey) || candidate.expiresAt <= Date.now()
      || candidate.policyVersion !== GAMING_HYBRID_CANDIDATE_POLICY_VERSION
      || candidate.contentHash !== hashGamingApprovedDocument(candidate.document)) {
      return denied('GAMING_HYBRID_APPROVAL_INVALID', 'The source approval expired or does not belong to this caller.');
    }
    if (!candidate.sourcePolicy.durableAllowed || candidate.document.metrics.truncated
      || (input.storagePolicy === 'auto_store_approved' && !candidate.sourcePolicy.autoStoreAllowed)) {
      return denied('GAMING_HYBRID_SOURCE_STORAGE_DISALLOWED', 'The selected source category does not qualify for this storage policy.');
    }
  }
  return createApprovedGamingSourceIngestion(input.candidates.map(candidate => ({
    url: candidate.publicUrl, game: candidate.game, contentHash: candidate.contentHash,
    actorScopeHash: candidate.actorScopeHash, policyVersion: candidate.policyVersion,
    recordType: candidate.recordType,
    sourceTrustType: candidate.sourcePolicy.authority === 'official' ? 'official' as const
      : candidate.sourcePolicy.authority === 'specialist' ? 'curated' as const : 'supplied' as const,
    freshness: { ...candidate.freshness }
  })), input.idempotencyKey, { ...context, canStore: true });
}
