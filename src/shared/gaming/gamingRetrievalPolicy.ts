import { filterGamingDocumentInstructions } from '@services/gamingDocumentExtraction.js';
import type { GamingPlayerContext } from './gamingPlayerContext.js';
import { assessGamingProgressionRequest, filterGamingNonAffirmativeStateClauses, hasUsefulGamingProgressValue } from './gamingProgressionPolicy.js';
import { GAMING_PLAYER_DECISION_CHOICES } from './gamingPreferenceData.js';

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

/** Explicit unresolved choices are player decisions, never missing source facts. */
export function resolveGamingUserDecisionGap(input: GamingRetrievalPolicyInput): { prompt: string; clarification?: string } {
  if (/\b(?:compare|comparison|differences?|pros and cons)\b/iu.test(input.prompt)) return { prompt: input.prompt };
  const marker = "(?:I(?:'m| am)?\\s+)?(?:undecided\\s+(?:between|about)|(?:am\\s+)?(?:unsure|not sure)\\s+(?:whether|between)|haven't decided\\s+(?:between|whether)|(?:can't|cannot) decide\\s+between|should I (?:choose|use|play))\\s+";
  let prompt = input.prompt;
  let clarification: string | undefined;
  for (const choice of GAMING_PLAYER_DECISION_CHOICES) {
    const alternatives = `(?:${choice.first})\\s+(?:or|versus|vs\\.?|and)\\s+(?:${choice.second})|(?:${choice.second})\\s+(?:or|versus|vs\\.?|and)\\s+(?:${choice.first})`;
    const pattern = new RegExp(`\\b${marker}(?:${alternatives})`, 'iu');
    const match = pattern.exec(input.prompt);
    if (!match) continue;
    const preferences = [input.role, ...(input.constraints ?? [])].filter((value): value is string => Boolean(value));
    const affirmative = (option: string) => new RegExp(`^(?:(?:I\\s+)?(?:prefer|choose|want|use)\\s+)?(?:a\\s+|an\\s+)?${option}(?:\\s+(?:build|playstyle|style))?[.!]?$`, 'iu');
    const first = preferences.some(value => affirmative(choice.first).test(value.trim()));
    const second = preferences.some(value => affirmative(choice.second).test(value.trim()));
    prompt = prompt.replace(pattern, '');
    if (first === second) clarification ??= choice.question;
  }
  return { prompt, ...(clarification ? { clarification } : {}) };
}

