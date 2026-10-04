import { resolveGamingRequestEdition, gamingEditionEvidenceMatchesRequest, readGamingMinecraftEditionScope, normalizeGamingMinecraftEdition } from './gamingGameIdentity.js';
import { resolveGamingFreshnessDisposition } from './gamingFreshnessDisposition.js';
import { detectGamingDocumentGame } from './gamingDocumentIngestionCore.js';
import { normalizeGamingGameIdentity, normalizeGamingEditionIdentity, resolveGamingGuideIdentity } from './gamingGameIdentity.js';
import { buildGamingRetrievalTerms, buildGamingRequestRequirements, hasGamingRelevantGuideContribution, gamingTermCoverage } from './gamingRetrievalPolicy.js';
import { assessGamingSourcePolicy, classifyGamingQuestionFreshness, extractGamingFreshnessMetadata, evaluateGamingFreshness, type GamingFreshnessEvidence, type GamingSourcePolicyAssessment } from './gamingFreshnessCore.js';
import type { GamingStoredKnowledgeInput } from './gamingStoredEvidenceCore.js';
import type { ResolvedGamingDocument } from '@services/gamingDocumentResolution.js';
import { assessGamingStructuralUsability, classifyGamingEditionRequirements, readGamingEvidenceUnits, selectGamingEditionScopedEvidence, selectGamingSourceEditionScopedEvidence } from './gamingStructuralEvidence.js';
import { createGamingClearAssessment, classifyGamingClearQuestion, gamingClearContextFingerprint,
  type GamingClearSourceRole } from './gamingClearPolicy.js';
import { detectGamingLeadingGameAlias } from '@services/gamingGameDetection.js';

const containsIdentity = (text: string, expected: string): boolean => (`-${normalizeGamingGameIdentity(text)}-`)
  .includes(`-${normalizeGamingGameIdentity(expected)}-`);
const DOCUMENT_LABEL = /^(?:(?:beginner|boss|build|class|combat|current|endgame|loadout|mechanics|patch|progression|pve|pvp|quest|raid|route|season|strategy|survival|synthetic)-){0,4}(?:guide|build|loadout|walkthrough|wiki|tips|patch-notes|release-notes|update-notes)$/u;
const DISTINCT_SCOPE = /^(?:ii|iii|iv|\d+|nightreign|classic|remastered|remake|bedrock|java|dungeons|legends|shadow-of-the-erdtree|dlc|expansion)(?:-|$)/u;

