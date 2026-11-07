import type { GamingExtractionQuality } from "@services/gamingBuildResourceSchema.js";
import { isGamingCatalogMetadataOnly } from "@services/gamingDocumentExtraction.js";
import { detectGamingGame, type GamingGameDetection } from "@services/gamingGameDetection.js";
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import { assessGamingStructuralUsability, isGamingDocumentMetadataUnit } from './gamingStructuralEvidence.js';
import { gamingRegistryLiteralPattern } from './gamingGameRegistry.js';
import { gamingAttributableClaimText } from './gamingRetrievalPolicy.js';

/** Keep generic page parameters after admission; document-only sources own their public identity. */
export function selectGamingSourceAdmissionUrl(
  sanitizedUrl: string,
  description: { publicUrl: string; supportsUrlPayload: boolean }
): string {
  return description.supportsUrlPayload ? sanitizedUrl : description.publicUrl;
}

/** Persist the same admitted generic page identity used for acquisition. */
export function selectGamingSourcePublicUrl(
  canonicalUrl: string,
  resolvedPublicUrl: string,
  supportsStructuredExtraction: boolean
): string {
  return supportsStructuredExtraction ? canonicalUrl : resolvedPublicUrl;
}

/** Source URLs and metadata provide identity; gameplay prose is not a user request. */
export function detectGamingDocumentGame(input: {
  canonicalUrl: string;
  pageTitle?: string;
  pageHeadings?: string;
  /** Explicit acquired scope clauses use the request grammar for contradiction checks. */
  allowAcquiredTopicIdentity?: boolean;
}): GamingGameDetection {
  return detectGamingGame({
    urls: [input.canonicalUrl],
    pageTitle: input.pageTitle,
    pageHeadings: input.pageHeadings,
    excludeAcquiredTopicIdentities: !input.allowAcquiredTopicIdentity
  });
}

