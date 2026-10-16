export function resolveErrorMessage(error: unknown, fallback: string = "Unknown error"): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return fallback;
}

/**
 * Preserve raw thrown-value diagnostics for callers that already stringify them.
 * Unlike resolveErrorMessage, this does not extract message fields from objects
 * or replace unknown values with a controlled fallback. String conversion can
 * itself throw, matching the original diagnostic expression.
 */
export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