/** Inspect bounded acquired scope clauses, preserving visibly quoted/reference context. */
function acquiredBodySubjects(prose: string): Array<{ text: string; explicitGameScope: boolean }> {
  const unquoted = prose.replace(/"[^"]*"|“[^”]*”|`[^`]*`|(?:^|\s)'(?:[^']|(?<=\w)'(?=\w))*'|‘[^’]*’/gu,
    (quote, offset: number) => {
      const name = quote.replace(/^[\s"“`'‘]+|[\s"”`'’]+$/gu, '');
      // Quoting a game name does not turn an affirmative scope into a quoted passage.
      const scopeName = /\b(?:this (?:guide|build|walkthrough) (?:covers|is for)|in(?: the game)?)\s*$/iu.test(prose.slice(0, offset));
      const titleSuffix = prose.slice(offset + quote.length).match(/^\s+(?:guide|build|loadout|meta|walkthrough|wiki|tips?)\b/iu)?.[0] ?? '';
      const namedSubject = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: `${name}${titleSuffix}` });
      return detectGamingLeadingGameAlias(name, true).game || (scopeName && (detectGamingLeadingGameAlias(name).game
        || namedSubject.source === 'page_metadata' && namedSubject.confidence >= 0.8))
        ? quote.replace(/^[\s"“`'‘]+|[\s"”`'’]+$/gu, boundary => ' '.repeat(boundary.length)) : ' '.repeat(quote.length);
    });
  const subjects: Array<{ text: string; explicitGameScope: boolean }> = [];
  for (const match of unquoted.matchAll(/\b(?:this (?:guide|build|walkthrough) (?:covers|is for)|in(?: the game)?)\s+/giu)) {
    const before = unquoted.slice(0, match.index);
    const prefix = before.slice(Math.max(...['.', '!', '?', ';', ',', '\n'].map(boundary => before.lastIndexOf(boundary))) + 1);
    const subject = unquoted.slice(match.index + match[0].length).split(/[,;.!?\n]/u, 1)[0].slice(0, 160).trim();
    // Reference qualifiers apply locally, so a later affirmative clause after
    // a comma or sentence boundary is still independently inspected.
    if (/\b(?:unlike|compared(?:\s+to)?|comparison(?:\s+with)?|contrast(?:\s+to)?|similar(?:ly)?|rather\s+than|instead\s+of|as(?:\s+is\s+the\s+case)?|like)\s*$/iu.test(prefix)
      || /\b(?:not(?:\s+(?:apply|applicable|valid|available|supported|used|found|present|exist|included|be|for)){0,4}|(?:doesn|isn|aren|don|didn)['’]?t(?:\s+(?:apply|exist|work))?|without|except|excluding|unavailable|unsupported)\s*$/iu.test(prefix)
      || /^(?:contrast|comparison|case|addition|particular)\b/iu.test(subject)) continue;
    if (subject) subjects.push({ text: subject, explicitGameScope: /^(?:this|in the game)\b/iu.test(match[0]) });
  }
  return subjects;
}

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
export function assessGamingClearSourceIdentity(document: Pick<ResolvedGamingDocument, 'text' | 'metadata' | 'publicUrl'> & Partial<Pick<ResolvedGamingDocument, 'evidenceUnits'>>,
  input: Pick<GamingStoredKnowledgeInput, 'game' | 'edition' | 'prompt' | 'mode' | 'requestedVersion'>,
  policy: GamingSourcePolicyAssessment, _allowPartialCoverage = false): { status: 'verified' | 'unknown' | 'conflict'; reasonCodes: string[] } {
  input = { ...input, edition: resolveGamingRequestEdition(input) };
  const expected = new Set([normalizeGamingGameIdentity(input.game), resolveGamingGuideIdentity(input.game, input.edition)]);
  let scoped = selectGamingEditionScopedEvidence(document, input);
  const minecraftScope = readGamingMinecraftEditionScope(document, input.game);
  const minecraft = normalizeGamingGameIdentity(input.game) === 'minecraft';
  const minecraftIdentity = (value: string) => minecraft && /^minecraft-(?:java|bedrock)(?:-edition)?$/u.test(value);
  const minecraftQualifier = (value: string) => {
    const match = /^(?:java|bedrock)(?:-edition)?(?:-(.*))?$/u.exec(value);
    return minecraft && Boolean(match) && !(match?.[1] && DISTINCT_SCOPE.test(match[1]));
  };
  if (scoped.reasonCodes.includes('GAME_MISMATCH')) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
  const labels = [...document.text.slice(0, 32_000).matchAll(/\bgame\s*:\s*(.{1,160}?)(?=\.(?:\s|$)|;|\||\n|\s+(?:Edition|Platform|Region|Patch|Build|Published at|Effective from)\s*:|$)/giu)];
  if (labels.some(label => !expected.has(normalizeGamingGameIdentity(label[1])) && !minecraftIdentity(normalizeGamingGameIdentity(label[1])))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
  const metadata = [document.metadata.title, document.metadata.headings].filter((value): value is string => Boolean(value));
  let editionScopeConflict = false;
  for (const value of metadata) {
    const identity = normalizeGamingGameIdentity(value);
    // Explicit sequel/edition qualifiers cannot be erased by a broad franchise alias.
    if ([...expected].some(game => identity.startsWith(`${game}-`) && DISTINCT_SCOPE.test(identity.slice(game.length + 1))
      && ![...expected].some(full => full !== game && (identity === full || identity.startsWith(`${full}-`))))) {
      if (/^shadow-of-the-erdtree|^(?:dlc|expansion)(?:-|$)/u.test(identity.slice(normalizeGamingGameIdentity(input.game).length + 1)))
        editionScopeConflict = true;
      else if (!(minecraftQualifier(identity.slice(normalizeGamingGameIdentity(input.game).length + 1)))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    }
    // Acquired title and body can establish an explicit different subject even
    // outside the alias catalog. A URL label must not hide that contradiction.
    const detected = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: value });
    const acquiredBody = document.text.replace(/\bgame\s*:[^.;|\n]{1,160}[.;]?/giu, '');
    if (detected.game && (detected.source === 'alias' || containsIdentity(acquiredBody, detected.game)) && detected.confidence >= 0.8 && !expected.has(normalizeGamingGameIdentity(detected.game))
      && ![...expected].some(game => containsIdentity(value, game))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };

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
  // Every affirmative acquired subject binds; matching titles and earlier
  // requested-game subjects cannot hide a later different gameplay scope.
  for (const { text: bodySubject, explicitGameScope } of acquiredBodySubjects(prose)) {
    const leading = detectGamingLeadingGameAlias(bodySubject);
    const metadataSubject = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: bodySubject });
    // Bare location clauses can use guide/build as imperative verbs. Their
    // objects do not declare a new game; explicit game scopes and aliases do.
    const firstInstructionMarker = /\b(?:guide|build|loadout|meta|walkthrough|wiki|tips?|tier(?:\s+list)?|patch\s+notes)\b/iu.exec(bodySubject);
    const instructionalClause = !explicitGameScope && Boolean(firstInstructionMarker
      && /^(?:guide|build)$/iu.test(firstInstructionMarker[0])
      && /^\s+(?:a|an|the|your|our|their|my|his|her|its|them|him|us|me)\b/iu.test(
        bodySubject.slice(firstInstructionMarker.index + firstInstructionMarker[0].length)));
    const detected = leading.game ? leading : metadataSubject.source !== 'alias' && !instructionalClause ? metadataSubject : leading;
    const subjectIdentity = normalizeGamingGameIdentity(bodySubject);
    const expectedSubject = [...expected].some(game => subjectIdentity === game || subjectIdentity.startsWith(`${game}-`));
    if (detected.game && detected.confidence >= 0.8 && !expected.has(normalizeGamingGameIdentity(detected.game))
      && !(leading.game ? expectedSubject : [...expected].some(game => containsIdentity(bodySubject, game))))
      return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    if ([...expected].some(game => {
      const bodyIdentity = normalizeGamingGameIdentity(bodySubject);
      return bodyIdentity.startsWith(`${game}-`) && DISTINCT_SCOPE.test(bodyIdentity.slice(game.length + 1))
        && ![...expected].some(full => full !== game && bodyIdentity.startsWith(`${full}-`));
    })) {
      const qualifier = normalizeGamingGameIdentity(bodySubject).slice(normalizeGamingGameIdentity(input.game).length + 1);
      if (/^shadow-of-the-erdtree|^(?:dlc|expansion)(?:-|$)/u.test(qualifier)) editionScopeConflict = true;
      else if (!(minecraftQualifier(qualifier))) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
    }
  }
  const ordinaryTitle = metadata.some(value => [...expected].some(game => {
    const identity = normalizeGamingGameIdentity(value);
    return identity === game || identity.startsWith(`${game}-`) && DOCUMENT_LABEL.test(identity.slice(game.length + 1));
  }));
  const metadataAnchor = metadata.some(value => [...expected].some(game => containsIdentity(value, game)));
  const proseAnchor = [...expected].some(game => containsIdentity(document.text.replace(/\bgame\s*:[^.;|\n]{1,160}[.;]?/giu, ''), game));
  const reviewedAssociation = Boolean(policy.ruleId) && ['official', 'specialist', 'community'].includes(policy.authority);
  if (!(metadataAnchor && proseAnchor) && !(reviewedAssociation && metadataAnchor))
    return { status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] };
  // Parent Minecraft scope is acquired independently from a requested edition choice.
  if (minecraftScope.status === 'conflict') return { status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] };
  if (minecraftScope.status === 'unverified') return { status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'] };
  if (minecraftScope.status === 'verified') {
    if (input.edition && normalizeGamingMinecraftEdition(input.edition) !== minecraftScope.edition)
      return { status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] };
    if (!input.edition && (minecraftScope.exclusive || resolveGamingFreshnessDisposition(input) === 'REQUIRED'))
      return { status: 'unknown', reasonCodes: ['EDITION_REQUIRED'] };
  }
  const applicability = extractGamingFreshnessMetadata(document, input);
  const qualifiedSourceEdition = !input.edition && applicability.edition
    && gamingEditionEvidenceMatchesRequest(applicability.edition, undefined, input);
  if (!input.edition && applicability.edition && !qualifiedSourceEdition)
    return { status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'] };
  if (qualifiedSourceEdition) scoped = selectGamingSourceEditionScopedEvidence(document, input, applicability.edition);
  if (scoped.reasonCodes.includes('GAME_MISMATCH')) return { status: 'conflict', reasonCodes: ['GAME_MISMATCH'] };
  // Evaluate game contradictions before reporting narrower edition scope.
  const baseRequest = input.edition && normalizeGamingEditionIdentity(input.edition) === 'base-game';
  const requirements = qualifiedSourceEdition ? classifyGamingEditionRequirements(scoped.status === 'verified' || scoped.reasonCodes.length > 0
    ? gamingClearIntactProseText({ ...document, metrics: { truncated: false } }) : document.text, false, true)
    : baseRequest && scoped.status !== 'verified' ? classifyGamingEditionRequirements(document.text) : 'clear';
  if (editionScopeConflict || scoped.status === 'conflict' || requirements === 'conflict'
    || baseRequest && metadata.some(value => /\bshadow[\s-]+of[\s-]+the[\s-]+erdtree\b/iu.test(value)))
    return { status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] };
  if (requirements === 'unverified' || scoped.status === 'unverified' && scoped.reasonCodes.length)
    return { status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'] };
  if (input.edition) {
    // Game identity is independently verified. An ordinary base-game request
    // allows absent edition metadata; positive scope claims and conflicts still bind.
    if (normalizeGamingEditionIdentity(input.edition) === 'base-game') {
      if (!gamingEditionEvidenceMatchesRequest(applicability.edition, input.edition))
        return { status: applicability.edition ? 'conflict' : 'unknown', reasonCodes: [applicability.edition ? 'EDITION_CONFLICT' : 'EDITION_UNVERIFIED'] };
    } else if (minecraftScope.status !== 'verified' && !containsIdentity([document.metadata.title, document.metadata.headings, prose].join(' '), input.edition)) {
      return { status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'] };
    }
  }
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
    freshness: GamingFreshnessEvidence; now: Date; allowPartialCoverage?: boolean }) {
  input = { ...input, edition: resolveGamingRequestEdition(input) };
  const role = gamingClearSourceRole(input, options.sourcePolicy);
  const identity = assessGamingClearSourceIdentity(document, input, options.sourcePolicy, options.allowPartialCoverage);
  const editionIssue = identity.reasonCodes.every(code => code.startsWith('EDITION_'));
  const gameIdentity = editionIssue ? 'verified' as const : identity.status;
  const scoped = selectGamingSourceEditionScopedEvidence(document, input, options.freshness.edition);
  const qualifiedSourceEdition = !input.edition && options.freshness.edition
    && gamingEditionEvidenceMatchesRequest(options.freshness.edition, undefined, input);
  const evidenceDocument = scoped.status === 'verified' ? { ...document, text: scoped.text, evidenceUnits: scoped.units } : document;
  const supporting = ['patch_authority', 'currentness_index', 'live_status'].includes(role);
  const intactText = gamingClearIntactSourceText(evidenceDocument);
  const coverage = gamingTermCoverage(intactText, buildGamingRetrievalTerms(input).focusTerms);
  const proseText = gamingClearIntactProseText(evidenceDocument);
  const structural = assessGamingStructuralUsability({ units: evidenceDocument.evidenceUnits, ...input, proseText });
  const structuredClaim = Boolean(evidenceDocument.evidenceUnits?.length) && structural.claimShape !== 'none';
  const independentProse = !structural.hasRelevantClaimUnit && structural.hasIndependentProseAnchors
    && proseText.length >= 120 && gamingTermCoverage(proseText, buildGamingRetrievalTerms(input).focusTerms) >= 0.25;
  const usable = structural.hasIntactUsableUnit || intactText.trim().length >= 120;
  const partialTopic = options.allowPartialCoverage === true
    && buildGamingRequestRequirements(input).some(requirement => gamingTermCoverage(intactText, requirement.terms) === 1);
  const contribution = options.allowPartialCoverage === true && hasGamingRelevantGuideContribution(intactText, input);
  const partial = options.allowPartialCoverage === true && usable && (coverage >= 0.25 || partialTopic || contribution)
    && !structural.reasonCodes.includes('CONTRADICTORY_STRUCTURAL_RECORDS');
  const relevant = supporting || (structuredClaim ? structural.claimSupported || independentProse || partial : coverage >= 0.25 || partialTopic || contribution);
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
  const compatibility = options.freshness.metadataConflict || future || expired || wrongPatch || editionIssue && identity.status === 'conflict' ? 'conflict' as const
    : options.freshness.metadataUnverified || invalidInterval || editionIssue && identity.status === 'unknown' ? 'unknown' as const : 'verified' as const;
  const substantiveFreshness = stable || historical || combinedCurrent ? 'verified' as const : role === 'live_status'
    ? evaluateGamingFreshness({ question: input.prompt, game: input.game, evidence: [options.freshness], now: options.now }).usable
      ? 'verified' as const : 'unknown' as const : supporting ? 'not_applicable' as const : 'unknown' as const;
  const assessment = createGamingClearAssessment({ profile: 'source', questionProfile: classifyGamingClearQuestion(input), sourceRole: role,
    subjectId: options.subjectId, subjectHash: options.subjectHash,
    contextFingerprint: gamingClearContextFingerprint({ actorScopeHash: options.actorScopeHash, game: input.game, edition: input.edition,
      prompt: input.prompt, mode: input.mode, platform: input.platform, region: input.region, requestedVersion: input.requestedVersion,
      currentArea: input.currentArea, lastCompletedObjective: input.lastCompletedObjective, progressPoint: input.progressPoint,
      constraints: input.constraints, spoilerMode: input.spoilerMode, answerDepth: input.answerDepth, freshness: options.freshness }),
    evidenceRefs: refs,
    gates: { identity: gameIdentity, compatibility, claimSupport: usable && relevant ? 'verified' : 'unknown',
      freshness: substantiveFreshness, provenance: 'verified', security: document.metrics.instructionFiltered ? 'conflict' : 'verified' },
    dimensions: {
      clarity: evaluated(usable ? structural.hasIntactUsableUnit ? 4 : /[.!?](?:\s|$)/u.test(document.text) ? 4.5 : 4 : 0,
        usable ? structural.hasIntactUsableUnit ? 'INTELLIGIBLE_HEADER_VALUE_RELATIONSHIPS' : 'INTELLIGIBLE_RELEVANT_EXTRACTION' : 'INSUFFICIENT_EXTRACTION'),
      leverage: evaluated(relevant ? coverage >= 0.5 ? 4.5 : 4 : 1, supporting ? 'SUPPORTING_SOURCE_ROLE' : relevant ? 'QUESTION_ANCHORS_PRESENT' : 'QUESTION_COVERAGE_INSUFFICIENT'),
      efficiency: evaluated(!structural.hasIntactUsableUnit && (document.extraction.navigationDensity ?? 0) >= 0.4 ? 3 : 4.5,
        structural.hasIntactUsableUnit ? 'ISOLATED_ATTRIBUTABLE_STRUCTURAL_UNITS' : 'BOUNDED_CHUNK_RETRIEVAL_AVAILABLE'),
      alignment: identity.status === 'verified' ? evaluated(4, identity.reasonCodes[0]) : { status: 'unknown', score: null,
        reasonCodes: identity.reasonCodes, evidenceRefs: refs, unresolvedFacts: [editionIssue ? 'EDITION_APPLICABILITY' : 'GAME_IDENTITY'] },
      resilience: { ...evaluated(document.metrics.truncated ? 3 : 3.5, document.metrics.truncated ? 'EXTRACTION_PARTIAL' : 'TRACEABLE_ACQUIRED_DOCUMENT'),
        unresolvedFacts: ['INDEPENDENT_CORROBORATION_NOT_ESTABLISHED', ...(!stable && !historical && !combinedCurrent ? ['COMBINED_APPLICABILITY_REQUIRED'] : [])] }
    }, findings: [...(qualifiedSourceEdition ? [{ code: 'SOURCE_EDITION_QUALIFIED', severity: 'warning' as const, evidenceRefs: refs }] : []), ...(options.freshness.metadataWarnings ?? []).map(code => ({ code, severity: 'warning' as const, evidenceRefs: refs })), ...(!supporting && structuredClaim && !structural.claimSupported && !independentProse && !partial ? structural.reasonCodes.map(code => ({ code, severity: 'blocking' as const, evidenceRefs: refs })) : []),
      ...(future || expired || wrongPatch ? [{ code: future ? 'NOT_YET_EFFECTIVE' : expired ? 'NO_LONGER_EFFECTIVE' : 'PATCH_MISMATCH', severity: 'blocking' as const, evidenceRefs: refs }] : []),
      ...identity.reasonCodes.filter(() => identity.status !== 'verified').map(code => ({ code, severity: identity.status === 'conflict'
      ? 'blocking' as const : 'warning' as const, evidenceRefs: refs })), ...(document.metrics.truncated
      ? [{ code: 'EXTRACTION_PARTIAL', severity: 'warning' as const, evidenceRefs: refs }] : [])], evaluatedAt: options.now.toISOString()
  });
  // Applicability established for individual records cannot authorize storing the
  // original whole page as base-game content. The existing storage gate enforces this.
  return scoped.status === 'verified' || qualifiedSourceEdition ? { ...assessment, qualityEligible: false } : assessment;
}
