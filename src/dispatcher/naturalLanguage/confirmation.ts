const CONFIRMATION_TOKEN_BODY_KEY = 'confirmation_token';
const CONFIRMATION_HEADER_TOKEN_PREFIX = 'token:';

export const DISPATCH_RUN_BODY_KEYS = new Set([
  'utterance',
  'context',
  'dryRun',
  CONFIRMATION_TOKEN_BODY_KEY
]);

export function readDispatchConfirmationTokenField(value: unknown):
  | { ok: true; confirmationChallengeId: string }
  | { ok: false; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, message: 'confirmation_token must be a non-empty string when provided.' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'confirmation_token must be a non-empty string when provided.' };
  }

  const confirmationChallengeId = trimmed.toLowerCase().startsWith(CONFIRMATION_HEADER_TOKEN_PREFIX)
    ? trimmed.slice(CONFIRMATION_HEADER_TOKEN_PREFIX.length).trim()
    : trimmed;

  if (confirmationChallengeId.length === 0 || /\s/u.test(confirmationChallengeId)) {
    return { ok: false, message: 'confirmation_token must be a single non-empty token value.' };
  }

  return { ok: true, confirmationChallengeId };
}

export function stripDispatchConfirmationToken(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  confirmationToken?: unknown;
} {
  if (!Object.prototype.hasOwnProperty.call(body, CONFIRMATION_TOKEN_BODY_KEY)) {
    return { body };
  }

  const nextBody = { ...body };
  const confirmationToken = nextBody[CONFIRMATION_TOKEN_BODY_KEY];
  delete nextBody[CONFIRMATION_TOKEN_BODY_KEY];
  return {
    body: nextBody,
    confirmationToken
  };
}
