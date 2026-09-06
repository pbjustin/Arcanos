import type { GamingExtractionQuality } from "@services/gamingBuildResourceSchema.js";
import { isGamingCatalogMetadataOnly } from "@services/gamingDocumentExtraction.js";
import { detectGamingGame, type GamingGameDetection } from "@services/gamingGameDetection.js";

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
}): GamingGameDetection {
  return detectGamingGame({
    urls: [input.canonicalUrl],
    pageTitle: input.pageTitle,
    pageHeadings: input.pageHeadings
  });
}

export function classifyGamingDocumentQuality(input: {
  cleanedText: string;
  navigationDensity?: number;
  truncated: boolean;
  minUsefulTextChars: number;
}): 'unusable' | 'metadata-only' | 'partial' | 'complete' {
  const metadataOnly = isGamingCatalogMetadataOnly(input.cleanedText)
    || (input.navigationDensity ?? 0) >= 0.62;
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
