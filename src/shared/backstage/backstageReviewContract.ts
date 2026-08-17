export const BACKSTAGE_REVIEW_BULLET_COUNT = 6;
export const BACKSTAGE_REVIEW_TOKEN_LIMIT_MAX = 1_600;

export function buildBackstageReviewResponseStyleInstruction(): string {
  return [
    `Return exactly ${BACKSTAGE_REVIEW_BULLET_COUNT} top-level numbered bullets:`,
    '1. Overall verdict and the show\'s strongest through-line.',
    '2. Match results and ratings that most affected the show.',
    '3. Promos, headcanon, and non-match segments that mattered most.',
    '4. Rivalry development and continuity strengths or problems.',
    '5. Pacing, booking logic, and the highest-value correction.',
    '6. The remaining matches and the best next step.',
    'Use no more than two concise sentences per bullet.',
    'No preamble, headings, sub-bullets, alternative full card, conclusion, or production-notes appendix.',
    'Synthesize instead of recapping: do not re-list the supplied show state, results, ratings, or segments.',
    'Treat matches identified as still to come as unresolved; never invent their results.',
  ].join('\n');
}

export function resolveBoundedBackstageReviewTokenLimit(
  prompt: string,
  defaultTokenLimit: number
): number | null {
  return shouldUseBoundedBackstageReviewMode(prompt)
    ? Math.min(defaultTokenLimit, BACKSTAGE_REVIEW_TOKEN_LIMIT_MAX)
    : null;
}

export interface BackstageReviewClassificationDiagnostics {
  boundedReviewMode: boolean;
  quoteLookaheadScans: number;
}

const BACKSTAGE_REVIEW_REQUEST_VERB_PATTERN =
  /^(?:(?:briefly|carefully|concisely|critically|directly|honestly|kindly|quickly|thoroughly)\s*,?\s+)*(?:review|critique|assess|evaluate|analy[sz]e|rate|grade)\b/i;
const BACKSTAGE_REVIEW_NOUN_PATTERN =
  /^(?:me\s+)?(?:(?:a|an|the|this|my|our|your)\s+)?(?:(?:brief|concise|critical|detailed|full|honest|new|short)\s+)*(?:review|critique|assessment|evaluation|analysis|rating|grade|score|feedback|recommendation)\b/i;
const BACKSTAGE_CREATIVE_REQUEST_VERB_PATTERN =
  /^(?:book|write|generate|create|build|draft|continue|advance|develop|finish|rebook|rewrite|redo|rework)\b/i;
const BACKSTAGE_EMBEDDED_CREATIVE_GERUND_PATTERN =
  /\b(?:before|after|while|by|through|instead\s+of)\s+(?:please\s+)?(?:booking|writing|generating|creating|building|drafting|continuing|advancing|developing|finishing|rebooking|rewriting|redoing|reworking)\b/i;
