export const BACKSTAGE_STORYLINE_MAX_BYTES = 16 * 1024;
export const BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS = 100;
export const BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS = 25;
export const BACKSTAGE_STORYLINE_PROMPT_BEATS = 5;
export const BACKSTAGE_STORYLINE_PUBLIC_RESPONSE_MAX_BYTES = 512 * 1024;
export const BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE =
  'BACKSTAGE_STORYLINE_INVALID';
export const BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE =
  'BACKSTAGE_STORYLINE_PERSISTENCE_FAILED';
export const BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_MESSAGE =
  'Storyline persistence could not be confirmed.';

export interface StorylineBeat {
  [key: string]: unknown;
}

/** Identify caller-controlled storyline beats that fail the shared runtime contract. */
export class BackstageStorylineValidationError extends TypeError {
  readonly code = BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'BackstageStorylineValidationError';
  }
}

/** Recognize the typed storyline validation failure at in-process adapter boundaries. */
export function isBackstageStorylineValidationError(
  value: unknown
): value is BackstageStorylineValidationError {
  return value instanceof BackstageStorylineValidationError;
}

const RETRYABLE_STORYLINE_SQLSTATES = new Set([
  '40001',
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03'
]);
const RETRYABLE_STORYLINE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT'
]);
const RETRYABLE_STORYLINE_TRANSPORT_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Database not configured or not connected',
  'Database pool not available',
  'canceling statement due to statement timeout',
  'timeout exceeded when trying to connect'
]);
const MAX_STORYLINE_PERSISTENCE_CAUSES = 8;

/** Represent a safe failure when the durable storyline invariant is not trustworthy. */
export class BackstageStorylinePersistenceError extends Error {
  readonly code = BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE;

  constructor(cause?: unknown) {
    super(
      BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_MESSAGE,
      cause === undefined ? undefined : { cause }
    );
    this.name = 'BackstageStorylinePersistenceError';
  }
}

/** Recognize the safe durable-storyline failure at transport boundaries. */
export function isBackstageStorylinePersistenceError(
  value: unknown
): value is BackstageStorylinePersistenceError {
  return value instanceof BackstageStorylinePersistenceError;
}

/** Permit volatile fallback only for classified transient database availability failures. */
export function isRetryableBackstageStorylinePersistenceCause(
  value: unknown
): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();

  for (
    let inspected = 0;
    pending.length > 0 && inspected < MAX_STORYLINE_PERSISTENCE_CAUSES;
    inspected += 1
  ) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);

    try {
      const candidate = current as {
        cause?: unknown;
        code?: unknown;
        errors?: unknown;
        message?: unknown;
        rollbackCause?: unknown;
      };
      const code = typeof candidate.code === 'string'
        ? candidate.code.trim().toUpperCase()
        : '';
      if (
        (code.length === 5 && code.startsWith('08'))
        || RETRYABLE_STORYLINE_SQLSTATES.has(code)
        || RETRYABLE_STORYLINE_TRANSPORT_CODES.has(code)
        || (
          typeof candidate.message === 'string'
          && RETRYABLE_STORYLINE_TRANSPORT_MESSAGES.has(candidate.message.trim())
        )
      ) {
        return true;
      }

      if (candidate.cause !== undefined) {
        pending.push(candidate.cause);
      }
      if (candidate.rollbackCause !== undefined) {
        pending.push(candidate.rollbackCause);
      }
      if (Array.isArray(candidate.errors)) {
        pending.push(...candidate.errors.slice(0, MAX_STORYLINE_PERSISTENCE_CAUSES));
      }
    } catch {
      // Ignore hostile accessors while keeping classification bounded.
    }
  }

  return false;
}

/** Append one volatile beat while retaining only the contract's newest bounded set. */
export function appendBoundedBackstageStorylineBeat(
  retainedBeats: readonly StorylineBeat[],
  beat: StorylineBeat
): StorylineBeat[] {
  const firstRetainedIndex = Math.max(
    0,
    retainedBeats.length - BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS + 1
  );
  return [...retainedBeats.slice(firstRetainedIndex), beat];
}

/** Select the contract's newest bounded response while preserving chronological order. */
export function selectBackstageStorylineResponseBeats(
  retainedBeats: readonly StorylineBeat[]
): StorylineBeat[] {
  return retainedBeats.slice(-BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function invalidJsonObject(): BackstageStorylineValidationError {
  return new BackstageStorylineValidationError(
    'Storyline beat payload must be a JSON object.'
  );
}

/** Parse one exact bounded storage component without trusting its parallel JSONB projection. */
export function parseBackstageStorylineSerializedPayload(
  serialized: unknown
): StorylineBeat {
  if (
    typeof serialized !== 'string'
    || Buffer.byteLength(serialized, 'utf8') > BACKSTAGE_STORYLINE_MAX_BYTES
  ) {
    throw new Error('Backstage storyline storage contained an invalid serialized beat.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('Backstage storyline storage contained invalid JSON.');
  }

  if (!isPlainObject(parsed)) {
    throw new Error('Backstage storyline storage contained a non-object beat.');
  }

  return parsed;
}

/**
 * Validate and JSON-normalize one storyline beat before any mutation or fallback effect.
 *
 * The JSON round trip removes accessors and prototypes so database serialization observes
 * the exact value whose compact UTF-8 representation passed the public byte contract.
 */
export function parseBackstageStorylinePayload(payload: unknown): StorylineBeat {
  if (!isPlainObject(payload)) {
    throw invalidJsonObject();
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new BackstageStorylineValidationError(
      'Storyline beat payload must contain valid JSON values.'
    );
  }

  if (typeof serialized !== 'string') {
    throw invalidJsonObject();
  }

  if (Buffer.byteLength(serialized, 'utf8') > BACKSTAGE_STORYLINE_MAX_BYTES) {
    throw new BackstageStorylineValidationError(
      `Storyline beat payload must not exceed ${BACKSTAGE_STORYLINE_MAX_BYTES} bytes of serialized UTF-8 JSON.`
    );
  }

  let normalized: unknown;
  try {
    normalized = JSON.parse(serialized) as unknown;
  } catch {
    throw new BackstageStorylineValidationError(
      'Storyline beat payload must contain valid JSON values.'
    );
  }

  if (!isPlainObject(normalized)) {
    throw invalidJsonObject();
  }

  return normalized;
}
