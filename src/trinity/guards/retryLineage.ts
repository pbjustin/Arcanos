const lineageRetries: Record<string, number> = {};

const MAX_RETRIES = 3;

export function registerRetry(lineageId: string) {
  lineageRetries[lineageId] =
    (lineageRetries[lineageId] || 0) + 1;

  if (lineageRetries[lineageId] > MAX_RETRIES) {
    throw new Error("Retry limit exceeded");
  }
}
