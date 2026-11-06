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
  for (const heading of headings) {
    if (prose === heading || prose.startsWith(heading) && /^\s/u.test(prose.slice(heading.length)))
      prose = prose.slice(heading.length).trim();
  }
  // A known nominal prefix may be identity context; an arbitrary in-clause
  // can contain a real gameplay fact and must not be discarded as metadata.
  if (game) prose = prose.replace(new RegExp(`^in(?: the game)?\\s+${gamingRegistryLiteralPattern(game)},\\s*`, 'iu'), '');
  return /^(?:this|the)\s+(?:page|article|guide|walkthrough|document|source)\s+(?:lists?|indexes?|catalogues?)\s+(?:an?|the)\s+(?:[\p{L}'’-]+\s+){0,10}(?:records?|entries|index|overview)\s*[.!?]$/iu.test(prose);
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