/** A closed source description establishes a topic, not a gameplay claim. */
export function isGamingDocumentOverviewOnly(text: string, metadata?: { title?: string; headings?: string }, game?: string): boolean {
  let prose = text.trim();
  // Every supported overview contains this closed description frame. Ordinary
  // gameplay chunks must not construct heading/identity matchers per assessment.
  if (!/\b(?:this|the)\s+(?:following\s+)?(?:page|article|guide|walkthrough|document|source|section)\s+/iu.test(prose)) return false;
  const headings = [...new Set([metadata?.title, metadata?.headings])]
    .filter((heading): heading is string => Boolean(heading)).sort((left, right) => right.length - left.length);
  // Strip only the known nominal identity, never an arbitrary clause that may
  // already supply a location, price or other gameplay fact.
  const gameLiteral = game ? gamingRegistryLiteralPattern(game) : undefined;
  const nominalGamePrefix = gameLiteral
    ? new RegExp(`^in(?: the game)?\\s+${gameLiteral},\\s*`, 'iu') : undefined;
  const description = /^(?:this|the)\s+(?:following\s+)?(?:page|article|guide|walkthrough|document|source|section)\s+(?:(?:explains?|describes?)\s+how\s+to\s+(?:acquire|obtain|get|find|unlock|activate|use|build|craft|complete|buy|collect|reach)\s+|(?:provides?|contains?|includes?|offers?|presents?)\s+(?:(?:an?|the)\s+)?(?:overview|summary|index)\s+of\s+|(?:provides?|contains?)\s+information\s+about\s+|(?:lists?|index(?:es)?|catalogues?|catalogs?|describes?|covers?)\s+)([\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,10})\s*[.!?]$/iu;
  // A nominal subject can establish a topic. Relations, predicates, values and
  // qualifications can carry the answer even inside a page-description frame.
  const materialTopic = /\b(?:at|in|from|for|after|before|until|when|where|with|without|only|through|via|during|under|over|beneath|above|below|beside|behind|near|between|inside|outside|into|onto|within|while|unless|except|if|because|although|but|as|how|that|to|is|are|was|were|be|being|been|has|have|had|can|could|may|might|must|should|will|would|does|do|did|cost(?:s|ing)?|requir(?:es?|ed|ing)|sold|sells?|available|opens?|grants?|unlocks?|blocks?|protects?|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/iu;
  // Inflected nouns and modifiers are not predicates merely because they end
  // in s/ed/ing. This closed gameplay predicate grammar requires a preceding subject;
  // an initial modifier, including one after a determiner, remains nominal.
  // The subject boundary cannot restart inside a long letter/hyphen token.
  const hasMaterialPredicate = (topic: string): boolean =>
    /(?<![\p{L}'’-])[\p{L}'’-]+\s+(?:(?:deflect|reflect|absorb|inflict|glow|gleam|trigger|prevent)(?:s|ed|ing)?|(?:reduc|restor|increas|chang)(?:e|es|ed|ing)|deal(?:s|ing)?|dealt|stun(?:s|ned|ning)?|nestl(?:e|es|ed|ing))\b/iu
      .test(topic.replace(/^(?:an?|the)\s+/iu, ''));
  const overviewTopic = (sentence: string): string | undefined => {
    const candidate = nominalGamePrefix ? sentence.replace(nominalGamePrefix, '') : sentence;
    const topic = description.exec(candidate)?.[1];
    const closedTopic = topic && (/\b(?:records?|entries|index|overview|summary|acquisition|locations?)$/iu.test(topic)
      || /\bhow\s+to\s+/iu.test(candidate));
    return topic && closedTopic && !materialTopic.test(topic) && !hasMaterialPredicate(topic) ? topic : undefined;
  };
  const canonicalNominal = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[\s-]+/gu, ' ').trim();
  const canonicalGame = game ? canonicalNominal(game) : '';
  const nominalHeadingTopic = (label: string): string | undefined => {
    if (label.length > 240) return undefined;
    const canonical = canonicalNominal(label);
    const withoutGame = canonicalGame && canonical.startsWith(`${canonicalGame} `) ? canonical.slice(canonicalGame.length + 1) : canonical;
    const withoutArticle = withoutGame.replace(/^(?:an?|the) /u, '');
    const topic = withoutArticle.replace(/ (?:(?:locations?|acquisition) )?(?:guide|walkthrough)$/u, '');
    return topic && topic !== withoutArticle && !materialTopic.test(topic) && !hasMaterialPredicate(topic) ? topic : undefined;
  };
  const nominalHeadingPrefix = (body: string, expectedTopic?: string, requireGame = false) => {
    for (const match of body.slice(0, 241).matchAll(/\b(?:guide|walkthrough)(?=\s|$)/giu)) {
      const end = match.index + match[0].length;
      // A bounded scan cannot manufacture the end of a longer source label.
      if (end > 240 || !/^(?:\s|$)/u.test(body.slice(end, end + 1))) continue;
      const label = body.slice(0, end);
      if (requireGame && (!canonicalGame || !canonicalNominal(label).startsWith(`${canonicalGame} `))) continue;
      const topic = nominalHeadingTopic(label);
      if (topic && (expectedTopic === undefined || topic === expectedTopic)) return { label, end };
    }
    return undefined;
  };
  /** Remove at most eight closed labels naming the same descriptive object.
   * Inspected material predicates remain facts when a template repeats them. */
  const nominalTopicHeadingRemainder = (label: string, remainder: string): string | undefined => {
    const topic = nominalHeadingTopic(label);
    if (!topic) return undefined;
    let body = remainder;
    for (let count = 1; count < 8; count++) {
      const repeated = nominalHeadingPrefix(body, topic);
      if (!repeated) break;
      body = body.slice(repeated.end).trimStart();
    }
    const describedTopic = overviewTopic(body.split(/(?<=[.!?])\s+/u, 1)[0])?.replace(/^(?:an?|the)\s+/iu, '');
    return describedTopic && describedTopic.length <= 240 && canonicalNominal(describedTopic) === topic ? body : undefined;
  };
  const gameHeadingPrefix = gameLiteral ? new RegExp(`^${gameLiteral}(?=\\s|$)\\s*`, 'iu') : undefined;
  for (const heading of headings) {
    if (!(prose === heading || prose.startsWith(heading) && /^\s/u.test(prose.slice(heading.length)))) continue;
    const remainder = prose.slice(heading.length).trim();
    const label = gameHeadingPrefix ? heading.replace(gameHeadingPrefix, '') : heading;
    const catalogTopic = label.match(/^([\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,9})\s+(?:records?|entries|index|overview|summary)$/iu)?.[1];
    const topicRemainder = nominalTopicHeadingRemainder(heading, remainder);
    // Acquired headings may themselves contain the gameplay fact. Strip only
    // closed nominal labels; qualifiers and unmatched heading topics stay intact.
    const nominalLabel = /^(?:gameplay\s+)?(?:guide|walkthrough)$/iu.test(label)
      || Boolean(catalogTopic && !materialTopic.test(label) && !hasMaterialPredicate(catalogTopic));
    if (topicRemainder !== undefined) prose = topicRemainder;
    else if (nominalLabel) prose = remainder;
  }
  // Retained chunks can lack display metadata. This exact generic heading is
  // only a negative quality signal; it does not establish source identity.
  if (gameLiteral) prose = prose.replace(new RegExp(`^${gameLiteral}\\s+(?:gameplay\\s+guide|guide|walkthrough)(?=\\s|$)\\s*`, 'iu'), '');
  if (canonicalGame) {
    // A retained nominal heading can lack display metadata. Require the exact
    // requested game and the same descriptive object, within the metadata bound.
    const retained = nominalHeadingPrefix(prose, undefined, true);
    if (retained) {
      const topicRemainder = nominalTopicHeadingRemainder(retained.label, prose.slice(retained.end).trimStart());
      if (topicRemainder !== undefined) prose = topicRemainder;
    }
  }
  return prose.split(/(?<=[.!?])\s+/u).every(sentence => overviewTopic(sentence) !== undefined);
}

export function classifyGamingDocumentQuality(input: {
  cleanedText: string;
  metadata?: { title?: string; headings?: string };
  game?: string;
  navigationDensity?: number;
  truncated: boolean;
  minUsefulTextChars: number;
  evidenceUnits?: readonly GamingEvidenceUnit[];
}): 'unusable' | 'metadata-only' | 'partial' | 'complete' {
  if (assessGamingStructuralUsability({ units: input.evidenceUnits?.filter(unit => !isGamingDocumentMetadataUnit(unit)) }).hasIntactUsableUnit) return input.truncated ? 'partial' : 'complete';
  // Parser-owned metadata remains available for identity/applicability but
  // cannot supply gameplay length or prevent a catalog classification.
  const prose = (input.evidenceUnits ?? []).filter(isGamingDocumentMetadataUnit)
    .reduce((text, unit) => {
      // The extractor appends serialized records on their own lines. An equal
      // inline prose assertion remains intact, including its punctuation.
      const index = text.lastIndexOf(unit.text);
      const after = index + unit.text.length;
      return index >= 0 && (index === 0 || text[index - 1] === '\n')
        && (after === text.length || text[after] === '\n')
        ? text.slice(0, index) + text.slice(after) : text;
    }, input.cleanedText).trim();
  const hasClaims = gamingAttributableClaimText(prose, input.game, input.metadata).trim().length > 0;
  const referenceContext = /\b(?:wiki|catalog|index|glossary|encyclopedia|directory|article titles?|topics?|keywords?|linked walkthrough)\b/iu
    .test([prose, input.metadata?.title, input.metadata?.headings].filter(Boolean).join('\n'));
  const metadataOnly = isGamingDocumentOverviewOnly(prose, input.metadata, input.game)
    || !hasClaims && (referenceContext || isGamingCatalogMetadataOnly(prose) || (input.navigationDensity ?? 0) >= 0.62);
  const shortGameplay = !input.truncated && !metadataOnly && hasClaims;
  // A bounded excerpt can lose the claim-bearing tail. Preserve partial
  // extraction state; request coverage still receives no invented claim text.
  return metadataOnly ? 'metadata-only' : !hasClaims && !input.truncated || prose.length < input.minUsefulTextChars && !shortGameplay
    ? 'unusable' : input.truncated ? 'partial' : 'complete';
}

export function classifyGamingStructuredExtractionQuality(input: {
  isBuildRecord: boolean;
  hasStructuredFields: boolean;
  quality: GamingExtractionQuality;
}): GamingExtractionQuality | 'not_applicable' {
  return input.isBuildRecord || input.hasStructuredFields ? input.quality : 'not_applicable';
}

/** Metadata uses remaining capacity without pushing resolved guide prose off the index. */
export function buildGamingDocumentSearchText(input: {
  cleanedText: string;
  title?: string;
  game: string;
  patchVersion?: string;
  normalizedEvidence: string;
  maxChars: number;
}): string {
  const searchMetadata = [
    input.title,
    input.game,
    input.patchVersion,
    input.normalizedEvidence
  ].filter(Boolean).join('\n\n');
  return [input.cleanedText, searchMetadata]
    .filter(Boolean).join('\n\n').slice(0, input.maxChars);
}
