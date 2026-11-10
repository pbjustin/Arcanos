import { filterGamingDocumentInstructions } from '@services/gamingDocumentExtraction.js';
import type { GamingPlayerContext } from './gamingPlayerContext.js';
import { assessGamingProgressionRequest, filterGamingNonAffirmativeStateClauses, hasUsefulGamingProgressValue } from './gamingProgressionPolicy.js';
import { GAMING_PLAYER_DECISION_CHOICES } from './gamingPreferenceData.js';
import { gamingRegistryLiteralPattern, resolveGamingRegistryGame } from './gamingGameRegistry.js';

export const GAMING_RETRIEVAL_POLICY_VERSION = 'gaming-player-retrieval/v1';
const STOP_WORDS = new Set('a an and are as at be by can do does for from how i in is it me my of on or should that the this to was what when where which who why with you about after before finishing completing completed finished defeated get go help please tell use using want would guide next now then need proceed continue current objective checkpoint step steps walkthrough explain detailed detail concise briefly spoiler spoilers spoilerfree beat defeat boss strategy game look up newly released beginner route supplied source opening simple summary summarize overview linked guides direct answer both am im m supposed stuck has have user major first'.split(' '));
const GENERIC_RELATIONSHIP_HEADS = String.raw`effects?|mechanics?|benefits?|locations?|stats?|attributes?|strengths?|weakness(?:es)?|resistances?|requirements?|costs?|propert(?:y|ies)`;
const GAMEPLAY_ACTIONS = new Set('activate access align allocate attack avoid block buy choose collect compare complete confirm craft cross defeat deploy dodge enter equip exit explore find finish focus follow gather heal improve inspect insert jump keep leave move open place plan plant practice prepare preserve press prioritize raise reach read reduce register remove repair restore return rotate save select spend take trade travel turn unlock upgrade use visit wait'.split(' '));
const ACTION_COUNTS: Readonly<Record<string, number>> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const FIRST_ACTIONS = /\bfirst\s+(zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(?:concrete|ordered)\s+)?actions?\b/iu;

/** Quoted acquisition titles are named objects, not requests for that number of actions. */
function gamingLiteralAcquisitionTitle(prompt: string): boolean {
  return gamingAcquisitionObjectRequest(prompt) && (/["“][^"”\n]{1,160}["”]|\b\p{Lu}[\p{L}'’-]+\s+(?:for|of)\s+\p{Lu}[\p{L}'’-]+/u.test(prompt)
    || /\bfirst\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+actions?\s+book\b/iu.test(prompt));
}

/** Keep action counts outside bounded quoted titles while preserving invalid counts for clarification. */
function gamingRequestedActionCount(prompt: string): number | undefined {
  const unquoted = prompt.replace(/"[^"\n]{1,160}"|“[^”\n]{1,160}”/gu, ' ');
  const scoped = gamingAcquisitionObjectRequest(prompt)
    ? unquoted.replace(/\bfirst\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+actions?\s+book\b/giu, ' ') : unquoted;
  const match = FIRST_ACTIONS.exec(scoped);
  return match ? ACTION_COUNTS[match[1].toLowerCase()] ?? Number(match[1]) : undefined;
}

/** Resolve only closed, single-sentence coordinated references in the request. */
function gamingScopedRequest(prompt: string): string {
  return prompt.slice(0, 8_000)
    .replace(/\b(what\s+materials\s+do\s+(?:i|we)\s+need\s+for\s+)([^.!?\n]{1,160}?)\s+and\s+(where\s+(?:can|do)\s+(?:i|we)\s+(?:find|obtain|buy|collect))\s+them\b/giu,
      (_match, prefix: string, subject: string, follow: string) => `${prefix}${subject} and ${follow} materials for ${subject}`)
    .replace(/(^|[.!?]\s+)((?:explain|list|describe)\s+)?([^.!?\n]{1,160}?)\s+prerequisites\s+and\s+its\s+(first\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(?:concrete|ordered)\s+)?actions?)\b/giu,
      (_match, boundary: string, frame: string = '', subject: string, actions: string) => `${boundary}${frame}${subject} prerequisites and ${actions} for ${subject}`)
    .replace(/\b(how\s+to\s+(?:start|begin|get\s+started\s+with)\s+)([^.!?\n]{1,160}?)\s+and\s+((?:identify|list|describe)\s+(?:the\s+)?required\s+materials)\b/giu,
      (_match, frame: string, subject: string, materials: string) => `${frame}${subject} and ${materials} for ${subject}`);
}

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

/** Keep acquisition questions about named objects outside procedure-facet parsing. */
function gamingAcquisitionObjectRequest(prompt: string): boolean {
  return /^\s*(?:where|which|how)\b[^.!?\n]{0,80}\b(?:obtain|find|buy|acquire|locate)\b/iu.test(prompt);
}

