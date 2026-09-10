import { detectGamingDocumentGame } from './gamingDocumentIngestionCore.js';
import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from './gamingGameIdentity.js';
import { buildGamingRetrievalTerms, gamingTermCoverage } from './gamingRetrievalPolicy.js';
import { assessGamingSourcePolicy, classifyGamingQuestionFreshness, evaluateGamingFreshness, type GamingFreshnessEvidence, type GamingSourcePolicyAssessment } from './gamingFreshnessCore.js';
import type { GamingStoredKnowledgeInput } from './gamingStoredEvidenceCore.js';
import type { ResolvedGamingDocument } from '@services/gamingDocumentResolution.js';
import { assessGamingStructuralUsability, readGamingEvidenceUnits } from './gamingStructuralEvidence.js';
import { createGamingClearAssessment, classifyGamingClearQuestion, gamingClearContextFingerprint,
  type GamingClearSourceRole } from './gamingClearPolicy.js';

const containsIdentity = (text: string, expected: string): boolean => (`-${normalizeGamingGameIdentity(text)}-`)
  .includes(`-${normalizeGamingGameIdentity(expected)}-`);
const DOCUMENT_LABEL = /^(?:(?:beginner|boss|build|class|combat|current|endgame|loadout|mechanics|patch|progression|pve|pvp|quest|raid|route|season|strategy|survival|synthetic)-){0,4}(?:guide|build|loadout|walkthrough|wiki|tips|patch-notes|release-notes|update-notes)$/u;
const DISTINCT_SCOPE = /^(?:ii|iii|iv|\d+|nightreign|classic|remastered|remake|bedrock|java|shadow-of-the-erdtree|dlc|expansion)(?:-|$)/u;

/** Structural serialization never becomes fallback prose, even when repeated. */
export function gamingClearIntactProseText(document: Pick<ResolvedGamingDocument, 'text' | 'evidenceUnits'> & {
  metrics: Pick<ResolvedGamingDocument['metrics'], 'truncated'>;
}): string {
  const units = readGamingEvidenceUnits(document.evidenceUnits, undefined, document.text);
  let prose = document.text;
  for (const unit of units) prose = prose.split(unit.text).join('');
  if (!document.metrics.truncated) return prose.trim();
  let proseEnd = 0;
  for (const match of prose.matchAll(/[.!?](?=\s|$)/gu)) proseEnd = match.index + 1;
  return prose.slice(0, proseEnd).trim();
}

/** A truncated final sentence cannot be evidence for a claim whose qualification may be missing. */
export function gamingClearIntactSourceText(document: Pick<ResolvedGamingDocument, 'text' | 'metrics' | 'evidenceUnits'>): string {
  const units = readGamingEvidenceUnits(document.evidenceUnits, undefined, document.text);
  const prose = gamingClearIntactProseText(document);
  if (units.length) {
    // Parser-verified unit boundaries survive truncation elsewhere. Prose still
    // requires its own final sentence; parser repair never establishes integrity.
    return [prose, ...units.filter(unit => assessGamingStructuralUsability({ units: [unit] }).hasIntactUsableUnit)
      .map(unit => unit.text)].filter(Boolean).join('\n\n');
  }
  return document.metrics.truncated ? prose : document.text;
}

/** Historical expiry exemptions require acquired patch evidence, never a requested label alone. */
export function gamingClearHistoricalSourceVerified(input: Pick<GamingStoredKnowledgeInput, 'prompt' | 'game' | 'mode' | 'requestedVersion' | 'edition' | 'platform'> & { region?: string },
  freshness: GamingFreshnessEvidence, now: Date): boolean {
  if (!/\b(?:historical|as of|old patch|previous patch)\b/iu.test(input.prompt) || !input.requestedVersion) return false;
  const evaluated = evaluateGamingFreshness({ question: input.prompt, game: input.game, mode: input.mode,
    requestedVersion: input.requestedVersion, edition: input.edition, platform: input.platform, region: input.region,
    evidence: [freshness], now });
  return evaluated.usable && evaluated.reasons.includes('HISTORICAL_PATCH_APPLICABILITY_VERIFIED')
    && evaluated.selectedEvidenceIds.includes(freshness.id);
}

