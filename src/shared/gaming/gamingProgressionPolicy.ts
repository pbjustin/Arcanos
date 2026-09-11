import type { GamingPlayerContext } from './gamingPlayerContext.js';

export interface GamingProgressionInput extends GamingPlayerContext {
  prompt: string;
  game?: string;
}

const PROGRESS_FIELDS = ['currentArea', 'lastCompletedObjective', 'progressPoint'] as const;
const GENERIC_TERMS = new Set('a an and are as at be been by can could did do does doing for from go going had has have help how i im in is it ive just last me my next now of on or please point progress progression quest objective checkpoint current currently area world location level game guide walkthrough request question should supposed step steps stuck tell that the then there this to was were what when where which with you your am after before completed completing defeated defeating finished finishing beat beating boss get getting find found need want would like appreciate use explain not yet unknown unsure sure some somewhere something anywhere nothing none dont know remember early later major first second third chapter part section totally completely really lost confused answer make give short brief concise detailed spoiler spoilers difficulty platform story campaign guidance near beginning start starting end ending middle mission missions advice ideas direction directions advise tips assist assistance'.split(' '));
const NON_STATE = /\b(?:if|would|could|might|suppose|imagine|hypothetical|hypothetically|not|never|haven['’]?t|hadn['’]?t|didn['’]?t|don['’]?t)\b/iu;
const PROGRESS_STATE_CLAUSE = /^\s*(?:(?:actually|well),?\s+)?(?:(?:if|since|because|suppose|imagine|hypothetically),?\s+)?(?:i|we|(?:the\s+)?user)\s+(?:(?:am|are|was|were|have|has|had|be|been|do|does|did|would|could|might|not|never|haven['’]?t|hadn['’]?t|didn['’]?t|don['’]?t|currently|just|already|yet)\s+)*(?:at|in|near|to|complete[ds]?|finish(?:ed)?|defeat(?:ed)?|beat(?:en)?|reach(?:ed)?)\b/iu;
const PROGRESSION_QUERY = /\bwhat\s+(?:(?:should|do|can)\s+i\s+)?(?:do\s+)?(?:next|now)\b|\bwhat\s+(?:am\s+i\s+supposed\s+to|should\s+i|do\s+i)\s+do\b|\bwhere\s+(?:(?:should|do|can)\s+i\s+)?go\b|\b(?:i['’]?m|i\s+am)\s+(?:(?:completely|totally|really)\s+)?(?:stuck|lost|confused)\b|\b(?:next\s+(?:step|objective)|how\s+(?:do|can)\s+i\s+(?:proceed|continue)|what\s+to\s+do)\b/iu;

function tokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/['’]/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Exclude unasserted location/completion claims without discarding named tasks. */
export function filterGamingNonAffirmativeStateClauses(prompt: string): string {
  return prompt.split(/(?<!\d)\.|\.(?!\d)|[!?;\n]/u)
    // A denied/conditional state and an explicit question can share a sentence.
    // Filter their own clauses so either one's modal cannot erase the other.
    .flatMap(sentence => sentence.split(/(?:,\s*|\s+(?:and|but)\s+)(?=(?:what|where|how|why|which|(?:can|could|would)\s+(?:i|we|you)|please)\b)/iu))
    .filter(clause => {
      const expanded = clause.replace(/\b(i|we)['’](m|re|ve)\b/giu, (_match, subject: string, auxiliary: string) =>
        `${subject} ${auxiliary.toLowerCase() === 've' ? 'have' : auxiliary.toLowerCase() === 're' ? 'are' : 'am'}`);
      return !NON_STATE.test(clause) || !PROGRESS_STATE_CLAUSE.test(expanded);
    }).join(' ');
}

/** Presentation constraints and non-affirmative claims cannot establish a gameplay point. */
function topicalQuestion(input: GamingProgressionInput): string {
  return filterGamingNonAffirmativeStateClauses(input.prompt)
    .replace(/\b(?:no|without|avoid|light|full)\s+spoilers?\b/giu, '')
    .replace(/\bspoilers?\s+(?:are\s+)?(?:allowed|ok|okay|fine|permitted)\b/giu, '')
    .replace(/\b(?:keep|make)\s+it\s+(?:short|brief|concise|detailed)\b/giu, '')
    .replace(/\b(?:be\s+brief|briefly|in\s+detail|detailed|concise)\b/giu, '')
    .replace(/\b(?:on\s+)?(?:pc|playstation(?:\s*\d)?|ps[345]|xbox(?:\s+series\s+[xs])?|switch|console)\b/giu, '')
    .replace(/\b(?:on\s+)?(?:easy|normal|standard|hard|nightmare)\s+(?:difficulty|mode)\b/giu, '');
}

export function hasUsefulGamingProgressValue(value: string | undefined): boolean {
  if (!value || NON_STATE.test(value)) return false;
  return tokens(value).some(term => !GENERIC_TERMS.has(term));
}

/** Bounded lexical sufficiency, not inferred chronology or verified player state. */
export function assessGamingProgressionRequest(input: GamingProgressionInput): {
  progressionDependent: boolean;
  clarificationNeeded: boolean;
  hasProgressAnchor: boolean;
  hasRequestAnchor: boolean;
} {
  const progressionDependent = PROGRESSION_QUERY.test(input.prompt.replace(/\bwhat\s+i\s+should\s+do\b/giu, 'what should I do'));
  const conflictingProgress = PROGRESS_FIELDS.some(field => input.contextConflicts?.includes(field));
  const hasProgressAnchor = PROGRESS_FIELDS.some(field =>
    input.contextOrigins?.[field] !== 'tentative'
    && !input.contextConflicts?.includes(field)
    && hasUsefulGamingProgressValue(input[field]));
  const gameTerms = new Set(tokens(input.game ?? ''));
  const presentationTerms = new Set(tokens([input.platform, input.difficulty, input.edition, input.version].filter(Boolean).join(' ')));
  const hasRequestAnchor = tokens(topicalQuestion(input)).some(term => !GENERIC_TERMS.has(term) && !gameTerms.has(term) && !presentationTerms.has(term));
  return {
    progressionDependent,
    clarificationNeeded: progressionDependent && (conflictingProgress || (!hasProgressAnchor && !hasRequestAnchor)),
    hasProgressAnchor,
    hasRequestAnchor
  };
}
