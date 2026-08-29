import {
  BackstageBookerOutputIncompleteError,
  isBackstageProviderOutputLengthExhaustionError,
} from './backstageGenerationError.js';
import { shouldUseBoundedBackstageReviewMode } from './backstageReviewContract.js';

export interface BackstageDirectAnswerOutputContract {
  requestedBulletCount?: number;
  requestedBulletCountMode?: 'exact' | 'atMost' | 'preserve';
  requiresShortBullets: boolean;
}

export type BackstageCompactRetryItemPolicy =
  | { mode: 'exact' | 'atMost'; count: number; budgetItemCount: number }
  | { mode: 'preserve'; budgetItemCount: number }
  | { mode: 'default'; count: number; budgetItemCount: number };

export interface BackstageCompactOutputWordBounds {
  totalWordLimit: number;
  wordsPerItem: number;
}

export interface BackstageCompactRetryValidationContract {
  itemPolicy: BackstageCompactRetryItemPolicy;
  wordBounds: BackstageCompactOutputWordBounds;
}

export interface BackstageCompactOutputAttemptResult<T> {
  result: T;
  usedCompactOutputRetry: boolean;
}

export type BackstageCompactOutputAttemptEvent =
  | 'initial_length_exhaustion'
  | 'compact_retry_started'
  | 'compact_retry_provider_completed'
  | 'compact_retry_length_exhausted'
  | 'compact_retry_skipped_insufficient_budget';

export function resolveBackstageDirectAnswerBulletCount(contract: BackstageDirectAnswerOutputContract): number {
  return contract.requestedBulletCount ?? 5;
}

const NUMBER_WORDS = new Map<string, number>([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
  ['dozen', 12],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90]
]);

const BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN =
  Array.from(NUMBER_WORDS.keys()).join('|');
const BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_ITEM_PATTERN =
  '(?:alternative\\s+cards?|angles?|alternatives?|beats?|bouts?|bullets?|chapters?|feuds?|finish(?:es)?|ideas?|items?|match(?:es)?|matchups?|options?|phases?|programs?|promos?|rivalr(?:y|ies)|scenarios?|segments?|storylines?)';
const BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_MODIFIER_PATTERN =
  '(?:main[- ]event|booking|match|finish|title|storyline|rivalry|creative|different|possible|detailed|short|brief|concise|compact|numbered|men[\'’]?s|women[\'’]?s|raw|smackdown|nxt)';
const BACKSTAGE_BOOKER_COMPACT_RETRY_DIRECTIVE_PATTERN_SOURCE =
  `\\b(?<requestVerb>book|create|generate|give|list|offer|provide|propose|return|schedule|suggest|write|want|need)(?:\\s+(?<recipient>me|us))?\\s+(?:(?<qualifier>exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\\s+(?<modifiers>(?:${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_MODIFIER_PATTERN}\\s+){0,3})(?<itemNoun>alternative\\s+cards?|bullets?|items?|match(?:es)?|rivalr(?:y|ies)|options?|ideas?|alternatives?|scenarios?)\\b`;
const BACKSTAGE_DIRECT_GENERATION_VERB_PATTERN =
  '(?:book|build|continue|create|design|draft|generate|give|make|need|plan|produce|provide|rebook|return|rewrite|schedule|want|write)';
const BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN =
  '(?:angles?|beats?|bouts?|finish(?:es)?|match(?:es)?|matchups?|promos?|segments?)';
const BACKSTAGE_BOOKING_COMPONENT_COUNT_ADJECTIVE_PATTERN =
  `(?:(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})(?:\\s*-\\s*|\\s+)${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}\\s+){0,2}`;
const BACKSTAGE_BOOKING_CONTAINER_MODIFIER_PATTERN =
  '(?:raw|smackdown|nxt|dynamite|collision|wwe|aew|weekly|wrestling|booking|match|premium[- ]live|pay[- ]per[- ]view)';
const BACKSTAGE_COMPLETE_BOOKING_CONTAINER_REQUEST_PATTERN =
  `(?:${BACKSTAGE_DIRECT_GENERATION_VERB_PATTERN}(?:\\s+(?:me|us))?|(?:i|we)(?:['’]d|\\s+would)\\s+like)`;
const BACKSTAGE_COMPLETE_BOOKING_CONTAINER_DIRECTIVE_PATTERN = new RegExp(
  `\\b${BACKSTAGE_COMPLETE_BOOKING_CONTAINER_REQUEST_PATTERN}\\s+(?:(?:a|an|the|this|that|my|our|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}|\\d{1,2})\\s+)?${BACKSTAGE_BOOKING_COMPONENT_COUNT_ADJECTIVE_PATTERN}(?:complete|full|entire|whole)\\s+(?:${BACKSTAGE_BOOKING_CONTAINER_MODIFIER_PATTERN}\\s+){0,3}${BACKSTAGE_BOOKING_COMPONENT_COUNT_ADJECTIVE_PATTERN}(?:${BACKSTAGE_BOOKING_CONTAINER_MODIFIER_PATTERN}\\s+){0,3}(?:bookings?|cards?|shows?|events?|episodes?|ppvs?|ples?)\\b`,
  'giu'
);
const BACKSTAGE_BOOKING_COMPONENT_COUNT_PATTERN = new RegExp(
  `\\b(?:(?:up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\b(?:\\s*-\\s*|\\s+)(?:(?:short|detailed|opening|closing|major|minor|wrestling|booking|title|singles|tag[- ]team|main[- ]event|raw|smackdown|nxt)\\s+){0,4}${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}\\b(?!\\s+(?:alternatives?|bullets?|ideas?|items?|options?|scenarios?)\\b)`,
  'giu'
);
const BACKSTAGE_CONTAINER_COMPACT_OUTPUT_ANAPHORA_PATTERN = new RegExp(
  `\\b(?:provide|return|write)\\s+(?:it|the\\s+(?:answer|output|response))\\s+(?:in|as|using)\\s+(?:(?<qualifier>exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\b(?:\\s+(?:short|brief|concise|numbered|detailed)){0,3}\\s+(?:bullets?|items?|options?|alternatives?|scenarios?)\\b`,
  'giu'
);
const BACKSTAGE_CONTAINER_COMPACT_OUTPUT_SUFFIX_PATTERN = new RegExp(
  `\\b(?:(?:in|as|using|formatted\\s+as|keep\\s+(?:it|the\\s+(?:answer|output|response))\\s+to|limit\\s+(?:it|the\\s+(?:answer|output|response))\\s+to)\\s+(?:(?<qualifier>exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?|(?<standaloneQualifier>up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\b(?:\\s+(?:short|brief|concise|numbered|detailed)){0,3}\\s+(?:bullets?|items?|options?|alternatives?|scenarios?)\\b(?:\\s+(?<postQualifier>max(?:imum)?))?`,
  'giu'
);
const BACKSTAGE_COMPACT_OUTPUT_COUNT_REFERENCE_PATTERN = new RegExp(
  `\\b(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\b(?:\\s+(?:short|brief|concise|numbered|detailed)){0,3}\\s+(?:bullets?|items?|options?|alternatives?|scenarios?)\\b`,
  'giu'
);

export function parseBackstageDirectAnswerOutputContract(prompt: string): BackstageDirectAnswerOutputContract {
  const normalizedPrompt = prompt.trim();
  const embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(normalizedPrompt);
  const itemPolicy = resolveBackstageCompactRetryItemPolicy(
    normalizedPrompt,
    embeddedContentState
  );
  const requiresShortBullets = /\bshort\s+bullets?\b/iu.test(normalizedPrompt);

  if (itemPolicy.mode === 'exact' || itemPolicy.mode === 'atMost') {
    return {
      requestedBulletCount: itemPolicy.count,
      requestedBulletCountMode: itemPolicy.mode,
      requiresShortBullets,
    };
  }

  const explicitBulletMatches = Array.from(normalizedPrompt.matchAll(new RegExp(
    `\\b(?:(?<qualifier>up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\s+(?:short\\s+)?bullets?\\b`,
    'giu'
  ))).filter(match => {
    const matchIndex = match.index!;
    return !isBackstageCompactRetryDirectiveNegated(normalizedPrompt, matchIndex)
      && !isBackstageCompactRetryDirectiveEmbeddedContent(
        normalizedPrompt,
        matchIndex,
        embeddedContentState
      );
  });
  if (
    explicitBulletMatches.length === 1
    && !hasBackstageCompactRetryAmbiguousCountSyntax(
      normalizedPrompt,
      embeddedContentState
    )
  ) {
    const groups = explicitBulletMatches[0]!.groups as BackstageCompactRetryItemCountGroups & {
      qualifier?: string;
    };
    const requestedBulletCount = parseBackstageCompactRetryItemCountGroups(groups);
    if (requestedBulletCount !== null) {
      return {
        requestedBulletCount,
        requestedBulletCountMode: groups.qualifier ? 'atMost' : 'exact',
        requiresShortBullets,
      };
    }
  }

  if (itemPolicy.mode === 'preserve') {
    return {
      requestedBulletCount: itemPolicy.budgetItemCount,
      requestedBulletCountMode: 'preserve',
      requiresShortBullets,
    };
  }
  return { requiresShortBullets };
}

const BACKSTAGE_BOOKER_COMPACT_RETRY_DEFAULT_ITEM_LIMIT = 8;
const BACKSTAGE_BOOKER_COMPACT_RETRY_MAX_WORDS_PER_ITEM = 125;
const BACKSTAGE_BOOKER_COMPACT_RETRY_MAX_TOTAL_WORDS = 1_000;

interface BackstageCompactRetryDirectiveCount {
  count: number;
  mode: 'exact' | 'atMost';
  compactPresentation: boolean;
  negated: boolean;
  quoteAmbiguous: boolean;
}

interface BackstageCompactRetryCountLikeRequest {
  count: number;
  quoteAmbiguous: boolean;
}

interface BackstageAlternativeCardRequest {
  compactPresentation: boolean;
  containerRequest: boolean;
  count: number | null;
  mode: 'exact' | 'atMost';
}

interface BackstageCompactRetryItemReferenceSummary {
  topLevelCount: number;
  ambiguousCount: number;
}

export interface BackstageCompactOutputContract
  extends BackstageCompactRetryValidationContract {
  itemPolicy: BackstageCompactRetryItemPolicy;
  wordBounds: BackstageCompactOutputWordBounds;
  embeddedContentState: BackstageCompactRetryEmbeddedContentState;
  alternativeCardContainerRequest: boolean;
  completeBookingContainerComponentCount: boolean;
  explicitCompactOutputRequest: boolean;
}

/**
 * Identify a caller-owned top-level compact list without treating match,
 * segment, or other nested counts inside a complete booking container as the
 * returned list. An explicit compact shape attached to the container remains
 * authoritative. Only unambiguous give-me/us list-return directives activate
 * compact presentation here; book/create/generate counts retain booking
 * capacity unless a separate direct-answer cue applies.
 */
export function hasBackstageExplicitTopLevelCompactItemCount(
  prompt: string,
  contract: Pick<
    BackstageCompactOutputContract,
    | 'itemPolicy'
    | 'completeBookingContainerComponentCount'
    | 'explicitCompactOutputRequest'
  >
): boolean {
  if (
    contract.itemPolicy.mode !== 'exact'
    && contract.itemPolicy.mode !== 'atMost'
  ) {
    return false;
  }
  if (
    contract.completeBookingContainerComponentCount
    || contract.explicitCompactOutputRequest
  ) {
    return contract.explicitCompactOutputRequest;
  }

  const embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt);
  const compactPresentationDirectives = collectBackstageCompactRetryDirectiveCounts(
    prompt,
    embeddedContentState
  ).filter(directive =>
    directive.compactPresentation
    && !directive.negated
    && !directive.quoteAmbiguous
  );
  const directive = compactPresentationDirectives[0];
  return compactPresentationDirectives.length === 1
    && directive !== undefined
    && directive.count === contract.itemPolicy.count
    && directive.mode === contract.itemPolicy.mode;
}

export interface BackstageCompactRetryEmbeddedContentState {
  quotedDispositionByCodeUnit: BackstageCompactRetryQuotedDisposition[];
}

type BackstageCompactRetryQuotedDisposition = 'topLevel' | 'embedded' | 'ambiguous';
type BackstageSingleQuoteEvent = 'identity' | 'open' | 'close' | 'weakClose';

const BACKSTAGE_QUOTE_OUTSIDE_STATE = 1;
const BACKSTAGE_QUOTE_INSIDE_STATE = 2;

interface BackstageCompactRetryItemCountGroups extends Record<string, string | undefined> {
  digitCount?: string;
  wordCount?: string;
}

interface BackstageCompactRetryDirectiveGroups
  extends BackstageCompactRetryItemCountGroups {
  itemNoun?: string;
  modifiers?: string;
  qualifier?: string;
  recipient?: string;
  requestVerb?: string;
}