export function gamingLexicalTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Retrieval-only normalization; the original request retains every answer constraint. */
function gamingTopicalRequest(prompt: string): string {
  return prompt
    // Quoted source titles identify supplied material, not requested gameplay
    // facts or player edition. Required-source identity remains a separate gate.
    .replace(/\b(?:the|this|a)\s+(?:(?:submitted|supplied|provided|linked|required)\s+)?(?:guide|source|article)\s+is\s+(?:titled|called|named)\s+["“][^"”\n]{1,240}["”]\s*\.?/giu, '')
    .replace(/\b(?:while\s+)?(?:no|without|avoid(?:ing)?|light|full)\s+(?:story\s+)?spoilers?\b/giu, '')
    .replace(/\bspoilers?\s+(?:are\s+)?(?:allowed|ok|okay|fine|permitted)\b/giu, '')
    .replace(/\b(?:keep|make)\s+it\s+(?:short|brief|concise|detailed|spoiler[ -]?free)\b/giu, '')
    .replace(/\bspoiler[ -]?free\b/giu, '')
    .replace(/\b(?:before|after)\s+(?:moving\s+on|continuing|proceeding)\b/giu, '')
    // A requested number/style of steps is not a second mechanic. Keep the
    // topical preparation term and do not remove "safe" from named game objects.
    .replace(/\b(?:one|a\s+single)\s+(?:safe\s+)?(?=(?:preparation\s+)?step\b)/giu, '');
}

/** State supports a specific request; it becomes the anchor only for an ambiguous request. */
export function buildGamingRetrievalTerms(input: GamingRetrievalPolicyInput): GamingRetrievalTerms {
  const gameTerms = new Set(gamingLexicalTokens(input.game ?? ''));
  const meaningful = (text: string) => [...new Set(gamingLexicalTokens(text)
    .filter(term => !STOP_WORDS.has(term) && !gameTerms.has(term)))];
  // Share the progression filter so a polite task remains the topical anchor
  // while non-affirmative location/completion claims remain generation context.
  // Required-guide identity is enforced separately; host/path tokens are not
  // gameplay topics. Remove URLs before sentence filtering splits their dots.
  const question = filterGamingNonAffirmativeStateClauses(gamingTopicalRequest(resolveGamingUserDecisionGap(input).prompt
    .replace(/https?:\/\/[^\s)]+/giu, '')))
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

/** Source admission asks for a useful contribution; aggregate answer coverage remains separate. */
export function hasGamingRelevantGuideContribution(text: string, input: GamingRetrievalPolicyInput): boolean {
  const generic = new Set('create provide focusing focus recommend recommended recommendation recommendations best good guide build builds early game latest current beginner general advice weapon weapons stat stats armor armour route location configuration allocation'.split(' '));
  const anchors = buildGamingRetrievalTerms(input).focusTerms.filter(term => !generic.has(term));
  return anchors.length > 0 && gamingTermCoverage(text, anchors) > 0;
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

/** Public labels describe requested topics only; player context never becomes a discovery requirement. */
export interface GamingRequestRequirement { requirement: string; terms: string[] }

/**
 * Explicit lists/conjunctions retain their independent requested topics. A single
 * broad topic is assessed by the established topic floor rather than an invented
 * universal build checklist. This bounded lexical adapter makes no semantic claim.
 */
function gamingRequestClauses(input: GamingRetrievalPolicyInput): { clauses: string[]; hasCoordinatedTarget: boolean } {
  const question = gamingTopicalRequest(resolveGamingUserDecisionGap(input).prompt.slice(0, 8_000))
    .replace(/https?:\/\/[^\s)]+/giu, '')
    // Required-guide identity is enforced separately by backend intake. A
    // source-selection preamble is not an independent gameplay requirement.
    .replace(/\b(?:use|using)\s+(?:only|exclusively)\s*([.!?]|$)/giu, '$1')
    .replace(/\b(?:using|use|according to|based on|from)\s+(?:(?:this|the|a|these|my)\s+)?(?:(?:required|supplied|provided|linked)\s+)?(?:guides?|sources?|articles?)\s*(?:\([^)]*\))?\s*[:,]?\s*/giu, '')
    .replace(/\b(?:account|user|player|character)\s*(?:id|identifier|name)\s*[:=]\s*\S+/giu, '')
    .replace(/\b(?:password|token|secret|api[ _-]?key|credential)\s*[:=]\s*\S+/giu, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gmu, ';')
    // A leading location/build context belongs to the following question. A
    // comma here does not request both a location fact and a separate mechanic.
    .replace(/(^|[.!?;]\s*)(\s*(?:at|in|as|for|with)\b[^.!?;\n]+?),\s*(?=(?:what|where|how|which|why|can|could|should|please|explain|describe|recommend)\b)/giu,
      (_match, boundary: string, context: string) => `${boundary}${context.replace(/\s+(?:and|plus|as well as)\s+|,/giu, ' ')} `);
  // A coordinated noun phrase such as "blade of wind and rain" requests one
  // relationship. Keep its terms together without assuming that any bare pair
  // ("Wind and Rain") names a single object. The marker also
  // requires full same-passage support; the broad-topic floor cannot admit half.
  let hasCoordinatedTarget = false;
  const requestBoundaries = [...STOP_WORDS, 'also', 'find', 'locate', 'obtain', 'acquire', 'equip', 'craft', 'buy',
    'upgrade', 'repair', 'activate', 'unlock', 'open', 'allocate', 'improve', 'describe', 'recommend', 'show', 'list'];
  const targetWord = String.raw`(?!(?:${requestBoundaries.join('|')})\b)\p{L}[\p{L}\p{N}'’\-]*`;
  // Generic relationship heads describe separate subjects, not a named object:
  // "effects of poison and bleeding" can be supported by two intact passages.
  const relationshipHeads = String.raw`effects?|locations?|stats?|attributes?|strengths?|weakness(?:es)?|resistances?|requirements?|costs?|propert(?:y|ies)`;
  const targetHeadWord = String.raw`(?!(?:${relationshipHeads})\b)${targetWord}`;
  const coordinatedTitle = new RegExp(`(?<![\\p{L}\\p{N}'’\\-])(?:${targetWord}\\s+){0,3}${targetHeadWord}\\s+of\\s+(?:${targetWord}\\s+){1,4}and\\s+${targetWord}(?:\\s+${targetWord}){0,3}`, 'giu');
  const topicalQuestion = question.replace(coordinatedTitle, target => {
    hasCoordinatedTarget = true;
    return target.replace(/\s+and\s+/giu, ' ');
  });
  const detailStart = /\b(?:including|covering|include|covers?)\s+|\bwith\s+(?=[^.!?]*(?:\band\b|;))/iu.exec(topicalQuestion);
  const requested = detailStart ? topicalQuestion.slice(detailStart.index + detailStart[0].length) : topicalQuestion;
  const clauses = requested.split(/\s+(?:and|plus|as well as)\s+|[;,]|[.!?]\s+(?=(?:(?:also|then)\s+)?(?:what|where|how|which|why|can|could|should|please|explain|describe|recommend|show|list|tell)\b)/iu)
    .map(clause => clause.replace(/^\s*(?:also|then)\s+(?=(?:what|where|how|which|why|can|could|should|please|explain|describe|recommend|show|list|tell)\b)/iu, ''))
    .filter(clause => buildGamingRetrievalTerms({ game: input.game, prompt: clause }).requestTerms.length > 0);
  return { clauses, hasCoordinatedTarget };
}

/** Overflow asks for a narrower scope; it never silently omits requested facts. */
export function gamingRequestRequirementLimitExceeded(input: GamingRetrievalPolicyInput): boolean {
  return gamingRequestClauses(input).clauses.length > 8;
}

export function buildGamingRequestRequirements(input: GamingRetrievalPolicyInput): GamingRequestRequirement[] {
  const { clauses, hasCoordinatedTarget } = gamingRequestClauses(input);
  if (clauses.length > 8) return [];
  const requirements = clauses.map((clause, index) => {
    const terms = buildGamingRetrievalTerms({ game: input.game, prompt: clause }).requestTerms
      .filter(term => !['recommend', 'recommended', 'recommendation', 'recommendations', 'provide', 'describe', 'including', 'include', 'cover', 'covering'].includes(term))
      .filter(term => !/[0-9]{6,}/u.test(term));
    // This finite diagnostic vocabulary supplies labels only when explicitly
    // requested. It adds no mandatory facets and contains no player/source text.
    const clauseWords = new Set(terms);
    const canonical = [
      { label: 'weapon configuration', words: ['weapon', 'configuration'] },
      { label: 'stat allocation', words: ['stat', 'allocation'] },
      { label: 'stat allocation', words: ['stats', 'allocation'] },
      { label: 'team composition', words: ['team', 'composition'] },
      { label: 'upgrade route', words: ['upgrade', 'route'] },
      { label: 'equipment selection', words: ['equipment', 'selection'] },
      { label: 'skill selection', words: ['skill', 'selection'] }
    ].find(facet => facet.words.every(word => clauseWords.has(word)));
    return { requirement: canonical?.label ?? `requested topic ${index + 1}`, terms };
  }).filter(requirement => requirement.terms.length > 0 && requirement.requirement.length > 0);
  // A coordinated target is one atomic request, not two independently supported facts.
  return (requirements.length > 1 || hasCoordinatedTarget && requirements.length === 1) && requirements.every(requirement => requirement.terms.length >= 1)
    ? requirements.map((requirement, index) => ({ ...requirement,
      requirement: requirements.filter(entry => entry.requirement === requirement.requirement).length > 1
        ? `${requirement.requirement} (requested topic ${index + 1})` : requirement.requirement })) : [];
}
