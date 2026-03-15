import { randomUUID } from 'crypto';
import { getMonotonicTimestampMs } from '@services/safety/monotonicClock.js';

export type MemoryIdentifierKind =
  | 'transient_response_id'
  | 'durable_record_id'
  | 'canonical_memory_key'
  | 'legacy_row_id'
  | 'legacy_memory_key'
  | 'invalid';

export type MemoryIdentifierErrorCode =
  | 'InvalidTransientId'
  | 'InvalidMemoryIdentifier'
  | 'RecordNotFound';

export interface ClassifiedMemoryIdentifier {
  kind: MemoryIdentifierKind;
  raw: string;
  normalized: string | null;
  error: MemoryIdentifierErrorCode | null;
  message: string | null;
}

export interface MemoryLookupFailure {
  success: false;
  error: MemoryIdentifierErrorCode;
  message: string;
}

const TRANSIENT_MEMORY_RESPONSE_ID_PATTERN = /^memory_[A-Za-z0-9_-]{6,}$/;
const DURABLE_MEMORY_RECORD_ID_PATTERN = /^db-memory-[A-Za-z0-9-]{8,}$/;
const LEGACY_MEMORY_ROW_ID_PATTERN = /^legacy-memory-row:(\d{1,12})$/;
const NUMERIC_ROW_ID_PATTERN = /^\d{1,12}$/;
const CANONICAL_MEMORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_/-]{1,254}$/;
const LEGACY_MEMORY_KEY_PREFIX_PATTERNS = [/^nl-memory\//i, /^memory\//i];

/**
 * Create a transient response envelope identifier for memory API responses.
 * Inputs/outputs: no inputs -> transient `memory_*` response identifier.
 * Edge cases: identifier is intentionally non-durable and must not be reused for retrieval.
 */
export function createTransientMemoryResponseId(): string {
  const timestampMs = getMonotonicTimestampMs();
  const entropy = randomUUID().replace(/-/g, '').slice(0, 10);
  return `memory_${timestampMs}_${entropy}`;
}

/**
 * Classify an external memory lookup identifier into transient, durable, canonical, or legacy forms.
 * Inputs/outputs: raw request identifier -> normalized classification result.
 * Edge cases: malformed or blank identifiers return structured invalid classifications instead of throwing.
 */
export function classifyMemoryIdentifier(rawIdentifier: unknown): ClassifiedMemoryIdentifier {
  if (typeof rawIdentifier !== 'string') {
    return {
      kind: 'invalid',
      raw: '',
      normalized: null,
      error: 'InvalidMemoryIdentifier',
      message: 'Memory identifier must be a non-empty string.'
    };
  }

  const trimmedIdentifier = rawIdentifier.trim();

  //audit Assumption: exact lookup identifiers must be explicit non-empty strings; failure risk: blank input silently devolves into wide search behavior; expected invariant: exact lookup begins with one concrete identifier; handling strategy: reject empty values at classification time.
  if (!trimmedIdentifier) {
    return {
      kind: 'invalid',
      raw: trimmedIdentifier,
      normalized: null,
      error: 'InvalidMemoryIdentifier',
      message: 'Memory identifier must be a non-empty string.'
    };
  }

  //audit Assumption: `memory_*` identifiers are dispatcher response envelopes, not storage handles; failure risk: callers treat transient response ids as durable records; expected invariant: transient ids fail closed for exact retrieval; handling strategy: classify explicitly and return a dedicated error.
  if (TRANSIENT_MEMORY_RESPONSE_ID_PATTERN.test(trimmedIdentifier)) {
    return {
      kind: 'transient_response_id',
      raw: trimmedIdentifier,
      normalized: trimmedIdentifier,
      error: 'InvalidTransientId',
      message: 'memory_* identifiers are response envelopes and cannot be used for retrieval.'
    };
  }

  if (DURABLE_MEMORY_RECORD_ID_PATTERN.test(trimmedIdentifier)) {
    return {
      kind: 'durable_record_id',
      raw: trimmedIdentifier,
      normalized: trimmedIdentifier,
      error: null,
      message: null
    };
  }

  const legacyRowIdMatch = trimmedIdentifier.match(LEGACY_MEMORY_ROW_ID_PATTERN);
  if (legacyRowIdMatch?.[1]) {
    return {
      kind: 'legacy_row_id',
      raw: trimmedIdentifier,
      normalized: legacyRowIdMatch[1],
      error: null,
      message: null
    };
  }

  if (NUMERIC_ROW_ID_PATTERN.test(trimmedIdentifier)) {
    return {
      kind: 'legacy_row_id',
      raw: trimmedIdentifier,
      normalized: trimmedIdentifier,
      error: null,
      message: null
    };
  }

  if (CANONICAL_MEMORY_KEY_PATTERN.test(trimmedIdentifier) && trimmedIdentifier.includes(':')) {
    return {
      kind: 'canonical_memory_key',
      raw: trimmedIdentifier,
      normalized: trimmedIdentifier,
      error: null,
      message: null
    };
  }

  for (const legacyPattern of LEGACY_MEMORY_KEY_PREFIX_PATTERNS) {
    //audit Assumption: older clients may serialize canonical keys with `/` separators; failure risk: legacy persisted identifiers become unreadable after canonicalization changes; expected invariant: legacy forms normalize into the current canonical `:`-separated key; handling strategy: detect known legacy prefixes and convert deterministically.
    if (legacyPattern.test(trimmedIdentifier)) {
      return {
        kind: 'legacy_memory_key',
        raw: trimmedIdentifier,
        normalized: trimmedIdentifier.replace(/\//g, ':'),
        error: null,
        message: null
      };
    }
  }

  return {
    kind: 'invalid',
    raw: trimmedIdentifier,
    normalized: null,
    error: 'InvalidMemoryIdentifier',
    message: 'Memory identifier is malformed. Expected a durable record id or canonical memory key.'
  };
}

/**
 * Build a stable legacy record locator for rows that predate versioned `db-memory-*` identifiers.
 * Inputs/outputs: numeric row id -> legacy durable record locator string.
 * Edge cases: callers should only use positive integer ids.
 */
export function buildLegacyMemoryRowRecordId(rowId: number): string {
  return `legacy-memory-row:${rowId}`;
}

/**
 * Build a structured error payload for exact lookup failures.
 * Inputs/outputs: error code + message -> normalized failure object.
 * Edge cases: keeps error shape stable across HTTP and service layers.
 */
export function createMemoryLookupFailure(
  error: MemoryIdentifierErrorCode,
  message: string
): MemoryLookupFailure {
  return {
    success: false,
    error,
    message
  };
}
