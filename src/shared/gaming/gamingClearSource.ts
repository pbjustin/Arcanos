import { resolveGamingRequestEdition, gamingEditionEvidenceMatchesRequest } from './gamingGameIdentity.js';
import { gamingRegistryDistinctScopeQualifier, gamingRegistryExpansionNames, gamingRegistrySourceGameMatchesRequest,
  normalizeGamingRegistryEdition, readGamingRegistryEditionScope, resolveGamingRegistryGame } from './gamingGameRegistry.js';
import { resolveGamingFreshnessDisposition } from './gamingFreshnessDisposition.js';
import { detectGamingDocumentGame } from './gamingDocumentIngestionCore.js';
import { normalizeGamingGameIdentity, normalizeGamingEditionIdentity, resolveGamingGuideIdentity } from './gamingGameIdentity.js';
import { buildGamingRetrievalTerms, buildGamingRequestRequirements, hasGamingRelevantGuideContribution, gamingTermCoverage } from './gamingRetrievalPolicy.js';
import { assessGamingSourcePolicy, classifyGamingQuestionFreshness, extractGamingFreshnessMetadata, evaluateGamingFreshness, type GamingFreshnessEvidence, type GamingSourcePolicyAssessment } from './gamingFreshnessCore.js';
import type { GamingStoredKnowledgeInput } from './gamingStoredEvidenceCore.js';
import type { ResolvedGamingDocument } from '@services/gamingDocumentResolution.js';
import { assessGamingStructuralUsability, classifyGamingEditionRequirements, readGamingEvidenceUnits, selectGamingEditionScopedEvidence, selectGamingSourceEditionScopedEvidence, selectGamingGameScopedDocument, isGamingDocumentMetadataUnit, gamingPrimarySourceDeclarationPattern } from './gamingStructuralEvidence.js';
import { createGamingClearAssessment, classifyGamingClearQuestion, gamingClearContextFingerprint,
  type GamingClearSourceRole } from './gamingClearPolicy.js';
import { detectGamingLeadingGameAlias, isGamingAcquiredTopicTitle } from '@services/gamingGameDetection.js';
import { gamingAcquiredGameDeclarationPattern, withoutGamingAcquiredGameDeclarations } from './gamingGameDeclaration.js';

const containsIdentity = (text: string, expected: string): boolean => (`-${normalizeGamingGameIdentity(text)}-`)
  .includes(`-${normalizeGamingGameIdentity(expected)}-`);
const DOCUMENT_LABEL = /^(?:(?:beginner|boss|build|class|combat|current|endgame|loadout|mechanics|patch|progression|pve|pvp|quest|raid|route|season|strategy|survival|synthetic)-){0,4}(?:guide|build|loadout|walkthrough|wiki|tips|patch-notes|release-notes|update-notes)$/u;
const PUBLISHER_DATE_PREFACE = /\b(?:last\s+)?(?:updated|published)(?:\s+on)?\s+(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*|\s+)\d{4}|\d{4}-\d{2}-\d{2})(?=\s|[.|•–—]|$)/iu;
const PUBLISHER_BYLINE_PREFACE = /^(?:written\s+)?by\s+[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,5}$/iu;

/** Only bounded publisher metadata may precede the independently acquired first heading. */
function acquiredHeadingStart(acquiredStart: string, firstHeading: string | undefined): string {
  if (!firstHeading || acquiredStart.startsWith(firstHeading)) return acquiredStart;
  const offset = acquiredStart.indexOf(firstHeading);
  if (offset < 1 || offset > 160 || !/[\s.!|•–—]$/u.test(acquiredStart.slice(0, offset))) return acquiredStart;
  const preface = acquiredStart.slice(0, offset).trim();
  // A byline-shaped reference or recommendation remains prose, not a subject boundary.
  if (/\b(?:unlike|compared|comparison|contrast|rather|instead|like|not|recommended|related|read|next|in|game|guide|build|covers|for|only)\b/iu.test(preface)) return acquiredStart;
  const date = PUBLISHER_DATE_PREFACE.exec(preface);
  const beforeDate = date ? preface.slice(0, date.index).replace(/^[.!|•–—\s]+|[.!|•–—\s]+$/gu, '') : '';
  const afterDate = date ? preface.slice(date.index + date[0].length).replace(/^[.!|•–—\s]+|[.!|•–—\s]+$/gu, '') : '';
  // Date and author are separate metadata clauses; do not splice a date out of prose.
  if (date && beforeDate && afterDate) return acquiredStart;
  const byline = (date ? beforeDate || afterDate : preface).replace(/^[.!|•–—\s]+|[.!|•–—\s]+$/gu, '');
  return (date || byline) && (!byline || PUBLISHER_BYLINE_PREFACE.test(byline))
    ? acquiredStart.slice(offset) : acquiredStart;
}

