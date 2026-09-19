import { GAMING_HYBRID_CONTRACT_VERSION, gamingHybridQuerySchema } from './gamingHybridContract.js';
import { combineGamingCurrentnessEvidence, GAMING_CURRENTNESS_LIMITS,
  type GamingCurrentnessDocument } from './gamingCurrentnessAdapters.js';
import { extractGamingFreshnessMetadata, evaluateGamingFreshness,
  type GamingFreshnessEvidence, type GamingReviewedSourceRule } from './gamingFreshnessCore.js';
import { assessGamingClearEvidence } from './gamingClearEvidence.js';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash, parseGamingClearModelAssessment,
  type GamingClearAssessment, type GamingClearDimensions } from './gamingClearPolicy.js';
import { GAMING_CLEAR_APPROVED_ANSWER, hasBoundGamingClearAnswer } from './gamingClearAnswerBinding.js';
import { projectGamingHybridCandidateEvidence, resolveGamingHybridCandidateAttempt,
  resolveGamingHybridCurrentnessReason } from './gamingHybridPolicyCore.js';
import type { GamingStoredKnowledgeContext } from './gamingStoredEvidenceCore.js';

export const GAMING_CURRENTNESS_PREVIEW_VERSION = 'gaming-currentness/v1';
export const GAMING_CURRENTNESS_CONTINUATION_PREVIEW_VERSION = 'gaming-currentness-continuation/v1';
const FAILURE = 'PREVIEW_GAMING_CURRENTNESS_CONTRACT_INVALID';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const GAME = 'Elden Ring';
const HOST = 'currentness-preview.example';
const GUIDE_URL = `https://${HOST}/guides/mage`;
const INDEX_URL = `https://${HOST}/updates`;
const ARTICLE_URL = `https://${HOST}/updates/patch-117`;
const QUESTION = 'What is a good Intelligence staff mage build now?';
const PROSE = 'In Elden Ring, the Intelligence staff mage build combines sorcery spells and sufficient equipment capacity. '
  + 'Equip a staff and select sorcery spells compatible with its requirements before increasing Intelligence. '
  + 'Compare the equipped staff requirements before choosing spells for this mage build.';
const ANSWER = 'Equip a staff and select sorcery spells compatible with its requirements before increasing Intelligence. [1]';
const RULES: readonly GamingReviewedSourceRule[] = [
  { id: 'synthetic-currentness-guide', game: GAME, hosts: [HOST], path: '/guides/', pathMatch: 'prefix',
    category: 'specialist_guide', currentness: 'none', durableAllowed: true, autoStoreAllowed: false },
  { id: 'synthetic-currentness-index', game: GAME, hosts: [HOST], path: '/updates', pathMatch: 'exact',
    category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false,
    metadataAdapter: 'bandai-news-index-v1', currentnessArticleRuleIds: ['synthetic-currentness-article'] },
  { id: 'synthetic-currentness-article', game: GAME, hosts: [HOST], path: '/updates/', pathMatch: 'prefix',
    category: 'official_updates', currentness: 'article', durableAllowed: false, autoStoreAllowed: false,
    metadataAdapter: 'bandai-patch-article-v1' },
  { id: 'synthetic-currentness-refresh', game: GAME, hosts: [HOST], path: '/continuation-index', pathMatch: 'exact',
    category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false,
    metadataAdapter: 'labeled-v1' }
];

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function query() {
  const parsed = gamingHybridQuerySchema.parse({ contractVersion: GAMING_HYBRID_CONTRACT_VERSION,
    idempotencyKey: 'synthetic-currentness-query', game: GAME, question: QUESTION, mode: 'build', platform: 'PC' });
  requireProof(parsed.storagePolicy === 'transient_only' && parsed.platform === 'PC' && parsed.mode === 'build'
    && parsed.question === QUESTION && parsed.requestedVersion === undefined);
  return { game: parsed.game, prompt: parsed.question, mode: parsed.mode, platform: parsed.platform };
}

function guide(labels = 'Patch: 1.17\nBuild: 1.17\nPlatforms: PC'): GamingCurrentnessDocument {
  return { publicUrl: GUIDE_URL, canonicalUrl: GUIDE_URL, text: `Game: ${GAME}\n${labels}\n${PROSE}`,
    metadata: { title: `${GAME} Intelligence Staff Mage Build` } };
}

