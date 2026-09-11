import { filterGamingDocumentInstructions } from '@services/gamingDocumentExtraction.js';
import type { GamingPlayerContext } from './gamingPlayerContext.js';
import { assessGamingProgressionRequest, filterGamingNonAffirmativeStateClauses, hasUsefulGamingProgressValue } from './gamingProgressionPolicy.js';

export const GAMING_RETRIEVAL_POLICY_VERSION = 'gaming-player-retrieval/v1';
const STOP_WORDS = new Set('a an and are as at be by can do does for from how i in is it me my of on or should that the this to was what when where which who why with you about after before finishing completing completed finished defeated get go help please tell use using want would guide next now then need proceed continue current objective checkpoint step steps walkthrough explain detailed detail concise briefly spoiler spoilers spoilerfree beat defeat boss strategy game look up newly released beginner route supplied source opening simple summary summarize overview linked guides direct answer both am im m supposed stuck has have user major first'.split(' '));

export interface GamingRetrievalPolicyInput extends GamingPlayerContext {
  game?: string;
  prompt: string;
  mode?: 'guide' | 'build' | 'meta';
}

export interface GamingRetrievalTerms {
  requestTerms: string[];
  contextTerms: string[];
  /** Only these terms drive candidate acquisition and the existing relevance floor. */
  focusTerms: string[];
}

export function gamingLexicalTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** State supports a specific request; it becomes the anchor only for an ambiguous request. */
export function buildGamingRetrievalTerms(input: GamingRetrievalPolicyInput): GamingRetrievalTerms {
  const gameTerms = new Set(gamingLexicalTokens(input.game ?? ''));
  const meaningful = (text: string) => [...new Set(gamingLexicalTokens(text)
    .filter(term => !STOP_WORDS.has(term) && !gameTerms.has(term)))];
  // Share the progression filter so a polite task remains the topical anchor
  // while non-affirmative location/completion claims remain generation context.
  const question = filterGamingNonAffirmativeStateClauses(input.prompt)
    .replace(/\b(?:no|without|avoid|light|full)\s+spoilers?\b/giu, '')
    .replace(/\bspoilers?\s+(?:are\s+)?(?:allowed|ok|okay|fine|permitted)\b/giu, '')
    .replace(/\b(?:keep|make)\s+it\s+(?:short|brief|concise|detailed)\b/giu, '')
    .replace(/\bon\s+(?:pc|playstation(?:\s*\d)?|ps[345]|xbox(?:\s+series\s+[xs])?|switch|console)\b/giu, '')
    .replace(/\b(?:on\s+)?(?:easy|normal|hard|nightmare)\s+(?:difficulty|mode)\b/giu, '');
  const progression = assessGamingProgressionRequest(input);
  const requestTerms = progression.progressionDependent && !progression.hasRequestAnchor ? [] : meaningful(question).slice(0, 16);
  // Platform, difficulty, edition, version and presentation preferences are not topical terms.
  // Caller state is request context, not evidence or a source compatibility assertion.
  const progressValues = (['currentArea', 'progressPoint', 'lastCompletedObjective'] as const)
    .filter(field => input.contextOrigins?.[field] !== 'tentative' && !input.contextConflicts?.includes(field))
    .map(field => input[field]).filter(hasUsefulGamingProgressValue);
  const contextTerms = meaningful([
    ...progressValues,
    // Class/build constraints cannot stand in for a missing progression point.
    ...(!progression.progressionDependent ? [input.class, input.role, ...(input.constraints ?? [])] : [])
  ].filter(Boolean).join(' ')).slice(0, 16);
  return { requestTerms, contextTerms, focusTerms: requestTerms.length ? requestTerms : contextTerms };
}

export function gamingTermCoverage(text: string, terms: readonly string[]): number {
  const available = new Set(gamingLexicalTokens(text));
  return terms.length ? terms.filter(term => available.has(term)).length / terms.length : 0;
}

/** Prefer explicit paragraphs; flattened documents reuse the existing sentence boundary convention. */
export function scopeGamingEvidenceParagraphs(text: string, input: GamingRetrievalPolicyInput): string {
  if (input.mode !== 'guide' || input.spoilerMode === 'full') return text;
  const { focusTerms } = buildGamingRetrievalTerms(input);
  const paragraphs = text.split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean);
  if (!focusTerms.length) return text;
  const units = paragraphs.length > 1 ? paragraphs : text.split(/(?<=[.!?])\s+/u).filter(Boolean);
  if (units.length < 2) return text;
  const included = new Set<number>();
  for (const [index, unit] of units.entries()) {
    if (gamingTermCoverage(unit, focusTerms) === 0) continue;
    included.add(index);
    if (index > 0 && /\b(?:prerequisite|requires?|must first|only if)\b/iu.test(units[index - 1])) included.add(index - 1);
    // A paragraph is already a complete source unit; do not infer that the next
    // paragraph continues the same mechanic merely from a discourse prefix.
    if (paragraphs.length > 1) continue;
    // Retain a directly dependent mechanic/warning and an explicit prerequisite.
    // This is conservative excerpt selection, not a verified progression classifier.
    for (let next = index + 1; next < Math.min(units.length, index + 5); next += 1) {
      const previousTerms = [...new Set(gamingLexicalTokens(units[next - 1]))].filter(term => !STOP_WORDS.has(term));
      const connected = gamingTermCoverage(units[next], previousTerms) > 0;
      const dependentOrAction = /^(?:(?:then|otherwise)\s+)?(?:do not|don't|cross|step|back away|open|close|turn|pull|push|wait|dodge|block|attack|equip|bring|check|inspect|follow|climb|return|keep|avoid)\b/iu.test(units[next]);
      const evidenceLimit = /^the (?:guide|source|evidence) (?:does not|doesn't|cannot|can't)\b/iu.test(units[next]);
      if (!connected && !dependentOrAction && !evidenceLimit) break;
      included.add(next);
    }
  }
  // Never invent a passage when no paragraph matches; the existing relevance gate handles zero.
  return units.filter((_part, index) => included.has(index)).join('\n\n');
}

/** Metadata is untrusted, bounded and optional; it must not reveal unrelated section names. */
export function safeGamingEvidenceMetadata(value: string, input: GamingRetrievalPolicyInput, maxChars = 160): string {
  const safe = filterGamingDocumentInstructions(value)
    .replace(/[\r\n\t\u0000-\u001f\u007f<>\[\]]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
  if (!safe || input.mode !== 'guide' || input.spoilerMode === 'full') return safe;
  // Even a matching chapter name can append an ending/twist. Conservative modes omit
  // prose metadata entirely; internal provenance still retains sanitized heading paths.
  return '';
}