function parseBackstageCompactRetryItemCountGroups(
  groups: BackstageCompactRetryItemCountGroups
): number | null {
  const digitCount = groups.digitCount
    ? Number.parseInt(groups.digitCount, 10)
    : undefined;
  const wordCount = groups.wordCount
    ? NUMBER_WORDS.get(groups.wordCount.toLowerCase())
    : undefined;
  const itemCount = digitCount ?? wordCount;

  return itemCount !== undefined
    && Number.isSafeInteger(itemCount)
    && itemCount >= 1
    ? itemCount
    : null;
}

function isBackstageCompactRetryDirectiveNegated(
  prompt: string,
  matchIndex: number
): boolean {
  const precedingText = prompt.slice(Math.max(0, matchIndex - 160), matchIndex);
  const clauseStart = Math.max(
    precedingText.lastIndexOf('.'),
    precedingText.lastIndexOf('!'),
    precedingText.lastIndexOf('?'),
    precedingText.lastIndexOf(':'),
    precedingText.lastIndexOf(';'),
    precedingText.lastIndexOf('\n')
  );
  const clause = precedingText.slice(clauseStart + 1);
  let negationScope = clause;
  for (const boundary of clause.matchAll(/\b(?:but|however|instead|then)\b/giu)) {
    negationScope = clause.slice(boundary.index! + boundary[0].length);
  }
  return /\b(?:do\s+not|don['’]t|never|not|no|isn['’]t|aren['’]t|wasn['’]t|weren['’]t)(?:[\s,()\-]+[\p{L}'’]+){0,12}[\s,()\-]*$/iu.test(
    negationScope
  ) || /\b(?:without|avoid(?:ing)?)(?:[\s,()\-]+(?:using|applying|setting|imposing|requesting|asking|for|following|enforcing|a|an|the|any|this|that)){0,6}[\s,()\-]*$/iu.test(
    negationScope
  );
}

const BACKSTAGE_SINGLE_QUOTE_WEAK_SUFFIX_SEPARATOR_PATTERN = /[\s,]/u;

function buildBackstageNextSingleQuoteSignificantIndexes(characters: string[]): number[] {
  const indexes = Array<number>(characters.length).fill(-1);
  let nextIndex = -1;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    indexes[index] = nextIndex;
    if (!BACKSTAGE_SINGLE_QUOTE_WEAK_SUFFIX_SEPARATOR_PATTERN.test(characters[index]!)) {
      nextIndex = index;
    }
  }
  return indexes;
}

function classifyBackstageSingleQuoteEvent(
  characters: string[],
  index: number,
  openingQuote: "'" | '‘',
  closingQuote: "'" | '’',
  nextSignificantIndexes: number[]
): BackstageSingleQuoteEvent {
  const character = characters[index]!;
  if (openingQuote !== closingQuote && character === openingQuote) {
    return 'open';
  }
  if (character !== closingQuote) {
    return 'identity';
  }

  const precedingCharacter = characters[index - 1] ?? '';
  const followingCharacter = characters[index + 1] ?? '';
  const precededByWordCharacter = /[\p{L}\p{N}]/u.test(precedingCharacter);
  const followedByWordCharacter = /[\p{L}\p{N}]/u.test(followingCharacter);
  if (precededByWordCharacter && followedByWordCharacter) {
    return 'identity';
  }
  if (openingQuote === closingQuote && !precededByWordCharacter && followedByWordCharacter) {
    return 'open';
  }

  const nextSignificantIndex = nextSignificantIndexes[index]!;
  if (
    precedingCharacter.toLowerCase() === 's'
    && BACKSTAGE_SINGLE_QUOTE_WEAK_SUFFIX_SEPARATOR_PATTERN.test(followingCharacter)
    && nextSignificantIndex >= 0
    && /\p{L}/u.test(characters[nextSignificantIndex]!)
  ) {
    return 'weakClose';
  }
  return 'close';
}

function advanceBackstageSingleQuoteStates(
  states: number,
  event: BackstageSingleQuoteEvent
): number {
  if (event === 'identity') {
    return states;
  }
  if (event === 'open') {
    return states & BACKSTAGE_QUOTE_OUTSIDE_STATE
      ? BACKSTAGE_QUOTE_INSIDE_STATE
      : 0;
  }
  if (event === 'close') {
    return states & BACKSTAGE_QUOTE_INSIDE_STATE
      ? BACKSTAGE_QUOTE_OUTSIDE_STATE
      : 0;
  }

  let nextStates = 0;
  if (states & BACKSTAGE_QUOTE_OUTSIDE_STATE) {
    nextStates |= BACKSTAGE_QUOTE_OUTSIDE_STATE;
  }
  if (states & BACKSTAGE_QUOTE_INSIDE_STATE) {
    nextStates |= BACKSTAGE_QUOTE_OUTSIDE_STATE | BACKSTAGE_QUOTE_INSIDE_STATE;
  }
  return nextStates;
}

function rewindBackstageSingleQuoteStates(
  reachableAfter: number,
  event: BackstageSingleQuoteEvent
): number {
  if (event === 'identity') {
    return reachableAfter;
  }
  if (event === 'open') {
    return reachableAfter & BACKSTAGE_QUOTE_INSIDE_STATE
      ? BACKSTAGE_QUOTE_OUTSIDE_STATE
      : 0;
  }
  if (event === 'close') {
    return reachableAfter & BACKSTAGE_QUOTE_OUTSIDE_STATE
      ? BACKSTAGE_QUOTE_INSIDE_STATE
      : 0;
  }

  let precedingStates = 0;
  if (reachableAfter & BACKSTAGE_QUOTE_OUTSIDE_STATE) {
    precedingStates |= BACKSTAGE_QUOTE_OUTSIDE_STATE | BACKSTAGE_QUOTE_INSIDE_STATE;
  }
  if (reachableAfter & BACKSTAGE_QUOTE_INSIDE_STATE) {
    precedingStates |= BACKSTAGE_QUOTE_INSIDE_STATE;
  }
  return precedingStates;
}

function buildBackstageQuoteDispositionByCodeUnit(
  text: string,
  characters: string[],
  events: BackstageSingleQuoteEvent[]
): BackstageCompactRetryQuotedDisposition[] {
  const forwardStates = Array<number>(characters.length + 1).fill(0);
  const backwardStates = Array<number>(characters.length + 1).fill(0);
  forwardStates[0] = BACKSTAGE_QUOTE_OUTSIDE_STATE;
  for (let index = 0; index < characters.length; index += 1) {
    forwardStates[index + 1] = advanceBackstageSingleQuoteStates(
      forwardStates[index]!,
      events[index]!
    );
  }
  backwardStates[characters.length] = BACKSTAGE_QUOTE_OUTSIDE_STATE;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    backwardStates[index] = rewindBackstageSingleQuoteStates(
      backwardStates[index + 1]!,
      events[index]!
    );
  }

  const dispositionByCodeUnit = Array<BackstageCompactRetryQuotedDisposition>(
    text.length + 1
  ).fill('topLevel');
  let codeUnitIndex = 0;

  for (let index = 0; index <= characters.length; index += 1) {
    const possibleStates = forwardStates[index]! & backwardStates[index]!;
    const disposition: BackstageCompactRetryQuotedDisposition =
      possibleStates === BACKSTAGE_QUOTE_INSIDE_STATE
        ? 'embedded'
        : possibleStates === BACKSTAGE_QUOTE_OUTSIDE_STATE
          ? 'topLevel'
          : 'ambiguous';
    if (index === characters.length) {
      dispositionByCodeUnit[text.length] = disposition;
      break;
    }
    const character = characters[index]!;
    for (let offset = 0; offset < character.length; offset += 1) {
      dispositionByCodeUnit[codeUnitIndex + offset] = disposition;
    }
    codeUnitIndex += character.length;
  }

  return dispositionByCodeUnit;
}

function buildBackstageSingleQuoteDispositionByCodeUnit(
  text: string,
  openingQuote: "'" | '‘',
  closingQuote: "'" | '’'
): BackstageCompactRetryQuotedDisposition[] {
  const characters = Array.from(text);
  const nextSignificantIndexes = buildBackstageNextSingleQuoteSignificantIndexes(characters);
  const events = characters.map((_, index) => classifyBackstageSingleQuoteEvent(
    characters,
    index,
    openingQuote,
    closingQuote,
    nextSignificantIndexes
  ));
  return buildBackstageQuoteDispositionByCodeUnit(text, characters, events);
}

function countBackstagePrecedingBackslashes(characters: string[], index: number): number {
  let precedingBackslashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && characters[cursor] === '\\';
    cursor -= 1
  ) {
    precedingBackslashCount += 1;
  }
  return precedingBackslashCount;
}

function isBackstageDoubleQuoteMeasurementMark(
  characters: string[],
  index: number,
  precedingCharacterIndex = index - 1
): boolean {
  const precedingCharacter = characters[precedingCharacterIndex] ?? '';
  const followingCharacter = characters[index + 1];
  return /\d/u.test(precedingCharacter)
    && (
      followingCharacter === undefined
      || /[\d\s.,;:!?)/\]{}\-–—]/u.test(followingCharacter)
    );
}

function buildBackstageDoubleQuoteDispositionByCodeUnit(
  text: string,
  quoteKind: 'straight' | 'escaped' | 'curly'
): BackstageCompactRetryQuotedDisposition[] {
  const characters = Array.from(text);
  const events = characters.map((character, index): BackstageSingleQuoteEvent => {
    if (quoteKind === 'curly') {
      if (character === '“') {
        return 'open';
      }
      if (character !== '”') {
        return 'identity';
      }
      return isBackstageDoubleQuoteMeasurementMark(characters, index)
        ? 'weakClose'
        : 'close';
    }
    if (character !== '"') {
      return 'identity';
    }

    const precedingBackslashCount = countBackstagePrecedingBackslashes(characters, index);
    const escapedQuote = precedingBackslashCount % 2 === 1;
    if ((quoteKind === 'escaped') !== escapedQuote) {
      return 'identity';
    }
    const precedingCharacterIndex = index - precedingBackslashCount - 1;
    if (isBackstageDoubleQuoteMeasurementMark(
      characters,
      index,
      precedingCharacterIndex
    )) {
      return 'weakClose';
    }
    const precededByWordCharacter = /[\p{L}\p{N}]/u.test(
      characters[precedingCharacterIndex] ?? ''
    );
    const followedByWordCharacter = /[\p{L}\p{N}]/u.test(characters[index + 1] ?? '');
    return !precededByWordCharacter && followedByWordCharacter ? 'open' : 'close';
  });
  return buildBackstageQuoteDispositionByCodeUnit(text, characters, events);
}

function buildBackstageCompactRetryEmbeddedContentState(
  prompt: string
): BackstageCompactRetryEmbeddedContentState {
  const straightSingleDisposition = buildBackstageSingleQuoteDispositionByCodeUnit(
    prompt,
    "'",
    "'"
  );
  const curlySingleDisposition = buildBackstageSingleQuoteDispositionByCodeUnit(
    prompt,
    '‘',
    '’'
  );
  const straightDoubleDisposition = buildBackstageDoubleQuoteDispositionByCodeUnit(
    prompt,
    'straight'
  );
  const escapedDoubleDisposition = buildBackstageDoubleQuoteDispositionByCodeUnit(
    prompt,
    'escaped'
  );
  const curlyDoubleDisposition = buildBackstageDoubleQuoteDispositionByCodeUnit(
    prompt,
    'curly'
  );
  const quotedDispositionByCodeUnit = Array<BackstageCompactRetryQuotedDisposition>(
    prompt.length + 1
  ).fill('topLevel');

  for (let index = 0; index <= prompt.length; index += 1) {
    const dispositions = [
      straightSingleDisposition[index],
      curlySingleDisposition[index],
      straightDoubleDisposition[index],
      escapedDoubleDisposition[index],
      curlyDoubleDisposition[index],
    ];
    quotedDispositionByCodeUnit[index] = dispositions.includes('embedded')
      ? 'embedded'
      : dispositions.includes('ambiguous')
        ? 'ambiguous'
        : 'topLevel';
  }

  return { quotedDispositionByCodeUnit };
}

function isBackstageCompactRetryDirectiveEmbeddedContent(
  prompt: string,
  matchIndex: number,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): boolean {
  if (embeddedContentState.quotedDispositionByCodeUnit[matchIndex] !== 'topLevel') {
    return true;
  }

  return isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex);
}