function index(): GamingCurrentnessDocument {
  const text = 'Platforms: PC\nLatest News on ELDEN RING. Patch Notes (2) '
    + 'Elden Ring – Patch Notes Version 1.17 08/09/2026 Elden Ring – Patch Notes Version 1.16 07/09/2026';
  return { publicUrl: INDEX_URL, canonicalUrl: INDEX_URL, text,
    metadata: { title: 'ELDEN RING news | Synthetic publisher' }, currentnessDocument: {
      ruleId: 'synthetic-currentness-index', adapterId: 'bandai-news-index-v1', status: 'complete',
      rawContentHash: gamingClearHash(text), categoryCount: 2,
      cards: [{ title: 'Elden Ring – Patch Notes Version 1.17', publishedDate: '08/09/2026', url: ARTICLE_URL },
        { title: 'Elden Ring – Patch Notes Version 1.16', publishedDate: '07/09/2026', url: `https://${HOST}/updates/patch-116` }]
    } };
}

function article(build = '1.17', release = 'This update is required for online play.'): GamingCurrentnessDocument {
  const text = `Targeted Platforms PlayStation 5 / Steam App Ver. 1.17 Regulation Ver. ${build} ${release}`;
  return { publicUrl: ARTICLE_URL, canonicalUrl: ARTICLE_URL, text,
    metadata: { title: 'Elden Ring – Patch Notes Version 1.17 | Synthetic publisher' }, currentnessDocument: {
      ruleId: 'synthetic-currentness-article', adapterId: 'bandai-patch-article-v1', status: 'complete',
      rawContentHash: gamingClearHash(text), platformText: 'PlayStation 5 / Steam'
    } };
}

function extract(doc: GamingCurrentnessDocument, at = NOW): GamingFreshnessEvidence {
  return extractGamingFreshnessMetadata(doc, { game: GAME }, at, RULES);
}

function knowledge(evidence: GamingFreshnessEvidence[]): GamingStoredKnowledgeContext {
  const passages = evidence.map(item => item.category === 'specialist_guide' ? PROSE
    : 'Official release record identifies the active application patch and regulation build.');
  return { context: passages.join('\n\n'), sources: evidence.map((item, i) => ({ sourceId: item.id, url: item.url,
    game: item.game, sourceType: item.category, fetchedAt: item.fetchedAt, snippet: passages[i], freshnessMetadata: { ...item } })),
  evidence: evidence.map((item, i) => ({ sourceId: item.id, revisionId: `synthetic-currentness-revision-${gamingClearHash(item.id).slice(0, 16)}`,
    recordId: `synthetic-currentness-chunk-${gamingClearHash(item.id).slice(0, 16)}`, recordType: 'build', publicUrl: item.url, text: passages[i],
    lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: item.fetchedAt } })) };
}

function assess(raw: GamingFreshnessEvidence[], input = query()) {
  const evidence = combineGamingCurrentnessEvidence(raw, NOW);
  const freshness = evaluateGamingFreshness({ game: input.game, question: input.prompt, mode: input.mode,
    platform: input.platform, evidence, now: NOW });
  const clear = assessGamingClearEvidence(input, knowledge(evidence), { now: NOW });
  return { evidence, freshness, clear };
}

/** Fixed synthetic model projection tests policy admission; it does not perform a model audit. */
function answerAssessment(evidence: GamingClearAssessment, status: 'completed' | 'not_run' = 'completed', response = ANSWER): GamingClearAssessment {
  const refs = evidence.dimensionScores.clarity.evidenceRefs;
  const dimension = (): GamingClearDimensions['clarity'] => ({ status: 'evaluated', score: 5,
    reasonCodes: ['SUPPORTED_SYNTHETIC_MAGE_PASSAGE'], evidenceRefs: refs, unresolvedFacts: [] });
  const model = parseGamingClearModelAssessment({ dimensions: { clarity: dimension(), leverage: dimension(), efficiency: dimension(),
    alignment: dimension(), resilience: dimension() }, findings: [] }, refs);
  requireProof(model);
  return createGamingClearAssessment({ profile: 'answer', questionProfile: 'current_build',
    subjectId: 'synthetic-currentness-answer', subjectHash: gamingClearHash(response),
    contextFingerprint: gamingClearContextFingerprint({ question: query(), evidence: evidence.subjectHash }),
    evidenceRefs: refs, gates: { ...evidence.gates }, dimensions: model.dimensions, findings: model.findings,
    assessmentMethod: 'mixed', assessmentStatus: status, evaluatedAt: NOW.toISOString() });
}

function requireBlocked(raw: GamingFreshnessEvidence[], input = query()): void {
  const result = assess(raw, input);
  requireProof(!result.freshness.usable && result.clear.decision !== 'accept');
  const answer = answerAssessment(result.clear);
  requireProof(answer.decision !== 'accept' && !hasBoundGamingClearAnswer({ response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: answer }));
}

