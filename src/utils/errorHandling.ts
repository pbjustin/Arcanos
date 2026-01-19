/**
 * Resolve a human-readable error message from unknown errors.
 *
 * Purpose: Normalize error messages for logging and API responses.
 * Inputs/Outputs: Accepts an unknown error value and optional fallback; returns a string message.
 * Edge cases: Handles non-Error thrown values and missing message fields by returning the fallback.
 */
export function resolveErrorMessage(error: unknown, fallback: string = 'Unknown error'): string {
  //audit Assumption: thrown Error instances contain useful messages; risk: message might be empty; invariant: returned value is a string; handling: return Error.message when available.
  if (error instanceof Error) {
    return error.message;
  }

  //audit Assumption: some throw sites use strings; risk: empty string; invariant: returned value is a string; handling: return the string directly.
  if (typeof error === 'string') {
    return error;
  }

  //audit Assumption: objects may expose a message property; risk: non-string message; invariant: returned value is a string; handling: validate message type before returning.
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    //audit Assumption: message can be coerced; risk: non-string values; invariant: returned value is a string; handling: return only when message is a string.
    if (typeof message === 'string') {
      return message;
    }
  }

  //audit Assumption: fallback is safe to expose; risk: losing context; invariant: returned value is a string; handling: return provided fallback.
  return fallback;
}
