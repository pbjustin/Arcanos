export const BACKSTAGE_ROSTER_MAX_ITEMS = 100;
export const BACKSTAGE_WRESTLER_NAME_MAX_LENGTH = 120;
export const BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE = 'BACKSTAGE_ROSTER_INVALID';
export const BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE =
  'BACKSTAGE_ROSTER_PERSISTENCE_FAILED';
export const BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE =
  'Roster update persistence could not be confirmed.';

export interface Wrestler {
  name: string;
  overall: number;
}

/** Identify caller-controlled roster payloads that fail the shared runtime contract. */
export class BackstageRosterValidationError extends TypeError {
  readonly code = BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'BackstageRosterValidationError';
  }
}

const RETRYABLE_ROSTER_SQLSTATES = new Set([
  '40001',
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03'
]);
const RETRYABLE_ROSTER_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT'
]);
const RETRYABLE_ROSTER_TRANSPORT_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Database not configured or not connected',
  'Database pool not available',
  'canceling statement due to statement timeout',
  'timeout exceeded when trying to connect'
]);
const MAX_ROSTER_PERSISTENCE_CAUSES = 8;

/** Represent a safely disclosed failure of the authoritative roster transaction. */
export class BackstageRosterPersistenceError extends Error {
  readonly code = BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE;
  readonly retryable: boolean;

  constructor(options: { retryable?: boolean; cause?: unknown } = {}) {
    super(
      BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = 'BackstageRosterPersistenceError';
    this.retryable = options.retryable ?? false;
  }
}

/** Classify only transient database/transport failures as safe to retry. */
export function isRetryableBackstageRosterPersistenceCause(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();

  for (
    let inspected = 0;
    pending.length > 0 && inspected < MAX_ROSTER_PERSISTENCE_CAUSES;
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
      };
      const code = typeof candidate.code === 'string'
        ? candidate.code.trim().toUpperCase()
        : '';
      if (
        (code.length === 5 && code.startsWith('08'))
        || RETRYABLE_ROSTER_SQLSTATES.has(code)
        || RETRYABLE_ROSTER_TRANSPORT_CODES.has(code)
        || (
          typeof candidate.message === 'string'
          && RETRYABLE_ROSTER_TRANSPORT_MESSAGES.has(candidate.message.trim())
        )
      ) {
        return true;
      }

      if (candidate.cause !== undefined) {
        pending.push(candidate.cause);
      }
      if (Array.isArray(candidate.errors)) {
        pending.push(...candidate.errors.slice(0, MAX_ROSTER_PERSISTENCE_CAUSES));
      }
    } catch {
      // Ignore hostile accessors and continue through the bounded queue.
    }
  }

  return false;
}

/** Recognize the typed roster validation failure at in-process adapter boundaries. */
export function isBackstageRosterValidationError(
  value: unknown
): value is BackstageRosterValidationError {
  return value instanceof BackstageRosterValidationError;
}

/** Recognize the typed roster persistence failure at in-process adapter boundaries. */
export function isBackstageRosterPersistenceError(
  value: unknown
): value is BackstageRosterPersistenceError {
  return value instanceof BackstageRosterPersistenceError;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasBoundedCodePointLength(value: string, maximum: number): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maximum) {
      return false;
    }
  }
  return length > 0;
}

/**
 * Validate and normalize one roster mutation before any database work.
 *
 * Accepted entries are reduced to the exact public Wrestler shape. Names are
 * trimmed, while duplicate identity remains case-sensitive for compatibility
 * with the existing database key and in-memory fallback behavior.
 */
export function parseBackstageRosterPayload(payload: unknown): Wrestler[] {
  if (!Array.isArray(payload)) {
    throw new BackstageRosterValidationError('Roster payload must be an array.');
  }

  if (payload.length > BACKSTAGE_ROSTER_MAX_ITEMS) {
    throw new BackstageRosterValidationError(
      `Roster payload must contain at most ${BACKSTAGE_ROSTER_MAX_ITEMS} items.`
    );
  }

  const seenNames = new Set<string>();
  const wrestlers: Wrestler[] = [];
  for (let index = 0; index < payload.length; index += 1) {
    const itemDescriptor = Object.getOwnPropertyDescriptor(payload, String(index));
    const item = itemDescriptor && 'value' in itemDescriptor
      ? itemDescriptor.value
      : undefined;
    if (!isPlainObject(item)) {
      throw new BackstageRosterValidationError(
        `Roster item at index ${index} must be a plain object.`
      );
    }

    const nameDescriptor = Object.getOwnPropertyDescriptor(item, 'name');
    const rawName = nameDescriptor && 'value' in nameDescriptor
      ? nameDescriptor.value
      : undefined;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.includes('\u0000')) {
      throw new BackstageRosterValidationError(
        `Roster item at index ${index} name must not contain U+0000.`
      );
    }
    if (!hasBoundedCodePointLength(name, BACKSTAGE_WRESTLER_NAME_MAX_LENGTH)) {
      throw new BackstageRosterValidationError(
        `Roster item at index ${index} requires a name between 1 and ${BACKSTAGE_WRESTLER_NAME_MAX_LENGTH} characters.`
      );
    }

    const overallDescriptor = Object.getOwnPropertyDescriptor(item, 'overall');
    const overall = overallDescriptor && 'value' in overallDescriptor
      ? overallDescriptor.value
      : undefined;
    if (
      typeof overall !== 'number'
      || !Number.isFinite(overall)
      || !Number.isInteger(overall)
      || overall < 0
      || overall > 100
    ) {
      throw new BackstageRosterValidationError(
        `Roster item at index ${index} requires an integer overall rating from 0 through 100.`
      );
    }

    if (seenNames.has(name)) {
      throw new BackstageRosterValidationError(
        `Roster payload contains a duplicate name at index ${index}.`
      );
    }
    seenNames.add(name);

    wrestlers.push({ name, overall });
  }

  return wrestlers;
}
