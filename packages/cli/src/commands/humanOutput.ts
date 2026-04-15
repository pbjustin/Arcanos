const COMMON_TEXT_KEYS = ["text", "message", "result", "response", "output", "prompt"] as const;

export function extractHumanReadableText(...values: unknown[]): string {
  const visited = new Set<unknown>();

  for (const value of values) {
    const text = extractTextValue(value, visited);
    if (text) {
      return text;
    }
  }

  return "";
}

function extractTextValue(value: unknown, visited: Set<unknown>): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (visited.has(value)) {
    return "";
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractTextValue(item, visited);
      if (text) {
        return text;
      }
    }
    return "";
  }

  const recordValue = value as Record<string, unknown>;
  for (const key of COMMON_TEXT_KEYS) {
    const candidate = recordValue[key];
    const text = extractTextValue(candidate, visited);
    if (text) {
      return text;
    }
  }

  return "";
}
