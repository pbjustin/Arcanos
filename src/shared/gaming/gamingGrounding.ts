import {
  GamingSourceEvidenceError,
  type GamingGrounding
} from '@services/gamingModes.js';

export const LIMITED_GAMING_ARTICLE_TEXT_SNIPPET = 'Relevant source retrieved, but readable article text was limited.';
const STRUCTURED_RESOURCE_DIAGNOSTIC_SNIPPETS = new Set([
  'Structured build resource detected, but the loadout data could not be decoded safely.',
  'Structured build resource detected, but only bounded metadata could be recovered.',
  'Resource metadata was inspected, but no structured build data was recovered.'
]);

export function isCitableGamingEvidenceSource(source: { snippet?: string }): boolean {
  return Boolean(source.snippet && source.snippet !== LIMITED_GAMING_ARTICLE_TEXT_SNIPPET
    && !STRUCTURED_RESOURCE_DIAGNOSTIC_SNIPPETS.has(source.snippet));
}

export function resolveGamingExecutionOutcome(fallbackReason?: string): 'fallback' | 'completed' {
  return fallbackReason ? 'fallback' : 'completed';
}

export function buildGamingGroundingSummary(input: {
  requestedSourceCount: number;
  fetchedSourceCount: number;
  fetchedSuppliedSourceCount: number;
  sources: ReadonlyArray<{ snippet?: string }>;
  selectedChunkCount: number;
  suppliedEvidenceSourceCount: number;
}): GamingGrounding {
  const usableSourceCount = input.sources.filter(isCitableGamingEvidenceSource).length;
  return {
    groundingStatus: usableSourceCount > 0 && input.selectedChunkCount > 0
      ? 'grounded'
      : input.fetchedSourceCount > 0 ? 'insufficient_evidence' : 'unavailable',
    requestedSourceCount: input.requestedSourceCount,
    fetchedSourceCount: input.fetchedSourceCount,
    fetchedSuppliedSourceCount: input.fetchedSuppliedSourceCount,
    usableSourceCount,
    citableSourceCount: usableSourceCount,
    selectedChunkCount: input.selectedChunkCount,
    suppliedEvidenceSourceCount: input.suppliedEvidenceSourceCount,
    groundedInSuppliedEvidence: input.suppliedEvidenceSourceCount > 0 && input.selectedChunkCount > 0
  };
}

export function createGamingSuppliedGuideEvidenceError(grounding: GamingGrounding): GamingSourceEvidenceError | null {
  return grounding.groundedInSuppliedEvidence ? null : new GamingSourceEvidenceError({
    ...grounding,
    groundingStatus: grounding.fetchedSuppliedSourceCount > 0 ? 'insufficient_evidence' : 'unavailable'
  });
}