function isBackstageCompactRetryDirectiveCreativeContent(
  prompt: string,
  matchIndex: number
): boolean {
  const precedingText = prompt.slice(Math.max(0, matchIndex - 180), matchIndex);
  const clauseStart = Math.max(
    precedingText.lastIndexOf('.'),
    precedingText.lastIndexOf('!'),
    precedingText.lastIndexOf('?'),
    precedingText.lastIndexOf('\n')
  );
  const clause = precedingText.slice(clauseStart + 1).slice(-180);
  return /\b(?:promo|dialogue|speech|script|segment|scene|story|angle)\b[^.!?\n]{0,120}\b(?:where|that|in\s+which|says?|said|asks?|asked|telling|told)\b[^.!?\n]{0,64}$/iu.test(
    clause
  );
}

function isBackstageTopLevelOutputRequestMatch(
  prompt: string,
  matchIndex: number,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): boolean {
  const directiveNegated = isBackstageCompactRetryDirectiveNegated(
    prompt,
    matchIndex
  );
  const boundedComponentQualifier = new RegExp(
    `\\b(?:featuring|with)\\s+no\\s+more\\s+than\\s+(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\b(?:\\s+(?:short|detailed|opening|closing|major|minor|wrestling|booking|title|singles|tag[- ]team|main[- ]event|raw|smackdown|nxt)){0,4}\\s+${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}\\b\\s*$`,
    'iu'
  ).test(prompt.slice(Math.max(0, matchIndex - 180), matchIndex));
  return embeddedContentState.quotedDispositionByCodeUnit[matchIndex] === 'topLevel'
    && !isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
    && (!directiveNegated || boundedComponentQualifier);
}