/** Retrieval-only normalization; the original request retains every answer constraint. */
function gamingTopicalRequest(prompt: string, preserveProcedure = false): string {
  // Closed presentation clauses do not assert a second gameplay fact. Keep
  // named objects, player restrictions and the original generation request.
  prompt = gamingScopedRequest(prompt)
    .replace(/\b(?:cite|provide\s+citations?\s+(?:for|to))\s+(?:(?:your|the|these|guide)\s+){0,2}sources?(?=\s*[.!?,;]|\s*$)/giu, '')
    .replace(/\b(?:give|show|provide)\s+(?:(?:me|us)\s+)?(?:(?:clear|concrete|ordered|numbered|actionable)\s+){0,2}(?:steps|instructions)(?:\s+with\s+citations)?(?=\s*[.!?,;]|\s*$)/giu, '');
  // A request to find a guide names the gameplay topic, not an acquired fact
  // containing the words "find" or "explaining". Only consume a leading,
  // bounded source-discovery frame; quoted titles and ordinary find actions stay.
  const discoveryPrefix = /^\s*(?:please\s+)?find\s+(?:(?:me|us)\s+)?(?:a|an|the)\s+(?:(?:good|detailed)\s+){0,2}/iu.exec(prompt);
  if (discoveryPrefix) {
    const remainder = prompt.slice(discoveryPrefix[0].length);
    const directFrame = /^(?:guide|walkthrough)(?:\s+(?:explaining|about|for|on)\s+|\s*[,;]\s*)/iu;
    const topicFrame = /^([^.!?\n"“”]{1,160}?)\s+(?:guide|walkthrough)(?=\s*(?:[.!?]|$)|\s+(?:for|about|on)\b)/iu;
    const topic = directFrame.test(remainder) ? remainder.replace(directFrame, '')
      : topicFrame.test(remainder) ? remainder.replace(topicFrame, '$1') : undefined;
    if (topic !== undefined) prompt = topic
      // The bare introductory tail belongs to this guide-search frame. Keep
      // concrete subjects ("get started with surface prospecting") untouched.
      .replace(/\s+and\s+how\s+to\s+get\s+started(?=\s*(?:[.!?]|$))/giu, '');
  }
  if (!preserveProcedure && !gamingLiteralAcquisitionTitle(prompt)) prompt = prompt
    // Only question/action framing is interchangeable; named gameplay objects
    // remain exact anchors. "Begin" alone never establishes a source mechanic.
    .replace(/\b(?:how\s+(?:do|can|should)\s+(?:i|we)\s+|how\s+to\s+)(?:get\s+started(?:\s+with)?|begin|start)(?=\s|[.!?,;]|$)/giu, '')
    .replace(/\b(?:the\s+)?first\s+(?:concrete\s+|ordered\s+)?steps(?=\s*[.!?,;]|\s*$|\s+(?:and|for|to|with)\b)/giu, '')
    .replace(/\b(?:the\s+)?first\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(?:concrete|ordered)\s+)?actions?(?:\s+(?:needed|required))?(?:\s+for)?\b/giu, '')
    .replace(/\bwhat\s+materials\s+do\s+(?:i|we)\s+need\s+for\s+/giu, 'materials ')
    .replace(/\bwhere\s+(?:can|do)\s+(?:i|we)\s+(?:find|obtain|buy|collect)\s+materials\s+for\s+/giu, 'materials ')
    .replace(/\b(?:identify|list|describe)\s+(?:the\s+)?required\s+materials\s+for\s+/giu, 'materials ')
    .replace(/\b(?:prerequisites?|requirements?)(?=\s*[.!?,;]|\s*$|\s+(?:and|plus|as well as|for|to)\b)/giu,
      match => gamingAcquisitionObjectRequest(prompt) ? match : '')
    .replace(/\bwhat\s+do\s+(?:i|we)\s+need\s+first(?:\s+(?:for|to))?\b/giu, '')
    .replace(/\bhow\s+(?:do|can|should)\s+(?:i|we)\s+set\s+up\s+/giu, '')
    .replace(/\bearly\s+in\s+(?=chapter\s+\d\b)/giu, '');
  return prompt
    .replace(/(^|[.!?]\s+)(?:no\s+major|avoid\s+(?:major|later[ -]story))\s+spoilers?(?=\s*(?:[.!?]|$))/giu, '$1')
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
  // An explicit source-scope disclaimer is not support for the topics it lists.
  // Keep the acquired text intact elsewhere, and retain real negative gameplay
  // advice as well as affirmative facts beside the disclaimer.
  const supportingText = text.replace(/\b(?:does\s+not|doesn['’]t|do\s+not|don['’]t|cannot|can['’]t|will\s+not|won['’]t)\s+(?:explain|cover|describe|document|address|support|verify|establish|prove)\b[^.!?;\n]*/giu,
    (clause: string, offset: number) => {
      const prefix = text.slice(Math.max(0, offset - 240), offset).split(/[.!?;\n]/u).at(-1) ?? '';
      if (!/\b(?:guide|source|article|page|evidence|document|section|passage)\b/iu.test(prefix)) return clause;
      const continuation = /,\s*(?:but|however|yet)\b/iu.exec(clause);
      return continuation ? clause.slice(continuation.index) : ' ';
    });
  const available = new Set(gamingLexicalTokens(supportingText));
  return terms.length ? terms.filter(term => available.has(term)).length / terms.length : 0;
}

/** Claim coverage excludes request style and contextual freshness qualifiers.
 * The original request remains intact for identity, applicability and freshness. */
export function buildGamingClaimCoverageTerms(input: GamingRetrievalPolicyInput): string[] {
  const prompt = input.prompt.replace(/\b(?:on|for|at|as of)\s+(?:the\s+)?(?:latest|current|newest|live)\s+(?:patch|version|build|season)\b(?!\s+(?:changes|updates|notes|differences|effects)\b)/giu, '');
  return buildGamingRetrievalTerms({ ...input, prompt }).focusTerms
    .filter(term => !['recommend', 'recommended', 'recommendation', 'recommendations', 'best', 'good'].includes(term));
}

/** Intelligible acquired gameplay assertions, not an authority or truth verdict.
 * Catalog speech acts, game identity and topic labels supply no claim text.
 * Both declarative relations and player actions remain eligible for the normal
 * identity, applicability, coverage and final semantic CLEAR assessments. */
export function gamingAttributableClaimText(text: string, game?: string, metadata?: { title?: string; headings?: string }): string {
  const registryGame = game ? resolveGamingRegistryGame(game) : undefined;
  const names = [...new Set([game, registryGame?.name, ...(registryGame?.aliases ?? [])].filter((value): value is string => Boolean(value)))];
  const gamePattern = names.length ? `(?:${names.sort((left, right) => right.length - left.length).map(gamingRegistryLiteralPattern).join('|')})` : undefined;
  const scope = gamePattern ? new RegExp(`\\bin(?: the game)?\\s+${gamePattern},\\s*`, 'iu') : undefined;
  const gamePrefix = gamePattern ? new RegExp(`^${gamePattern}\\s+`, 'iu') : undefined;
  const definition = gamePattern ? new RegExp(`^${gamePattern}\\s+is\\s+an?\\s+(?:[\\p{L}][\\p{L}'’-]{0,31}\\s+){0,8}game(?=\\s|[.!?,;]|$)`, 'iu') : undefined;
  const authorship = /^(?:(?:it|this\s+game|the\s+game)\s+(?:is|was|were|has\s+been)\s+)?(?:developed|published|created|produced)\s+by\b/iu;
  const nominalSection = String.raw`(?:about\s+(?:the\s+)?game|(?:overview|summary|details|information)\s+(?:of|about)\s+(?:the\s+)?game)`;
  const sectionPrefix = new RegExp(`^${nominalSection}(?:\\s*[:.!?])?(?:\\s+|$)`, 'iu');
  const nominalPagePrefix = gamePattern ? new RegExp(`^${gamePattern}\\s+(?:wiki(?:\\s+guide)?|guide|walkthrough|index)\\s+(?=${nominalSection}\\b|${gamePattern}\\s+is\\b)`, 'iu') : undefined;
  const metaHead = /\b(?:wiki|catalog|index|glossary|encyclopedia|entry|entries|article|articles|page|pages|topic|topics|directory|collection|heading|headings|guide|document|source|section|sections|overview|summary|content|gameplay|evidence|information|news|record|records|table|tables|titles|labels|names)\s*$/iu;
  const referenceObject = /\b(?:wiki|catalog|index|encyclopedia|directory|articles?|pages?|headings?|titles?|topics?|glossary)\b/iu;
  const action = new RegExp(`\\b(?:${[...GAMEPLAY_ACTIONS].join('|')})\\b`, 'iu');
  const relation = /\b(?:is|are|was|were|has|have|uses?|costs?|requires?|needs?|opens?|unlocks?|grants?|blocks?|protects?|deflects?|reflects?|absorbs?|inflicts?|deals?|reduces?|restores?|increases?|changes?|stuns?|sells?|spawns?|drops?|equals?|provides?|supports?|contains?|includes?|prevents?|allows?|follows?|begins?|starts?|ends?|waits?|leaves?|progress(?:es)?|prioritizes?|retains?|favors?|combines?|improves?|determines?|depends?|gives?|causes?|offers?|halves?|staggers?|weighs?)\s+\S/giu;
  // A plural noun is not a finite verb merely because it ends in s or is
  // capitalized. Retain productive verb forms without admitting label bags.
  const finiteRelation = /\b[\p{L}][\p{L}'’-]*(?:ates|ifies|izes|ises|ects|uces|ores|ows|cks|ches|shes|rms|rns|nks|lds|nts)\s+(?!(?:and|or|plus|as|is|are|was|were|has|have|can|could|must|should|may|will|would)\b)\S/giu;
  const location = /\b(?:at|in|on|from|near|beside|behind|inside|outside|under|beneath|above|below|between|within)\s+\S/giu;
  // A flattened heading can precede a source-description sentence without a
  // full stop. Keep its material assertion separate from the description.
  let prose = text.trim().replace(/\s+(?=(?:this|the)\s+(?:page|article|guide|walkthrough|document|source|section)\s+(?:explains?|describes?|covers?|lists?|provides?|contains?|includes?|offers?|presents?)\b)/giu, '\n');
  for (const heading of [metadata?.title, metadata?.headings?.split(/\s+\|\s+|\n/u, 1)[0]]
    .filter((value): value is string => Boolean(value)).sort((left, right) => right.length - left.length)) {
    const topic = gamePrefix ? heading.replace(gamePrefix, '') : heading;
    if (prose.startsWith(heading) && /^\s/u.test(prose.slice(heading.length))
      && ![...topic.matchAll(relation), ...topic.matchAll(finiteRelation), ...topic.matchAll(location)].length && !action.test(topic.split(/\s+/u, 1)[0])
      && (/^(?:wiki(?:\s+guide)?|guide|walkthrough|index)$/iu.test(topic)
        || !/^\s+(?:is|are|was|were|has|have|can|must|should|uses?|costs?|requires?|opens?|grants?|blocks?)\b/iu.test(prose.slice(heading.length))))
      prose = prose.slice(heading.length).trim();
  }
  // A fresh acquired game scope starts its own clause even when a flattened
  // primary heading precedes it. Evaluate that prefix independently instead of
  // borrowing its words or losing the following procedure without display metadata.
  const claimProse = scope ? prose.replace(new RegExp(scope.source, 'giu'), (_match: string, offset: number) => {
    // The suffix rules below need at most two words. Inspect them directly
    // instead of copying/splitting the entire preceding document per scope.
    // Keep arbitrary whitespace intact and stop at the original clause boundary.
    let prefixStart = offset;
    let completedWords = 0;
    let withinWord = false;
    while (prefixStart > 0) {
      const character = prose.charAt(prefixStart - 1);
      if (/[.!?;\n]/u.test(character)) break;
      if (/\s/u.test(character)) {
        if (withinWord) {
          completedWords += 1;
          withinWord = false;
          if (completedWords === 2) break;
        }
      } else withinWord = true;
      prefixStart -= 1;
    }
    const prefix = prose.slice(prefixStart, offset);
    // A parenthetical scope cannot sever a prohibition or conditional prefix
    // from its action and turn negative gameplay advice into a positive claim.
    return /,\s*$/u.test(prefix) || /\b(?:do\s+not|don['’]t|does\s+not|doesn['’]t|never|cannot|can['’]t|must\s+not|should\s+not|unless|only\s+if)\s*$/iu.test(prefix)
      ? ' ' : '\n';
  }) : prose;
  return claimProse.split(/\n+|(?<=[.!?])\s+|;\s*/u).map(original => {
    let clause = original.trim();
    if (!clause || /\b(?:at|in|for|from|to|with|and|but|after|before|until|when|where|if|unless|only)\s*[.!?]?$/iu.test(clause)) return '';
    // Flattened parser headings can precede the definition without punctuation.
    // Remove only closed nominal page/section labels, never a factual heading.
    if (nominalPagePrefix) clause = clause.replace(nominalPagePrefix, '');
    clause = clause.replace(sectionPrefix, '').trim();
    // Identity/authorship is metadata even when the same sentence names a
    // developer or publisher. Inspect a separate gameplay continuation intact.
    const definitionMatch = definition?.exec(clause);
    if (definitionMatch) clause = clause.slice(definitionMatch[0].length).trim();
    if (authorship.test(clause)) {
      const continuation = /,\s*(?:(?:and|while|but|whereas)\s+)?|\s+(?:while|but|whereas)\s+/iu.exec(clause);
      clause = continuation ? clause.slice(continuation.index + continuation[0].length).trim() : '';
    }
    if (definitionMatch) clause = clause.replace(/^(?:and|while|but|where|whereas)\s+/iu, '');
    if (!clause || /^[.!?]+$/u.test(clause)) return '';
    // Reading a source link supplies no acquired gameplay, even when its label
    // repeats the requested item. Preserve a separate authored continuation.
    if (/^(?:(?:first|next|then)[,:]?\s+)?(?:read|consult|browse)\s+[^.!?;:\n]{0,180}\b(?:walkthroughs?|guides?|articles?|pages?|wiki|catalog|index|directory)\b/iu.test(clause)) {
      const continuation = /,\s*(?:(?:and|while|but|whereas)\s+)?|\s+(?:while|but|whereas)\s+/iu.exec(clause);
      clause = continuation ? clause.slice(continuation.index + continuation[0].length).trim() : '';
      if (!clause) return '';
    }
    const claimText = clause;
    // A title's leading game name may itself contain a preposition or verb.
    // Evaluate its following topic; preserve a game that is the actual subject
    // of an explicit finite relation rather than a heading prefix.
    if (gamePrefix) {
      const topic = clause.replace(gamePrefix, '');
      const directPredicate = [...topic.matchAll(relation), ...topic.matchAll(finiteRelation)].some(match => match.index === 0)
        || /^(?:can|could|must|should|may|will|would)\b/iu.test(topic);
      if (topic !== clause && !directPredicate) clause = topic;
    }
    const actionClause = clause.replace(/^(?:do\s+not|don['’]t)\s+/iu, '');
    // A bounded imperative can name the mechanic before its acquired by-action.
    // Preserve a negative imperative as advice; it still cannot prove a start.
    const explicitStart = /^(?:start|begin)\s+[^.!?;\n]{1,180}?\s+by\s+(.+)/iu.exec(actionClause);
    if (explicitStart && (/^(?:do\s+not|don['’]t)\s+/iu.test(clause)
      || gamingActionInstruction(explicitStart[1].split(/\s+and\s+/iu, 1)[0]))) return claimText;
    // Typed build serialization binds a named slot, ranked skill or stat value;
    // a list of unbound item/topic names does not satisfy these relations.
    if (/^(?:Equipment\s+\(\d+\):\s+[^:,\n]{1,80}:\s+\S|Skills\s+\(\d+\):\s+[^,\n]{1,160}\s+rank\s+\d|Stats\s+\(\d+\):\s+[^:,\n]{1,80}:\s+(?:[-+]?\d|yes\b|no\b))/iu.test(clause)) return claimText;
    clause = clause.replace(/\b(?:does|do)\s+not\s+(?!(?:explain|cover|describe|document|address|support|verify|establish|prove)\b)/giu, '');
    const attributed = (index: number): boolean => {
      const subject = clause.slice(0, index).split(/[,;:]/u).at(-1)?.trim() ?? '';
      return Boolean(subject && /\p{L}/u.test(subject) && !metaHead.test(subject)
        && !/^(?:the|a|an|these|those|this|our|your|their)$/iu.test(subject));
    };
    if ([...clause.matchAll(relation)].some(match => attributed(match.index)
      // Offering a guide/build is a description until it binds the actual
      // configuration used. Catalog/document subjects remain excluded above.
      && (!/^offers?\b/iu.test(match[0]) || /\busing\s+\S/iu.test(clause.slice(match.index)))
      && (!referenceObject.test(clause) || /^(?:(?:is|are|was|were)\s+(?:sold|found|located|available)|costs?|requires?|needs?|opens?|unlocks?|grants?|blocks?|protects?|deflects?|reflects?|absorbs?|inflicts?|deals?|reduces?|restores?|increases?|changes?|stuns?|sells?|spawns?|drops?|equals?|prevents?|follows?)\b/iu.test(clause.slice(match.index))))) return claimText;
    if (!referenceObject.test(clause) && [...clause.matchAll(finiteRelation)].some(match => attributed(match.index))) return claimText;
    // Generic imperative syntax preserves unfamiliar procedure verbs such as
    // "align the prism" without admitting an instruction to follow a catalog.
    const mechanicalResult = /\b(?:to\s+(?:unlock|open|activate|restore|repair|cross|defeat)|grants?|unlocks?|costs?|inflicts?|deals?)\s+(?!(?:the\s+)?(?:wiki|catalog|index|article|page|directory)\b)\S/iu.test(clause);
    const browsingOnly = referenceObject.test(clause) && !mechanicalResult;
    const instruction = /^(?:(?:first|next|then)[,:]?\s+)?(?:to\s+)?([\p{L}][\p{L}'’-]*)\s+\S/iu.exec(actionClause);
    const localInstruction = /(?:^|[,:])\s*(?:(?:first|next|then)[,:]?\s+)?(?:to\s+)?([\p{L}][\p{L}'’-]*)\s+\S/giu;
    const imperative = /(?:^|[,:])\s*(?:(?:first|next|then)[,:]?\s+)?(?!(?:about|above|below|under|over|at|in|on|of|with|without|for|from|as|through|during|after|before|unless|because|while|where|when|if|that|this|the|an?|and|or|plus|but|its|their|these|those|your|our|my|we|you|they|he|she|is|are|was|were|has|does)\b)[\p{L}][\p{L}'’-]*\s+(?:the|a|an|your|our|their|its|this|that)\s+\p{L}/iu.test(actionClause);
    if (!browsingOnly && (imperative || instruction && action.test(instruction[1])
      || [...actionClause.matchAll(localInstruction)].some(match => action.test(match[1])))) return claimText;
    const modal = /\b(?:can|could|must|should|may|will|would)\s+[\p{L}][\p{L}'’-]*\s+\S/giu;
    if (!browsingOnly && [...clause.matchAll(modal)].some(match => attributed(match.index))) return claimText;
    if (/\b(?:you|players?|characters?|commanders?)\s+(?:(?:can|could|must|should|may|will|typically|usually|often)\s+){0,2}[\p{L}][\p{L}'’-]*\s+\S/iu.test(clause)
      && !referenceObject.test(clause)) return claimText;
    return !referenceObject.test(clause) && [...clause.matchAll(location)].some(match => attributed(match.index)) ? claimText : '';
  }).filter(Boolean).join('\n');
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
  const countedStarts = buildGamingRequestRequirements(input).filter(requirement => (requirement.minimumActions ?? 0) > 1);
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
      const raiseInstruction = /^(?:(?:then|otherwise)\s+)?raise\b/iu.test(units[next]);
      const connected = gamingTermCoverage(units[next], previousTerms.filter(term => !raiseInstruction || term !== 'raise')) > 0;
      // Raising a banner can describe unrelated story progression. Without a
      // shared topic, retain only an explicit attribute/equipment allocation
      // relationship in matching build context; no named game stat is assumed.
      const buildAllocation = raiseInstruction && /\b(?:builds?|stats?|attributes?|equipment)\b/iu.test(`${input.prompt} ${unit}`)
        && /^(?:(?:then|otherwise)\s+)?raise\s+(?!(?:the|an?|your|our|their|this|that|these|those)\b)[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2}\s+(?:enough\s+)?(?:for|to|until)\b/iu.test(units[next])
        && /\b(?:equipment|stats?|attributes?|requirements?)\b/iu.test(units[next]);
      const countedContinuation = countedStarts.some(requirement => gamingRequirementSupported(units[index], { ...requirement, minimumActions: 1 }))
        && Boolean(gamingActionInstruction(units[next].split(/\s+and\s+/iu, 1)[0]));
      const dependentOrAction = /^(?:(?:then|otherwise)\s+)?(?:do not|don't|cross|step|back away|open|close|turn|pull|push|wait|dodge|block|attack|equip|bring|check|inspect|follow|climb|return|keep|avoid|prioritize)\b/iu.test(units[next]) || buildAllocation || countedContinuation;
      const evidenceLimit = /^(?:this|the|our|that) (?:guide|source|article|page|evidence|document|section|passage) (?:does not|doesn't|cannot|can't|will not|won't)\b/iu.test(units[next]);
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
export interface GamingRequestRequirement {
  requirement: string;
  terms: string[];
  /** Closed request wording; it does not establish that the mechanic exists. */
  procedure?: 'prerequisite' | 'start';
  /** Internal factual constraints; never public authority or source claims. */
  minimumActions?: number;
  relation?: 'materials' | 'acquisition';
}

/** Identify closed prerequisite/start wording without asserting source support. */
function gamingProcedureRequest(clause: string): GamingRequestRequirement['procedure'] {
  if (gamingAcquisitionObjectRequest(clause)) return undefined;
  if (/\b(?:prerequisites?|requirements?)(?=\s*[.!?,;]|\s*$|\s+(?:and|plus|as well as|for|to)\b)|\bwhat\s+do\s+(?:i|we)\s+need\s+first\b/iu.test(clause)) return 'prerequisite';
  if (FIRST_ACTIONS.test(clause)) return 'start';
  if (/\b(?:how\s+(?:do|can|should)\s+(?:i|we)\s+|how\s+to\s+)(?:get\s+started|begin|start)\b|\bfirst\s+(?:concrete\s+|ordered\s+)?steps(?=\s*[.!?,;]|\s*$|\s+(?:and|for|to|with)\b)/iu.test(clause)) return 'start';
  return undefined;
}

/** An affirmative player action, not a question, passive fact or nominal list. */
function gamingActionInstruction(text: string): string | undefined {
  if (text.includes('?')) return undefined;
  const instruction = text.trim().replace(/^(?:you|players?|commanders?)\s+(?:(?:can|could|may|must|should|will)\s+)/iu, '')
    .replace(/^(?:(?:first|next|then)[,:]?\s+|[1-8][.)]\s+)/iu, '');
  const match = /^([\p{L}][\p{L}'’-]*)\s+(.+)/u.exec(instruction);
  if (!match) return undefined;
  const word = match[1].toLowerCase();
  const stem = word.replace(/ing$/u, '');
  const verb = [word, ...(stem !== word ? [stem, `${stem}e`, stem.replace(/(.)\1$/u, '$1')] : [])]
    .find(value => GAMEPLAY_ACTIONS.has(value));
  const object = match[2].split(/\b(?:where|which|who|that|because)\b/iu, 1)[0];
  if (!verb || /\b(?:is|are|was|were|has|have|can|could|must|should|will|would|begins?|starts?|requires?|needs?|sells?)\b/iu.test(object)) return undefined;
  return `${verb} ${match[2]}`.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Count bounded ordered actions only after an explicit same-passage start anchor. */
function gamingStartingActions(text: string, terms: readonly string[], affirmativeSubject: (subject: string) => boolean): number {
  let best = 0;
  for (const paragraph of text.split(/\n\s*\n/u)) {
    const actions = new Set<string>();
    let active = false;
    for (const sentence of paragraph.split(/\n+|(?<=[.!?])\s+|;\s*/u)) {
      if (sentence.includes('?')) { active = false; actions.clear(); continue; }
      const forbidden = (index: number) => /\b(?:not|never|avoid|don['’]t)\b/iu.test(sentence.slice(0, index));
      const target = /\bto\s+(?:begin|start)\s+([^.!?;\n,:]{1,180})[,:]\s*(.+)/iu.exec(sentence);
      const imperative = /^(?:start|begin)\s+([^.!?;\n]{1,180}?)\s+by\s+(.+)/iu.exec(sentence.trim());
      const subject = /^(.{1,180}?)\s+(?:begins?|starts?)\s+by\s+(.+)/iu.exec(sentence);
      const by = /\b(?:begin|start)\s+by\s+(.+)/iu.exec(sentence);
      let tail: string | undefined;
      if (target) tail = affirmativeSubject(target[1]) && !forbidden(target.index) ? target[2]
        : /^(?:your|the)\s+journey\b/iu.test(target[1]) && by && gamingTermCoverage(by[1], terms) === 1 && !forbidden(by.index) ? by[1] : undefined;
      else if (imperative) tail = affirmativeSubject(imperative[1]) ? imperative[2] : undefined;
      else if (subject) tail = affirmativeSubject(subject[1]) ? subject[2] : undefined;
      else if (by) tail = gamingTermCoverage(by[1], terms) === 1 && !forbidden(by.index) ? by[1] : undefined;
      const anchor = Boolean(target || imperative || subject || by);
      tail = tail?.replace(/^(?:begin|start)\s+by\s+/iu, '');
      if (anchor) {
        // Each explicit start begins its own route; alternative procedures do
        // not contribute actions to one another's requested count.
        actions.clear();
        active = Boolean(tail);
        if (!active) break;
      }
      if (!active) continue;
      const sequence = (tail ?? sentence).trim()
        .replace(/^(?:you|players?|commanders?)\s+(?:(?:can|could|may|must|should|will)\s+)/iu, '')
        .replace(/^(?:(?:first|next|then)[,:]?\s+|[1-8][.)]\s+)/iu, '');
      const fragments = sequence.split(/\s+(?:and(?:\s+then)?|then)\s+|,\s*/iu);
      if (!gamingActionInstruction(fragments[0])) break;
      let found = false;
      for (const fragment of fragments) {
        const action = gamingActionInstruction(fragment);
        if (action) { actions.add(action); found = true; }
        else if (!/^(?:do\s+not|don['’]t)\s+/iu.test(fragment.trim())) break;
      }
      if (!found) break;
      best = Math.max(best, actions.size);
      if (best >= 8) return 8;
    }
  }
  return best;
}

/** The requested topic must be the grammatical target, not an incidental nearby object. */
function gamingTopicSubject(subject: string, terms: readonly string[]): boolean {
  const topical = subject.trim().replace(/^(?:(?:the|a|an|your|our|new)\s+){0,2}/iu, '');
  return terms.length > 0 && gamingLexicalTokens(topical)[0] === terms[0]
    && gamingTermCoverage(topical, terms) === 1;
}

/** Extract a stated materials list only from the request's acquired topic relation. */
function gamingRequiredMaterials(text: string, terms: readonly string[]): string[] {
  for (const sentence of text.split(/\n+|(?<=[.!?])\s+|;\s*/u)) {
    if (gamingTermCoverage(sentence, terms) !== 1 || sentence.includes('?') || /\b(?:unlike|not|never|no\s+longer)\b/iu.test(sentence)) continue;
    const direct = /\bmaterials\s+(?:required|needed)\s+for\s+(.{1,160}?)\s+(?:are|include)\s+(.{1,240})/iu.exec(sentence);
    const scoped = /^for\s+(.{1,160}?),\s*(?:the\s+)?required\s+materials\s+(?:are|include)\s+(.{1,240})/iu.exec(sentence);
    const match = direct ?? scoped;
    if (!match || !gamingTopicSubject(match[1], terms)) continue;
    const entities = match[2].replace(/[.!?]+$/u, '').split(/\s+and\s+|,\s*/iu)
      .map(value => value.trim()).filter(value => value && value.length <= 80);
    if (entities.length > 0 && entities.length <= 8
      && entities.every(value => !/^(?:unknown|not\s+specified|unverified|unspecified|n\/?a|not\s+confirmed|to\s+be\s+determined)$/iu.test(value))) return entities;
  }
  return [];
}

/** Bind acquisition locations to actual topic materials, rather than an unresolved pronoun. */
function gamingMaterialAcquisitionSupported(text: string, terms: readonly string[]): boolean {
  const sentences = text.split(/\n+|(?<=[.!?])\s+|;\s*/u)
    .filter(sentence => !sentence.includes('?'))
    .flatMap(sentence => sentence.split(/\s+and\s+(?=(?:buy|collect|gather|obtain|find)\s)/iu));
  const objects = sentences.flatMap(sentence => {
    if (sentence.includes('?') || /\b(?:not|never|unavailable|except|excluding|without|apart\s+from|other\s+than)\b/iu.test(sentence)) return [];
    const relation = /^(?:buy|collect|gather|obtain|find)\s+(.{1,240}?)\s+(?:at|from|in|near)\s+\S/iu.exec(sentence)
      ?? /^(.{1,240}?)\s+(?:is|are|can\s+be)\s+(?:sold|found|available|obtained|collected)\s+(?:at|from|in|near)\s+\S/iu.exec(sentence);
    return relation ? [relation[1]] : [];
  });
  const materials = gamingRequiredMaterials(text, terms);
  if (materials.length > 0 && materials.every(material => objects.some(object => gamingTermCoverage(object, gamingLexicalTokens(material)) === 1))) return true;
  return objects.some(value => !/\b(?:one\s+of|some|among|part\s+of)\b/iu.test(value)
    && /\bmaterials\b/iu.test(value) && (gamingTopicSubject(value, terms)
      || /^materials\s+for\s+/iu.test(value.trim()) && gamingTopicSubject(value.replace(/^materials\s+for\s+/iu, ''), terms)));
}

/** Exact named topic anchors plus an acquired requirement/action relationship.
 * These closed grammatical alternatives do not relax other lexical clauses. */
export function gamingRequirementSupported(text: string, requirement: GamingRequestRequirement): boolean {
  if (text.length > 8_000) return false;
  if (requirement.minimumActions !== undefined && (!Number.isInteger(requirement.minimumActions)
    || requirement.minimumActions < 1 || requirement.minimumActions > 8)) return false;
  if (requirement.relation === 'materials') return gamingRequiredMaterials(text, requirement.terms).length > 0;
  if (requirement.relation === 'acquisition') return gamingMaterialAcquisitionSupported(text, requirement.terms);
  if (!requirement.procedure) return gamingTermCoverage(text, requirement.terms) === 1;
  const affirmativeSubject = (subject: string) => {
    if (/\b(?:not|never|unlike|except|rather\s+than|no\s+longer)\b/iu.test(subject)
      || gamingTermCoverage(subject, requirement.terms) !== 1) return false;
    const coordinated = subject.split(/\b(?:and|or)\b/iu);
    const lastSubject = coordinated.at(-1)?.trim() ?? '';
    // A complete requested topic before a new coordinated subject cannot lend
    // its anchors to that subject's predicate. Atomic names spanning "and"
    // retain their complete term set rather than becoming separate objects.
    return coordinated.length < 2 || !lastSubject || gamingTermCoverage(lastSubject, requirement.terms) === 1
      || !coordinated.slice(0, -1).some(part => gamingTermCoverage(part, requirement.terms) === 1);
  };
  if (requirement.procedure === 'start') return gamingStartingActions(text, requirement.terms, affirmativeSubject) >= (requirement.minimumActions ?? 1);
  return text.split(/\n+|(?<=[.!?])\s+|;\s*/u).some(sentence => {
    if (gamingTermCoverage(sentence, requirement.terms) !== 1) return false;
    if (requirement.procedure === 'prerequisite') {
      const relation = /\b(?:requires?|needs?|must\s+(?:first\s+)?(?:have|obtain|buy|equip|unlock|complete|reach|finish|carry|collect|spend|select)|only\s+if|(?:is|are)\s+required|(?:no|without)\s+prerequisites?)\b/giu;
      return [...sentence.matchAll(relation)].some(match => {
        const prefix = sentence.slice(0, match.index);
        const before = /\bbefore\s+(?:beginning|starting)\s+([^,;:]{1,180}),\s*(?:you|players?|commanders?)\s*$/iu.exec(prefix);
        return affirmativeSubject(prefix.split(/[,;:]|\b(?:but|whereas|while|although)\b/iu).at(-1) ?? '')
          || Boolean(before && affirmativeSubject(before[1]));
      });
    }
    return false;
  });
}

/**
 * Explicit lists/conjunctions retain their independent requested topics. A single
 * broad topic is assessed by the established topic floor rather than an invented
 * universal build checklist. This bounded lexical adapter makes no semantic claim.
 */
function gamingRequestClauses(input: GamingRetrievalPolicyInput): { clauses: string[]; hasCoordinatedTarget: boolean } {
  const question = gamingTopicalRequest(resolveGamingUserDecisionGap(input).prompt.slice(0, 8_000), true)
    .replace(/https?:\/\/[^\s)]+/giu, '')
    // In "How do X, Y and Z work?", the shared predicate and an introductory
    // regional qualifier frame the topics. Original scope/freshness gates still
    // inspect the complete question; named work objects and personal actions stay.
    .replace(/\bhow\s+(?:do|does)\s+(?!(?:i|we|you)\b)([^.!?\n]{1,800}?)\s+work\s*(?=[.!?]|$)/giu,
      (clause: string, topics: string) => /,|\s+(?:and|plus|as well as)\s+/iu.test(topics)
        ? topics.replace(/^(?:regional|region[ -]specific)\s+/iu, '') : clause)
    // Required-guide identity is enforced separately by backend intake. A
    // source-selection preamble is not an independent gameplay requirement.
    .replace(/\b(?:use|using)\s+(?:only|exclusively)\s*([.!?]|$)/giu, '$1')
    .replace(/\b(?:using|use|according to|based on|from)\s+(?:(?:this|the|a|these|my)\s+)?(?:(?:required|supplied|provided|linked)\s+)?(?:guides?|sources?|articles?)\s*(?:\([^)]*\))?\s*[:,]?\s*/giu, '')
    .replace(/\b(?:account|user|player|character)\s*(?:id|identifier|name)\s*[:=]\s*\S+/giu, '')
    .replace(/\b(?:password|token|secret|api[ _-]?key|credential)\s*[:=]\s*\S+/giu, '')
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gmu, ';')
    // A leading location/build context belongs to the following question. A
    // comma here does not request both a location fact and a separate mechanic.
    .replace(/(^|[.!?;]\s*)(\s*(?:at|in|on|as|for|with)\b[^.!?;\n]+?),\s*(?=(?:what|where|how|which|why|can|could|should|please|explain|describe|recommend)\b)/giu,
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
  const targetHeadWord = String.raw`(?!(?:${GENERIC_RELATIONSHIP_HEADS})\b)${targetWord}`;
  const coordinatedTitle = new RegExp(`(?<![\\p{L}\\p{N}'’\\-])(?:${targetWord}\\s+){0,3}${targetHeadWord}\\s+of\\s+(?:${targetWord}\\s+){1,4}and\\s+${targetWord}(?:\\s+${targetWord}){0,3}`, 'giu');
  const topicalQuestion = question.replace(coordinatedTitle, target => {
    hasCoordinatedTarget = true;
    return target.replace(/\s+and\s+/giu, ' ');
  });
  const detailStart = /\b(?:including|covering|include|covers?)\s+|\bwith\s+(?=[^.!?]*(?:\band\b|;))/iu.exec(topicalQuestion);
  const requested = detailStart ? topicalQuestion.slice(detailStart.index + detailStart[0].length) : topicalQuestion;
  const clauses = requested.split(/\s+(?:and|plus|as well as)\s+|[;,]|[.!?]\s+(?=(?:(?:also|then)\s+)?(?:what|where|how|which|why|can|could|should|please|explain|describe|recommend|show|list|tell)\b)/iu)
    .map(clause => clause.replace(/^\s*(?:also|then)\s+(?=(?:what|where|how|which|why|can|could|should|please|explain|describe|recommend|show|list|tell)\b)/iu, ''))
    .filter(clause => gamingProcedureRequest(clause) || buildGamingRetrievalTerms({ game: input.game, prompt: clause }).requestTerms.length > 0);
  return { clauses, hasCoordinatedTarget };
}

/** Overflow asks for a narrower scope; it never silently omits requested facts. */
export function gamingRequestRequirementLimitExceeded(input: GamingRetrievalPolicyInput): boolean {
  const count = gamingRequestedActionCount(input.prompt);
  return gamingRequestClauses(input).clauses.length > 8
    || count !== undefined && (count < 1 || count > 8);
}

/** Missing gameplay scope or unresolved references cannot be supplied by retrieved text. */
export function gamingRequestScopeUnresolved(input: GamingRetrievalPolicyInput): boolean {
  const scoped = gamingScopedRequest(input.prompt);
  if (/\bwhere\s+(?:can|do)\s+(?:i|we)\s+(?:find|obtain|buy|collect)\s+them\b|\bits\s+first\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(?:concrete|ordered)\s+)?actions?\b/iu.test(scoped)) return true;
  const generic = new Set('list find identify required materials prerequisites requirements mechanics actions needed its them three one two four five six seven eight nine ten'.split(' '));
  const terms = buildGamingClaimCoverageTerms(input);
  return terms.length === 0 || terms.every(term => generic.has(term) || /^\d+$/u.test(term));
}

/** Build bounded factual clauses and procedure intents while retaining named topic anchors. */
export function buildGamingRequestRequirements(input: GamingRetrievalPolicyInput): GamingRequestRequirement[] {
  const { clauses, hasCoordinatedTarget } = gamingRequestClauses(input);
  if (clauses.length > 8) return [];
  const subject = gamingScopedRequest(input.prompt).split(/\b(?:including|covering|include|covers?)\s+/iu, 1)[0];
  const genericTerms = new Set('identify list required materials prerequisites requirements actions needed its them concrete ordered'.split(' '));
  const topicTerms = buildGamingClaimCoverageTerms({ game: input.game, prompt: subject }).filter(term => !genericTerms.has(term));
  let hasAtomicTarget = false;
  const requirements = clauses.map((clause, index) => {
    // Relational question framing describes the requested facts; it is not a
    // word that an independently acquired passage must repeat verbatim.
    const topicalClause = clause.replace(new RegExp(`\\b(?:${GENERIC_RELATIONSHIP_HEADS})\\s+of\\s+`, 'giu'), '');
    const minimumActions = gamingRequestedActionCount(clause);
    const procedure = minimumActions !== undefined ? 'start' as const : gamingProcedureRequest(clause);
    const relation = /^where\s+(?:can|do)\s+(?:i|we)\s+(?:find|obtain|buy|collect)\s+materials\s+for\b/iu.test(topicalClause.trim()) ? 'acquisition' as const
      : /\bwhat\s+materials\s+do\s+(?:i|we)\s+need\s+for\b|\b(?:identify|list|describe)\s+(?:the\s+)?required\s+materials\b/iu.test(topicalClause) ? 'materials' as const : undefined;
    const atomic = gamingLiteralAcquisitionTitle(clause);
    hasAtomicTarget ||= atomic;
    let terms = buildGamingClaimCoverageTerms({ game: input.game, prompt: topicalClause })
      .filter(term => !['recommend', 'recommended', 'recommendation', 'recommendations', 'provide', 'describe', 'including', 'include', 'cover', 'covering'].includes(term))
      .filter(term => !/[0-9]{6,}/u.test(term));
    if (relation) terms = terms.filter(term => !genericTerms.has(term));
    if (atomic) terms = terms.filter(term => !['find', 'obtain', 'buy', 'acquire', 'locate'].includes(term));
    if (atomic && FIRST_ACTIONS.test(clause) && !terms.includes('first')) terms.push('first');
    if (procedure && !terms.length) terms = topicTerms;
    if (relation && !terms.length) terms = topicTerms;
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
    return { requirement: canonical?.label ?? `requested topic ${index + 1}`, terms, ...(procedure ? { procedure } : {}),
      ...(minimumActions !== undefined ? { minimumActions } : {}), ...(relation ? { relation } : {}) };
  }).filter(requirement => requirement.terms.length > 0 && requirement.requirement.length > 0);
  // A coordinated target is one atomic request, not two independently supported facts.
  return (requirements.length > 1 || hasAtomicTarget || hasCoordinatedTarget && requirements.length === 1 || requirements.some(requirement => requirement.procedure || requirement.relation)) && requirements.every(requirement => requirement.terms.length >= 1)
    ? requirements.map((requirement, index) => ({ ...requirement,
      requirement: requirements.filter(entry => entry.requirement === requirement.requirement).length > 1
        ? `${requirement.requirement} (requested topic ${index + 1})` : requirement.requirement })) : [];
}