function requireCurrentPcAnswer(): void {
  const officialIndex = extract(index());
  const officialArticle = extract(article());
  const gameplay = extract(guide());
  requireProof(gameplay.patch === '1.17' && gameplay.build === '1.17' && gameplay.platforms?.join(',') === 'PC'
    && gameplay.metadataConfidence === 'content_extracted' && gameplay.authority === 'specialist');
  requireProof(officialIndex.currentnessMetadata?.status === 'incomplete' && officialIndex.currentPatch === '1.17'
    && officialIndex.currentBuild === undefined && officialArticle.currentPatch === undefined);
  const result = assess([gameplay, officialIndex, officialArticle]);
  const completed = result.evidence.find(item => item.id === officialIndex.id);
  requireProof(completed?.currentnessMetadata?.status === 'verified' && completed.currentPatch === '1.17'
    && completed.currentBuild === '1.17' && completed.currentnessMetadata.versionSemantics === 'app-regulation'
    && completed.platforms?.join(',') === 'Steam,PC' && !completed.durableAllowed
    && completed.currentnessMetadata.evidenceRefs.length === 2
    && completed.currentnessMetadata.evidenceRefs.some(ref => ref.url === INDEX_URL && /^[a-f0-9]{64}$/u.test(ref.contentHash))
    && completed.currentnessMetadata.evidenceRefs.some(ref => ref.url === ARTICLE_URL && /^[a-f0-9]{64}$/u.test(ref.contentHash)));
  requireProof(officialIndex.currentnessMetadata.status === 'incomplete');
  requireProof(result.freshness.usable && result.freshness.status === 'current' && result.freshness.effectivePatch === '1.17'
    && result.freshness.effectiveBuild === '1.17' && result.freshness.verifiedAsOf === NOW.toISOString()
    && result.freshness.guideApplicability?.some(item => item.evidenceId === gameplay.id && item.status === 'verified_current')
    && result.clear.decision === 'accept' && result.clear.gates.freshness === 'verified' && result.clear.gates.claimSupport === 'verified');
  const answer = answerAssessment(result.clear);
  const carrier = { response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: answer };
  requireProof(answer.decision === 'accept' && hasBoundGamingClearAnswer(carrier));
  requireProof(!hasBoundGamingClearAnswer({ ...carrier, response: `${ANSWER} Works on every platform.` }));
  requireProof(!hasBoundGamingClearAnswer({ response: ANSWER }));
  requireProof(!hasBoundGamingClearAnswer({ response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: answerAssessment(result.clear, 'not_run') }));
  requireProof(JSON.stringify(carrier) === JSON.stringify({ response: ANSWER }));

  // Same app with a different regulation must remain a separate effective build.
  const separate = assess([extract(guide('Patch: 1.17\nBuild: 1.17.1\nPlatforms: PC')), officialIndex, extract(article('1.17.1'))]);
  requireProof(separate.freshness.usable && separate.freshness.effectivePatch === '1.17'
    && separate.freshness.effectiveBuild === '1.17.1' && separate.clear.decision === 'accept');
  requireBlocked([gameplay, officialIndex, extract(article('1.17.1'))]);

  for (const labels of ['Patch: 1.17\nPlatforms: PC', 'Patch: 1.17\nBuild: 1.16\nPlatforms: PC',
    'Patch: 1.17\nBuild: 1.17', 'Patch: 1.17\nBuild: 1.17\nPlatforms: PS5']) {
    requireBlocked([extract(guide(labels)), officialIndex, officialArticle]);
  }
  requireBlocked([gameplay]);
  requireBlocked([gameplay, officialIndex]);
  requireBlocked([gameplay, officialArticle]);
  requireBlocked([gameplay, officialIndex, extract({ ...article(), currentnessDocument: undefined })]);
  requireBlocked([gameplay, officialIndex, extract({ ...article(), publicUrl: `https://${HOST}/updates/unlisted`, canonicalUrl: `https://${HOST}/updates/unlisted` })]);
  requireBlocked([gameplay, officialIndex, extract(article('1.17', 'This update will be released tomorrow.'))]);
  const stale = new Date(NOW.getTime() - GAMING_CURRENTNESS_LIMITS.revalidateMs - 1);
  requireBlocked([gameplay, extract(index(), stale), officialArticle]);
  requireBlocked([gameplay, officialIndex, extract(article(), stale)]);
  requireBlocked([gameplay, officialIndex, officialArticle, extract(article('1.17.1'))]);
  requireBlocked([extract(guide('Patch: 1.17\nBuild: 1.17\nPlatforms: PS5')), officialIndex, officialArticle], { ...query(), platform: 'PS5' });

  // Official currentness is useful corroboration, but cannot supply a gameplay answer.
  const officialOnly = assess([officialIndex, officialArticle]);
  requireProof(officialOnly.clear.decision !== 'accept' && officialOnly.clear.gates.claimSupport === 'unknown');
  const unsupported = answerAssessment(officialOnly.clear);
  requireProof(unsupported.decision !== 'accept'
    && !hasBoundGamingClearAnswer({ response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: unsupported }));
}

