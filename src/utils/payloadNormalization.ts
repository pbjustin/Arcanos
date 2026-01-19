export function extractTextPrompt(
  payload: unknown,
  candidateKeys: string[] = ['prompt', 'message', 'text', 'content', 'query']
): string {
  if (typeof payload === 'string') {
    return payload.trim();
  }

  if (!payload || typeof payload !== 'object') {
    return '';
  }

  for (const key of candidateKeys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

export function normalizeStringList(...candidates: Array<unknown>): string[] {
  const results: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      results.push(candidate.trim());
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry === 'string' && entry.trim()) {
          results.push(entry.trim());
        }
      }
    }
  }

  return Array.from(new Set(results));
}

