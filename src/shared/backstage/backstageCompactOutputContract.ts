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
  '(?:angles?|alternatives?|beats?|bouts?|bullets?|cards?|chapters?|feuds?|finish(?:es)?|ideas?|items?|match(?:es)?|matchups?|options?|phases?|programs?|promos?|rivalr(?:y|ies)|scenarios?|segments?|storylines?)';
const BACKSTAGE_BOOKER_COMPACT_RETRY_COUNT_LIKE_MODIFIER_PATTERN =
  '(?:main[- ]event|booking|match|title|storyline|rivalry|creative|different|possible|detailed|men[\'’]?s|women[\'’]?s|raw|smackdown|nxt)';

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
  negated: boolean;
  quoteAmbiguous: boolean;
}

interface BackstageCompactRetryCountLikeRequest {
  count: number;
  quoteAmbiguous: boolean;
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

function collectBackstageCompactRetryDirectiveCounts(
  prompt: string,
  embeddedContentState: BackstageCompactRetryEmbeddedContentState
): BackstageCompactRetryDirectiveCount[] {
  const matches = prompt.matchAll(
    /\b(?:book|create|generate|give|list|offer|provide|propose|return|schedule|suggest|write|want|need)(?:\s+(?:me|us))?\s+(?:(?<qualifier>exactly|only|up\s+to|at\s+most|no\s+more\s+than)\s+)?(?:(?<digitCount>\d+)|(?<wordCount>one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:(?:main[- ]event|booking|match|title|storyline|rivalry|creative|different|possible|detailed|men['’]?s|women['’]?s|raw|smackdown|nxt)\s+){0,3}(?:bullets?|match(?:es)?|rivalr(?:y|ies)|options?|ideas?|alternatives?|scenarios?)\b/giu
  );
  const directiveCounts: BackstageCompactRetryDirectiveCount[] = [];

  for (const match of matches) {
    const groups = match.groups as BackstageCompactRetryItemCountGroups & {
      qualifier?: string;
    };
    const matchIndex = match.index!;
    const count = parseBackstageCompactRetryItemCountGroups(groups);
    const quoteDisposition = embeddedContentState.quotedDispositionByCodeUnit[matchIndex];
    if (
      count === null
      || quoteDisposition === 'embedded'
      || isBackstageCompactRetryDirectiveCreativeContent(prompt, matchIndex)
    ) {
      continue;
    }

    const qualifier = groups.qualifier?.toLowerCase() ?? '';
    directiveCounts.push({
      count,
      mode: /^(?:up\s+to|at\s+most|no\s+more\s+than)$/u.test(qualifier)
        ? 'atMost'
        : 'exact',
      negated: isBackstageCompactRetryDirectiveNegated(
        prompt,
        matchIndex
      ),
      quoteAmbiguous: quoteDisposition === 'ambiguous',
    });
  }

  return directiveCounts;
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
      && !isBackstageCompactRetryDirectiveNegated(prompt, matchIndex);
  }));
}

function resolveBackstageCompactRetryItemPolicy(
  prompt: string,
  embeddedContentState = buildBackstageCompactRetryEmbeddedContentState(prompt)
): BackstageCompactRetryItemPolicy {
  if (shouldUseBoundedBackstageReviewMode(prompt)) {
    return { mode: 'exact', count: 6, budgetItemCount: 6 };
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
  const topLevelDirectiveCounts = directiveCounts.filter(({ quoteAmbiguous }) => !quoteAmbiguous);
  const hasAmbiguousConstraint = hasBackstageCompactRetryAmbiguousCountSyntax(
    prompt,
    embeddedContentState
  )
    || topLevelDirectiveCounts.some(({ negated }) => negated)
    || topLevelDirectiveCounts.length > 1;

  const directiveCount = topLevelDirectiveCounts[0];
  if (topLevelDirectiveCounts.length === 1 && directiveCount && !hasAmbiguousConstraint) {
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
  runAttempt: (compactOutputRetry: boolean) => Promise<T>
): Promise<BackstageCompactOutputAttemptResult<T>> {
  try {
    return {
      result: await runAttempt(false),
      usedCompactOutputRetry: false,
    };
  } catch (error) {
    if (!isBackstageProviderOutputLengthExhaustionError(error)) {
      throw error;
    }
  }

  try {
    return {
      result: await runAttempt(true),
      usedCompactOutputRetry: true,
    };
  } catch (error) {
    if (isBackstageProviderOutputLengthExhaustionError(error)) {
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
  usedCompactOutputRetry: boolean
): void {
  if (
    usedCompactOutputRetry
    && !isBackstageBookerCompactRetryOutputValid(output, contract)
  ) {
    throw new BackstageBookerOutputIncompleteError();
  }
}
