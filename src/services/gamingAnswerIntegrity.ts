import citationSyntax from '../shared/gaming/gamingCitationSyntax.json' with { type: 'json' };
import { gamingHybridCitationLinks, gamingHybridCitationTargets, readGamingMarkdownCitationDestination } from '@shared/gaming/gamingHybridPolicyCore.js';
import { GAMING_STALE_GUIDE_WARNING, GAMING_UNVERIFIED_GUIDE_WARNING, gamingAnswerClaimsVerifiedCurrentness } from '@shared/gaming/gamingFreshnessDisposition.js';
import type { GamingStoredKnowledgeContext } from '@shared/gaming/gamingStoredEvidenceCore.js';

const MAX_GAMING_ANSWER_CHARS = 12_000;
const MAX_GAMING_CITATION_REFERENCES = 128;
const NUMERIC_CITATION = new RegExp(citationSyntax.numericReferencePattern, 'giu');
const MARKDOWN_LINK = /\[(?:[^\[\]\r\n]|\[[^\[\]\r\n]*\])+\]\(/gu;
const NUMBERED_CITATION_LABEL = /^\[\s*(?:sources?\s+)?(\d+(?:\s*,\s*\d+)*)\s*\]\($/iu;
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[[^\[\]\r\n]+\]:/mu;
const MARKDOWN_QUOTED_BLOCK = /^ {0,3}((`|~)\2{2,})[^\r\n]*\r?\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*(?=\r?$)|(?![\s\S]))|^ {0,3}>[^\r\n]*(?:\r?\n(?![ \t]*\r?$)[^\r\n]+)*/gmu;
const QUOTED_EXCERPT = /`+[^`\r\n]+`+|"[^"]*"|“[^”]*(?:”|(?![\s\S]))|(?:^|[\s(])'(?:[^'\r\n]|(?<=\p{L})'(?=\p{L}))*'|‘[^’]*’/gmu;
const HTML_MARKUP = /<!--[\s\S]*?(?:-->|(?![\s\S]))|<\/?[a-z][a-z\d-]*(?:\s[^<>]*|\/?)>/giu;
const EXPLICIT_CITATION_REQUEST = /(?:^|[.!?,;\n]|\band\b)\s*(?:please\s+)?(?:cite\s+(?:(?:your|the|these|guide)\s+){0,2}sources?|(?:include|provide)\s+(?:source\s+)?citations?)(?=\s*[.!?,;]|\s*$)/iu;
const ANSWER_PATCH_REFERENCE = /\b(?:for|on|in)\s+(?:current\s+)?patch\s+(\d+(?:\.\d+){1,2})\b/giu;
const GUIDE_PATCH_UNCERTAINTY = /(?:^|[.!?](?:\s*\[(?:sources?\s+)?\d+(?:\s*,\s*\d+)*\])?\s+|\r?\n)\s*(?:the|this)\s+guide\s+does\s+not\s+(?:establish|confirm)\s+(?:whether\s+(?:these\s+steps\s+work|(?:the|this)\s+(?:route|strategy|build)\s+works)\s+on|compatibility\s+(?:for|with|on))\s+patch\s+\d+(?:\.\d+){1,2}\.(?=\s|$)/giu;

type GamingSource = GamingStoredKnowledgeContext['sources'][number];

function selectedCitationIndices(knowledge: GamingStoredKnowledgeContext): Set<number> {
  return new Set((knowledge.evidence ?? []).map(chunk => knowledge.sources.findIndex(source =>
    source.sourceId === chunk.sourceId && source.url === chunk.publicUrl) + 1));
}

function hasCitedNumber(answer: string, matches: Iterable<RegExpExecArray>): boolean {
  return [...matches].some(match => match[1] !== undefined
    || match[2] !== undefined && /^\s*(?:[.,;:!?\])]|$)/u.test(answer.slice(match.index + match[0].length)));
}

function withinCitationLimit(answer: string): boolean {
  let references = 0;
  for (const match of answer.matchAll(NUMERIC_CITATION)) {
    references += (match[1] ?? match[2])?.split(',').length ?? 0;
    if (references > MAX_GAMING_CITATION_REFERENCES) return false;
  }
  return true;
}

/** Use the ordered evidence index for an already cited URL. Keep the cited prose and link intact. */
export function resolveGamingGuideCitations(answer: string, knowledge: GamingStoredKnowledgeContext): string | undefined {
  // Blank quotations without moving the citation offsets in the delivered answer.
  const blankExcerpt = (excerpt: string) => excerpt.replace(/[^\r\n]/g, ' ');
  const attribution = answer.replace(MARKDOWN_QUOTED_BLOCK, blankExcerpt).replace(HTML_MARKUP, blankExcerpt)
    .replace(QUOTED_EXCERPT, blankExcerpt);
  const references = [...attribution.matchAll(NUMERIC_CITATION)]
    .filter(match => !/[!\\]/u.test(attribution[match.index - 1] ?? ''));
  if (hasCitedNumber(attribution, references)) return withinCitationLimit(answer) ? answer : undefined;
  const selected = [...selectedCitationIndices(knowledge)];
  let resolved = '';
  let offset = 0;
  for (const link of gamingHybridCitationLinks(attribution)) {
    if (/[!\\]/u.test(attribution[link.start - 1] ?? '')) continue;
    const indices = selected.filter(index => knowledge.sources[index - 1]?.url === link.url);
    if (indices.length !== 1) continue;
    resolved += `${answer.slice(offset, link.end)} [${indices[0]}]`;
    offset = link.end;
  }
  if (!offset) return undefined;
  const citedAnswer = resolved + answer.slice(offset);
  return withinCitationLimit(citedAnswer) ? citedAnswer : undefined;
}

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
  const selected = selectedCitationIndices(knowledge);
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
    const literalUrlLabel = /^<?(https?:\/\/[^\s<>]+)>?$/iu.exec(match[0].slice(1, -2).trim())?.[1];
    if (literalUrlLabel && literalUrlLabel !== destination.url) return 'CITATION_SOURCE_MISMATCH';
  }
  const urls = gamingHybridCitationTargets(answer);
  if (urls.some(url => !selectedUrls.has(url))) return 'CITATION_SOURCE_MISMATCH';
  if (!hasCitedNumber(answer, numeric) && !urls.length && EXPLICIT_CITATION_REQUEST.test(prompt.replace(/"[^"\r\n]{0,160}"|“[^”\r\n]{0,160}”/gu, ' '))) {
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
