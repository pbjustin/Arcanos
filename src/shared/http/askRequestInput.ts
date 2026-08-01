const BRAIN_TEXT_INPUT_FIELDS = [
  'prompt',
  'message',
  'userInput',
  'content',
  'text',
  'query',
] as const;

const API_ARCANOS_TEXT_INPUT_FIELDS = [
  'prompt',
  'userInput',
  'content',
  'text',
  'query',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Match the ask validator's GET-first-array and non-GET-body source selection. */
export function resolveAskRequestSource(
  method: string,
  body: unknown,
  query: unknown
): Record<string, unknown> {
  const source = asRecord(method.trim().toUpperCase() === 'GET' ? query : body) ?? {};
  if (method.trim().toUpperCase() !== 'GET') {
    return source;
  }

  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
  );
}

/** Match `/brain`'s prompt-first, first-non-empty text alias contract. */
export function extractBrainTextInput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const field of BRAIN_TEXT_INPUT_FIELDS) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/** Match deprecated API Arcanos input precedence; `message` is not an input alias there. */
export function extractApiArcanosInput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  for (const field of API_ARCANOS_TEXT_INPUT_FIELDS) {
    const candidate = record[field];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}
