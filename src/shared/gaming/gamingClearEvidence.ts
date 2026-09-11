import { createGamingClearAssessment, classifyGamingClearQuestion, gamingClearContextFingerprint, gamingClearHash,
  type GamingClearAssessment } from './gamingClearPolicy.js';
import { normalizeGamingGameIdentity, normalizeGamingEvidenceGameIdentity, resolveGamingGuideIdentity } from './gamingGameIdentity.js';
import { assessGamingProgressionRequest } from './gamingProgressionPolicy.js';
import { buildGamingRetrievalTerms, gamingTermCoverage, type GamingRetrievalPolicyInput } from './gamingRetrievalPolicy.js';
import { classifyGamingQuestionFreshness, evaluateGamingFreshness, type GamingFreshnessEvaluation, type GamingFreshnessEvidence } from './gamingFreshnessCore.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeSource } from './gamingStoredEvidenceCore.js';
import { assessGamingStructuralUsability } from './gamingStructuralEvidence.js';
import { gamingClearIntactProseText } from './gamingClearSource.js';

export interface GamingClearEvidenceOptions {
  freshness?: GamingFreshnessEvaluation;
  freshnessEvidence?: readonly GamingFreshnessEvidence[];
  now?: Date;
  actorScopeHash?: string;
  /** Existing backend acquisition/catalog identity checks, never frontend labels. */
  identityVerified?: boolean;
}

function sourceMetadata(source: GamingStoredKnowledgeSource): GamingFreshnessEvidence | undefined {
  const value = source.freshnessMetadata;
  return value && typeof value.game === 'string' && typeof value.id === 'string'
    ? value as unknown as GamingFreshnessEvidence : undefined;
}

function safePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/**
 * Assess the actual bounded, formatted set, after lexical selection and acquisition.
 * This is deterministic topic/constraint coverage; semantic claim support is checked
 * against the composed answer. Source count never stands in for corroboration.
 */
