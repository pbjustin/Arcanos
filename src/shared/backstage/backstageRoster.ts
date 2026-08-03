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

/** Represent a safe, retryable failure of the authoritative roster transaction. */
export class BackstageRosterPersistenceError extends Error {
  readonly code = BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE;

  constructor() {
    super(BACKSTAGE_ROSTER_PERSISTENCE_ERROR_MESSAGE);
    this.name = 'BackstageRosterPersistenceError';
  }
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