/** Acquired labels are assertions, never independent proof. Complete names preserve edition distinctions. */
export function assessGamingClearSourceIdentity(document: Pick<ResolvedGamingDocument, 'text' | 'metadata' | 'publicUrl'>,
  input: Pick<GamingStoredKnowledgeInput, 'game' | 'edition' | 'prompt' | 'mode'>,
  policy: GamingSourcePolicyAssessment): { status: 'verified' | 'unknown' | 'conflict'; reasonCodes: string[] } {
  const expected = new Set([normalizeGamingGameIdentity(input.game), resolveGamingGuideIdentity(input.game, input.edition)]);
  const labels = [...document.text.slice(0, 32_000).matchAll(/\bgame\s*:\s*(.{1,160}?)(?=\.(?:\s|$)|;|\||\n|\s+(?:Edition|Platform|Region|Patch|Build|Published at|Effective from)\s*:|$)/giu)];
  if (labels.some(label => !expected.has(normalizeGamingGameIdentity(label[1])))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
  const metadata = [document.metadata.title, document.metadata.headings].filter((value): value is string => Boolean(value));
  for (const value of metadata) {
    const identity = normalizeGamingGameIdentity(value);
    // Explicit sequel/edition qualifiers cannot be erased by a broad franchise alias.
    if ([...expected].some(game => identity.startsWith(`${game}-`) && DISTINCT_SCOPE.test(identity.slice(game.length + 1))
      && ![...expected].some(full => full !== game && (identity === full || identity.startsWith(`${full}-`))))) {
      return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    }
    const detected = detectGamingDocumentGame({ canonicalUrl: document.publicUrl, pageTitle: value });
    if (detected.game && detected.confidence >= 0.8 && !expected.has(normalizeGamingGameIdentity(detected.game))
      && ![...expected].some(game => containsIdentity(value, game))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    // A complete ordinary guide title for a different unknown game remains an explicit veto.
    if (!metadata.some(item => [...expected].some(game => containsIdentity(item, game)))
      && /.+\s+(?:guide|build|walkthrough|wiki|patch notes|release notes)$/iu.test(value)) {
      return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    }
  }
  const prose = document.text.slice(0, 32_000).replace(/\bgame\s*:[^.;|\n]{1,160}[.;]?/giu, '');
  const bodyHeadings = prose.split(/\n+|(?<=[.!?])\s+/u).slice(0, 128)
    .filter(unit => /^[^.!?\n]{2,160}\b(?:guide|build|walkthrough)\s*:/iu.test(unit));
  for (const heading of bodyHeadings) {
    // URL-first detection must not hide an explicit conflicting subject in acquired prose.
    const detected = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: heading.slice(0, 240) });
    if (detected.game && detected.confidence >= 0.8 && !expected.has(normalizeGamingGameIdentity(detected.game))
      && ![...expected].some(game => containsIdentity(heading.split(':')[0], game))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
  }
  // Only an explicit body subject can veto metadata; incidental comparisons do not establish a different subject.
  const bodySubject = /(?:^|[.!?]\s+)(?:this (?:guide|build|walkthrough) (?:covers|is for)|in(?: the game)?)\s+([^.!?\n]{2,160})/iu.exec(prose.trim())?.[1];
  if (bodySubject) {
    const detected = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: bodySubject });
    if (detected.game && detected.confidence >= 0.8 && !expected.has(normalizeGamingGameIdentity(detected.game))
      && ![...expected].some(game => containsIdentity(bodySubject, game)))
      return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    if ([...expected].some(game => {
      const bodyIdentity = normalizeGamingGameIdentity(bodySubject);
      return bodyIdentity.startsWith(`${game}-`) && DISTINCT_SCOPE.test(bodyIdentity.slice(game.length + 1))
        && ![...expected].some(full => full !== game && bodyIdentity.startsWith(`${full}-`));
    })) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
  }
  const ordinaryTitle = metadata.some(value => [...expected].some(game => {
    const identity = normalizeGamingGameIdentity(value);
    return identity === game || identity.startsWith(`${game}-`) && DOCUMENT_LABEL.test(identity.slice(game.length + 1));
  }));
  const metadataAnchor = metadata.some(value => [...expected].some(game => containsIdentity(value, game)));
  const proseAnchor = [...expected].some(game => containsIdentity(document.text.replace(/\bgame\s*:[^.;|\n]{1,160}[.;]?/giu, ''), game));
  // The resolver already bounded this document; identity relevance must not erase a late intact passage.
  const relevant = gamingTermCoverage(document.text, buildGamingRetrievalTerms(input).focusTerms) >= 0.25;
  const reviewedAssociation = Boolean(policy.ruleId) && ['official', 'specialist', 'community'].includes(policy.authority);
  if (!(metadataAnchor && proseAnchor && relevant) && !(reviewedAssociation && metadataAnchor))
    return { status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] };
  if (input.edition && !containsIdentity([document.metadata.title, document.metadata.headings, prose].join(' '), input.edition))
    return { status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'] };
  return { status: 'verified', reasonCodes: [ordinaryTitle ? 'ACQUIRED_TITLE_AND_PASSAGE_IDENTITY' : reviewedAssociation
    ? 'REVIEWED_GAME_ASSOCIATION' : 'ACQUIRED_METADATA_AND_BODY_IDENTITY'] };
}