export function assessGamingClearEvidence(
  input: GamingRetrievalPolicyInput & { game: string; requestedVersion?: string; region?: string },
  knowledge: GamingStoredKnowledgeContext,
  options: GamingClearEvidenceOptions = {}
): GamingClearAssessment {
  const chunks = knowledge.evidence ?? [];
  const bounded = chunks.length <= 8 && knowledge.sources.length <= 8
    && chunks.every(chunk => chunk.text.length <= 8_000) && knowledge.context.length <= 32_000;
  const selected = chunks.slice(0, 8);
  const sources = knowledge.sources.slice(0, 8);
  const refs = [...new Set(selected.flatMap(chunk => [chunk.sourceId, chunk.revisionId, chunk.recordId]))];
  const questionProfile = classifyGamingClearQuestion(input);
  const metadata = options.freshnessEvidence ?? sources.flatMap(source => {
    const value = sourceMetadata(source);
    return value ? [value] : [];
  });
  const relevantMetadata = metadata.filter(item => sources.some(source => source.sourceId === item.id || source.url === item.url));
  const patchSensitive = classifyGamingQuestionFreshness(input) !== 'stable';
  const evaluatedNow = options.now ?? new Date();
  const freshness = options.freshness ?? (patchSensitive && relevantMetadata.length
    ? evaluateGamingFreshness({ question: input.prompt, game: input.game, mode: input.mode,
      requestedVersion: input.requestedVersion, edition: input.edition, platform: input.platform, region: input.region,
      evidence: relevantMetadata, now: evaluatedNow }) : undefined);
  const freshnessCoversSet = freshness?.usable === true && sources.every(source =>
    freshness.selectedEvidenceIds.includes(source.sourceId)
      || relevantMetadata.some(item => item.url === source.url && freshness.selectedEvidenceIds.includes(item.id)));
  // A stable question does not need patch metadata, but explicit restrictions
  // still apply. Only verified historical-patch evidence may use an old interval.
  const historicalPatchVerified = freshnessCoversSet && Boolean(input.requestedVersion)
    && freshness?.effectivePatch === input.requestedVersion
    && freshness?.reasons.includes('HISTORICAL_PATCH_APPLICABILITY_VERIFIED') === true;
  const expected = new Set([input.game, resolveGamingGuideIdentity(input.game, input.edition)].map(normalizeGamingEvidenceGameIdentity));
  const identityConflict = sources.some(source => source.game && !expected.has(normalizeGamingEvidenceGameIdentity(source.game)))
    || relevantMetadata.some(item => !expected.has(normalizeGamingEvidenceGameIdentity(item.game)));
  const compatibilityConflict = relevantMetadata.some(item => item.metadataConflict
    || (item.effectiveFrom && Date.parse(item.effectiveFrom) > evaluatedNow.getTime())
    || (item.publishedAt && Date.parse(item.publishedAt) > evaluatedNow.getTime())
    || (!historicalPatchVerified && item.effectiveUntil && Date.parse(item.effectiveUntil) <= evaluatedNow.getTime())
    || (item.edition && normalizeGamingGameIdentity(item.edition) !== normalizeGamingGameIdentity(input.edition ?? ''))
    || (input.platform && item.platforms?.length && !item.platforms.some(platform => ['all', input.platform!.toLowerCase()].includes(platform.toLowerCase())))
    || (input.region && item.regions?.length && !item.regions.some(region => ['all', input.region!.toLowerCase()].includes(region.toLowerCase())))
    || (input.requestedVersion && item.patch && item.currentness !== 'current_index'
      && item.patch !== input.requestedVersion && !item.baselineForPatches?.includes(input.requestedVersion)))
    || sources.some(source => source.edition && normalizeGamingGameIdentity(source.edition) !== normalizeGamingGameIdentity(input.edition ?? ''));
  const compatibilityUnknown = relevantMetadata.some(item => item.metadataUnverified
    || (!input.platform && item.platforms?.length && !item.platforms.some(platform => platform.toLowerCase() === 'all'))
    || (!input.region && item.regions?.length && !item.regions.some(region => region.toLowerCase() === 'all'))
    || [item.effectiveFrom, item.effectiveUntil, item.publishedAt].some(value => value && !Number.isFinite(Date.parse(value))))
    || Boolean(input.edition && sources.some(source => !source.edition
      && !relevantMetadata.some(item => (item.id === source.sourceId || item.url === source.url) && item.edition === input.edition)
      && normalizeGamingEvidenceGameIdentity(source.game ?? '') !== normalizeGamingEvidenceGameIdentity(resolveGamingGuideIdentity(input.game, input.edition))));
  const identityVerified = !identityConflict && (options.identityVerified === true
    || (sources.length > 0 && sources.every(source => source.game && expected.has(normalizeGamingEvidenceGameIdentity(source.game)))));
  const traceable = selected.length > 0 && selected.every(chunk => chunk.text.trim().length > 0
    && [chunk.sourceId, chunk.revisionId, chunk.recordId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 240)
    && sources.some(source => source.sourceId === chunk.sourceId && source.url === chunk.publicUrl)
    && Number.isFinite(Date.parse(chunk.provenance.fetchedAt)));
  const { focusTerms } = buildGamingRetrievalTerms(input);
  const gameplayChunks = selected.filter(chunk => {
    const source = sources.find(item => item.sourceId === chunk.sourceId);
    const item = relevantMetadata.find(entry => entry.id === chunk.sourceId || entry.url === chunk.publicUrl);
    const role = source?.clearSourceAssessment?.sourceRole;
    if (chunk.recordId.endsWith(':verification') || role === 'currentness_index' || item?.currentness === 'current_index') return false;
    return questionProfile !== 'current_build' || (role !== 'patch_authority' && source?.sourceType !== 'official_updates'
      && source?.sourceType !== 'patch_notes' && item?.category !== 'official_updates');
  });
  const text = gameplayChunks.map(chunk => chunk.text).join('\n\n');
  const coverage = gamingTermCoverage(text, focusTerms);
  const structuralUnits = gameplayChunks.flatMap(chunk => chunk.evidenceUnits ?? []);
  const proseText = gamingClearIntactProseText({ text, evidenceUnits: structuralUnits, metrics: { truncated: false } });
  const structural = assessGamingStructuralUsability({ units: structuralUnits, ...input, proseText });
  const structuredClaim = structuralUnits.length > 0 && structural.claimShape !== 'none';
  const independentProse = !structural.hasRelevantClaimUnit && structural.hasIndependentProseAnchors
    && proseText.length >= 120 && gamingTermCoverage(proseText, focusTerms) >= 0.5;
  const progress = assessGamingProgressionRequest(input);
  const hasSupport = gameplayChunks.length > 0 && focusTerms.length > 0
    && (structuredClaim ? structural.claimSupported || independentProse : coverage >= 0.5) && !progress.clarificationNeeded;
  const uniqueText = new Set(selected.map(chunk => gamingClearHash(chunk.text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim())));
  // Identical or syndicated text never earns independent-corroboration credit.
  const duplicate = uniqueText.size < selected.length;
  const claims = new Map<string, string>();
  let contradictory = false;
  for (const item of relevantMetadata) for (const [key, value] of Object.entries(item.mechanicValues ?? {}).slice(0, 16)) {
    if (claims.has(key) && claims.get(key) !== value) contradictory = true;
    claims.set(key, value);
  }
  const findings: Array<{ code: string; severity: 'blocking' | 'warning'; evidenceRefs: string[] }> = [];
  const finding = (code: string, blocking = true) => findings.push({ code, severity: blocking ? 'blocking' : 'warning', evidenceRefs: refs.slice(0, 8) });
  if (!bounded) finding('EVIDENCE_BUDGET_EXCEEDED');
  if (identityConflict) finding('GAME_MISMATCH');
  if (compatibilityConflict) finding('APPLICABILITY_CONFLICT');
  if (compatibilityUnknown) finding('APPLICABILITY_UNVERIFIED');
  if (contradictory) finding('CONTRADICTORY_EVIDENCE');
  if (progress.clarificationNeeded) finding('PROGRESS_POINT_REQUIRED');
  if (!hasSupport) finding('QUESTION_COVERAGE_INSUFFICIENT');
  if (structuredClaim && !structural.claimSupported && !independentProse) for (const reason of structural.reasonCodes) finding(reason);
  if (!traceable) finding('CITATION_PROVENANCE_MISSING');
  if (patchSensitive && !freshnessCoversSet) finding('REQUIRED_FRESHNESS_UNVERIFIED');
  if (duplicate) finding('DUPLICATE_EVIDENCE', false);
  if (sources.some(source => !source.clearSourceAssessment)) finding('LEGACY_SOURCE_NOT_PREVIOUSLY_ASSESSED', false);
  const dimension = (score: number | null, code: string, unresolvedFacts: string[] = []) => ({
    status: score === null || refs.length === 0 ? 'unknown' as const : 'evaluated' as const, score: refs.length ? score : null,
    reasonCodes: [code], evidenceRefs: refs.slice(0, 8), unresolvedFacts
  });
  const identity = identityConflict ? 'conflict' as const : identityVerified ? 'verified' as const : 'unknown' as const;
  const applicable = !compatibilityConflict && !contradictory && !compatibilityUnknown;
  return createGamingClearAssessment({ profile: 'evidence', questionProfile, subjectId: `evidence:${gamingClearHash(refs)}`,
    subjectHash: gamingClearHash(selected.map(chunk => [chunk.sourceId, chunk.revisionId, chunk.recordId, chunk.text,
      ...(chunk.evidenceUnits?.length ? [chunk.evidenceUnits] : [])])),
    contextFingerprint: gamingClearContextFingerprint({ input, actorScopeHash: options.actorScopeHash,
      freshness: freshness ? [freshness.policyVersion, freshness.status, freshness.effectivePatch, freshness.effectiveBuild, freshness.verifiedAsOf] : null,
      applicability: relevantMetadata }), evidenceRefs: refs, assessmentMethod: 'deterministic', assessmentStatus: 'completed',
    ...(options.now ? { evaluatedAt: options.now.toISOString() } : {}),
    gates: { identity, compatibility: compatibilityConflict || contradictory ? 'conflict' : compatibilityUnknown ? 'unknown' : 'verified', claimSupport: hasSupport && bounded ? 'verified' : 'unknown',
      freshness: !patchSensitive ? 'not_applicable' : freshnessCoversSet ? 'verified' : 'unknown',
      provenance: traceable ? 'verified' : 'unknown', security: sources.every(source => safePublicUrl(source.url)) && bounded ? 'verified' : 'conflict' },
    dimensions: {
      clarity: dimension(selected.length ? selected.every(chunk => chunk.evidenceUnits?.length
        ? assessGamingStructuralUsability({ units: chunk.evidenceUnits }).hasIntactUsableUnit : chunk.text.trim().length >= 40) ? 4.2 : 3.5 : null, 'INTACT_ATTRIBUTABLE_PASSAGES'),
      leverage: dimension(selected.length ? Math.min(4.5, 2.5 + 2 * coverage) : null, 'COMBINED_TOPIC_COVERAGE', hasSupport ? [] : ['REQUEST_COVERAGE_INCOMPLETE']),
      efficiency: dimension(selected.length ? duplicate ? 3 : 4.2 : null, 'BOUNDED_NONREDUNDANT_SELECTION'),
      alignment: dimension(identityVerified && applicable ? 4.5 : null, 'REQUEST_APPLICABILITY', identityVerified ? [] : ['GAME_IDENTITY_UNVERIFIED']),
      resilience: dimension(traceable && applicable && (!patchSensitive || freshnessCoversSet) ? 3.8 : null, 'TRACEABLE_APPLICABLE_EVIDENCE', ['SEMANTIC_CLAIM_SUPPORT_REQUIRES_ANSWER_AUDIT'])
    }, findings });
}