const BACKSTAGE_REQUEST_PREFIX_PATTERN =
  /^(?:please\s*,?\s+|(?:can|could|would|will)\s+you\s*,?\s+(?:please\s*,?\s+)?|you\s+(?:should|must|can|could|will|would|need\s+to)\s+|i(?:['’]d\s+(?:also\s+)?like|\s+(?:also\s+)?(?:want|need|would\s+(?:also\s+)?like))\s+(?:you\s+)?(?:to\s+)?)/i;
const BACKSTAGE_REQUEST_CONNECTOR_PREFIX_PATTERN =
  /^(?:(?:and\s+then|then|also|and|but|or)\s+)/i;
const BACKSTAGE_DIRECT_STYLE_CLAUSE_PATTERN =
  /^(?:(?:answer|respond|reply|say)\s+directly|just\s+answer|(?:do\s+not|don't|no|without)\s+(?:simulate|simulation|role-?play|pretend)|no\s+hypothetical(?:\s+runs?)?|hypothetical\s+run)\b/i;
const BACKSTAGE_DIRECT_STYLE_PREFIX_PATTERN =
  /^(?:(?:answer|respond|reply|say)\s+directly|just\s+answer)\s*(?:[:,.\-–—]\s*)?/i;
const BACKSTAGE_DIRECTIVE_HEADING_PREFIX_PATTERN =
  /^(?:#{1,6}\s*)?(?:(?:backend|backstage|booker|booking|show)\s+)*(?:review\s+)?(?:request|directive|task|instructions?)\s*(?:[:,\-–—]\s*)/i;
const BACKSTAGE_STATE_FIELD_PATTERN =
  /^(?:booking|continue|finish|review|rating|score)\s*:/i;
const BACKSTAGE_CREATIVE_STATE_FIELD_PATTERN =
  /^(?:booking|draft|continue|finish)(?:\s+(?:details?|flag|logic|notes?|plan|result|status|style|type|version)){1,3}\s*:/i;
const BACKSTAGE_SCALAR_STATE_FIELD_PATTERN =
  /^draft\s*:\s*(?:complete|completed|final|false|pending|true|v?\d+(?:\.\d+)*)\b/i;
const BACKSTAGE_ATTRIBUTED_DIALOGUE_PATTERN =
  /,\s*(?:[\p{L}\p{N}][\p{L}\p{N}'’.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’.-]*){0,2})\s+(?:asked|replied|said|suggested|told|wrote)\b[^.!?]*[.!?]?$/iu;
const BACKSTAGE_FULL_REVIEW_STATE_TARGET_PATTERN = /^(?:show|booking)\s+state\b/i;
const BACKSTAGE_FULL_REVIEW_CONTEXTUAL_TARGET_PATTERN =
  /^(?:this|that|my|our|current|completed?|complete|full|entire|supplied|recorded|the|a|an|this\s+week['’]s|last\s+night['’]s)\s+(?:(?:current|completed?|complete|full|entire|supplied|recorded|whole|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)-match|raw|smackdown|nxt|dynamite|collision)\s+){0,3}(?:show|card|episode|universe)\b/i;
const BACKSTAGE_FULL_REVIEW_CONTEXTUAL_BOOKING_PATTERN =
  /^(?:this|that|my|our|current|completed?|complete|full|entire|supplied|recorded|the)\s+booking\b/i;
const BACKSTAGE_FULL_REVIEW_SO_FAR_PATTERN =
  /^(?:show|everything|raw|smackdown|nxt|dynamite|collision)\s+so\s+far\b/i;
const BACKSTAGE_FULL_REVIEW_BRAND_ONLY_PATTERN =
  /^(?:(?:of|on|for|about)\s+)?(?:(?:this|that|the|my|our|current|completed?|complete|full|entire|wwe|aew|this\s+week['’]s|last\s+night['’]s)\s+){0,3}(?:raw|smackdown|nxt|dynamite|collision)(?:\s+(?:show|card|episode|so\s+far))?(?:\s+tonight)?$/i;
const BACKSTAGE_FULL_REVIEW_COMPLETED_PORTION_PATTERN =
  /^(?:(?:this|that|the|my|our)\s+)?(?:completed?|complete)\s+(?:portion|part)\s+of\s+(?:raw|smackdown|nxt|dynamite|collision)\b/i;
const BACKSTAGE_FULL_REVIEW_EVENT_PATTERN =
  /^(?:(?:this|that|the|completed?|complete|full|entire)\s+)?(?:premium\s+live\s+event|pay[- ]per[- ]view|ppv|ple)(?:\s+(?:show|card|event|so\s+far))?$/i;
const BACKSTAGE_NARROW_REVIEW_TARGET_SUFFIX_PATTERN =
  /^(?:['’]s\b|\s+(?:main[- ]event|match|finish|opener|segment|promo|angle|decision|logic|opponent|title|champion)\b)/i;
const BACKSTAGE_DECISION_REVIEW_SCOPE_PATTERN =
  /^(?:(?:of|on|for|about)\s+)?(?:whether|if|who|what|when|where|why|how|which|should|can|could|would|will|is|are|do|does|did)\b/i;
const BACKSTAGE_REQUEST_CLAUSE_SEPARATOR_PATTERN =
  /(?:\r?\n+|[.!?]\s+|;\s*|\s+(?:and\s+then|and|then|before|after|while|but|or)\s+|\s+also\s+(?=(?:please\s+)?(?:book|write|generate|create|build|draft|continue|advance|develop|finish|rebook|rewrite|redo|rework)\b)|[,/:]\s*(?=(?:(?:also|then)\s+)?(?:please\s+)?(?:book|write|generate|create|build|draft|continue|advance|develop|finish|rebook|rewrite|redo|rework)\b)|\s*(?:[–—]|\s-\s)\s*(?=(?:please\s+)?(?:book|write|generate|create|build|draft|continue|advance|develop|finish|rebook|rewrite|redo|rework)\b))/i;
const BACKSTAGE_LIST_ITEM_PATTERN = /^(?:[-*]|\d+[.)])\s+/;
const BACKSTAGE_REVIEW_ABBREVIATION_PATTERN =
  /\b(?:[a-z]\.[ \t]*){2,}|\b(?:dr|mr|mrs|ms|no|prof|sr|jr|st|vs)\./gi;

export function stripMarkdownFormatting(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripBackstageDirectAnswerPreamblePrefix(value: string): string {
  return value.replace(
    /^(?:quick\s+gut\s+check|gut\s+read|quick\s+take|direct\s+answer|bottom\s+line)\s*:\s*/i,
    ''
  ).trim();
}

export function collectTopLevelListItems(text: string): string[] {
  const items: string[] = [];
  let currentItem = '';

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    const normalizedListLine = stripMarkdownFormatting(trimmedLine);
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;

    if (!trimmedLine || /^---+$/.test(trimmedLine) || /^#{1,6}\s+/.test(trimmedLine)) {
      continue;
    }

    const hasNormalizedListMarker = BACKSTAGE_LIST_ITEM_PATTERN.test(normalizedListLine);
    const listMarkerSource = BACKSTAGE_LIST_ITEM_PATTERN.test(trimmedLine)
      ? trimmedLine
      : normalizedListLine;
    const isTopLevelItem = indentation <= 1 && hasNormalizedListMarker;
    const isNestedItem = indentation > 1 && hasNormalizedListMarker;

    if (isTopLevelItem) {
      if (currentItem) {
        items.push(currentItem.trim());
      }
      currentItem = listMarkerSource.replace(BACKSTAGE_LIST_ITEM_PATTERN, '');
      continue;
    }

    if (currentItem) {
      const appendedLine = isNestedItem
        ? listMarkerSource.replace(BACKSTAGE_LIST_ITEM_PATTERN, '')
        : trimmedLine;
      currentItem = `${currentItem} ${appendedLine}`.trim();
    }
  }

  if (currentItem) {
    items.push(currentItem.trim());
  }

  return items;
}

function maskBackstageQuotedRequestText(
  value: string,
  diagnostics?: BackstageReviewClassificationDiagnostics
): string {
  let closingQuote: '"' | '\'' | '”' | '’' | null = null;
  let maskedValue = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const previousCharacter = value[index - 1] ?? '';
    const nextCharacter = value[index + 1] ?? '';
    const isInWordApostrophe = (character === '\'' || character === '’')
      && /[\p{L}\p{N}]/u.test(previousCharacter)
      && /[\p{L}\p{N}]/u.test(nextCharacter);
    const shouldScanForLaterClosingQuote = closingQuote === character
      && !isInWordApostrophe;
    if (shouldScanForLaterClosingQuote && diagnostics) {
      diagnostics.quoteLookaheadScans += 1;
    }
    const hasLaterClosingQuote = shouldScanForLaterClosingQuote
      && Array.from(value.slice(index + 1)).some((candidate, offset) => {
        if (candidate !== character) {
          return false;
        }
        const candidateIndex = index + offset + 1;
        return !(
          /[\p{L}\p{N}]/u.test(value[candidateIndex - 1] ?? '')
          && /[\p{L}\p{N}]/u.test(value[candidateIndex + 1] ?? '')
        );
      });
    const isInternalPluralPossessive = closingQuote === character
      && previousCharacter.toLowerCase() === 's'
      && /[\s.,;:!?]/u.test(nextCharacter)
      && hasLaterClosingQuote;

    if (closingQuote) {
      if (character === closingQuote && !isInWordApostrophe && !isInternalPluralPossessive) {
        closingQuote = null;
        maskedValue += character;
      } else if (/\s/u.test(character)) {
        maskedValue += '\u0001';
      } else if (character === ';') {
        maskedValue += '\u0002';
      } else if (character === '–') {
        maskedValue += '\u0003';
      } else if (character === '—') {
        maskedValue += '\u0004';
      } else if (character === ',') {
        maskedValue += '\u0005';
      } else if (character === '/') {
        maskedValue += '\u0006';
      } else if (character === ':') {
        maskedValue += '\u0007';
      } else {
        maskedValue += character;
      }
      continue;
    }

    const isUnquotedPluralPossessive = character === '\''
      && /[\p{L}\p{N}]/u.test(previousCharacter)
      && (!nextCharacter || /[\s.,;:!?]/u.test(nextCharacter));
    if (!isInWordApostrophe && !isUnquotedPluralPossessive) {
      if (character === '"') {
        closingQuote = '"';
      } else if (character === '\'') {
        closingQuote = '\'';
      } else if (character === '“') {
        closingQuote = '”';
      } else if (character === '‘') {
        closingQuote = '’';
      }
    }
    maskedValue += character;
  }

  return maskedValue;
}

function splitBackstageRequestClauses(
  value: string,
  diagnostics?: BackstageReviewClassificationDiagnostics
): string[] {
  return maskBackstageQuotedRequestText(value, diagnostics)
    .split(BACKSTAGE_REQUEST_CLAUSE_SEPARATOR_PATTERN)
    .map(clause => clause
      .replace(/\u0001/g, ' ')
      .replace(/\u0002/g, ';')
      .replace(/\u0003/g, '–')
      .replace(/\u0004/g, '—')
      .replace(/\u0005/g, ',')
      .replace(/\u0006/g, '/')
      .replace(/\u0007/g, ':'));
}

function evaluateBoundedBackstageReviewMode(
  prompt: string,
  diagnostics?: BackstageReviewClassificationDiagnostics
): boolean {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return false;
  }

  const clauses = splitBackstageRequestClauses(normalizedPrompt, diagnostics)
    .map(normalizeBackstageRequestClause)
    .filter(Boolean);
  const hasEmbeddedCreativeGerundRequest = BACKSTAGE_EMBEDDED_CREATIVE_GERUND_PATTERN.test(
    maskBackstageQuotedRequestText(normalizedPrompt, diagnostics)
  );

  return clauses.some(isBackstageReviewRequestClause)
    && !hasEmbeddedCreativeGerundRequest
    && !clauses.some(isBackstageCreativeRequestClause);
}

export function shouldUseBoundedBackstageReviewMode(prompt: string): boolean {
  return evaluateBoundedBackstageReviewMode(prompt);
}

export function inspectBackstageReviewClassification(
  prompt: string
): BackstageReviewClassificationDiagnostics {
  const diagnostics: BackstageReviewClassificationDiagnostics = {
    boundedReviewMode: false,
    quoteLookaheadScans: 0,
  };
  diagnostics.boundedReviewMode = evaluateBoundedBackstageReviewMode(
    prompt,
    diagnostics
  );
  return diagnostics;
}

function normalizeBackstageRequestClause(value: string): string {
  let normalized = value.trim();
  let previousValue = '';
  while (normalized && normalized !== previousValue) {
    previousValue = normalized;
    normalized = normalized
      .replace(BACKSTAGE_DIRECTIVE_HEADING_PREFIX_PATTERN, '')
      .replace(BACKSTAGE_DIRECT_STYLE_PREFIX_PATTERN, '')
      .replace(BACKSTAGE_REQUEST_CONNECTOR_PREFIX_PATTERN, '')
      .replace(BACKSTAGE_REQUEST_PREFIX_PATTERN, '')
      .trim();
  }
  return normalized;
}

function hasBackstageContextualFullReviewTarget(
  value: string,
  pattern: RegExp
): boolean {
  const targetMatch = value.match(pattern);
  if (!targetMatch || targetMatch.index === undefined) {
    return false;
  }

  const targetSuffix = value.slice(targetMatch.index + targetMatch[0].length);
  return !BACKSTAGE_NARROW_REVIEW_TARGET_SUFFIX_PATTERN.test(targetSuffix);
}

function isBackstageFullReviewScope(value: string): boolean {
  const normalizedValue = value.trim().replace(/[.!?;:]+$/, '').trim();
  const normalizedTargetValue = normalizedValue
    .replace(/^(?:and\s+)?(?:review|critique|assess|evaluate|analy[sz]e|rate|grade)\s+/i, '')
    .replace(/^(?:of|on|for|about)\s+/i, '')
    .trim();
  return Boolean(normalizedTargetValue)
    && !BACKSTAGE_DECISION_REVIEW_SCOPE_PATTERN.test(normalizedTargetValue)
    && (
      BACKSTAGE_FULL_REVIEW_BRAND_ONLY_PATTERN.test(normalizedTargetValue)
      || hasBackstageContextualFullReviewTarget(
        normalizedTargetValue,
        BACKSTAGE_FULL_REVIEW_STATE_TARGET_PATTERN
      )
      || hasBackstageContextualFullReviewTarget(
        normalizedTargetValue,
        BACKSTAGE_FULL_REVIEW_SO_FAR_PATTERN
      )
      || hasBackstageContextualFullReviewTarget(
        normalizedTargetValue,
        BACKSTAGE_FULL_REVIEW_COMPLETED_PORTION_PATTERN
      )
      || hasBackstageContextualFullReviewTarget(
        normalizedTargetValue,
        BACKSTAGE_FULL_REVIEW_EVENT_PATTERN
      )
      || hasBackstageContextualFullReviewTarget(
        normalizedTargetValue,
        BACKSTAGE_FULL_REVIEW_CONTEXTUAL_TARGET_PATTERN
      )
      || hasBackstageContextualFullReviewTarget(
        normalizedTargetValue,
        BACKSTAGE_FULL_REVIEW_CONTEXTUAL_BOOKING_PATTERN
      )
    );
}

function isBackstageReviewNounRequest(value: string): boolean {
  const normalizedValue = value.trim();
  const nounMatch = normalizedValue.match(BACKSTAGE_REVIEW_NOUN_PATTERN);
  if (!nounMatch) {
    return false;
  }

  const requestedScope = normalizedValue
    .slice(nounMatch[0].length)
    .trim()
    .replace(/[.!?;:]+$/, '')
    .trim();
  return !requestedScope || isBackstageFullReviewScope(requestedScope);
}

function isBackstageReviewRequestClause(clause: string): boolean {
  if (
    !clause
    || BACKSTAGE_DIRECT_STYLE_CLAUSE_PATTERN.test(clause)
    || BACKSTAGE_STATE_FIELD_PATTERN.test(clause)
  ) {
    return false;
  }
  const reviewVerbMatch = clause.match(BACKSTAGE_REVIEW_REQUEST_VERB_PATTERN);
  if (reviewVerbMatch) {
    return isBackstageFullReviewScope(
      clause.slice(reviewVerbMatch[0].length)
    );
  }

  if (isBackstageReviewNounRequest(clause)) {
    return true;
  }

  const requestMatch = clause.match(/^(?:give|provide|write|generate|create|draft)\b(?<object>.*)$/i);
  return isBackstageReviewNounRequest(requestMatch?.groups?.object ?? '');
}

function isBackstageCreativeRequestClause(clause: string): boolean {
  if (
    BACKSTAGE_STATE_FIELD_PATTERN.test(clause)
    || BACKSTAGE_CREATIVE_STATE_FIELD_PATTERN.test(clause)
    || BACKSTAGE_SCALAR_STATE_FIELD_PATTERN.test(clause)
    || BACKSTAGE_ATTRIBUTED_DIALOGUE_PATTERN.test(clause)
  ) {
    return false;
  }

  const requestMatch = clause.match(BACKSTAGE_CREATIVE_REQUEST_VERB_PATTERN);
  if (!requestMatch) {
    return false;
  }

  const verb = requestMatch[0].toLowerCase();
  if (
    ['book', 'rebook', 'rewrite', 'redo', 'rework'].includes(verb)
  ) {
    return true;
  }

  const requestedObject = clause.slice(requestMatch[0].length).trim();
  return !BACKSTAGE_REVIEW_NOUN_PATTERN.test(requestedObject);
}

function splitBackstageReviewSentences(value: string): string[] {
  const protectedAbbreviations = value.replace(
    BACKSTAGE_REVIEW_ABBREVIATION_PATTERN,
    match => match.replace(/\./g, '\u0000')
  );
  return protectedAbbreviations
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.replace(/\u0000/g, '.').trim())
    .filter(Boolean);
}

function compactBackstageReviewBulletItem(item: string): string {
  const normalizedItem = stripBackstageDirectAnswerPreamblePrefix(
    stripMarkdownFormatting(item)
  );
  const sentences = splitBackstageReviewSentences(normalizedItem);
  return sentences.length > 2
    ? sentences.slice(0, 2).join(' ')
    : normalizedItem;
}

export function applyBackstageReviewOutputContract(output: string): string {
  let listItems = collectTopLevelListItems(output);
  if (listItems.length === 0) {
    const normalizedOutput = stripBackstageDirectAnswerPreamblePrefix(
      stripMarkdownFormatting(output)
    );
    const proseSentences = splitBackstageReviewSentences(normalizedOutput)
      .slice(0, BACKSTAGE_REVIEW_BULLET_COUNT * 2);
    listItems = [];
    for (let index = 0; index < proseSentences.length; index += 2) {
      listItems.push(proseSentences.slice(index, index + 2).join(' '));
    }
  }

  return listItems
    .slice(0, BACKSTAGE_REVIEW_BULLET_COUNT)
    .map((item, index) => `${index + 1}. ${compactBackstageReviewBulletItem(item)}`)
    .join('\n');
}
