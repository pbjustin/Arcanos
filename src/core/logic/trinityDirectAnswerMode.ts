import { buildDirectAnswerModeSystemInstruction } from '@services/directAnswerMode.js';

const DIRECT_ANSWER_PREAMBLE_PREFIX_PATTERNS: RegExp[] = [
  /^here(?:'s| is)\s+(?:the\s+)?(?:direct\s+)?answer\s*:\s*/i,
  /^direct\s+answer\s*:\s*/i,
  /^answer\s*:\s*/i,
  /^response\s*:\s*/i
];

const DIRECT_ANSWER_BULLET_COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};

const DIRECT_ANSWER_BULLET_COUNT_PATTERN =
  /\b(?:(?<digit>\d{1,2})|(?<word>one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s+(?:short\s+|brief\s+|compact\s+)?(?:top-level\s+)?(?:numbered\s+)?bullets?\b/i;

const DIRECT_ANSWER_SHORT_BULLET_PATTERN =
  /\b(?:short|brief|compact)\s+bullets?\b/i;
const DIRECT_ANSWER_LIST_ITEM_PATTERN = /^(?:[-*]|(?<number>\d+)[.)])\s+/;
const DIRECT_ANSWER_INLINE_FIRST_ITEM_PATTERN = /^(.+[.!?:;])\s+1[.)]\s+(.+)$/;
const DIRECT_ANSWER_LIMITATION_LANGUAGE_PATTERN =
  /\b(can(?:not|'t)|unable to|do not have|don't have|haven't|have not|cannot confirm|can't confirm|cannot verify|can't verify|without live|without browsing|unverified|unconfirmed|inferred|unavailable)\b/i;

export const TRINITY_DIRECT_ANSWER_AUDIT_FLAG = 'DIRECT_ANSWER_MODE_ACTIVE';
export const TRINITY_DIRECT_ANSWER_STAGE = 'ARCANOS-DIRECT-ANSWER';

export interface TrinityDirectAnswerOutputContract {
  requestedBulletCount?: number;
  requiresShortBullets: boolean;
}

function stripMarkdownFormatting(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

function stripDirectAnswerPreamblePrefix(value: string): string {
  let normalizedValue = value.trim();

  for (const preamblePattern of DIRECT_ANSWER_PREAMBLE_PREFIX_PATTERNS) {
    normalizedValue = normalizedValue.replace(preamblePattern, '').trim();
  }

  return normalizedValue;
}

function splitCollapsedDirectAnswerListLines(
  text: string,
  requestedBulletCount: number | undefined
): string[] {
  return text.split(/\r?\n/).flatMap(line => {
    const normalizedLine = stripMarkdownFormatting(line.trim());
    const markerMatches = Array.from(normalizedLine.matchAll(/(?:^|\s)(\d+)[.)]\s+/g));
    const markerNumbers = markerMatches.map(match => Number.parseInt(match[1] ?? '', 10));
    const hasSequentialMarkers = markerNumbers.length >= 2
      && markerNumbers.every((number, index) => index === 0 || number === markerNumbers[index - 1]! + 1);
    const firstMarkerStart = (markerMatches[0]?.index ?? 0)
      + (/^\s/.test(markerMatches[0]?.[0] ?? '') ? 1 : 0);
    const prefix = normalizedLine.slice(0, firstMarkerStart).trim();
    const firstMarkerNumber = markerNumbers[0];
    const matchesRequestedList = requestedBulletCount !== undefined
      && requestedBulletCount >= 2
      && (
        (firstMarkerNumber === 1 && markerNumbers.length >= requestedBulletCount)
        || (
          firstMarkerNumber === 2
          && markerNumbers.length >= requestedBulletCount - 1
          && DIRECT_ANSWER_LIMITATION_LANGUAGE_PATTERN.test(prefix)
        )
      );
    if (!hasSequentialMarkers || !matchesRequestedList) {
      return [line];
    }

    const markerStarts = markerMatches.map(match =>
      (match.index ?? 0) + (/^\s/.test(match[0]) ? 1 : 0)
    );
    const logicalLines: string[] = [];
    if ((markerStarts[0] ?? 0) > 0) {
      logicalLines.push(normalizedLine.slice(0, markerStarts[0]).trim());
    }
    for (let index = 0; index < markerStarts.length; index += 1) {
      logicalLines.push(normalizedLine.slice(
        markerStarts[index],
        markerStarts[index + 1] ?? normalizedLine.length
      ).trim());
    }
    return logicalLines.filter(Boolean);
  });
}

function resolveRequestedBulletCount(
  matchedCountText: string | undefined
): number | undefined {
  if (!matchedCountText) {
    return undefined;
  }

  const normalizedCountText = matchedCountText.trim().toLowerCase();
  const parsedDigitCount = Number.parseInt(normalizedCountText, 10);
  //audit Assumption: numeric bullet requests should stay bounded to avoid over-inflating the response contract; failure risk: unrealistic counts create oversized outputs and timeout pressure; expected invariant: bullet count, when present, is a small positive integer; handling strategy: reject unsupported counts by returning undefined.
  if (Number.isFinite(parsedDigitCount)) {
    return parsedDigitCount >= 1 && parsedDigitCount <= 12
      ? parsedDigitCount
      : undefined;
  }

  return DIRECT_ANSWER_BULLET_COUNT_WORDS[normalizedCountText];
}

function collectTopLevelListItems(
  text: string,
  requestedBulletCount: number | undefined
): string[] {
  const items: string[] = [];
  let currentItem = '';
  let pendingLimitationPrefix = '';

  for (const line of splitCollapsedDirectAnswerListLines(text, requestedBulletCount)) {
    const trimmedLine = line.trim();
    const normalizedListLine = stripMarkdownFormatting(trimmedLine);
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;

    if (!trimmedLine || /^---+$/.test(trimmedLine) || /^#{1,6}\s+/.test(trimmedLine)) {
      continue;
    }

    const leadingListMarker = normalizedListLine.match(DIRECT_ANSWER_LIST_ITEM_PATTERN);
    const hasLeadingListMarker = Boolean(leadingListMarker);
    const inlineFirstItem = indentation <= 1
      && !currentItem
      && items.length === 0
      && !hasLeadingListMarker
      ? normalizedListLine.match(DIRECT_ANSWER_INLINE_FIRST_ITEM_PATTERN)
      : null;

    if (inlineFirstItem) {
      const prefix = inlineFirstItem[1]?.trim() ?? '';
      const itemBody = inlineFirstItem[2]?.trim() ?? '';
      currentItem = DIRECT_ANSWER_LIMITATION_LANGUAGE_PATTERN.test(prefix)
        ? `${prefix} ${itemBody}`.trim()
        : itemBody;
      continue;
    }

    if (
      indentation <= 1
      && !currentItem
      && items.length === 0
      && !hasLeadingListMarker
      && DIRECT_ANSWER_LIMITATION_LANGUAGE_PATTERN.test(normalizedListLine)
    ) {
      pendingLimitationPrefix = normalizedListLine;
      continue;
    }

    const isTopLevelItem = indentation <= 1 && hasLeadingListMarker;
    const isNestedItem = indentation > 1 && hasLeadingListMarker;

    if (isTopLevelItem) {
      if (currentItem) {
        items.push(currentItem.trim());
      }
      const itemBody = normalizedListLine.replace(DIRECT_ANSWER_LIST_ITEM_PATTERN, '');
      const markerNumber = Number.parseInt(leadingListMarker?.groups?.number ?? '', 10);
      if (pendingLimitationPrefix && Number.isFinite(markerNumber) && markerNumber > 1) {
        items.push(pendingLimitationPrefix);
        currentItem = itemBody;
      } else {
        currentItem = pendingLimitationPrefix
          ? `${pendingLimitationPrefix} ${itemBody}`.trim()
          : itemBody;
      }
      pendingLimitationPrefix = '';
      continue;
    }

    if (currentItem) {
      const appendedLine = isNestedItem
        ? normalizedListLine.replace(DIRECT_ANSWER_LIST_ITEM_PATTERN, '')
        : trimmedLine;
      currentItem = `${currentItem} ${appendedLine}`.trim();
    }
  }

  if (currentItem) {
    items.push(currentItem.trim());
  }

  return items;
}

function compactDirectAnswerBulletItem(
  item: string,
  requiresShortBullets: boolean
): string {
  const normalizedItem = stripDirectAnswerPreamblePrefix(stripMarkdownFormatting(item));
  if (!requiresShortBullets || normalizedItem.length <= 140) {
    return normalizedItem;
  }

  const firstSentence = normalizedItem.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence && firstSentence.length >= 24 && firstSentence.length <= 140) {
    return firstSentence;
  }

  const firstClause = normalizedItem.split(/\s--\s|\s[-:]\s/)[0]?.trim();
  if (firstClause && firstClause.length >= 24 && firstClause.length <= 140) {
    return firstClause;
  }

  return `${normalizedItem.slice(0, 137).trimEnd()}...`;
}

function buildDirectAnswerResponseShapeInstruction(
  contract: TrinityDirectAnswerOutputContract | null
): string {
  if (!contract) {
    return 'Keep the answer concise and return only the final user-facing content.';
  }

  if (!contract.requestedBulletCount) {
    return [
      'Return only top-level numbered bullets.',
      'Do not add a preamble, heading, or conclusion.',
      'Do not use sub-bullets or nested lists.',
      contract.requiresShortBullets
        ? 'Each bullet must be one compact sentence.'
        : 'Each bullet must stay concise.'
    ].join(' ');
  }

  const bulletSentence = contract.requiresShortBullets
    ? 'Each bullet must be one compact sentence.'
    : 'Each bullet must be one compact paragraph.';

  return [
    `Return only ${contract.requestedBulletCount} top-level numbered bullets.`,
    'Do not add a preamble, heading, or conclusion.',
    'Do not use sub-bullets or nested lists.',
    bulletSentence
  ].join(' ');
}

/**
 * Parse user-visible direct-answer formatting constraints from a prompt.
 * Inputs/outputs: raw user prompt -> normalized bullet-format contract, or null when no bullet contract is present.
 * Edge cases: unsupported counts resolve to null so normal direct-answer formatting still works.
 */
export function parseTrinityDirectAnswerOutputContract(
  prompt: string
): TrinityDirectAnswerOutputContract | null {
  const matchedBulletCount = prompt.match(DIRECT_ANSWER_BULLET_COUNT_PATTERN);
  const requestedBulletCount = resolveRequestedBulletCount(
    matchedBulletCount?.groups?.digit ?? matchedBulletCount?.groups?.word
  );
  const requiresShortBullets = DIRECT_ANSWER_SHORT_BULLET_PATTERN.test(prompt);

  if (!requestedBulletCount && !requiresShortBullets) {
    return null;
  }

  return {
    requestedBulletCount,
    requiresShortBullets
  };
}

/**
 * Build the strict system instruction used by Trinity direct-answer mode.
 * Inputs/outputs: memory context summary + user prompt -> direct-answer system instruction string.
 * Edge cases: blank memory context becomes an explicit "no memory" note so the model does not invent hidden context.
 */
export function buildTrinityDirectAnswerSystemInstruction(
  memoryContextSummary: string,
  prompt: string
): string {
  const directAnswerContract = parseTrinityDirectAnswerOutputContract(prompt);
  const memoryInstruction = memoryContextSummary.trim()
    ? `Relevant memory context: ${memoryContextSummary.trim()}`
    : 'No relevant memory context is available.';

  return [
    buildDirectAnswerModeSystemInstruction({
      moduleLabel: 'ARCANOS core assistant',
      domainGuidance: 'Provide the final user-facing answer for the request while using relevant memory context when it materially helps.',
      prohibitedBehaviors: [
        'simulate scenes',
        'role-play a persona',
        'narrate internal ARCANOS processes',
        'frame the reply as a hypothetical run'
      ],
      missingInfoBehavior: 'If important information is missing, say what is missing briefly instead of inventing details.'
    }),
    'Do not mention Trinity, routing stages, audit traces, or internal reasoning.',
    'Do not add preambles, framing, or meta commentary.',
    'Follow the user-requested output format exactly when one is specified.',
    buildDirectAnswerResponseShapeInstruction(directAnswerContract),
    memoryInstruction
  ].join(' ');
}

/**
 * Normalize a Trinity direct-answer model output into the user-requested final shape.
 * Inputs/outputs: raw model output + original prompt -> cleaned user-facing answer text.
 * Edge cases: when the model ignores a bullet request, the fallback keeps the cleaned raw output instead of fabricating bullets.
 */
export function applyTrinityDirectAnswerOutputContract(
  output: string,
  prompt: string
): string {
  const directAnswerContract = parseTrinityDirectAnswerOutputContract(prompt);
  const listItems = collectTopLevelListItems(
    output,
    directAnswerContract?.requestedBulletCount
  );

  //audit Assumption: direct-answer list prompts want the final answer body only; failure risk: model preambles or extra bullets leak through despite direct-answer mode; expected invariant: list-shaped prompts return normalized top-level bullets, optionally capped by the requested count; handling strategy: trim and compact top-level list items when the model produced a list and otherwise fall back to cleaned plain text.
  if (directAnswerContract && listItems.length > 0) {
    const normalizedItems = directAnswerContract.requestedBulletCount
      ? listItems.slice(0, directAnswerContract.requestedBulletCount)
      : listItems;

    return normalizedItems
      .map((item, index) => `${index + 1}. ${compactDirectAnswerBulletItem(item, directAnswerContract.requiresShortBullets)}`)
      .join('\n');
  }

  return stripDirectAnswerPreamblePrefix(stripMarkdownFormatting(output));
}

/**
 * Resolve a smaller token budget for Trinity direct-answer prompts.
 * Inputs/outputs: original prompt + default token budget -> bounded direct-answer token limit.
 * Edge cases: generic direct-answer requests still keep a moderate floor so concise answers do not truncate.
 */
export function resolveTrinityDirectAnswerTokenLimit(
  prompt: string,
  defaultTokenLimit: number
): number {
  const directAnswerContract = parseTrinityDirectAnswerOutputContract(prompt);
  if (!directAnswerContract) {
    return Math.min(defaultTokenLimit, 500);
  }

  if (!directAnswerContract.requestedBulletCount) {
    return Math.min(defaultTokenLimit, directAnswerContract.requiresShortBullets ? 320 : 500);
  }

  const tokenBudgetPerBullet = directAnswerContract.requiresShortBullets ? 48 : 80;
  const constrainedTokenLimit = Math.max(
    120,
    directAnswerContract.requestedBulletCount * tokenBudgetPerBullet
  );

  //audit Assumption: direct-answer bullet prompts should complete within a smaller bounded budget than open-ended Trinity replies; failure risk: verbose generations ignore the requested list shape and push past route timeouts; expected invariant: token budget scales with the requested bullet count while remaining conservative; handling strategy: clamp the direct-answer limit below the normal default ceiling.
  return Math.min(defaultTokenLimit, constrainedTokenLimit);
}
