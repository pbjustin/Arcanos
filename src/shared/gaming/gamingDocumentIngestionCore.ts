import type { GamingExtractionQuality } from "@services/gamingBuildResourceSchema.js";
import { hasGamingActionableProse, isGamingCatalogMetadataOnly } from "@services/gamingDocumentExtraction.js";
import { detectGamingGame, type GamingGameDetection } from "@services/gamingGameDetection.js";
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import { assessGamingStructuralUsability } from './gamingStructuralEvidence.js';
import { gamingRegistryLiteralPattern } from './gamingGameRegistry.js';

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
  const materialTopic = /\b(?:at|in|from|for|after|before|until|when|where|with|without|only|through|via|during|under|over|beside|behind|near|between|inside|outside|into|onto|within|while|unless|except|if|because|although|but|as|how|that|to|is|are|was|were|be|being|been|has|have|had|can|could|may|might|must|should|will|would|does|do|did|cost(?:s|ing)?|requir(?:es?|ed|ing)|sold|sells?|available|opens?|grants?|unlocks?|blocks?|protects?|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/iu;
  const gameHeadingPrefix = gameLiteral ? new RegExp(`^${gameLiteral}(?=\\s|$)\\s*`, 'iu') : undefined;
  for (const heading of headings) {
    const label = gameHeadingPrefix ? heading.replace(gameHeadingPrefix, '') : heading;
    const catalogTopic = label.match(/^([\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,9})\s+(?:records?|entries|index|overview|summary)$/iu)?.[1];
    // Acquired headings may themselves contain the gameplay fact. Strip only
    // closed nominal labels, preserving unfamiliar predicates conservatively.
    const nominalLabel = /^(?:gameplay\s+)?(?:guide|walkthrough)$/iu.test(label)
      || Boolean(catalogTopic && !materialTopic.test(label) && !/\b[\p{L}]+(?:s|ed|ing)\b/iu.test(catalogTopic));
    if (nominalLabel && (prose === heading || prose.startsWith(heading) && /^\s/u.test(prose.slice(heading.length))))
      prose = prose.slice(heading.length).trim();
  }
  // Retained chunks can lack display metadata. This exact generic heading is
  // only a negative quality signal; it does not establish source identity.
  if (gameLiteral) prose = prose.replace(new RegExp(`^${gameLiteral}\\s+(?:gameplay\\s+guide|guide|walkthrough)(?=\\s|$)\\s*`, 'iu'), '');
  return prose.split(/(?<=[.!?])\s+/u).every(sentence => {
    const candidate = nominalGamePrefix ? sentence.replace(nominalGamePrefix, '') : sentence;
    const topic = description.exec(candidate)?.[1];
    const closedTopic = topic && (/\b(?:records?|entries|index|overview|summary|acquisition|locations?)$/iu.test(topic)
      || /\bhow\s+to\s+/iu.test(candidate) && !/\b[\p{L}]+(?:ing|ed)\b/iu.test(topic));
    return Boolean(topic && closedTopic && !materialTopic.test(topic));
  });
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
  if (assessGamingStructuralUsability({ units: input.evidenceUnits }).hasIntactUsableUnit) return input.truncated ? 'partial' : 'complete';
  const metadataOnly = isGamingDocumentOverviewOnly(input.cleanedText, input.metadata, input.game) || isGamingCatalogMetadataOnly(input.cleanedText)
    || (input.navigationDensity ?? 0) >= 0.62 && !hasGamingActionableProse(input.cleanedText);
  return input.cleanedText.length < input.minUsefulTextChars
    ? 'unusable'
    : metadataOnly ? 'metadata-only' : input.truncated ? 'partial' : 'complete';
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