export interface GamingSourceIdentityDiagnostic {
  ruleId: string;
  evidenceCategory: 'structured_field' | 'prose_metadata' | 'document_title' | 'body_heading' | 'body_scope' | 'edition_scope' | 'acquired_anchors';
}
export interface GamingSourceIdentityAssessment {
  status: 'verified' | 'unknown' | 'conflict';
  /** Independent acquired game proof; an edition-only reason never supplies it. */
  gameIdentityVerified?: boolean;
  reasonCodes: string[];
  /** Closed server rule/category only; publisher content and request text stay private. */
  diagnostic: GamingSourceIdentityDiagnostic;
}

/** Inspect bounded acquired scope clauses, preserving visibly quoted/reference context. */
function acquiredBodySubjects(prose: string): Array<{ text: string; explicitGameScope: boolean; namedGameScope: boolean }> {
  const unquoted = prose.replace(/"[^"]*"|“[^”]*”|`[^`]*`|(?:^|\s)'(?:[^']|(?<=\w)'(?=\w))*'|‘[^’]*’/gu,
    (quote, offset: number) => {
      const name = quote.replace(/^[\s"“`'‘]+|[\s"”`'’]+$/gu, '');
      // Quoting a game name does not turn an affirmative scope into a quoted passage.
      // The apostrophe-safe single-quote matcher consumes leading whitespace;
      // retain that whitespace when reading the acquired scope introducer.
      const quoteStart = offset + (quote.match(/^\s*/u)?.[0].length ?? 0);
      const scopePrefix = prose.slice(0, quoteStart);
      const scopeName = new RegExp(`(?:${gamingPrimarySourceDeclarationPattern().source}|\\bin(?: the game)?\\s+)\\s*$`, 'iu')
        .test(scopePrefix);
      const namedGameScope = /\bin the game\s*$/iu.test(scopePrefix);
      const titleSuffix = prose.slice(offset + quote.length).match(/^\s+(?:guide|build|loadout|meta|walkthrough|wiki|tips?)\b/iu)?.[0] ?? '';
      const namedSubject = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: `${name}${titleSuffix || (scopeName ? ' guide' : '')}`,
        allowAcquiredTopicIdentity: namedGameScope });
      return detectGamingLeadingGameAlias(name, true).game || (scopeName && (detectGamingLeadingGameAlias(name).game
        || namedSubject.source === 'page_metadata' && namedSubject.confidence >= 0.8))
        ? quote.replace(/^[\s"“`'‘]+|[\s"”`'’]+$/gu, boundary => ' '.repeat(boundary.length)) : ' '.repeat(quote.length);
    });
  const subjects: Array<{ text: string; explicitGameScope: boolean; namedGameScope: boolean }> = [];
  for (const match of unquoted.matchAll(new RegExp(`(?:${gamingPrimarySourceDeclarationPattern().source}|\\bin(?: the game)?\\s+)`, 'giu'))) {
    const before = unquoted.slice(0, match.index);
    const prefix = before.slice(Math.max(...['.', '!', '?', ';', ',', '\n'].map(boundary => before.lastIndexOf(boundary))) + 1);
    const subject = unquoted.slice(match.index + match[0].length).split(/[,;.!?\n]/u, 1)[0].slice(0, 160).trim();
    // Reference qualifiers apply locally, so a later affirmative clause after
    // a comma or sentence boundary is still independently inspected.
    if (/\b(?:unlike|compared(?:\s+to)?|comparison(?:\s+with)?|contrast(?:\s+to)?|similar(?:ly)?|rather\s+than|instead\s+of|as(?:\s+is\s+the\s+case)?|like)\s*$/iu.test(prefix)
      || /\b(?:not(?:\s+(?:apply|applicable|valid|available|supported|used|found|present|exist|included|be|for)){0,4}|(?:doesn|isn|aren|don|didn)['’]?t(?:\s+(?:apply|exist|work))?|without|except|excluding|unavailable|unsupported)\s*$/iu.test(prefix)
      || /^(?:contrast|comparison|case|addition|particular)\b/iu.test(subject)) continue;
    if (subject) subjects.push({ text: subject, explicitGameScope: /^(?:this|in the game)\b/iu.test(match[0]),
      namedGameScope: /^in the game\b/iu.test(match[0]) });
  }
  return subjects;
}

/** Structural serialization never becomes fallback prose, even when repeated. */
export function gamingClearIntactProseText(document: Pick<ResolvedGamingDocument, 'text' | 'evidenceUnits'> & {
  metrics: Pick<ResolvedGamingDocument['metrics'], 'truncated'>;
}): string {
  const units = readGamingEvidenceUnits(document.evidenceUnits, undefined, document.text);
  let prose = document.text;
  // A metadata serialization can be a prefix of a complete gameplay record.
  // Remove whole records first so a shorter label cannot turn the remainder
  // of an excluded or incomplete record into fallback prose.
  for (const unit of [...units].sort((left, right) => right.text.length - left.text.length)) prose = prose.split(unit.text).join('');
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
  policy: GamingSourcePolicyAssessment, _allowPartialCoverage = false): GamingSourceIdentityAssessment {
  let gameIdentityVerified = false;
  const result = (status: GamingSourceIdentityAssessment['status'], reason: string, ruleId: string,
    evidenceCategory: GamingSourceIdentityDiagnostic['evidenceCategory']): GamingSourceIdentityAssessment =>
    ({ status, gameIdentityVerified: gameIdentityVerified && reason !== 'GAME_MISMATCH',
      reasonCodes: [reason], diagnostic: { ruleId, evidenceCategory } });
  input = { ...input, edition: resolveGamingRequestEdition(input) };
  const gameScoped = selectGamingGameScopedDocument(document, input.game);
  if (gameScoped.status === 'conflict') return result('conflict', 'GAME_MISMATCH', 'gaming.identity.structured_game_conflict', 'structured_field');
  if (gameScoped.status === 'unverified') {
    const unsafeForeignScope = readGamingEvidenceUnits(document.evidenceUnits, document.publicUrl, document.text)
      .some(unit => unit.fields.some(field => /^game$/iu.test(field.label.split(/\s+\/\s+/u).at(-1)!)
        && !gamingRegistrySourceGameMatchesRequest(field.value, input.game)));
    return unsafeForeignScope ? result('conflict', 'GAME_MISMATCH', 'gaming.identity.structured_game_conflict', 'structured_field')
      : result('unknown', 'GAME_IDENTITY_UNVERIFIED', 'gaming.identity.local_game_scope_not_intact', 'structured_field');
  }
  document = gameScoped.document;
  const registryGame = resolveGamingRegistryGame(input.game);
  const expected = new Set([input.game, ...(registryGame ? [registryGame.name, ...registryGame.aliases] : []),
    resolveGamingGuideIdentity(input.game, input.edition)].map(normalizeGamingGameIdentity));
  let scoped = selectGamingEditionScopedEvidence(document, input);
  const editionScope = readGamingRegistryEditionScope(document, input.game);
  const distinctScope = (qualifier: string) => gamingRegistryDistinctScopeQualifier(input.game, qualifier);
  const sourceGameMatches = (value: string) => expected.has(normalizeGamingGameIdentity(value))
    || gamingRegistrySourceGameMatchesRequest(value, input.game);
  const editionQualifier = (value: string) => registryGame?.editions.filter(edition => edition.kind === 'edition')
    .some(edition => [edition.name, ...edition.aliases].some(alias => {
      const identity = normalizeGamingGameIdentity(alias);
      return value === identity || value.startsWith(`${identity}-`) && !distinctScope(value.slice(identity.length + 1));
    })) ?? false;
  const expansionQualifier = (value: string) => /^(?:dlc|expansion)(?:-|$)/u.test(value)
    || gamingRegistryExpansionNames(input.game).some(name => {
      const identity = normalizeGamingGameIdentity(name);
      return value === identity || value.startsWith(`${identity}-`);
    });
  if (scoped.reasonCodes.includes('GAME_MISMATCH')) return result('conflict', 'GAME_MISMATCH', 'gaming.identity.structured_game_conflict', 'structured_field');
  const units = readGamingEvidenceUnits(document.evidenceUnits, document.publicUrl, document.text);
  if (units.some(unit => unit.fields.some(field => /^game$/iu.test(field.label.split(/\s+\/\s+/u).at(-1)!)
    && !sourceGameMatches(field.value))))
    return result('conflict', 'GAME_MISMATCH', 'gaming.identity.structured_game_conflict', 'structured_field');
  const labels = [...document.text.slice(0, 32_000).matchAll(gamingAcquiredGameDeclarationPattern())];
  if (labels.some(label => !sourceGameMatches(label[1])))
    return result('conflict', 'GAME_MISMATCH', 'gaming.identity.acquired_game_label_conflict', 'prose_metadata');
  let editionScopeConflict = false;
  // Pooled section headings can include related links or comparisons. Only the
  // acquired title or a first heading independently repeated at the bounded start
  // of acquired prose, after an optional publisher preface, asserts the article's
  // subject. Later pooled headings do not.
  const firstHeading = document.metadata.headings?.split(/\s+\|\s+/u, 1)[0]?.trim();
  const acquiredStart = acquiredHeadingStart(document.text.slice(0, 512).normalize('NFKC').trimStart(), firstHeading);
  const clippedPrimaryHeading = firstHeading && firstHeading.length >= 240 && acquiredStart.startsWith(firstHeading);
  // HTML block boundaries become whitespace in the common instruction filter.
  // Parser-derived headings still need an exact acquired heading prefix and a lexical
  // boundary; a metadata cap cannot manufacture the end of a longer heading.
  const leadingHeading = firstHeading && firstHeading.length < 240 && acquiredStart.startsWith(firstHeading)
    && /^(?:\s|[.!?:;]|$)/u.test(acquiredStart.slice(firstHeading.length))
    && !/^(?:unlike|compared|comparison|contrast|rather\s+than|instead\s+of|like|not|recommended|related|read\s+next)\b/iu.test(firstHeading)
    ? firstHeading : undefined;
  const subjects = [
    ...(document.metadata.title ? [{ value: document.metadata.title, category: 'document_title' as const }] : []),
    ...(leadingHeading ? [{ value: leadingHeading, category: 'body_heading' as const }] : [])
  ];
  // Pooled related headings can establish neither positive game identity nor
  // requested edition applicability. The same acquired subject boundary applies
  // to both admission and contradiction checks.
  const metadata = subjects.map(subject => subject.value);
  for (const { value, category } of subjects) {
    // Closed editorial framing does not erase a sequel/edition subject. This
    // normalization is only for contradiction checks; full acquired names still
    // supply the independent positive anchors below.
    const identity = normalizeGamingGameIdentity(value).replace(/^(?:the-)?best-/u, '');
    // Explicit sequel/edition qualifiers cannot be erased by a broad franchise alias.
    if ([...expected].some(game => identity.startsWith(`${game}-`) && distinctScope(identity.slice(game.length + 1))
      && ![...expected].some(full => full !== game && (identity === full || identity.startsWith(`${full}-`))))) {
      if (expansionQualifier(identity.slice(normalizeGamingGameIdentity(input.game).length + 1)))
        editionScopeConflict = true;
      else if (!(editionQualifier(identity.slice(normalizeGamingGameIdentity(input.game).length + 1))))
        return result('conflict', 'GAME_MISMATCH', category === 'document_title'
          ? 'gaming.identity.distinct_title_scope' : 'gaming.identity.distinct_primary_heading_scope', category);
    }
    // Acquired title and body can establish an explicit different subject even
    // outside the alias catalog. A URL label must not hide that contradiction.
    const detected = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: value });
    const acquiredBody = withoutGamingAcquiredGameDeclarations(document.text);
    if (detected.game && (detected.source === 'alias' || !isGamingAcquiredTopicTitle(value) && containsIdentity(acquiredBody, detected.game)) && detected.confidence >= 0.8 && !sourceGameMatches(detected.game)
      && ![...expected].some(game => containsIdentity(value, game)))
      return result('conflict', 'GAME_MISMATCH', category === 'document_title'
        ? 'gaming.identity.acquired_title_conflict' : 'gaming.identity.acquired_primary_heading_conflict', category);

  }
  const prose = withoutGamingAcquiredGameDeclarations(document.text.slice(0, 32_000));
  const bodyHeadings = prose.split(/\n+|(?<=[.!?])\s+/u).slice(0, 128)
    .filter(unit => /^[^.!?\n]{2,160}\b(?:guide|build|walkthrough)\s*:/iu.test(unit));
  for (const heading of bodyHeadings) {
    if (/^(?:unlike|compared(?:\s+(?:to|with))?|comparison(?:\s+(?:to|with))?|contrast(?:\s+(?:to|with))?|rather\s+than|instead\s+of|like|not)\b/iu.test(heading)) continue;
    // URL-first detection must not hide an explicit conflicting subject in acquired prose.
    const detected = detectGamingDocumentGame({ canonicalUrl: '', pageTitle: heading.slice(0, 240) });
    if (detected.game && (detected.source === 'alias' || !isGamingAcquiredTopicTitle(heading.split(':')[0]))
      && detected.confidence >= 0.8 && !sourceGameMatches(detected.game)
      && ![...expected].some(game => containsIdentity(heading.split(':')[0], game)))
      return result('conflict', 'GAME_MISMATCH', 'gaming.identity.instruction_heading_conflict', 'body_heading');
  }
  // Every affirmative acquired subject binds; matching titles and earlier
  // requested-game subjects cannot hide a later different gameplay scope.
  for (const { text: bodySubject, explicitGameScope, namedGameScope } of acquiredBodySubjects(prose)) {
    // A primary declaration can name content applicability rather than a new
    // game. Registry-owned expansion names and closed generic edition nouns
    // retain their own conflict category; they never prove the source's game.
    const editionSubject = normalizeGamingGameIdentity(bodySubject).replace(/^(?:(?:only|the)-){1,2}/u, '');
    const expansionPrefix = explicitGameScope && gamingRegistryExpansionNames(input.game)
      .find(name => editionSubject === normalizeGamingGameIdentity(name)
        || editionSubject.startsWith(`${normalizeGamingGameIdentity(name)}-`));
    const expansionSuffix = expansionPrefix ? editionSubject.slice(normalizeGamingGameIdentity(expansionPrefix).length) : '';
    const declaredExpansion = expansionPrefix && (!expansionSuffix
      || /^(?:-(?:dlc|expansion|content|guide|build|walkthrough)){1,3}$/u.test(expansionSuffix)) ? expansionPrefix : undefined;
    if (expansionPrefix && !declaredExpansion)
      return result('conflict', 'EDITION_CONFLICT', 'gaming.identity.edition_declaration_boundary_conflict', 'edition_scope');
    const genericExpansionSubject = explicitGameScope && /^(?:dlc|expansion)(?:-(?:content|guide|build|walkthrough)){0,2}$/u.test(editionSubject);
    if (declaredExpansion || genericExpansionSubject) {
      const sameRequestedExpansion = input.edition && declaredExpansion
        && normalizeGamingRegistryEdition(input.game, input.edition) === normalizeGamingRegistryEdition(input.game, declaredExpansion);
      editionScopeConflict ||= Boolean(input.edition && !sameRequestedExpansion
        && (declaredExpansion || normalizeGamingEditionIdentity(input.edition) === 'base-game'));
      continue;
    }
    const leading = detectGamingLeadingGameAlias(bodySubject);
    const firstInstructionMarker = /\b(?:guide|build|loadout|meta|walkthrough|wiki|tips?|tier(?:\s+list)?|patch\s+notes)\b/iu.exec(bodySubject);
    const metadataSubject = detectGamingDocumentGame({ canonicalUrl: '',
      pageTitle: explicitGameScope && !firstInstructionMarker ? `${bodySubject} guide` : bodySubject,
      allowAcquiredTopicIdentity: namedGameScope });
    // Bare location clauses can use guide/build as imperative verbs. Their
    // objects do not declare a new game; explicit game scopes and aliases do.
    const instructionalClause = !explicitGameScope && Boolean(firstInstructionMarker
      && /^(?:guide|build)$/iu.test(firstInstructionMarker[0])
      && /^\s+(?:a|an|the|your|our|their|my|his|her|its|them|him|us|me)\b/iu.test(
        bodySubject.slice(firstInstructionMarker.index + firstInstructionMarker[0].length)));
    const detected = leading.game ? leading : metadataSubject.source !== 'alias' && !instructionalClause ? metadataSubject : leading;
    const subjectIdentity = normalizeGamingGameIdentity(bodySubject);
    const expectedSubject = [...expected].some(game => subjectIdentity === game || subjectIdentity.startsWith(`${game}-`));
    if (detected.game && detected.confidence >= 0.8 && !sourceGameMatches(detected.game)
      && !(leading.game ? expectedSubject : [...expected].some(game => containsIdentity(bodySubject, game))))
      return result('conflict', 'GAME_MISMATCH', 'gaming.identity.affirmative_body_scope_conflict', 'body_scope');
    if ([...expected].some(game => {
      const bodyIdentity = normalizeGamingGameIdentity(bodySubject);
      return bodyIdentity.startsWith(`${game}-`) && distinctScope(bodyIdentity.slice(game.length + 1))
        && ![...expected].some(full => full !== game && (bodyIdentity === full || bodyIdentity.startsWith(`${full}-`)));
    })) {
      const qualifier = normalizeGamingGameIdentity(bodySubject).slice(normalizeGamingGameIdentity(input.game).length + 1);
      if (expansionQualifier(qualifier)) editionScopeConflict = true;
      else if (!(editionQualifier(qualifier))) return result('conflict', 'GAME_MISMATCH', 'gaming.identity.distinct_body_scope', 'body_scope');
    }
  }
  const ordinaryTitle = metadata.some(value => [...expected].some(game => {
    const identity = normalizeGamingGameIdentity(value);
    return identity === game || identity.startsWith(`${game}-`) && DOCUMENT_LABEL.test(identity.slice(game.length + 1));
  }));
  const metadataAnchor = metadata.some(value => [...expected].some(game => containsIdentity(value, game)));
  // The primary heading is acquired article metadata even when the extractor
  // repeats it in prose. It cannot corroborate itself or become a second anchor
  // through an inherited structural record heading.
  let identityProse = gamingClearIntactProseText({ ...document, metrics: { truncated: false } });
  if (leadingHeading) {
    const headingOffset = identityProse.indexOf(leadingHeading);
    const remainder = headingOffset >= 0 ? identityProse.slice(headingOffset + leadingHeading.length) : '';
    // Legacy normalized documents may expose a bare game heading while prose
    // starts with the longer guide label. That prefix is not the whole heading.
    const continuation = remainder.match(/^\s+([^.!?\n:;]{1,80})(?=[.!?\n:;]|$)/u)?.[1];
    if (headingOffset >= 0 && !(continuation && DOCUMENT_LABEL.test(normalizeGamingGameIdentity(continuation))))
      identityProse = identityProse.slice(0, headingOffset) + remainder;
  }
  const acquiredGlobalGame = labels.some(label => sourceGameMatches(label[1]));
  const contextGameMatches = (value: string) => sourceGameMatches(value) || [...expected].some(game => {
    const identity = normalizeGamingGameIdentity(value);
    const suffix = identity.startsWith(`${game}-`) ? identity.slice(game.length + 1) : '';
    return DOCUMENT_LABEL.test(suffix) || /^(?:resources?|records?|resource-records|equipment|statistics)$/u.test(suffix);
  });
  const localRecordAnchor = units.some(unit => {
    if (isGamingDocumentMetadataUnit(unit)) return false;
    const usable = assessGamingStructuralUsability({ units: [unit], prompt: input.prompt, game: input.game, mode: input.mode });
    if (!usable.hasIntactUsableUnit || !usable.hasRelevantClaimUnit) return false;
    const declaredGame = unit.fields.some(field => /^game$/iu.test(field.label.split(/\s+\/\s+/u).at(-1)!) && sourceGameMatches(field.value));
    const acquiredCaption = unit.context.caption && contextGameMatches(unit.context.caption) && unit.text.includes(unit.context.caption);
    // An exact game-valued section heading binds its complete gameplay tuple.
    // Generic article titles such as GAME guide remain primary metadata and
    // cannot provide this ownership merely through inherited row context.
    const acquiredRecordHeading = unit.context.heading && sourceGameMatches(unit.context.heading)
      && unit.text.includes(unit.context.heading);
    return declaredGame || acquiredGlobalGame || acquiredCaption || acquiredRecordHeading;
  });
  const proseAnchor = localRecordAnchor || [...expected].some(game => containsIdentity(withoutGamingAcquiredGameDeclarations(identityProse), game));
  const reviewedAssociation = Boolean(policy.ruleId) && ['official', 'specialist', 'community'].includes(policy.authority);
  // A generic acquired topic title still needs an affirmative acquired game
  // declaration. Neither matching player/topic terms nor a reference mention
  // can supply that proof, and all acquired contradictions above still bind.
  const acquiredBodyScope = !metadataAnchor && metadata.some(isGamingAcquiredTopicTitle) && acquiredBodySubjects(prose).some(({ text: subject }) => {
    const declared = detectGamingLeadingGameAlias(subject);
    return declared.game && declared.confidence >= 0.8 && expected.has(normalizeGamingGameIdentity(declared.game));
  });
  gameIdentityVerified = Boolean((metadataAnchor && proseAnchor || reviewedAssociation && metadataAnchor || acquiredBodyScope)
    && !clippedPrimaryHeading);
  // A definitive acquired applicability contradiction remains terminal without
  // turning absent independent game proof into a verified identity outcome.
  if (editionScopeConflict)
    return result('conflict', 'EDITION_CONFLICT', 'gaming.identity.edition_scope_conflict', 'edition_scope');
  if (!(metadataAnchor && proseAnchor) && !(reviewedAssociation && metadataAnchor) && !acquiredBodyScope)
    return result('unknown', 'GAME_IDENTITY_UNVERIFIED', 'gaming.identity.independent_anchor_required', 'acquired_anchors');
  if (clippedPrimaryHeading)
    return result('unknown', 'GAME_IDENTITY_UNVERIFIED', 'gaming.identity.primary_heading_boundary_unverified', 'body_heading');
  // Registry edition scope is acquired independently from a requested edition choice.
  if (editionScope.status === 'conflict') return result('conflict', 'EDITION_CONFLICT', 'gaming.identity.edition_scope_conflict', 'edition_scope');
  if (editionScope.status === 'unverified') return result('unknown', 'EDITION_UNVERIFIED', 'gaming.identity.edition_scope_unverified', 'edition_scope');
  if (editionScope.status === 'verified') {
    if (input.edition && normalizeGamingRegistryEdition(input.game, input.edition) !== editionScope.edition)
      return result('conflict', 'EDITION_CONFLICT', 'gaming.identity.edition_scope_conflict', 'edition_scope');
    if (!input.edition && (editionScope.exclusive || resolveGamingFreshnessDisposition(input) === 'REQUIRED'))
      return result('unknown', 'EDITION_REQUIRED', 'gaming.identity.edition_choice_required', 'edition_scope');
  }
  const applicability = extractGamingFreshnessMetadata(document, input);
  const qualifiedSourceEdition = !input.edition && applicability.edition
    && gamingEditionEvidenceMatchesRequest(applicability.edition, undefined, input);
  if (!input.edition && applicability.edition && !qualifiedSourceEdition)
    return result('unknown', 'EDITION_UNVERIFIED', 'gaming.identity.edition_scope_unverified', 'edition_scope');
  if (qualifiedSourceEdition) scoped = selectGamingSourceEditionScopedEvidence(document, input, applicability.edition);
  if (scoped.reasonCodes.includes('GAME_MISMATCH')) return result('conflict', 'GAME_MISMATCH', 'gaming.identity.structured_game_conflict', 'structured_field');
  // Evaluate game contradictions before reporting narrower edition scope.
  const baseRequest = input.edition && normalizeGamingEditionIdentity(input.edition) === 'base-game';
  const requirements = qualifiedSourceEdition ? classifyGamingEditionRequirements(scoped.status === 'verified' || scoped.reasonCodes.length > 0
    ? gamingClearIntactProseText({ ...document, metrics: { truncated: false } }) : document.text, false, true)
    : baseRequest && scoped.status !== 'verified' ? classifyGamingEditionRequirements(document.text) : 'clear';
  if (editionScopeConflict || scoped.status === 'conflict' || requirements === 'conflict'
    || baseRequest && gamingRegistryExpansionNames(input.game).some(name => containsIdentity(document.metadata.title ?? '', name)))
    return result('conflict', 'EDITION_CONFLICT', 'gaming.identity.edition_scope_conflict', 'edition_scope');
  if (requirements === 'unverified' || scoped.status === 'unverified' && scoped.reasonCodes.length)
    return result('unknown', 'EDITION_UNVERIFIED', 'gaming.identity.edition_scope_unverified', 'edition_scope');
  if (input.edition) {
    // Game identity is independently verified. An ordinary base-game request
    // allows absent edition metadata; positive scope claims and conflicts still bind.
    if (normalizeGamingEditionIdentity(input.edition) === 'base-game') {
      if (!gamingEditionEvidenceMatchesRequest(applicability.edition, input.edition))
        return result(applicability.edition ? 'conflict' : 'unknown', applicability.edition ? 'EDITION_CONFLICT' : 'EDITION_UNVERIFIED', 'gaming.identity.edition_applicability', 'edition_scope');
    } else if (editionScope.status !== 'verified' && !containsIdentity([...metadata, prose].join(' '), input.edition)) {
      return result('unknown', 'EDITION_UNVERIFIED', 'gaming.identity.edition_scope_unverified', 'edition_scope');
    }
  }
  return result('verified', acquiredBodyScope ? 'ACQUIRED_BODY_SCOPE_IDENTITY' : ordinaryTitle ? 'ACQUIRED_TITLE_AND_PASSAGE_IDENTITY' : reviewedAssociation
    ? 'REVIEWED_GAME_ASSOCIATION' : 'ACQUIRED_METADATA_AND_BODY_IDENTITY', 'gaming.identity.acquired_anchors_verified', 'acquired_anchors');
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
    freshness: GamingFreshnessEvidence; now: Date; allowPartialCoverage?: boolean; onIdentityAssessment?: (identity: GamingSourceIdentityAssessment) => void }) {
  input = { ...input, edition: resolveGamingRequestEdition(input) };
  const role = gamingClearSourceRole(input, options.sourcePolicy);
  const identity = assessGamingClearSourceIdentity(document, input, options.sourcePolicy, options.allowPartialCoverage);
  options.onIdentityAssessment?.(identity);
  const editionIssue = identity.reasonCodes.every(code => code.startsWith('EDITION_'));
  const gameIdentity = editionIssue ? identity.gameIdentityVerified === true ? 'verified' as const : 'unknown' as const : identity.status;
  const gameScoped = selectGamingGameScopedDocument(document, input.game);
  const selectedDocument = gameScoped.status === 'projected' ? gameScoped.document : document;
  const scoped = selectGamingSourceEditionScopedEvidence(selectedDocument, input, options.freshness.edition);
  const qualifiedSourceEdition = !input.edition && options.freshness.edition
    && gamingEditionEvidenceMatchesRequest(options.freshness.edition, undefined, input);
  const evidenceDocument = scoped.status === 'verified' ? { ...selectedDocument, text: scoped.text, evidenceUnits: scoped.units } : selectedDocument;
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
  return gameScoped.status === 'projected' || scoped.status === 'verified' || qualifiedSourceEdition ? { ...assessment, qualityEligible: false } : assessment;
}
