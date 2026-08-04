import { validateGptIdentifier } from './gptIdentifier.js';

export interface GptModuleMapEntry {
  module: string;
  route: string;
}

export type GptModuleMapMatchMethod =
  | 'exact'
  | 'normalized'
  | 'substring'
  | 'token-subset'
  | 'fuzzy';

export interface ResolvedGptModuleMapEntry<TEntry extends GptModuleMapEntry> {
  entry: TEntry;
  matchMethod: GptModuleMapMatchMethod;
  matchedId: string;
}

function normalizeGptId(value: string): string {
  return value.toLowerCase().trim();
}

function stripNonAlphanumeric(value: string): string {
  return normalizeGptId(value).replace(/[^a-z0-9]+/g, '');
}

function levenshteinDistance(left: string, right: string): number {
  const normalizedLeft = stripNonAlphanumeric(left);
  const normalizedRight = stripNonAlphanumeric(right);
  const leftLength = normalizedLeft.length;
  const rightLength = normalizedRight.length;

  if (leftLength === 0) {
    return rightLength;
  }
  if (rightLength === 0) {
    return leftLength;
  }

  let previousRow = Array.from(
    { length: rightLength + 1 },
    (_unused, rightIndex) => rightIndex,
  );
  let currentRow = Array<number>(rightLength + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= leftLength; leftIndex += 1) {
    currentRow[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= rightLength; rightIndex += 1) {
      const substitutionCost = normalizedLeft[leftIndex - 1] === normalizedRight[rightIndex - 1]
        ? 0
        : 1;
      currentRow[rightIndex] = Math.min(
        (previousRow[rightIndex] ?? 0) + 1,
        (currentRow[rightIndex - 1] ?? 0) + 1,
        (previousRow[rightIndex - 1] ?? 0) + substitutionCost,
      );
    }
    [previousRow, currentRow] = [currentRow, previousRow];
  }

  return previousRow[rightLength] ?? rightLength;
}

/** Resolve a GPT ID with the exact matching order used by the public dispatcher. */
export function resolveGptModuleMapEntry<TEntry extends GptModuleMapEntry>(
  incomingGptId: string,
  gptModuleMap: Readonly<Record<string, TEntry>>
): ResolvedGptModuleMapEntry<TEntry> | null {
  const incomingValidation = validateGptIdentifier(incomingGptId);
  if (!incomingValidation.ok) {
    return null;
  }

  const validatedIncomingGptId = incomingValidation.value;
  const configuredGptIds = Object.keys(gptModuleMap).filter(
    (gptId) => validateGptIdentifier(gptId).ok
  );

  const exactMatch = configuredGptIds.find((gptId) => gptId === validatedIncomingGptId);
  if (exactMatch) {
    return {
      entry: gptModuleMap[exactMatch],
      matchMethod: 'exact',
      matchedId: exactMatch,
    };
  }

  const normalizedIncomingGptId = normalizeGptId(validatedIncomingGptId);
  const normalizedEntry = gptModuleMap[normalizedIncomingGptId];
  if (normalizedEntry) {
    return {
      entry: normalizedEntry,
      matchMethod: 'normalized',
      matchedId: normalizedIncomingGptId,
    };
  }

  const substringMatch = [...configuredGptIds]
    .sort((left, right) => right.length - left.length)
    .find((gptId) => validatedIncomingGptId.includes(gptId));
  if (substringMatch) {
    return {
      entry: gptModuleMap[substringMatch],
      matchMethod: 'substring',
      matchedId: substringMatch,
    };
  }

  const incomingTokens = new Set(
    normalizeGptId(validatedIncomingGptId).split(/[^a-z0-9]+/).filter(Boolean)
  );
  for (const gptId of configuredGptIds) {
    const configuredTokens = normalizeGptId(gptId).split(/[^a-z0-9]+/).filter(Boolean);
    if (configuredTokens.length === 0) {
      continue;
    }
    const commonTokenCount = configuredTokens.filter((token) => incomingTokens.has(token)).length;
    if (commonTokenCount / configuredTokens.length >= 0.6) {
      return {
        entry: gptModuleMap[gptId],
        matchMethod: 'token-subset',
        matchedId: gptId,
      };
    }
  }

  let bestMatchId: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const gptId of configuredGptIds) {
    const distance = levenshteinDistance(validatedIncomingGptId, gptId);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatchId = gptId;
    }
  }

  if (bestMatchId) {
    const threshold = Math.max(2, Math.floor(bestMatchId.length * 0.25));
    if (bestDistance <= threshold) {
      return {
        entry: gptModuleMap[bestMatchId],
        matchMethod: 'fuzzy',
        matchedId: bestMatchId,
      };
    }
  }

  return null;
}
