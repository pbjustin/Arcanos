/**
 * Daemon GPT ID utilities.
 * Normalize and parse daemon GPT ID headers consistently.
 */

import { IncomingMessage } from 'http';

export interface DaemonGptIdConfig {
  headerName: string;
  maxLength: number;
}

export interface DaemonGptIdParseResult {
  ok: boolean;
  value?: string;
  error?: string;
}

const DEFAULT_DAEMON_GPT_ID_HEADER = 'OpenAI-GPT-ID';
const DEFAULT_DAEMON_GPT_ID_MAX_LENGTH = 128;
const MIN_DAEMON_GPT_ID_MAX_LENGTH = 16;

function normalizeDaemonGptHeaderName(rawHeaderName: string | undefined): string {
  /**
   * Purpose: Normalize the daemon GPT ID header name with a default.
   * Inputs/Outputs: raw header name; returns normalized header name.
   * Edge cases: Empty values fall back to default header name.
   */
  //audit assumption: header name optional; risk: empty header name; invariant: default used; strategy: trim and fallback.
  const trimmed = (rawHeaderName || '').trim();
  return trimmed || DEFAULT_DAEMON_GPT_ID_HEADER;
}

function normalizeDaemonGptMaxLength(rawMaxLength: number | undefined): number {
  /**
   * Purpose: Normalize daemon GPT ID max length with bounds.
   * Inputs/Outputs: raw max length; returns normalized max length.
   * Edge cases: Non-finite values fall back to defaults.
   */
  if (rawMaxLength === undefined || rawMaxLength === null) {
    //audit assumption: max length optional; risk: unset value; invariant: default used; strategy: return default.
    return DEFAULT_DAEMON_GPT_ID_MAX_LENGTH;
  }
  if (!Number.isFinite(rawMaxLength)) {
    //audit assumption: max length must be finite; risk: NaN/Infinity; invariant: default used; strategy: return default.
    return DEFAULT_DAEMON_GPT_ID_MAX_LENGTH;
  }
  //audit assumption: max length should be integer; risk: fractional values; invariant: integer; strategy: floor.
  const normalized = Math.floor(rawMaxLength);
  if (normalized < MIN_DAEMON_GPT_ID_MAX_LENGTH) {
    //audit assumption: max length too small; risk: reject valid IDs; invariant: minimum enforced; strategy: clamp to minimum.
    return MIN_DAEMON_GPT_ID_MAX_LENGTH;
  }
  return normalized;
}

/**
 * Resolve daemon GPT ID configuration.
 * Inputs/Outputs: optional header name and max length; returns normalized config.
 * Edge cases: Missing values fall back to defaults.
 */
export function resolveDaemonGptIdConfig(
  headerName?: string,
  maxLength?: number
): DaemonGptIdConfig {
  return {
    headerName: normalizeDaemonGptHeaderName(headerName),
    maxLength: normalizeDaemonGptMaxLength(maxLength)
  };
}

/**
 * Extract a header value from an IncomingMessage-compatible request.
 * Inputs/Outputs: request and header name; returns header string or null.
 * Edge cases: Multiple header values return the first.
 */
export function extractHeaderValue(
  request: Pick<IncomingMessage, 'headers'>,
  headerName: string
): string | null {
  const headerKey = headerName.toLowerCase();
  const rawValue = request.headers[headerKey];
  if (typeof rawValue === 'string') {
    //audit assumption: header is string; risk: empty value; invariant: return raw string; strategy: return string.
    return rawValue;
  }
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    //audit assumption: header array may exist; risk: multiple values; invariant: first value used; strategy: return first.
    return rawValue[0];
  }
  //audit assumption: header missing; risk: no daemon ID; invariant: null returned; strategy: return null.
  return null;
}

/**
 * Parse the daemon GPT ID from a raw header value.
 * Inputs/Outputs: raw header value and max length; returns parse result.
 * Edge cases: Missing header is treated as ok with undefined value.
 */
export function parseDaemonGptId(
  rawHeaderValue: string | null,
  maxLength: number
): DaemonGptIdParseResult {
  if (!rawHeaderValue) {
    //audit assumption: header optional; risk: no daemon ID; invariant: ok result without value; strategy: return ok.
    return { ok: true, value: undefined };
  }
  //audit assumption: trimming is safe; risk: whitespace-only IDs; invariant: trimmed string; strategy: trim.
  const trimmedValue = rawHeaderValue.trim();
  if (!trimmedValue) {
    //audit assumption: empty header invalid; risk: ambiguous ID; invariant: error returned; strategy: reject empty.
    return { ok: false, error: 'daemon GPT ID header is empty' };
  }
  if (trimmedValue.length > maxLength) {
    //audit assumption: header length bounded; risk: oversized header; invariant: max length enforced; strategy: reject.
    return { ok: false, error: `daemon GPT ID exceeds ${maxLength} characters` };
  }
  return { ok: true, value: trimmedValue };
}
