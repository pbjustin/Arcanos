import citationSyntax from '../shared/gaming/gamingCitationSyntax.json' with { type: 'json' };
import { gamingHybridCitationTargets, readGamingMarkdownCitationDestination } from '@shared/gaming/gamingHybridPolicyCore.js';
import { GAMING_STALE_GUIDE_WARNING, GAMING_UNVERIFIED_GUIDE_WARNING, gamingAnswerClaimsVerifiedCurrentness } from '@shared/gaming/gamingFreshnessDisposition.js';
import type { GamingStoredKnowledgeContext } from '@shared/gaming/gamingStoredEvidenceCore.js';

const MAX_GAMING_ANSWER_CHARS = 12_000;
const NUMERIC_CITATION = new RegExp(citationSyntax.numericReferencePattern, 'giu');
const MARKDOWN_LINK = /\[(?:[^\[\]\r\n]|\[[^\[\]\r\n]*\])+\]\(/gu;
const NUMBERED_CITATION_LABEL = /^\[\s*(?:sources?\s+)?(\d+(?:\s*,\s*\d+)*)\s*\]\($/iu;
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[[^\[\]\r\n]+\]:/mu;
const EXPLICIT_CITATION_REQUEST = /(?:^|[.!?,;\n]|\band\b)\s*(?:please\s+)?(?:cite\s+(?:(?:your|the|these|guide)\s+){0,2}sources?|(?:include|provide)\s+(?:source\s+)?citations?)(?=\s*[.!?,;]|\s*$)/iu;
const ANSWER_PATCH_REFERENCE = /\b(?:for|on|in)\s+(?:current\s+)?patch\s+(\d+(?:\.\d+){1,2})\b/giu;
const GUIDE_PATCH_UNCERTAINTY = /(?:^|[.!?](?:\s*\[(?:sources?\s+)?\d+(?:\s*,\s*\d+)*\])?\s+|\r?\n)\s*(?:the|this)\s+guide\s+does\s+not\s+(?:establish|confirm)\s+(?:whether\s+(?:these\s+steps\s+work|(?:the|this)\s+(?:route|strategy|build)\s+works)\s+on|compatibility\s+(?:for|with|on))\s+patch\s+\d+(?:\.\d+){1,2}\.(?=\s|$)/giu;

type GamingSource = GamingStoredKnowledgeContext['sources'][number];
/** Partial coverage is server-owned acquisition metadata. */
export function isGamingSourcePartiallyExtracted(source: GamingSource): boolean {
  const assessment = source.clearSourceAssessment;
  return source.freshnessMetadata?.partialExtraction === true
    || assessment?.findings.some(finding => finding.code === 'EXTRACTION_PARTIAL') === true
    || Object.values(assessment?.dimensionScores ?? {}).some(dimension => dimension.reasonCodes.includes('EXTRACTION_PARTIAL'));
}

/** Structural citation and applicability checks for the exact candidate. */
export function checkGamingAnswerIntegrity(input: {
  answer: string; prompt: string; knowledge: GamingStoredKnowledgeContext; advisory: boolean;
}): string | undefined {
  const { answer, prompt, knowledge, advisory } = input;
  if (!answer.trim() || answer.length > MAX_GAMING_ANSWER_CHARS) return 'INVALID_ANSWER_LENGTH';
  const selected = new Set((knowledge.evidence ?? []).map(chunk => knowledge.sources.findIndex(source =>
    source.sourceId === chunk.sourceId && source.url === chunk.publicUrl) + 1));
  if (!selected.size || selected.has(0)) return 'CITATION_PROVENANCE_MISSING';
  const numeric = [...answer.matchAll(NUMERIC_CITATION)];
  if (numeric.some(match => (match[1] ?? match[2])?.split(',').some(index => !selected.has(Number(index.trim()))))) {
    return 'CITATION_NOT_FOUND';
  }
  const selectedUrls = new Set([...selected].map(index => knowledge.sources[index - 1].url));
  if (MARKDOWN_REFERENCE_DEFINITION.test(answer)) return 'CITATION_SOURCE_MISMATCH';
  for (const match of answer.matchAll(MARKDOWN_LINK)) {
    const destination = readGamingMarkdownCitationDestination(answer.slice(match.index + match[0].length));
    if (!destination || !selectedUrls.has(destination.url)) return 'CITATION_SOURCE_MISMATCH';
    const numbered = NUMBERED_CITATION_LABEL.exec(match[0])?.[1];
    if (numbered?.split(',').some(index => knowledge.sources[Number(index.trim()) - 1]?.url !== destination.url)) {
      return 'CITATION_SOURCE_MISMATCH';
    }
  }
  const urls = gamingHybridCitationTargets(answer);
  if (urls.some(url => !selectedUrls.has(url))) return 'CITATION_SOURCE_MISMATCH';
  const citedNumber = numeric.some(match => match[1] !== undefined
    || match[2] !== undefined && /^\s*(?:[.,;:!?\])]|$)/u.test(answer.slice(match.index + match[0].length)));
  if (!citedNumber && !urls.length && EXPLICIT_CITATION_REQUEST.test(prompt.replace(/"[^"\r\n]{0,160}"|“[^”\r\n]{0,160}”/gu, ' '))) {
    return 'CITATION_NOT_FOUND';
  }
  if (advisory && !(answer.includes(GAMING_UNVERIFIED_GUIDE_WARNING) || answer.includes(GAMING_STALE_GUIDE_WARNING))) {
    return 'FRESHNESS_WARNING_REQUIRED';
  }
  if (advisory && gamingAnswerClaimsVerifiedCurrentness(answer)) return 'UNSUPPORTED_CURRENTNESS_CLAIM';
  const patches = new Set(knowledge.sources.flatMap(source => [
    source.verifiedPatchVersion, source.freshnessMetadata?.patch, source.freshnessMetadata?.currentPatch
  ]).filter((value): value is string => typeof value === 'string'));
  if (patches.size && [...answer.replace(GUIDE_PATCH_UNCERTAINTY, '.').matchAll(ANSWER_PATCH_REFERENCE)]
    .some(match => !patches.has(match[1]))) return 'UNSUPPORTED_CURRENTNESS_CLAIM';
}