/** Exercise the production merge and policy decisions, without a workflow, acquisition, or provider. */
function requireSameUrlCurrentnessContinuation(): void {
  const input = query();
  const url = `https://${HOST}/continuation-index`;
  const doc = (build = ''): GamingCurrentnessDocument => ({ publicUrl: url, canonicalUrl: url,
    metadata: { title: `${GAME} Official Current Update` },
    text: `Game: ${GAME}\nCurrent patch: 1.17\n${build}\nEffective from: 2026-09-08\nPlatforms: PC` });
  const gameplay = { ...extract(guide('Patch: 1.17\nBuild: 1.17.1\nPlatforms: PC')), id: 'synthetic-continuation-guide' };
  const oldIndex = { ...extract(doc()), id: 'synthetic-continuation-old-index' };
  const freshIndex = { ...extract(doc('Current build: 1.17.1')), id: 'synthetic-continuation-fresh-index' };
  requireProof(oldIndex.currentnessMetadata?.status === 'verified' && oldIndex.currentBuild === undefined
    && freshIndex.currentnessMetadata?.status === 'verified' && freshIndex.currentBuild === '1.17.1');
  const prior = knowledge([gameplay, oldIndex]);
  const oldMarker = 'Obsolete synthetic index passage about the Intelligence staff mage build.';
  prior.sources[1].snippet = oldMarker;
  prior.evidence![1].text = oldMarker;
  const before = evaluateGamingFreshness({ ...input, question: input.prompt, evidence: [gameplay, oldIndex], now: NOW });
  requireProof(!before.usable && before.reasons.includes('CURRENT_BUILD_UNVERIFIED'));
  requireProof(resolveGamingHybridCurrentnessReason({ classification: before.classification, freshnessStatus: before.status,
    hasGameplayEvidence: true, reasons: before.reasons }) === 'CURRENT_BUILD_UNVERIFIED');
  const attempt = { requestedKey: 'synthetic-continuation-operation', expectedAction: 'verify_currentness' as const, maxRounds: 1 };
  requireProof(resolveGamingHybridCandidateAttempt({ ...attempt, round: 0, nextAction: 'verify_currentness' }) === 'begin');
  requireProof(resolveGamingHybridCandidateAttempt({ ...attempt, operationKey: attempt.requestedKey, round: 1 }) === 'resume');
  requireProof(resolveGamingHybridCandidateAttempt({ ...attempt, requestedKey: 'synthetic-extra-operation',
    operationKey: attempt.requestedKey, round: 1, nextAction: 'verify_currentness' }) === 'deny');

  for (const recordsPresent of [true, false]) {
    const acquired = recordsPresent ? knowledge([freshIndex]) : { context: '', sources: [] };
    const projected = projectGamingHybridCandidateEvidence({ prior, knowledge: acquired,
      acceptedFreshness: [freshIndex], priorFreshness: [gameplay, oldIndex] });
    requireProof(projected.knowledge.sources.length === (recordsPresent ? 2 : 1)
      && projected.knowledge.evidence?.length === (recordsPresent ? 2 : 1)
      && projected.knowledge.sources.some(source => source.sourceId === gameplay.id)
      && !projected.knowledge.sources.some(source => source.sourceId === oldIndex.id)
      && !projected.knowledge.evidence.some(chunk => chunk.sourceId === oldIndex.id)
      && new Set(projected.knowledge.evidence.map(chunk => chunk.recordId)).size === projected.knowledge.evidence.length
      && new Set(projected.knowledge.evidence.map(chunk => chunk.revisionId)).size === projected.knowledge.evidence.length
      && !JSON.stringify(projected.knowledge).includes(oldMarker)
      && projected.freshness.length === 2 && projected.freshness[0].id === freshIndex.id
      && !projected.freshness.some(item => item.id === oldIndex.id));
    const freshness = evaluateGamingFreshness({ ...input, question: input.prompt, evidence: projected.freshness, now: NOW });
    const clear = assessGamingClearEvidence(input, projected.knowledge, { freshness, freshnessEvidence: projected.freshness, now: NOW });
    requireProof(freshness.usable && freshness.status === 'current' && freshness.effectiveBuild === '1.17.1'
      && freshness.selectedEvidenceIds.includes(gameplay.id) && freshness.selectedEvidenceIds.includes(freshIndex.id)
      && clear.decision === 'accept');
    const response = ANSWER.replace('[1]', `[${projected.knowledge.sources.findIndex(source => source.sourceId === gameplay.id) + 1}]`);
    const answer = answerAssessment(clear, 'completed', response);
    requireProof(answer.decision === 'accept' && hasBoundGamingClearAnswer({ response, [GAMING_CLEAR_APPROVED_ANSWER]: answer }));
  }
  // A refreshed positive source cannot erase separately retained or newly acquired contradictions.
  const contradiction = { ...extract(doc('Current build: 1.17.1\nCurrent build: 1.17.2')),
    id: 'synthetic-continuation-conflict' };
  requireProof(contradiction.metadataConflict && contradiction.currentnessMetadata?.status === 'conflicting');
  for (const origin of ['prior', 'prior-adapter-only', 'prior-metadata-only', 'evaluated'] as const) {
    const negative = origin === 'prior-adapter-only' ? { ...contradiction, metadataConflict: false }
      : origin === 'prior-metadata-only' ? { ...contradiction, currentnessMetadata: undefined } : contradiction;
    const projected = projectGamingHybridCandidateEvidence({ prior, knowledge: knowledge([freshIndex]), acceptedFreshness: [freshIndex],
      priorFreshness: [gameplay, oldIndex, ...(origin !== 'evaluated' ? [negative] : [])],
      currentnessEvidence: origin === 'evaluated' ? [negative] : [] });
    requireProof(projected.freshness.some(item => item.id === negative.id)
      && projected.freshness[0].id === freshIndex.id && projected.knowledge.sources[0].freshnessMetadata?.id === freshIndex.id);
    const freshness = evaluateGamingFreshness({ ...input, question: input.prompt, evidence: projected.freshness, now: NOW });
    const clear = assessGamingClearEvidence(input, projected.knowledge, { freshness, freshnessEvidence: projected.freshness, now: NOW });
    requireProof(!freshness.usable && freshness.status === 'conflicting' && clear.decision !== 'accept'
      && resolveGamingHybridCurrentnessReason({ classification: freshness.classification, freshnessStatus: freshness.status,
        hasGameplayEvidence: true, reasons: freshness.reasons }) === undefined);
    requireProof(!hasBoundGamingClearAnswer({ response: ANSWER, [GAMING_CLEAR_APPROVED_ANSWER]: answerAssessment(clear) }));
  }
  const outsideScope = { ...contradiction, platforms: ['PS5'] };
  const scoped = projectGamingHybridCandidateEvidence({ prior, knowledge: knowledge([freshIndex]), acceptedFreshness: [freshIndex],
    priorFreshness: [gameplay, oldIndex, outsideScope] });
  const scopedFreshness = evaluateGamingFreshness({ ...input, question: input.prompt, evidence: scoped.freshness, now: NOW });
  requireProof(scoped.freshness.some(item => item.id === outsideScope.id)
    && scoped.knowledge.sources[0].freshnessMetadata?.id === freshIndex.id
    && scopedFreshness.usable && !scopedFreshness.selectedEvidenceIds.includes(outsideScope.id));
  const scopedClear = assessGamingClearEvidence(input, scoped.knowledge, { now: NOW, freshness: scopedFreshness,
    freshnessEvidence: scoped.freshness.filter(item => scopedFreshness.selectedEvidenceIds.includes(item.id)) });
  const scopedResponse = ANSWER.replace('[1]', `[${scoped.knowledge.sources.findIndex(source => source.sourceId === gameplay.id) + 1}]`);
  requireProof(scopedClear.decision === 'accept'
    && hasBoundGamingClearAnswer({ response: scopedResponse, [GAMING_CLEAR_APPROVED_ANSWER]: answerAssessment(scopedClear, 'completed', scopedResponse) }));
  requireProof(prior.sources[1].sourceId === oldIndex.id && prior.evidence![1].text === oldMarker
    && oldIndex.currentBuild === undefined);
}

/** Fixed synthetic shared-core proof. DOM projections are synthetic inputs, not a resolver run.
 * No normal query workflow, acquisition, provider/model audit, SQL, cache, logger, or worker executes. */
export function runGamingCurrentnessPreview(): void {
  try {
    requireCurrentPcAnswer();
    requireSameUrlCurrentnessContinuation();
  } catch {
    throw new Error(FAILURE);
  }
}
