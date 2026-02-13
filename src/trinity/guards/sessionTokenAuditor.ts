const SESSION_LIMIT = 20000;

const sessionUsage: Record<string, number> = {};

export function recordSessionTokens(
  sessionId: string,
  tokens: number
) {
  sessionUsage[sessionId] =
    (sessionUsage[sessionId] || 0) + tokens;

  if (sessionUsage[sessionId] > SESSION_LIMIT) {
    throw new Error("Session token limit exceeded");
  }
}