function isBackstageCompleteBookingContainerDirectiveMatch(
  prompt: string,
  match: RegExpMatchArray,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): boolean {
  const matchIndex = match.index!;
  if (!isBackstageTopLevelOutputRequestMatch(
    prompt,
    matchIndex,
    embeddedContentState
  )) {
    return false;
  }

  const precedingText = prompt.slice(Math.max(0, matchIndex - 180), matchIndex);
  const clauseStart = Math.max(
    precedingText.lastIndexOf('.'),
    precedingText.lastIndexOf('!'),
    precedingText.lastIndexOf('?'),
    precedingText.lastIndexOf('\n'),
    precedingText.lastIndexOf(','),
    precedingText.lastIndexOf(';'),
    precedingText.lastIndexOf(':')
  );
  if (
    clauseStart >= 0
    && /[,;:]/u.test(precedingText[clauseStart]!)
    && /\b(?:according\s+to|asks?|asked|context|don['’]t|examples?|ignore|never|not|quote|says?|said|tells?|told|(?:instructions?|request)\s+(?:from|says?))\b[^.!?\n]{0,120}[,;:]\s*$/iu.test(
      precedingText.slice(0, clauseStart + 1)
    )
  ) {
    return false;
  }
  const directivePrefix = precedingText.slice(clauseStart + 1).trim();
  return directivePrefix.length === 0
    || /^(?:(?:and|but)\s+)?(?:(?:also|first|next|now|then)(?:\s+(?:kindly|please))?|(?:kindly|please))?$/iu.test(
      directivePrefix
    )
    || /^(?:can|could|would|will)\s+you(?:\s+(?:kindly|please))?(?:\s+go\s+ahead\s+and)?$/iu.test(
      directivePrefix
    )
    || /^(?:go\s+ahead\s+and|let(?:['’]s|\s+us)|you\s+(?:can|could|must|should))$/iu.test(
      directivePrefix
    )
    || /^(?:i|we)(?:\s+(?:also|just|really))?$/iu.test(directivePrefix)
    || /^(?:i|we)\s+(?:(?:also|just|really)\s+)?(?:need|want)(?:\s+you)?\s+to$/iu.test(
      directivePrefix
    )
    || /^(?:i|we)(?:['’]d|\s+would)\s+like\s+you\s+to$/iu.test(
      directivePrefix
    )
    || /^(?:answer|respond)\s+(?:briefly|concisely|directly)(?:\s+and)?$/iu.test(
      directivePrefix
    );
}

function isBackstageTerminalCompactOutputAttachment(
  scope: string,
  match: RegExpMatchArray
): boolean {
  const trailingText = scope.slice(match.index! + match[0].length);
  const normalizedTail = trailingText
    .replace(/^[\s,;:\-–—]+/u, '')
    .trim();
  if (normalizedTail.length === 0 || /^please$/iu.test(normalizedTail)) {
    return true;
  }

  return new RegExp(
    `^(?:total|(?:and\\s+)?(?:be|keep\\s+(?:it|the\\s+(?:answer|output|response)))\\s+(?:brief|concise)|(?:and\\s+)?(?:use\\s+)?no\\s+(?:headings?|sub[- ]bullets?|table)|each\\s+(?:containing|covering|including|with)\\s+(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\s+${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}(?:\\s+and\\s+(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\s+${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}){0,3}|(?:one|1)\\s+per\\s+(?:item|section))$`,
    'iu'
  ).test(normalizedTail);
}

function isBackstageComponentScopedCompactOutputAttachment(prefix: string): boolean {
  return new RegExp(
    `(?:\\bwhere\\b[^,;:.!?\\n]{0,120}\\b${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}\\b|\\bwith\\s+(?!(?:(?:at\\s+most|exactly|no\\s+more\\s+than|only|up\\s+to)\\s+)?(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\b)[^,;:.!?\\n]{0,80}\\b${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}\\b|\\b(?:a|an|my|our|that|the|this)\\s+(?:(?:closing|main[- ]event|opening|title)\\s+){0,3}${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}\\b|\\b(?:branches?|ending|plays?\\s+out|resolves?|unfold(?:ed|ing|s)?)\\b)[^,;:.!?\\n]{0,100}$`,
    'iu'
  ).test(prefix);
}

function resolveBackstageExplicitCompactOutputItemPolicy(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): Extract<BackstageCompactRetryItemPolicy, { mode: 'exact' | 'atMost' }> | null {
  const validContainers = Array.from(prompt.matchAll(
    BACKSTAGE_COMPLETE_BOOKING_CONTAINER_DIRECTIVE_PATTERN
  )).filter(match => isBackstageCompleteBookingContainerDirectiveMatch(
    prompt,
    match,
    embeddedContentState
  ));
  if (validContainers.length === 0) {
    return null;
  }
  const firstContainerIndex = validContainers[0]!.index!;
  const presentationScope = prompt.slice(firstContainerIndex, firstContainerIndex + 1_000);
  const presentationReferences = Array.from(presentationScope.matchAll(
    BACKSTAGE_COMPACT_OUTPUT_COUNT_REFERENCE_PATTERN
  )).filter(match => isBackstageTopLevelOutputRequestMatch(
    prompt,
    firstContainerIndex + match.index!,
    embeddedContentState
  ));
  const hasPresentationCorrection = Array.from(presentationScope.matchAll(new RegExp(
    `\\b(?:actually|instead|rather|correction|make\\s+that|change\\s+(?:it|that)\\s+to)\\b[^.!?\\n]{0,48}\\b(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\b`,
    'giu'
  ))).some(match => isBackstageTopLevelOutputRequestMatch(
    prompt,
    firstContainerIndex + match.index!,
    embeddedContentState
  ));
  if (presentationReferences.length > 1 || hasPresentationCorrection) {
    return null;
  }
  const candidates = new Map<number, Extract<
    BackstageCompactRetryItemPolicy,
    { mode: 'exact' | 'atMost' }
  >>();
  const addCandidate = (match: RegExpMatchArray, offset = 0): void => {
    const matchIndex = offset + match.index!;
    if (
      !isBackstageTopLevelOutputRequestMatch(
        prompt,
        matchIndex,
        embeddedContentState
      )
    ) {
      return;
    }
    const groups = match.groups as BackstageCompactRetryItemCountGroups & {
      qualifier?: string;
      postQualifier?: string;
      standaloneQualifier?: string;
    };
    const count = parseBackstageCompactRetryItemCountGroups(groups);
    if (count === null) {
      return;
    }
    const qualifier = (
      groups.qualifier
      ?? groups.postQualifier
      ?? groups.standaloneQualifier
      ?? ''
    ).toLowerCase();
    candidates.set(matchIndex, {
      mode: /^(?:up\s+to|at\s+most|no\s+more\s+than|max(?:imum)?)$/u.test(qualifier)
        ? 'atMost'
        : 'exact',
      count,
      budgetItemCount: count,
    });
  };
  const addAttachedCandidates = (
    scope: string,
    offset: number,
    requireLeadingRelation: boolean
  ): void => {
    for (const pattern of [
      BACKSTAGE_CONTAINER_COMPACT_OUTPUT_SUFFIX_PATTERN,
      BACKSTAGE_CONTAINER_COMPACT_OUTPUT_ANAPHORA_PATTERN,
    ]) {
      for (const match of scope.matchAll(pattern)) {
        const prefix = scope.slice(0, match.index!);
        const isAnaphora = pattern === BACKSTAGE_CONTAINER_COMPACT_OUTPUT_ANAPHORA_PATTERN;
        const leadingRelation = /^[\s,;:!?\.\-–—]*(?:(?:and\s+)?then[\s,;:!?\.\-–—]*)?$/iu.test(
          prefix
        );
        const competingDirective = new RegExp(
          `\\b(?:${BACKSTAGE_DIRECT_GENERATION_VERB_PATTERN}|work)\\b`,
          'iu'
        ).test(prefix);
        if (
          (requireLeadingRelation && !leadingRelation)
          || (!requireLeadingRelation && competingDirective)
          || (!isAnaphora && !isBackstageTerminalCompactOutputAttachment(scope, match))
          || (!isAnaphora && isBackstageComponentScopedCompactOutputAttachment(prefix))
        ) {
          continue;
        }
        addCandidate(match, offset);
      }
    }
  };

  for (const containerMatch of validContainers) {
    const suffixScopeStart = containerMatch.index! + containerMatch[0].length;
    const suffixScope = prompt.slice(suffixScopeStart, suffixScopeStart + 500);
    const firstBoundaryIndex = suffixScope.search(/[.!?\n]/u);
    const attachedScopeEnd = firstBoundaryIndex < 0
      ? suffixScope.length
      : firstBoundaryIndex;
    addAttachedCandidates(
      suffixScope.slice(0, attachedScopeEnd),
      suffixScopeStart,
      false
    );
    if (firstBoundaryIndex >= 0) {
      const followingClauseStart = firstBoundaryIndex + 1;
      const followingText = suffixScope.slice(followingClauseStart);
      const followingBoundaryIndex = followingText.search(/[.!?\n]/u);
      const followingClause = followingText.slice(
        0,
        followingBoundaryIndex < 0 ? followingText.length : followingBoundaryIndex
      );
      addAttachedCandidates(
        followingClause,
        suffixScopeStart + followingClauseStart,
        true
      );
    }
  }

  const policies = Array.from(candidates.values());
  const policy = policies[0];
  return policy
    && policies.every(candidate =>
      candidate.mode === policy.mode && candidate.count === policy.count
    )
    ? policy
    : null;
}

/**
 * Detect a direct request for a complete booking container with nested component
 * counts. Those counts describe the contents of the card; they must not demote
 * the whole container to compact-list capacity.
 */
export function hasBackstageCompleteBookingContainerComponentCountRequest(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): boolean {
  const normalizedPrompt = prompt;
  if (
    normalizedPrompt.trim().length === 0
    || shouldUseBoundedBackstageReviewMode(normalizedPrompt)
  ) {
    return false;
  }

  for (const containerMatch of normalizedPrompt.matchAll(
    BACKSTAGE_COMPLETE_BOOKING_CONTAINER_DIRECTIVE_PATTERN
  )) {
    if (!isBackstageCompleteBookingContainerDirectiveMatch(
      normalizedPrompt,
      containerMatch,
      embeddedContentState
    )) {
      continue;
    }
    const containerIndex = containerMatch.index!;
    const componentScopeStart = containerIndex;
    const componentScope = normalizedPrompt.slice(
      componentScopeStart,
      componentScopeStart + 500
    );
    for (const componentMatch of componentScope.matchAll(
      BACKSTAGE_BOOKING_COMPONENT_COUNT_PATTERN
    )) {
      const componentIndex = componentScopeStart + componentMatch.index!;
      if (isBackstageTopLevelOutputRequestMatch(
        normalizedPrompt,
        componentIndex,
        embeddedContentState
      )) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Preserve explicit compact presentation independently of capacity promotion.
 * These nouns describe the returned list itself rather than card components.
 */
export function hasBackstageExplicitCompactOutputRequest(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): boolean {
  const normalizedPrompt = prompt;
  if (
    normalizedPrompt.trim().length === 0
    || shouldUseBoundedBackstageReviewMode(normalizedPrompt)
  ) {
    return false;
  }

  const alternativeCardRequests = collectBackstageAlternativeCardRequests(
    normalizedPrompt,
    embeddedContentState
  );
  if (alternativeCardRequests.some(request => request.containerRequest)) {
    return false;
  }

  return alternativeCardRequests.some(request => request.compactPresentation)
    || resolveBackstageExplicitCompactOutputItemPolicy(
    normalizedPrompt,
    embeddedContentState
  ) !== null;
}

function isBackstageCompactRetryDirectiveDiscardedContext(
  prompt: string,
  matchIndex: number
): boolean {
  const precedingText = prompt.slice(Math.max(0, matchIndex - 220), matchIndex);
  const clauseStart = Math.max(
    precedingText.lastIndexOf('.'),
    precedingText.lastIndexOf('!'),
    precedingText.lastIndexOf('?'),
    precedingText.lastIndexOf(';'),
    precedingText.lastIndexOf('\n')
  );
  const clause = precedingText.slice(clauseStart + 1);
  let discardScope = clause;
  for (const boundary of clause.matchAll(/\b(?:but|however|instead|then)\b/giu)) {
    discardScope = clause.slice(boundary.index! + boundary[0].length);
  }
  return /\b(?:disregard|ignore)\b[^.!?;\n]{0,128}\b(?:instructions?|requests?)\b[^.!?;\n]{0,96}$/iu.test(
    discardScope
  );
}

function collectBackstageCompactRetryDirectiveCounts(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): BackstageCompactRetryDirectiveCount[] {
  const matches = prompt.matchAll(new RegExp(
    BACKSTAGE_BOOKER_COMPACT_RETRY_DIRECTIVE_PATTERN_SOURCE,
    'giu'
  ));
  const directiveCounts: BackstageCompactRetryDirectiveCount[] = [];

  for (const match of matches) {
    const groups = match.groups as BackstageCompactRetryDirectiveGroups;
    const matchIndex = match.index!;
    const count = parseBackstageCompactRetryItemCountGroups(groups);
    const quoteDisposition = embeddedContentState.quotedDispositionByCodeUnit[matchIndex];
    if (
      count === null
      || isBackstageCompactRetryDirectiveDiscardedContext(prompt, matchIndex)
      || quoteDisposition === 'embedded'
      || isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
    ) {
      continue;
    }

    const alternativeCardRequest = /^alternative\s+cards?$/iu.test(
      groups.itemNoun ?? ''
    );
    const explicitAlternativeCardCompactIntent =
      /\b(?:brief|compact|concise|short)\b/iu.test(groups.modifiers ?? '');
    // A card is a booking container, not a compact list item. Preserve its
    // count unless the caller explicitly asks for a compact presentation.
    if (alternativeCardRequest && !explicitAlternativeCardCompactIntent) {
      continue;
    }

    const qualifier = groups.qualifier?.toLowerCase() ?? '';
    directiveCounts.push({
      count,
      mode: /^(?:up\s+to|at\s+most|no\s+more\s+than)$/u.test(qualifier)
        ? 'atMost'
        : 'exact',
      compactPresentation:
        groups.requestVerb?.toLowerCase() === 'give'
        && /^(?:me|us)$/u.test(groups.recipient?.toLowerCase() ?? ''),
      negated: isBackstageCompactRetryDirectiveNegated(
        prompt,
        matchIndex
      ),
      quoteAmbiguous: quoteDisposition === 'ambiguous',
    });
  }

  return directiveCounts;
}

function collectBackstageAlternativeCardRequests(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): BackstageAlternativeCardRequest[] {
  const requests: BackstageAlternativeCardRequest[] = [];
  const generationVerbPattern = '(?:assemble|book|brainstorm|build|come\\s+up\\s+with|compose|construct|craft|create|deliver|design|develop|devise|draft|draw\\s+up|flesh\\s+out|formulate|frame|generate|give|invent|lay\\s+out|list|make|map|need|offer|outline|pitch|plan|prepare|present|produce|provide|propose|put\\s+together|recommend|return|rewrite|schedule|show|sketch|suggest|want|work\\s+up|write)';
  const alternativeCardComponentNounPattern = `(?:${BACKSTAGE_BOOKING_COMPONENT_NOUN_PATTERN}|consequences?|fights?|lineups?|main[- ]events?|stories|storylines?|themes?|undercards?)`;
  const bookingGenerationParticiplePattern = '(?:assembled|booked|brainstormed|built|composed|constructed|crafted|created|delivered|described|designed|developed|devised|drafted|drawn\\s+up|fleshed\\s+out|formulated|framed|generated|invented|laid\\s+out|listed|made|mapped|offered|outlined|pitched|planned|prepared|presented|produced|provided|proposed|put\\s+together|recommended|returned|rewritten|scheduled|shown|sketched|suggested|worked\\s+up|written)';
  const alternativeCardDozenMultiplierPattern =
    '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const alternativeCardQuantityLeadPattern =
    `(?:a\\s+(?:(?:couple|pair|trio)\\s+of|dozen)|another|both|half\\s+a\\s+dozen|${alternativeCardDozenMultiplierPattern}\\s+dozen|several|some)`;
  for (const nounMatch of prompt.matchAll(/\balternative\s+cards?\b/giu)) {
    const nounIndex = nounMatch.index!;
    const suffixStart = nounIndex + nounMatch[0].length;
    const rawSuffix = prompt.slice(suffixStart, suffixStart + 480);
    const recoveryTargetPattern = `(?:it|that|them|these|this|those|each(?:\\s+one)?|every\\s+one|all(?:\\s+of)?\\s+them|all\\s+(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})|(?:each|every)\\s+(?:alternative\\s+)?card|(?:the\\s+)?(?:whole\\s+)?(?:set|trio)|(?:the\\s+)?(?:(?:actual|complete|full)\\s+)?(?:bookings?|cards?))`;
    const recoveryGenerationVerbPattern = '(?:assemble|book|brainstorm|build|compose|construct|craft|create|deliver|design|develop|devise|draft|draw|expand|flesh|formulate|frame|generate|give|invent|make|map|plan|prepare|produce|put|rewrite|schedule|turn|work|write)';
    const hasPositiveAnaphoricRecovery = rawSuffix
      .split(/[;.!?\n]/u)
      .some(clause => new RegExp(
        `^[\\s,:;\\-–—]*(?:(?:but|instead|rather)\\b[\\s,]*)?(?:(?:kindly|please)\\s+)?(?:[\\p{L}'’]+ly\\s+){0,3}${recoveryGenerationVerbPattern}\\b[^;.!?\\n]{0,64}\\b${recoveryTargetPattern}\\b`,
        'iu'
      ).test(clause))
      || new RegExp(
        `\\b(?:but|however|instead|rather)\\b[\\s,:;\\-–—]*(?:(?:kindly|please)\\s+)?(?:[\\p{L}'’]+ly\\s+){0,3}${recoveryGenerationVerbPattern}\\b[^;.!?\\n]{0,64}\\b${recoveryTargetPattern}\\b`,
        'iu'
      ).test(rawSuffix);
    if (
      embeddedContentState.quotedDispositionByCodeUnit[nounIndex] !== 'topLevel'
      || isBackstageCompactRetryDirectiveCreativeContent(prompt, nounIndex)
      || isBackstageCompactRetryDirectiveDiscardedContext(prompt, nounIndex)
      || (
        isBackstageCompactRetryDirectiveNegated(prompt, nounIndex)
        && !hasPositiveAnaphoricRecovery
      )
    ) {
      continue;
    }

    const rawPrefix = prompt.slice(Math.max(0, nounIndex - 240), nounIndex);
    const prefixBoundary = Math.max(
      rawPrefix.lastIndexOf('.'),
      rawPrefix.lastIndexOf('!'),
      rawPrefix.lastIndexOf('?'),
      rawPrefix.lastIndexOf('\n'),
      rawPrefix.lastIndexOf(';'),
      rawPrefix.lastIndexOf(':')
    );
    const bodyBeforeNoun = rawPrefix.slice(prefixBoundary + 1);
    const boundaryCharacter = prefixBoundary >= 0
      ? rawPrefix[prefixBoundary]
      : undefined;
    const contextualLeadIn = prefixBoundary >= 0
      ? rawPrefix.slice(0, prefixBoundary + 1)
      : '';
    if (
      boundaryCharacter
      && /[,;:]/u.test(boundaryCharacter)
      && /\b(?:according\s+to|asks?|asked|context|examples?|ignore|quote|says?|said|tells?|told|(?:instructions?|request)\s+(?:from|says?))\b[^.!?\n]{0,120}[,;:]\s*$/iu.test(
        contextualLeadIn
      )
    ) {
      continue;
    }
    if (
      /\bwithout(?:\s+(?:also|directly|first|initially))?\s+(?:booking|building|creating|describing|drafting|generating|giving|listing|offering|outlining|presenting|producing|providing|showing|writing)\s+(?:(?:me|us)\s+)?$/iu.test(
        bodyBeforeNoun
      )
      || /\bavoid(?:ing)?\s+(?:booking|building|creating|describing|drafting|generating|giving|listing|offering|outlining|presenting|producing|providing|showing|writing)\s+(?:(?:me|us)\s+)?$/iu.test(
        bodyBeforeNoun
      )
    ) {
      continue;
    }

    const suffixBoundary = rawSuffix.search(/[.!?\n]/u);
    const clauseSuffix = rawSuffix.slice(
      0,
      suffixBoundary < 0 ? rawSuffix.length : suffixBoundary
    );
    const followingText = suffixBoundary < 0
      ? ''
      : rawSuffix.slice(suffixBoundary + 1);
    const followingClauses = followingText
      .split(/[.!?\n]/u)
      .map(clause => clause.trim())
      .filter(clause => clause.length > 0);
    const anaphoricFollowingClauses = followingClauses.filter(clause => (
      /^\s*(?:all(?:\s+of\s+them)?|each|every|for\s+(?:each|every)|it\b|that\b|the\s+cards?|them\b|these\b|they\b|this\b|those\b)/iu.test(clause)
      || /\b(?:all\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:\s+(?:alternative\s+)?cards?)?)?|apiece|each|every|in\s+(?:all|each|every)\s+(?:alternative\s+)?cards?|on\s+(?:each|every)\s+(?:alternative\s+)?card|per\s+(?:alternative\s+)?card)\b/iu.test(
        clause
      )
    ));
    const compactFollowingClauses = followingClauses.filter(clause =>
      /^\s*(?:(?:return|write)\s+(?:them|the\s+(?:answer|cards?|output|response))|(?:keep|make)\s+(?:each|them|the\s+cards?|the\s+(?:answer|output|response)))\b/iu.test(
        clause
      )
    );
    const compactClauseScope = [clauseSuffix, ...compactFollowingClauses].join(' ');
    const requestClause = [
      bodyBeforeNoun,
      nounMatch[0],
      clauseSuffix,
      ...anaphoricFollowingClauses,
    ].join(' ');
    const hasContainerDetail = /\b(?:complete|comprehensive|detailed|entire|full|fully[- ]developed|whole)\b/iu.test(
      requestClause
    ) || /\bfully\s+(?:book|build|create|develop|draft|flesh\s+out|write)\b/iu.test(
      requestClause
    );
    const nestedCardScope = [clauseSuffix, ...anaphoricFollowingClauses].join('. ');
    const hasPositiveScopedBookingComponent = Array.from(
      nestedCardScope.matchAll(new RegExp(
        `\\b${alternativeCardComponentNounPattern}\\b`,
        'giu'
      ))
    ).some(match => {
      const matchIndex = match.index!;
      const localPrefix = nestedCardScope.slice(
        Math.max(0, matchIndex - 96),
        matchIndex
      );
      const localSuffix = nestedCardScope.slice(
        matchIndex + match[0].length,
        matchIndex + match[0].length + 64
      );
      const positiveBoundaryMatches = Array.from(localPrefix.matchAll(
        /\b(?:but|however|instead|rather)\b/giu
      ));
      const positiveBoundary = positiveBoundaryMatches.at(-1);
      const componentPrefix = positiveBoundary
        ? localPrefix.slice(positiveBoundary.index! + positiveBoundary[0].length)
        : localPrefix;
      const negatedComponent = /\b(?:avoid(?:ing)?|do\s+not|don['’]t|exclude(?:d|s|ing)?|must\s+not|never|no|not|omit(?:ted|s|ting)?|without|zero)\b[^;.!?\n]{0,80}$/iu.test(
        componentPrefix
      );
      const definedComponent = /\b(?:define|definition\s+of|explain\s+(?:to\s+(?:me|us)\s+)?what|meaning\s+of|tell\s+(?:me|us)\s+what|whether)\b[^;.!?\n]{0,72}$/iu.test(
        componentPrefix
      );
      const negativelyQualifiedAfter = /^\s*(?:[- ]free\b|(?:are|is|was|were)\s+(?:excluded|not\s+(?:included|required|wanted)|omitted|optional|unnecessary)\b)/iu.test(
        localSuffix
      );
      return !negatedComponent && !definedComponent && !negativelyQualifiedAfter;
    });
    const hasNestedCardStructure = hasPositiveScopedBookingComponent
      || /\bfully\s+(?:book|build|create|develop|draft|flesh\s+out|write)\s+(?:each(?:\s+one)?|it|them|the\s+cards?)\b/iu.test(
        requestClause
      );
    const hasCompactModifier = /\b(?:brief|compact|concise|short)\b(?:\s+[\p{L}\p{N}'’]+(?:-[\p{L}\p{N}'’]+)?){0,3}\s*$/iu.test(
      bodyBeforeNoun
    );
    const countedCompactSuffixMatch = new RegExp(
      `\\b(?:as|formatted\\s+as|in|using)\\s+(?:(?<qualifier>up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\s+(?:(?:brief|compact|concise|numbered|short|top[- ]level)\\s+){0,3}(?:bullets?|items?|paragraphs?|summaries?)\\b`,
      'iu'
    ).exec(compactClauseScope);
    const hasCompactSuffix = countedCompactSuffixMatch !== null
      || /\b(?:as|formatted\s+as|in|using)\s+(?:brief|compact|concise|short)(?:\s+(?:numbered|top[- ]level)){0,2}\s+(?:bullets?|items?|paragraphs?|summaries?)\b/iu.test(
        compactClauseScope
      )
      || /\b(?:keep|make)\s+(?:each|them|the\s+cards?|the\s+(?:answer|output|response))\s+(?:brief|compact|concise|short)\b/iu.test(
        compactClauseScope
      )
      || /\beach\s+(?:one\s+)?(?:brief|compact|concise|short)\b/iu.test(
        compactClauseScope
      );
    const hasCompactNegation = /\b(?:do\s+not|don['’]t|never|not|without)\b[^.!?\n]{0,64}\b(?:brief|compact|concise|short)\b/iu.test(
      [clauseSuffix, ...followingClauses].join(' ')
    );

    const countMatches = Array.from(bodyBeforeNoun.matchAll(new RegExp(
      `\\b(?:(?<qualifier>exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\b`,
      'giu'
    )));
    const countMatch = countMatches[countMatches.length - 1];
    const compoundDozenMatch = new RegExp(
      `\\b(?:(?<digitCount>\\d+)|(?<wordCount>one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\\s+dozen\\s*$`,
      'iu'
    ).exec(bodyBeforeNoun);
    const compoundDozenMultiplier = compoundDozenMatch
      ? parseBackstageCompactRetryItemCountGroups(
          compoundDozenMatch.groups as BackstageCompactRetryItemCountGroups
        )
      : null;
    const compoundQuantityCount = /\bhalf\s+a\s+dozen\s*$/iu.test(bodyBeforeNoun)
      ? 6
      : /\ba\s+trio\s+of\s*$/iu.test(bodyBeforeNoun)
        ? 3
        : /\b(?:a\s+(?:couple|pair)\s+of|both)\s*$/iu.test(bodyBeforeNoun)
          ? 2
          : /\banother\s*$/iu.test(bodyBeforeNoun)
            ? 1
            : compoundDozenMultiplier === null
              ? null
              : compoundDozenMultiplier * 12;
    const hasQuantityLead = new RegExp(
      `\\b${alternativeCardQuantityLeadPattern}\\s*$`,
      'iu'
    ).test(bodyBeforeNoun);
    const postNounRequestMatch = new RegExp(
      `^[\\s,:;\\-–—]*(?:(?:can|could|would|will)\\s+you\\s+)?(?:(?:kindly|please)\\s+)?${generationVerbPattern}(?:\\s+(?:me|us))?\\s+(?:(?<qualifier>exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\b`,
      'iu'
    ).exec(clauseSuffix);
    const suffixCount = countedCompactSuffixMatch
      ? parseBackstageCompactRetryItemCountGroups(
          countedCompactSuffixMatch.groups as BackstageCompactRetryItemCountGroups
        )
      : null;
    const prefixCount = countMatch
      ? parseBackstageCompactRetryItemCountGroups(
          countMatch.groups as BackstageCompactRetryItemCountGroups
        )
      : null;
    const postNounCount = postNounRequestMatch
      ? parseBackstageCompactRetryItemCountGroups(
          postNounRequestMatch.groups as BackstageCompactRetryItemCountGroups
        )
      : null;
    const implicitSingularCount = /^alternative\s+card$/iu.test(nounMatch[0])
      && /\b(?:a|an)\b(?:\s+[\p{L}\p{N}'’]+(?:-[\p{L}\p{N}'’]+)?){0,4}\s*$/iu.test(
        bodyBeforeNoun
      )
        ? 1
        : null;
    const explicitCount = suffixCount
      ?? compoundQuantityCount
      ?? prefixCount
      ?? postNounCount;
    const count = explicitCount ?? implicitSingularCount;
    const hasGenerationRequestVerb = new RegExp(
      `\\b${generationVerbPattern}\\b`,
      'iu'
    ).test(bodyBeforeNoun) || postNounRequestMatch !== null;
    const hasNaturalRequestLead = /\b(?:(?:can|could|may|might|would|will)\s+(?:(?:i|we)\s+(?:get|have|receive|see)|you\s+(?:(?:kindly|please)\s+)?(?:bring|get|send|show)(?:\s+(?:me|us))?)|(?:i|we)(?:['’]d|\s+would)\s+(?:like|love|prefer)(?:\s+to\s+(?:get|have|receive|see))?|let\s+(?:me|us)\s+(?:get|have|see)|(?:how|what)\s+about)\b/iu.test(
      bodyBeforeNoun
    );
    const hasDescriptiveRequestVerb = /\b(?:describe|outline|present|show)\b/iu.test(
      bodyBeforeNoun
    );
    const hasPoliteFragment = /\bplease\b/iu.test(
      `${bodyBeforeNoun} ${clauseSuffix}`
    );
    const hasStrongRequestEvidence = hasGenerationRequestVerb
      || hasNaturalRequestLead
      || explicitCount !== null;
    const numberedPhraseDiscussion = new RegExp(
      `\\b(?:(?:(?:brief|clear|compact|concise|detailed|full|short)\\s+){0,4}(?:explanation|understanding)\\s+of|compare|learn\\s+(?:more\\s+)?about|(?:(?:better|fully|more\\s+clearly)\\s+)?understand|explain|tell\\s+(?:me|us)\\s+about)\\s+(?:(?:all|a|an|the)\\s+)?(?:(?:exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\s+)?(?:(?:brief|compact|concise|detailed|full|numbered|short)\\s+){0,4}$`,
      'iu'
    ).test(bodyBeforeNoun);
    const contextualReferenceDiscussion = /\b(?:there\s+(?:are|exist|remain|were)|why\s+(?:are|were)|which\s+(?:of\s+)?(?:all\s+|the\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)?|(?:article|catalog|chart|database|document|example|file|notes?|page|passage|post|report|source|spreadsheets?|table|text|worksheets?)\s+(?:compares?|contains?|describes?|discusses?|has|includes?|lists?|mentions?|presents?|shows?))\b/iu.test(
      bodyBeforeNoun
    ) || /\b(?:according\s+to|from|in)\s+(?:an?|the)?\s*(?:article|catalog|chart|database|document|example|file|notes?|page|passage|post|report|source|spreadsheets?|table|text|worksheets?)\b/iu.test(
      clauseSuffix
    );
    const referenceNounLeadMatch = new RegExp(
      `(?:(?:(?:exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:(?:a|an)|(?:(?:all|the)\\s+)?(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))(?:\\s+(?:brief|compact|concise|detailed|full|numbered|short)){0,4}|${alternativeCardQuantityLeadPattern})\\s*$`,
      'iu'
    ).exec(bodyBeforeNoun);
    const referenceSubjectPredicate = referenceNounLeadMatch
      ? bodyBeforeNoun.slice(0, referenceNounLeadMatch.index).trim()
      : '';
    const hasFrontedRequestLead = /^(?:if\s+(?:(?:at\s+all\s+)?possible|(?:you|we)\s+can)|as\s+a\s+starting\s+point|to\s+begin|for\s+(?:raw|smackdown|nxt)(?:\s*(?:,|\/|and)\s*(?:raw|smackdown|nxt))*)\s*,\s*$/iu.test(
      referenceSubjectPredicate
    );
    const hasPostContextRequestReversal = new RegExp(
      `\\b(?:but|however|instead|rather)\\b[\\s,:;\\-–—]*(?:(?:i|we)\\s+(?:need|want)|(?:(?:kindly|please)\\s+)?${generationVerbPattern})\\b[^;.!?\\n]{0,64}$`,
      'iu'
    ).test(referenceSubjectPredicate);
    const referenceSubjectPredicateWordCount = Array.from(
      referenceSubjectPredicate.matchAll(/[\p{L}\p{N}'’.-]+/gu)
    ).length;
    const clauseInitialRequestLead = new RegExp(
      `^(?:(?:kindly|please)\\s+)?(?:${generationVerbPattern}|bring|fetch|send|try|use)\\b`,
      'iu'
    ).test(referenceSubjectPredicate)
      || /^(?:(?:can|could|may|might|should|would|will)\b|let(?:['’]s|\s+(?:me|us))\b|maybe\b|(?:i|we)(?:['’]d|\s+would)\b|(?:i|we)\s+(?:can|choose|could|hope|need|prefer|take|want|will)\b)/iu.test(
        referenceSubjectPredicate
      )
      || new RegExp(
        `^you\\s+(?:can|could|must|should|will|would)\\s+${generationVerbPattern}\\b`,
        'iu'
      ).test(referenceSubjectPredicate)
      || new RegExp(
        `^(?:(?:kindly|please)\\s+)?(?:(?:ask|get|tell)\\b[^;.!?\\n]{0,48}\\bto\\s+|(?:have|let)\\b[^;.!?\\n]{0,48}\\b)${generationVerbPattern}\\b`,
        'iu'
      ).test(referenceSubjectPredicate)
      || /^it\s+(?:could|would)\s+(?:(?:be\s+(?:great|helpful|ideal|nice|useful)\s+to\s+have)|help\s+to\s+have)\b/iu.test(
        referenceSubjectPredicate
      );
    const explicitRequestSubject = /\b(?:request|requested\s+output)\b/iu.test(
      referenceSubjectPredicate
    );
    const barePreferenceNounPhrase = /^(?:the\s+)?(?:best|favorite|favourite|ideal|strongest|top)\b/iu.test(
      referenceSubjectPredicate
    );
    const interrogativeReferenceLead = /^(?:how|what|which|why)\b/iu.test(
      referenceSubjectPredicate
    );
    const declarativeReferenceDiscussion = referenceSubjectPredicateWordCount >= 2
      && !clauseInitialRequestLead
      && !explicitRequestSubject
      && !barePreferenceNounPhrase
      && !interrogativeReferenceLead
      && !hasFrontedRequestLead
      && !hasPostContextRequestReversal;
    const informationalQuestion = new RegExp(
      `\\b(?:(?:explain|tell\\s+(?:me|us))\\s+(?:how|whether|why)|(?:how|why)\\s+(?:are|do|does|did|is|was|were)|(?:are|can|could|did|do|does|should|was|were|will|would)\\s+(?:(?:all|a|an|the)\\s+)?(?:(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\s+)?)\\b[^.!?\\n]{0,120}$`,
      'iu'
    ).test(bodyBeforeNoun) && /\b(?:compare[sd]?|differ(?:ed|s)?|exist(?:ed|s)?|mean(?:s|t)?|represent(?:ed|s)?|work(?:ed|s)?|be\s+(?:enough|viable)|suffice[sd]?)\b/iu.test(
      clauseSuffix
    );
    const sourceExplanation = /\b(?:explain|tell\s+(?:me|us))\s+(?:how|whether|why)\b/iu.test(
      bodyBeforeNoun
    ) && /\b(?:article|catalog|chart|database|document|example|file|notes?|page|passage|post|report|source|spreadsheets?|table|text|worksheets?)\b[^.!?\n]{0,80}\b(?:contains?|has|had|includes?|lists?|mentions?|presents?|shows?)\b/iu.test(
      bodyBeforeNoun
    );
    const postNounClause = clauseSuffix
      .replace(/^[\s,:;\-–—()[\]{}]+/u, '')
      .trim();
    const postNounWords = Array.from(
      postNounClause.matchAll(/[\p{L}\p{N}'’.-]+/gu),
      match => ({ lower: match[0].toLowerCase(), value: match[0] })
    );
    const postNounFiniteSubjectBlockers = new Set([
      'a', 'an', 'and', 'around', 'as', 'at', 'based', 'built', 'by',
      'comprising', 'containing', 'consisting', 'each', 'every', 'featuring',
      'for', 'from', 'in', 'including', 'made', 'no', 'of', 'on', 'or', 'per',
      'plus', 'that', 'the', 'to', 'which', 'who', 'with', 'without',
    ]);
    const postNounHasFinitePredicate = postNounWords.some((word, index) => {
      if (index === 0) {
        return false;
      }
      if (/^(?:are|can|could|did|does|had|has|have|is|may|might|must|shall|should|was|were|will|would)$/u.test(
        word.lower
      )) {
        const previousWord = postNounWords[index - 1]?.lower;
        const previousPreviousWord = postNounWords[index - 2]?.lower;
        if (
          /^(?:that|which|who)$/u.test(previousWord ?? '')
          || (
            previousWord?.endsWith('ly') === true
            && /^(?:that|which|who)$/u.test(previousPreviousWord ?? '')
          )
        ) {
          return false;
        }
        return index < postNounWords.length - 1;
      }
      if (!/(?:ed|became|caught|came|drew|found|got|grew|led|left|made|ran|sat|saw|sent|stood|took|went|won|wrote)$/u.test(
        word.lower
      )) {
        return false;
      }
      const bookingGenerationParticiple = new RegExp(
        `^${bookingGenerationParticiplePattern}$`,
        'iu'
      ).test(word.lower);
      if (
        index === postNounWords.length - 1
        && bookingGenerationParticiple
      ) {
        return false;
      }

      let subjectIndex = index - 1;
      while (
        subjectIndex > 0
        && (
          /^(?:all|already|each|just|still)$/u.test(
            postNounWords[subjectIndex]!.lower
          )
          || postNounWords[subjectIndex]!.lower.endsWith('ly')
        )
      ) {
        subjectIndex -= 1;
      }
      const subjectWord = postNounWords[subjectIndex]!;
      const nextWord = postNounWords[index + 1];
      return subjectIndex > 0
        && !postNounFiniteSubjectBlockers.has(subjectWord.lower)
        && !subjectWord.lower.endsWith('ly')
        && !/^\d+$/u.test(subjectWord.lower)
        && !new RegExp(
          `^(?:${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})$`,
          'iu'
        ).test(subjectWord.lower)
        && (
          nextWord === undefined
          || !/^(?:against|for|in|on|versus|with)$/u.test(nextWord.lower)
          || !bookingGenerationParticiple
        );
    });
    const postNounStructuredFragment = new RegExp(
      `^(?:(?:about|across|all|each|every|for|including|per|plus|where|with|without)\\b|(?:divided|split)\\s+(?:across|among)\\b|(?:based|built)\\s+(?:around|on)\\b|(?:comprising|containing|featuring)\\b|consisting\\s+of\\b|in\\s+which\\b|made\\s+up\\s+of\\b|${alternativeCardComponentNounPattern}\\b|(?:that|which|who)\\b)`,
      'iu'
    ).test(postNounClause) && !postNounHasFinitePredicate;
    const postNounDirectRequest = postNounRequestMatch !== null
      || new RegExp(
        `^(?:(?:kindly|please)\\s+)?(?:[\\p{L}'’]+ly\\s+){0,3}${recoveryGenerationVerbPattern}\\b[^;.!?\\n]{0,64}\\b${recoveryTargetPattern}\\b`,
        'iu'
      ).test(postNounClause)
      || new RegExp(
        `^(?:(?:can|could|may|might|will|would)\\s+you\\s+(?:(?:kindly|please)\\s+)?|(?:i|we)(?:['’]d|\\s+would)\\s+like\\s+you\\s+to\\s+)(?:[\\p{L}'’]+ly\\s+){0,3}${recoveryGenerationVerbPattern}\\b[^;.!?\\n]{0,64}\\b${recoveryTargetPattern}\\b`,
        'iu'
      ).test(postNounClause)
      || new RegExp(
        `^would\\s+you\\s+mind\\s+(?:[\\p{L}'’]+ly\\s+){0,3}(?:assembling|booking|building|creating|developing|drafting|fleshing\\s+out|generating|planning|writing)\\b[^;.!?\\n]{0,64}\\b${recoveryTargetPattern}\\b`,
        'iu'
      ).test(postNounClause);
    const postNounModalBookingRequest = new RegExp(
      `^(?:(?:must|shall|should)|ought(?:\\s+(?:all|each))?\\s+to|(?:are|is)\\s+to|(?:have|has)\\s+to)\\s+(?:(?:(?:also|now|still)|[\\p{L}'’.-]+ly)\\s+){0,3}(?:(?:all|each)\\s+)?(?:(?:(?:also|now|still)|[\\p{L}'’.-]+ly)\\s+){0,3}(?:be\\s+(?:(?:(?:also|now|still)|[\\p{L}'’.-]+ly)\\s+){0,3}${bookingGenerationParticiplePattern}\\b|(?:contain|feature|include|receive|consist\\s+of|have(?!\\s+been\\b))\\b[^;.!?\\n]{0,64}\\b${alternativeCardComponentNounPattern}\\b|be\\s+(?:complete|detailed|distinct|fully[- ]developed|full)\\b)`,
      'iu'
    ).test(postNounClause);
    const postNounBookingRequirement = new RegExp(
      `^(?:(?:will|would)\\s+)?(?:deserve(?:s)?|need(?:s)?|require(?:s)?)\\s+(?:to\\s+be\\s+(?:(?:[\\p{L}'’.-]+ly)\\s+){0,3}${bookingGenerationParticiplePattern}\\b|(?:(?:a|an|all|complete|comprehensive|detailed|exactly|full|the|\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\s+){0,5}(?:bookings?|${alternativeCardComponentNounPattern})\\b)`,
      'iu'
    ).test(postNounClause);
    const postNounCopularRequest = new RegExp(
      `^(?:are|is)\\s+(?:needed|required|wanted)\\b|^(?:are|is)\\s+(?:(?:exactly|just|precisely)\\s+)?(?:what\\s+(?:(?:i|we)\\s+(?:need|requested|want|asked\\s+for)|(?:i|we)(?:['’]d|\\s+would)\\s+like)|(?:the\\s+)?(?:exact\\s+)?(?:cards?|output)\\s+(?:(?:i|we)\\s+(?:need|requested|want)|(?:i|we)(?:['’]d|\\s+would)\\s+like)|(?:my|our)\\s+requested\\s+(?:cards?|output)|all(?:\\s+that)?\\s+(?:(?:i|we)\\s+(?:need|requested|want)|(?:i|we)(?:['’]d|\\s+would)\\s+like))\\b`,
      'iu'
    ).test(postNounClause);
    const postNounDesireRequest = /\b(?:could|would)\s+(?:be\s+(?:(?:a\s+)?great\s+help|appreciated|enough|great|helpful|ideal|nice|useful|welcome)|help\b|suffice\b)|\bwill\s+(?:do|help|suffice)\b/iu.test(
      postNounClause
    );
    const postNounImplicitRequest = postNounModalBookingRequest
      || postNounBookingRequirement
      || postNounCopularRequest
      || postNounDesireRequest;
    const postNounDelimitedListRequest = (
      /^\s*[:\/|→–—-]\s*[^,;/|.!?\n]{1,64}[,;/|]\s*[^,;/|.!?\n]{1,64}/u.test(
        clauseSuffix
      )
      || /^[^,;/|.!?\n]{1,64}[\/|]\s*[^,;/|.!?\n]{1,64}[\/|]\s*[^,;/|.!?\n]{1,64}/u.test(
        postNounClause
      )
    ) && !postNounHasFinitePredicate;
    const postNounVerblessRequest = new RegExp(
      `^(?:ideally|preferably)\\b|^if\\s+(?:(?:at\\s+all\\s+)?possible|you\\s+can)\\b|^(?:(?:a|an)\\s+different\\s+)?one(?:\\s+[\\p{L}'’.-]+ed){0,2}\\s+for\\s+each\\b|^(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\s+(?:apiece\\b|each\\b|(?:each\\s+)?(?:for|per|to)\\b)`,
      'iu'
    ).test(postNounClause) || postNounDelimitedListRequest;
    const interrogativePassiveDiscussion = /^(?:how|why)\s+(?:are|is|was|were)\b/iu.test(
      referenceSubjectPredicate
    ) && postNounHasFinitePredicate;
    const postNominalPredicateDiscussion = referenceNounLeadMatch !== null
      && !hasGenerationRequestVerb
      && !hasNaturalRequestLead
      && !clauseInitialRequestLead
      && !explicitRequestSubject
      && !interrogativeReferenceLead
      && !hasFrontedRequestLead
      && !hasPostContextRequestReversal
      && postNounClause.length > 0
      && !hasPositiveAnaphoricRecovery
      && !hasPoliteFragment
      && !hasCompactSuffix
      && !hasCompactNegation
      && !postNounStructuredFragment
      && !postNounDirectRequest
      && !postNounImplicitRequest
      && !postNounVerblessRequest;
    const phraseDiscussion = /\b(?:compare\s+(?:the\s+)?(?:phrase|term)|define|explain\s+(?:the\s+)?(?:phrase|term)|(?:definition|meaning)\s+of)\b/iu.test(
      bodyBeforeNoun
    ) || (contextualReferenceDiscussion && !hasPostContextRequestReversal)
      || postNominalPredicateDiscussion
      || interrogativePassiveDiscussion
      || (
        declarativeReferenceDiscussion
        && !hasNaturalRequestLead
        && !hasPositiveAnaphoricRecovery
      )
      || informationalQuestion
      || sourceExplanation
      || (
        numberedPhraseDiscussion
        && !hasNestedCardStructure
        && !hasPositiveAnaphoricRecovery
      )
      || /\b(?:the\s+)?(?:phrase|term)\s*$/iu.test(bodyBeforeNoun)
      || (
        /\bwhat\s+(?:are|does|do|is)\b/iu.test(bodyBeforeNoun)
        && !hasStrongRequestEvidence
      );
    const hasRequestContext = !phraseDiscussion && (
      hasGenerationRequestVerb
      || hasNaturalRequestLead
      || hasPositiveAnaphoricRecovery
      || hasContainerDetail
      || hasNestedCardStructure
      || ((hasDescriptiveRequestVerb || hasPoliteFragment) && (
        count !== null
        || hasContainerDetail
        || hasCompactModifier
        || hasCompactSuffix
      ))
      || hasQuantityLead
      || count !== null
    );
    if (!hasRequestContext) {
      continue;
    }

    const compactPresentation = !hasContainerDetail
      && !hasNestedCardStructure
      && !hasCompactNegation
      && (hasCompactModifier || hasCompactSuffix);
    const qualifier = (
      countedCompactSuffixMatch?.groups?.qualifier
      ?? countMatch?.groups?.qualifier
      ?? postNounRequestMatch?.groups?.qualifier
      ?? ''
    ).toLowerCase();
    requests.push({
      compactPresentation,
      containerRequest: !compactPresentation,
      count,
      mode: /^(?:up\s+to|at\s+most|no\s+more\s+than)$/u.test(qualifier)
        ? 'atMost'
        : 'exact',
    });
  }
  return requests;
}

function hasBackstageAlternativeCardContainerRequest(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): boolean {
  return collectBackstageAlternativeCardRequests(
    prompt,
    embeddedContentState
  ).some(request => request.containerRequest);
}

function collectBackstageCompactRetryCountLikeRequests(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): BackstageCompactRetryCountLikeRequest[] {
  const matches = prompt.matchAll(new RegExp(
    `\\b(?:book|create|generate|give|list|offer|provide|propose|return|schedule|suggest|write|want|need)(?:\\s+(?:me|us))?\\s+(?:(?:exactly|only|up\\s+to|at\\s+most|no\\s+more\\s+than)\\s+)?(?:a\\s+)?(?:(?<digitCount>\\d+)|(?<wordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\s+(?:${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_MODIFIER_PATTERN}\\s+){0,3}${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_ITEM_PATTERN}\\b`,
    'giu'
  ));
  const counts: BackstageCompactRetryCountLikeRequest[] = [];

  for (const match of matches) {
    const groups = match.groups as BackstageCompactRetryItemCountGroups;
    const matchIndex = match.index!;
    const count = parseBackstageCompactRetryItemCountGroups(groups);
    const quoteDisposition = embeddedContentState.quotedDispositionByCodeUnit[matchIndex];
    if (
      count === null
      || isBackstageCompactRetryDirectiveNegated(prompt, matchIndex)
      || isBackstageCompactRetryDirectiveDiscardedContext(prompt, matchIndex)
      || quoteDisposition === 'embedded'
      || isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
    ) {
      continue;
    }
    counts.push({
      count,
      quoteAmbiguous: quoteDisposition === 'ambiguous',
    });
  }

  return counts;
}

function countBackstageCompactRetryItemReferences(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): BackstageCompactRetryItemReferenceSummary {
  const matches = prompt.matchAll(new RegExp(
    `\\b(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})\\b(?:\\s+[\\p{L}\\p{N}'’]+(?:-[\\p{L}\\p{N}'’]+)*){0,4}\\s+${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_ITEM_PATTERN}\\b`,
    'giu'
  ));
  const summary: BackstageCompactRetryItemReferenceSummary = {
    topLevelCount: 0,
    ambiguousCount: 0,
  };
  for (const match of matches) {
    const matchIndex = match.index!;
    const quoteDisposition = embeddedContentState.quotedDispositionByCodeUnit[matchIndex];
    if (
      quoteDisposition === 'embedded'
      || isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
      || isBackstageCompactRetryDirectiveDiscardedContext(prompt, matchIndex)
    ) {
      continue;
    }
    if (quoteDisposition === 'ambiguous') {
      summary.ambiguousCount += 1;
    } else {
      summary.topLevelCount += 1;
    }
  }
  return summary;
}

function collectBackstageCompactRetryRangeBudgetCounts(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): number[] {
  const rangePatterns = [
    new RegExp(
      `\\b(?:(?<startDigitCount>\\d+)|(?<startWordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\s*(?:-|–|—|to|through)\\s*(?:(?<endDigitCount>\\d+)|(?<endWordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))(?:\\s+${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_MODIFIER_PATTERN}){0,4}\\s+${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_ITEM_PATTERN}\\b`,
      'giu'
    ),
    new RegExp(
      `\\bbetween\\s+(?:(?<startDigitCount>\\d+)|(?<startWordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))\\s+and\\s+(?:(?<endDigitCount>\\d+)|(?<endWordCount>${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN}))(?:\\s+${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_MODIFIER_PATTERN}){0,4}\\s+${BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_ITEM_PATTERN}\\b`,
      'giu'
    ),
  ];
  const counts: number[] = [];

  for (const pattern of rangePatterns) {
    for (const match of prompt.matchAll(pattern)) {
      const matchIndex = match.index!;
      if (
        embeddedContentState.quotedDispositionByCodeUnit[matchIndex] === 'embedded'
        || isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
        || isBackstageCompactRetryDirectiveNegated(prompt, matchIndex)
        || isBackstageCompactRetryDirectiveDiscardedContext(prompt, matchIndex)
      ) {
        continue;
      }
      const groups = match.groups as {
        startDigitCount?: string;
        startWordCount?: string;
        endDigitCount?: string;
        endWordCount?: string;
      };
      for (const count of [
        parseBackstageCompactRetryItemCountGroups({
          digitCount: groups.startDigitCount,
          wordCount: groups.startWordCount,
        }),
        parseBackstageCompactRetryItemCountGroups({
          digitCount: groups.endDigitCount,
          wordCount: groups.endWordCount,
        }),
      ]) {
        if (count !== null) {
          counts.push(count);
        }
      }
    }
  }

  return counts;
}

function hasBackstageCompactRetryAmbiguousCountSyntax(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): boolean {
  const countToken = `(?:\\d+|${BACKSTAGE_BOOKER_COMPACT_RETRY_NUMBER_WORD_PATTERN})`;
  const itemToken = BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_ITEM_PATTERN;
  const itemReference = `${countToken}(?:\\s+[\\p{L}\\p{N}'’]+(?:-[\\p{L}\\p{N}'’]+)*){0,4}\\s+${itemToken}`;
  const groupToken = '(?:divisions?|brands?|shows?|titles?|championships?|rosters?|teams?|weeks?|months?|events?|wrestlers?|participants?|opponents?)';
  const rangePattern = new RegExp(
    `\\b${countToken}\\s*(?:-|–|—|to|through)\\s*${countToken}(?:\\s+[\\p{L}\\p{N}'’]+(?:-[\\p{L}\\p{N}'’]+)*){0,4}\\s+${itemToken}\\b`,
    'giu'
  );
  const betweenRangePattern = new RegExp(
    `\\bbetween\\s+${countToken}\\s+and\\s+${countToken}(?:\\s+[\\p{L}\\p{N}'’]+(?:-[\\p{L}\\p{N}'’]+)*){0,4}\\s+${itemToken}\\b`,
    'giu'
  );
  const perGroupPattern = new RegExp(
    `\\b${countToken}\\b(?:\\s+[\\p{L}\\p{N}'’]+(?:-[\\p{L}\\p{N}'’]+)*){0,4}\\s+${itemToken}\\s+(?:(?:in|on|from|for)\\s+)?(?:each|every|per)\\s+${groupToken}\\b`,
    'giu'
  );
  const coordinatedCountPattern = new RegExp(
    `\\b${itemReference}\\s+(?:and|plus)\\s+${itemReference}\\b`,
    'giu'
  );
  const ellipticalCoordinatedCountPattern = new RegExp(
    `\\b${itemReference}\\b[^.!?\\n]{0,64}\\b(?:and|plus)\\s+${countToken}\\b`,
    'giu'
  );
  const correctionPattern = new RegExp(
    `\\b(?:actually|instead|rather|correction|make\\s+that|change\\s+(?:it|that)\\s+to)\\b[^.!?\\n]{0,48}\\b${countToken}\\b`,
    'giu'
  );

  return [
    rangePattern,
    betweenRangePattern,
    perGroupPattern,
    coordinatedCountPattern,
    ellipticalCoordinatedCountPattern,
    correctionPattern,
  ].some(pattern => Array.from(prompt.matchAll(pattern)).some(match => {
    const matchIndex = match.index!;
    return embeddedContentState.quotedDispositionByCodeUnit[matchIndex] !== 'embedded'
      && !isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
      && !isBackstageCompactRetryDirectiveNegated(prompt, matchIndex)
      && !isBackstageCompactRetryDirectiveDiscardedContext(prompt, matchIndex);
  }));
}

function resolveBackstageCompactRetryItemPolicy(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): BackstageCompactRetryItemPolicy {
  if (shouldUseBoundedBackstageReviewMode(prompt)) {
    return { mode: 'exact', count: 6, budgetItemCount: 6 };
  }

  const explicitCompactOutputPolicy =
    resolveBackstageExplicitCompactOutputItemPolicy(prompt, embeddedContentState);
  if (explicitCompactOutputPolicy) {
    return explicitCompactOutputPolicy;
  }

  const directiveCounts = collectBackstageCompactRetryDirectiveCounts(
    prompt,
    embeddedContentState
  );
  const itemReferenceSummary = countBackstageCompactRetryItemReferences(
    prompt,
    embeddedContentState
  );
  const countLikeRequests = collectBackstageCompactRetryCountLikeRequests(
    prompt,
    embeddedContentState
  );
  const rangeBudgetCounts = collectBackstageCompactRetryRangeBudgetCounts(
    prompt,
    embeddedContentState
  );
  const alternativeCardRequests = collectBackstageAlternativeCardRequests(
    prompt,
    embeddedContentState
  );
  const alternativeCardContainerRequests = alternativeCardRequests.filter(
    request => request.containerRequest
  );
  const alternativeCardCompactRequests = alternativeCardRequests.filter(
    request => request.compactPresentation
  );
  const topLevelDirectiveCounts = directiveCounts.filter(({ quoteAmbiguous }) => !quoteAmbiguous);
  const hasExplicitSupersedingDirective = topLevelDirectiveCounts.length === 1
    && new RegExp(
      `\\b(?:but\\s+)?(?:instead|rather)\\b[^.!?\\n]{0,48}${BACKSTAGE_BOOKER_COMPACT_RETRY_DIRECTIVE_PATTERN_SOURCE}`,
      'iu'
    ).test(prompt);
  const hasAmbiguousConstraint = hasBackstageCompactRetryAmbiguousCountSyntax(
    prompt,
    embeddedContentState
  )
    || topLevelDirectiveCounts.some(({ negated }) => negated)
    || topLevelDirectiveCounts.length > 1;

  if (alternativeCardContainerRequests.length > 0) {
    return {
      mode: 'preserve',
      budgetItemCount: Math.max(
        1,
        ...alternativeCardContainerRequests.flatMap(
          request => request.count === null ? [] : [request.count]
        ),
        ...directiveCounts.map(({ count }) => count),
        ...countLikeRequests.map(({ count }) => count),
        ...rangeBudgetCounts
      ),
    };
  }

  const alternativeCardCompactRequest = alternativeCardCompactRequests[0];
  if (
    alternativeCardCompactRequests.length === 1
    && alternativeCardCompactRequest
    && alternativeCardCompactRequest.count !== null
  ) {
    return {
      mode: alternativeCardCompactRequest.mode,
      count: alternativeCardCompactRequest.count,
      budgetItemCount: alternativeCardCompactRequest.count,
    };
  }

  const directiveCount = topLevelDirectiveCounts[0];
  if (
    topLevelDirectiveCounts.length === 1
    && directiveCount
    && (!hasAmbiguousConstraint || hasExplicitSupersedingDirective)
  ) {
    return {
      mode: directiveCount.mode,
      count: directiveCount.count,
      budgetItemCount: directiveCount.count,
    };
  }

  if (
    directiveCounts.length > 0
    || itemReferenceSummary.topLevelCount > 0
    || itemReferenceSummary.ambiguousCount > 0
    || countLikeRequests.length > 0
    || rangeBudgetCounts.length > 0
  ) {
    const budgetItemCount = Math.max(
      1,
      ...directiveCounts.map(({ count }) => count),
      ...countLikeRequests.map(({ count }) => count),
      ...rangeBudgetCounts
    );
    return { mode: 'preserve', budgetItemCount };
  }

  return {
    mode: 'default',
    count: BACKSTAGE_BOOKER_COMPACT_RETRY_DEFAULT_ITEM_LIMIT,
    budgetItemCount: BACKSTAGE_BOOKER_COMPACT_RETRY_DEFAULT_ITEM_LIMIT,
  };
}

function resolveBackstageCallerWordsPerItemLimit(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): number | null {
  const candidates: Array<{ index: number; wordLimit: number }> = [];
  const itemNounPattern =
    '(?:items?|options?|match(?:es)?|rivalr(?:y|ies)|ideas?|alternatives?|scenarios?|bullets?|paragraphs?)';
  const perItemSuffixPattern =
    `(?:each\\b|apiece\\b|per\\s+${itemNounPattern}\\b|for\\s+(?:each|every)\\s+${itemNounPattern}\\b)`;
  const itemScopePrefixPattern =
    `(?:\\b(?:each|every)\\s+${itemNounPattern}\\b(?:['’]s)?|\\bfor\\s+(?:each|every)\\s+${itemNounPattern}\\b)`;
  const explicitGlobalResponseScopePattern =
    `(?:(?:keep|limit|make|hold|write|ensure|use)\\s+(?:the\\s+)?(?:(?:whole|overall|entire|total|combined|final|complete|full)\\s+(?:answer|response|output)|(?:answer|response|output)\\s+as\\s+a\\s+whole|(?:all\\s+)?(?:answers|responses|outputs)\\s+combined)|(?:but|however|instead|then|while)\\s+(?:the\\s+)?(?:(?:whole|overall|entire|total|combined|final|complete|full)\\s+(?:answer|response|output)|(?:answer|response|output)\\s+as\\s+a\\s+whole|(?:all\\s+)?(?:answers|responses|outputs)\\s+combined)\\s+(?:(?:must|should|will|can)\\s+)?(?:be|stay|remain))`;
  const itemScopeGapPattern =
    `(?:(?!\\b${explicitGlobalResponseScopePattern}\\b)[^.!?;\\n]){0,64}`;
  const patterns = [
    new RegExp(
      `\\b(?:maximum(?:\\s+of)?|max(?:imum)?|at\\s+most|no\\s+more\\s+than|under|within)\\s+(?<wordLimit>\\d{1,4})\\s+words?\\s+${perItemSuffixPattern}`,
      'giu'
    ),
    new RegExp(
      `\\b(?<wordLimit>\\d{1,4})(?:\\s+words?\\s+(?:maximum|max|limit)|\\s*-\\s*word\\s+(?:maximum|max|limit))\\s+${perItemSuffixPattern}`,
      'giu'
    ),
    new RegExp(
      `${itemScopePrefixPattern}${itemScopeGapPattern}\\b(?:maximum(?:\\s+of)?|max(?:imum)?|at\\s+most|no\\s+more\\s+than|under|within)\\s+(?<wordLimit>\\d{1,4})\\s+words?\\b(?!\\s+in\\s+total\\b)`,
      'giu'
    ),
    new RegExp(
      `${itemScopePrefixPattern}${itemScopeGapPattern}\\b(?<wordLimit>\\d{1,4})\\s*-?\\s*word\\s+(?:maximum|max|limit)\\b`,
      'giu'
    ),
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const groups = match.groups as { wordLimit: string };
      const wordLimit = Number.parseInt(groups.wordLimit, 10);
      if (Number.isSafeInteger(wordLimit) && wordLimit >= 1) {
        candidates.push({
          index: match.index!,
          wordLimit,
        });
      }
    }
  }

  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  return candidate
    && !isBackstageCompactRetryDirectiveNegated(prompt, candidate.index)
    && !isBackstageCompactRetryDirectiveEmbeddedContent(
      prompt,
      candidate.index,
      embeddedContentState
    )
    ? candidate.wordLimit
    : null;
}

function hasBackstageCallerNumberedParagraphConstraint(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): boolean {
  const matches = Array.from(prompt.matchAll(
    /\b(?:one|1)\s+numbered\s+paragraph\s+per\s+(?:item|option|match|rivalry|idea|alternative|scenario|bullet)\b/giu
  ));
  if (matches.length !== 1) {
    return false;
  }
  const matchIndex = matches[0]!.index!;
  return !isBackstageCompactRetryDirectiveNegated(prompt, matchIndex)
    && !isBackstageCompactRetryDirectiveEmbeddedContent(
      prompt,
      matchIndex,
      embeddedContentState
    );
}

function resolveBackstageCompactOutputWordBounds(
  prompt: string,
  tokenLimit: number,
  itemPolicy: BackstageCompactRetryItemPolicy,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): BackstageCompactOutputWordBounds {
  const proportionalTotalWordLimit = Math.max(
    1,
    Math.floor((Math.max(1, Math.trunc(tokenLimit)) * 5) / 12)
  );
  const serverTotalWordLimit = Math.min(
    BACKSTAGE_BOOKER_COMPACT_RETRY_MAX_TOTAL_WORDS,
    Math.max(itemPolicy.budgetItemCount, proportionalTotalWordLimit)
  );
  const serverWordsPerItem = Math.max(
    1,
    Math.min(
      BACKSTAGE_BOOKER_COMPACT_RETRY_MAX_WORDS_PER_ITEM,
      Math.floor(serverTotalWordLimit / itemPolicy.budgetItemCount)
    )
  );
  const callerWordsPerItemLimit = resolveBackstageCallerWordsPerItemLimit(
    prompt,
    embeddedContentState
  );
  const wordsPerItem = Math.min(
    serverWordsPerItem,
    callerWordsPerItemLimit ?? serverWordsPerItem
  );
  const totalWordLimit = callerWordsPerItemLimit !== null
    && (itemPolicy.mode === 'exact' || itemPolicy.mode === 'atMost')
    ? Math.min(
        serverTotalWordLimit,
        Math.max(itemPolicy.budgetItemCount, wordsPerItem * itemPolicy.budgetItemCount)
      )
    : serverTotalWordLimit;

  return { totalWordLimit, wordsPerItem };
}

export function resolveBackstageCompactOutputContract(
  prompt: string,
  tokenLimit: number
): BackstageCompactOutputContract {
  const embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt);
  const itemPolicy = resolveBackstageCompactRetryItemPolicy(prompt, embeddedContentState);
  return {
    itemPolicy,
    wordBounds: resolveBackstageCompactOutputWordBounds(
      prompt,
      tokenLimit,
      itemPolicy,
      embeddedContentState
    ),
    embeddedContentState,
    alternativeCardContainerRequest:
      hasBackstageAlternativeCardContainerRequest(prompt, embeddedContentState),
    completeBookingContainerComponentCount:
      hasBackstageCompleteBookingContainerComponentCountRequest(
        prompt,
        embeddedContentState
      ),
    explicitCompactOutputRequest: hasBackstageExplicitCompactOutputRequest(
      prompt,
      embeddedContentState
    ),
  };
}

export function buildBackstageBookerRequestedOutputShapeInstruction(
  prompt: string,
  contract: BackstageCompactOutputContract
): string | null {
  const { itemPolicy, wordBounds, embeddedContentState } = contract;
  const callerWordsPerItemLimit = resolveBackstageCallerWordsPerItemLimit(
    prompt,
    embeddedContentState
  );
  if (
    callerWordsPerItemLimit === null
    || !hasBackstageCallerNumberedParagraphConstraint(prompt, embeddedContentState)
    || (itemPolicy.mode !== 'exact' && itemPolicy.mode !== 'atMost')
  ) {
    return null;
  }

  const { totalWordLimit, wordsPerItem } = wordBounds;
  const itemCountInstruction = itemPolicy.mode === 'exact'
    ? `Return exactly ${itemPolicy.count} numbered paragraphs, numbered 1 through ${itemPolicy.count}.`
    : `Return no more than ${itemPolicy.count} numbered paragraphs, numbered consecutively from 1.`;

  return [
    '<<CALLER_OUTPUT_CONSTRAINT>>',
    'This explicit caller output constraint overrides general response-style guidance.',
    itemCountInstruction,
    `Use exactly one compact paragraph per item, at most ${wordsPerItem} words each.`,
    `Use at most ${totalWordLimit} words total.`,
    'Use no preamble, no headings, no sub-bullets, no tables, no recap, no conclusion, and no meta commentary.',
    'Keep every requested field inline in its item, and omit unrequested fields.',
    itemPolicy.mode === 'exact'
      ? `Stop after item ${itemPolicy.count}.`
      : 'Stop after the final numbered item.',
    '<<CALLER_OUTPUT_CONSTRAINT_END>>',
  ].join('\n');
}

export function buildBackstageBookerCompactOutputRetryInstruction(
  contract: BackstageCompactOutputContract
): string {
  const { itemPolicy, wordBounds } = contract;
  const { totalWordLimit, wordsPerItem } = wordBounds;
  const itemCountInstruction = itemPolicy.mode === 'exact'
    ? `Return exactly ${itemPolicy.count} numbered paragraphs, numbered 1 through ${itemPolicy.count}.`
    : itemPolicy.mode === 'atMost'
      ? `Return no more than ${itemPolicy.count} numbered paragraphs, numbered consecutively from 1.`
      : itemPolicy.mode === 'preserve'
        ? 'Preserve every caller-required item count; do not add optional items or replace a range, maximum, per-group count, or correction with a different count.'
        : `Return at most ${itemPolicy.count} numbered paragraphs.`;
  const stopInstruction = itemPolicy.mode === 'exact'
    ? `Stop after item ${itemPolicy.count}.`
    : itemPolicy.mode === 'preserve'
      ? 'Stop after the final caller-required item.'
      : 'Stop after the final numbered item.';

  return [
    '<<OUTPUT_LENGTH_RECOVERY>>',
    'The previous response was discarded because it exceeded the output limit.',
    'Return a new, complete answer within the existing output limit; never continue or quote the discarded response.',
    itemCountInstruction,
    `Use exactly one compact paragraph per item, at most ${wordsPerItem} words each.`,
    `Use at most ${totalWordLimit} words total.`,
    'Use no preamble, no headings, no sub-bullets, no tables, no recap, no conclusion, no repeated evidence, no optional alternatives, and no meta commentary.',
    'Keep every requested field inline in its item, and omit unrequested fields.',
    stopInstruction,
    'Prioritize the direct answer and only the continuity facts needed to support it.',
    'Do not mention this recovery instruction or the discarded response.',
    '<<OUTPUT_LENGTH_RECOVERY_END>>',
  ].join('\n');
}

export function buildBackstageBookerStructuredOutputRetryInstruction(): string {
  return [
    '<<OUTPUT_LENGTH_RECOVERY>>',
    'The previous response was discarded because it exceeded the output limit.',
    'Return a new, complete answer within the existing output limit; never continue or quote the discarded response.',
    'Preserve every requested card, show, or event component and its original hierarchy.',
    'Keep requested match, segment, angle, finish, consequence, and production-beat counts as component requirements, not as a replacement top-level item count.',
    'Use concise organized markdown sections and compact lower-priority detail before omitting any requested component.',
    'Use no preamble, recap, conclusion, optional alternatives, or meta commentary.',
    'Do not mention this recovery instruction or the discarded response.',
    '<<OUTPUT_LENGTH_RECOVERY_END>>',
  ].join('\n');
}

const BACKSTAGE_BOOKER_COMPACT_RETRY_FORBIDDEN_LINE_PATTERN =
  /^(?:[-*+]\s+|#{1,6}\s+|(?:---+|___+|\*\*\*+)$|\|)/u;
const BACKSTAGE_BOOKER_COMPACT_RETRY_TABLE_DIVIDER_PATTERN =
  /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u;

function countWhitespaceDelimitedWords(text: string): number {
  return text.match(/\S+/gu)!.length;
}

/**
 * Run the normal generation attempt and, only for provider length exhaustion,
 * one compact retry. A second length exhaustion is collapsed to the public,
 * cause-free terminal error and never starts a third provider attempt.
 */
export async function runBackstageBookerCompactOutputAttempts<T>(
  runAttempt: (compactOutputRetry: boolean) => Promise<T>,
  canRetry: () => boolean = () => true,
  onEvent?: (event: BackstageCompactOutputAttemptEvent) => void
): Promise<BackstageCompactOutputAttemptResult<T>> {
  const emitEvent = (event: BackstageCompactOutputAttemptEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // Telemetry must never replace generation or its cause-free terminal error.
    }
  };

  try {
    return {
      result: await runAttempt(false),
      usedCompactOutputRetry: false,
    };
  } catch (error) {
    if (!isBackstageProviderOutputLengthExhaustionError(error)) {
      throw error;
    }
    emitEvent('initial_length_exhaustion');
  }

  if (!canRetry()) {
    emitEvent('compact_retry_skipped_insufficient_budget');
    throw new BackstageBookerOutputIncompleteError();
  }

  emitEvent('compact_retry_started');
  try {
    const result = await runAttempt(true);
    emitEvent('compact_retry_provider_completed');
    return {
      result,
      usedCompactOutputRetry: true,
    };
  } catch (error) {
    if (isBackstageProviderOutputLengthExhaustionError(error)) {
      emitEvent('compact_retry_length_exhausted');
      throw new BackstageBookerOutputIncompleteError();
    }
    throw error;
  }
}

export function parseBackstageBookerCompactRetryNumberedParagraphs(
  output: string
): string[] | null {
  const items: string[] = [];
  let previousLineWasBlank = false;

  for (const line of output.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      previousLineWasBlank = items.length > 0;
      continue;
    }

    const itemMatch = line.match(
      /^ ?(?:\*\*)?(?<itemNumber>\d+)[.)](?:\*\*)?\s+(?<body>\S.*)$/u
    );
    if (itemMatch) {
      const groups = itemMatch.groups as { body: string; itemNumber: string };
      const itemNumber = Number.parseInt(groups.itemNumber, 10);
      const itemBody = groups.body.trim();
      if (
        itemNumber !== items.length + 1
        || BACKSTAGE_BOOKER_COMPACT_RETRY_FORBIDDEN_LINE_PATTERN.test(itemBody)
        || BACKSTAGE_BOOKER_COMPACT_RETRY_TABLE_DIVIDER_PATTERN.test(itemBody)
      ) {
        return null;
      }
      items.push(itemBody);
      previousLineWasBlank = false;
      continue;
    }

    if (
      items.length === 0
      || previousLineWasBlank
      || /^ ?[A-Za-z][.)]\s+/u.test(line)
      || /^(?:\t| {2,})(?:(?:\*\*)?\d+[.)](?:\*\*)?|[A-Za-z][.)])\s+/u.test(line)
      || BACKSTAGE_BOOKER_COMPACT_RETRY_FORBIDDEN_LINE_PATTERN.test(trimmedLine)
      || BACKSTAGE_BOOKER_COMPACT_RETRY_TABLE_DIVIDER_PATTERN.test(trimmedLine)
    ) {
      return null;
    }
    items[items.length - 1] = `${items[items.length - 1]!} ${trimmedLine}`;
  }

  return items.length > 0 ? items : null;
}

export function isBackstageBookerCompactRetryOutputValid(
  output: string,
  contract: BackstageCompactRetryValidationContract
): boolean {
  const { itemPolicy, wordBounds } = contract;
  if (itemPolicy.mode !== 'exact' && itemPolicy.mode !== 'atMost') {
    return true;
  }

  const items = parseBackstageBookerCompactRetryNumberedParagraphs(output);
  if (!items) {
    return false;
  }

  const hasValidItemCount = itemPolicy.mode === 'exact'
    ? items.length === itemPolicy.count
    : items.length <= itemPolicy.count;
  if (!hasValidItemCount) {
    return false;
  }

  // For enforceable policies, wordsPerItem is derived from totalWordLimit / count,
  // so a valid item count plus every valid item ceiling also proves the total ceiling.
  return items.every(
    item => countWhitespaceDelimitedWords(item) <= wordBounds.wordsPerItem
  );
}

export function assertBackstageBookerCompactRetryOutputValid(
  output: string,
  contract: BackstageCompactRetryValidationContract,
  validationRequired: boolean
): void {
  if (
    validationRequired
    && !isBackstageBookerCompactRetryOutputValid(output, contract)
  ) {
    throw new BackstageBookerOutputIncompleteError();
  }
}
