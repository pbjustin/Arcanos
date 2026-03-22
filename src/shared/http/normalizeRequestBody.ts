function tryParseBodyRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Normalize loosely encoded HTTP request bodies into a JSON object shape.
 * Inputs/outputs: raw body payload -> object record or `null` when coercion is unsafe.
 * Edge cases: x-www-form-urlencoded bodies that encode a single JSON object key are reparsed for GPT/tool callers.
 */
export function normalizeRequestBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const recordBody = body as Record<string, unknown>;
    const entries = Object.entries(recordBody);
    if (entries.length === 1) {
      const [candidateJson, candidateValue] = entries[0];
      if (candidateValue === '' || candidateValue === null) {
        const reparsedBody = tryParseBodyRecord(candidateJson);
        if (reparsedBody) {
          return reparsedBody;
        }
      }
    }
    return recordBody;
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return tryParseBodyRecord(body);
  }

  return null;
}