export function gamingClearSourceRole(input: Pick<GamingStoredKnowledgeInput, 'mode'>,
  policy: GamingSourcePolicyAssessment): GamingClearSourceRole {
  return policy.currentness === 'current_index' ? 'currentness_index' : policy.currentness === 'live_status' ? 'live_status'
    : policy.category === 'official_updates' ? 'patch_authority' : policy.category === 'community' ? 'community_observation'
      : input.mode === 'build' ? 'build_analysis' : 'gameplay_guide';
}

/** All values are backend features after hard acquisition checks. No source-selected policy or model call. */
export function assessGamingClearSource(input: GamingStoredKnowledgeInput & { region?: string }, document: ResolvedGamingDocument,
  options: { subjectId: string; subjectHash: string; actorScopeHash: string; sourcePolicy: GamingSourcePolicyAssessment;
    freshness: GamingFreshnessEvidence; now: Date }) {
  const role = gamingClearSourceRole(input, options.sourcePolicy);
  const identity = assessGamingClearSourceIdentity(document, input, options.sourcePolicy);
  const supporting = ['patch_authority', 'currentness_index', 'live_status'].includes(role);
  const intactText = gamingClearIntactSourceText(document);
  const coverage = gamingTermCoverage(intactText, buildGamingRetrievalTerms(input).focusTerms);
  const proseText = gamingClearIntactProseText(document);
  const structural = assessGamingStructuralUsability({ units: document.evidenceUnits, ...input, proseText });
  const structuredClaim = Boolean(document.evidenceUnits?.length) && structural.claimShape !== 'none';
  const independentProse = !structural.hasRelevantClaimUnit && structural.hasIndependentProseAnchors
    && proseText.length >= 120 && gamingTermCoverage(proseText, buildGamingRetrievalTerms(input).focusTerms) >= 0.25;
  const usable = structural.hasIntactUsableUnit || intactText.trim().length >= 120;
  const relevant = structuredClaim ? structural.claimSupported || independentProse : coverage >= 0.25 || supporting;
  const refs = [options.subjectId];
  const evaluated = (score: number, reasonCode: string) => ({ status: 'evaluated' as const, score,
    reasonCodes: [reasonCode], evidenceRefs: refs, unresolvedFacts: [] as string[] });
  const stable = classifyGamingQuestionFreshness(input) === 'stable';
  const historical = gamingClearHistoricalSourceVerified(input, options.freshness, options.now);
  const verification = (options.freshness as GamingFreshnessEvidence & { currentVerification?: {
    artifactHash?: string; indexHash?: string; evidence?: GamingFreshnessEvidence; snippet?: string } }).currentVerification;
  const verifiedIndex = verification?.evidence;
  const combinedCurrent = verifiedIndex && verification.artifactHash === options.subjectHash
    && /^[a-f0-9]{64}$/u.test(verification.indexHash ?? '') && (verification.snippet?.length ?? Infinity) <= 600
    && verifiedIndex.currentness === 'current_index' && Boolean(verifiedIndex.ruleId)
    && assessGamingSourcePolicy(verifiedIndex.url, input.game).ruleId === verifiedIndex.ruleId
    && evaluateGamingFreshness({ question: input.prompt, game: input.game, mode: input.mode,
      requestedVersion: input.requestedVersion, edition: input.edition, platform: input.platform, region: input.region,
      evidence: [options.freshness, verifiedIndex], now: options.now }).usable;
  const future = [options.freshness.effectiveFrom, options.freshness.publishedAt].some(value => value && Date.parse(value) > options.now.getTime());
  const invalidInterval = [options.freshness.effectiveFrom, options.freshness.effectiveUntil, options.freshness.publishedAt]
    .some(value => value !== undefined && !Number.isFinite(Date.parse(value)));
  const expired = !historical && Boolean(options.freshness.effectiveUntil && Date.parse(options.freshness.effectiveUntil) <= options.now.getTime());
  const wrongPatch = Boolean(input.requestedVersion && options.freshness.patch
    && normalizeGamingGameIdentity(input.requestedVersion) !== normalizeGamingGameIdentity(options.freshness.patch)
    && !options.freshness.baselineForPatches?.some(patch => patch.normalize('NFKC').trim().toLowerCase()
      === input.requestedVersion!.normalize('NFKC').trim().toLowerCase()));
  const compatibility = options.freshness.metadataConflict || future || expired || wrongPatch ? 'conflict' as const
    : options.freshness.metadataUnverified || invalidInterval ? 'unknown' as const : 'verified' as const;
  const substantiveFreshness = stable || historical || combinedCurrent ? 'verified' as const : role === 'live_status'
    ? evaluateGamingFreshness({ question: input.prompt, game: input.game, evidence: [options.freshness], now: options.now }).usable
      ? 'verified' as const : 'unknown' as const : supporting ? 'not_applicable' as const : 'unknown' as const;
  return createGamingClearAssessment({ profile: 'source', questionProfile: classifyGamingClearQuestion(input), sourceRole: role,
    subjectId: options.subjectId, subjectHash: options.subjectHash,
    contextFingerprint: gamingClearContextFingerprint({ actorScopeHash: options.actorScopeHash, game: input.game, edition: input.edition,
      prompt: input.prompt, mode: input.mode, platform: input.platform, region: input.region, requestedVersion: input.requestedVersion,
      currentArea: input.currentArea, lastCompletedObjective: input.lastCompletedObjective, progressPoint: input.progressPoint,
      constraints: input.constraints, spoilerMode: input.spoilerMode, answerDepth: input.answerDepth, freshness: options.freshness }),
    evidenceRefs: refs,
    gates: { identity: identity.status, compatibility, claimSupport: usable && relevant ? 'verified' : 'unknown',
      freshness: substantiveFreshness, provenance: 'verified', security: document.metrics.instructionFiltered ? 'conflict' : 'verified' },
    dimensions: {
      clarity: evaluated(usable ? structural.hasIntactUsableUnit ? 4 : /[.!?](?:\s|$)/u.test(document.text) ? 4.5 : 4 : 0,
        usable ? structural.hasIntactUsableUnit ? 'INTELLIGIBLE_HEADER_VALUE_RELATIONSHIPS' : 'INTELLIGIBLE_RELEVANT_EXTRACTION' : 'INSUFFICIENT_EXTRACTION'),
      leverage: evaluated(relevant ? coverage >= 0.5 ? 4.5 : 4 : 1, supporting ? 'SUPPORTING_SOURCE_ROLE' : relevant ? 'QUESTION_ANCHORS_PRESENT' : 'QUESTION_COVERAGE_INSUFFICIENT'),
      efficiency: evaluated(!structural.hasIntactUsableUnit && (document.extraction.navigationDensity ?? 0) >= 0.4 ? 3 : 4.5,
        structural.hasIntactUsableUnit ? 'ISOLATED_ATTRIBUTABLE_STRUCTURAL_UNITS' : 'BOUNDED_CHUNK_RETRIEVAL_AVAILABLE'),
      alignment: identity.status === 'verified' ? evaluated(4, identity.reasonCodes[0]) : { status: 'unknown', score: null,
        reasonCodes: identity.reasonCodes, evidenceRefs: refs, unresolvedFacts: ['GAME_IDENTITY'] },
      resilience: { ...evaluated(document.metrics.truncated ? 3 : 3.5, document.metrics.truncated ? 'EXTRACTION_PARTIAL' : 'TRACEABLE_ACQUIRED_DOCUMENT'),
        unresolvedFacts: ['INDEPENDENT_CORROBORATION_NOT_ESTABLISHED', ...(!stable && !historical && !combinedCurrent ? ['COMBINED_APPLICABILITY_REQUIRED'] : [])] }
    }, findings: [...(structuredClaim && !structural.claimSupported && !independentProse ? structural.reasonCodes.map(code => ({ code, severity: 'blocking' as const, evidenceRefs: refs })) : []),
      ...(future || expired || wrongPatch ? [{ code: future ? 'NOT_YET_EFFECTIVE' : expired ? 'NO_LONGER_EFFECTIVE' : 'PATCH_MISMATCH', severity: 'blocking' as const, evidenceRefs: refs }] : []),
      ...identity.reasonCodes.filter(() => identity.status !== 'verified').map(code => ({ code, severity: identity.status === 'conflict'
      ? 'blocking' as const : 'warning' as const, evidenceRefs: refs })), ...(document.metrics.truncated
      ? [{ code: 'EXTRACTION_PARTIAL', severity: 'warning' as const, evidenceRefs: refs }] : [])], evaluatedAt: options.now.toISOString()
  });
}
