export const MAX_GPT_IDENTIFIER_LENGTH = 256;
export const INVALID_GPT_IDENTIFIER_PLACEHOLDER = 'invalid';

export type GptIdentifierValidation =
  | { ok: true; value: string }
  | {
      ok: false;
      value: string;
      error: {
        code: 'BAD_REQUEST';
        message: 'Missing gptId' | 'gptId too long';
      };
    };

/**
 * Normalize the public GPT route identifier before registry, logging, or
 * telemetry work. The inclusive 256-character maximum preserves the existing
 * direct-dispatch contract.
 */
export function validateGptIdentifier(
  gptId: string | null | undefined
): GptIdentifierValidation {
  const normalized = (gptId ?? '').trim();
  if (!normalized) {
    return {
      ok: false,
      value: '',
      error: { code: 'BAD_REQUEST', message: 'Missing gptId' },
    };
  }

  if (normalized.length > MAX_GPT_IDENTIFIER_LENGTH) {
    return {
      ok: false,
      value: INVALID_GPT_IDENTIFIER_PLACEHOLDER,
      error: { code: 'BAD_REQUEST', message: 'gptId too long' },
    };
  }

  return { ok: true, value: normalized };
}
