import { getEnv, getEnvNumber } from "@platform/runtime/env.js";

export interface ScholarlyApiConfig {
  endpoint: string;
  timeoutMs: number;
  defaultRows: number;
}

const DEFAULT_SCHOLARLY_ENDPOINT = 'https://api.crossref.org/works';
const DEFAULT_SCHOLARLY_TIMEOUT_MS = 15_000;
const DEFAULT_SCHOLARLY_ROWS = 3;

function parseTimeout(rawTimeout: string | undefined): number {
  //audit Assumption: missing timeout should fall back to a safe default; risk: unintended slow requests; invariant: timeoutMs is positive; handling: default to DEFAULT_SCHOLARLY_TIMEOUT_MS.
  if (!rawTimeout) return DEFAULT_SCHOLARLY_TIMEOUT_MS;

  const parsed = Number.parseInt(rawTimeout.trim(), 10);
  //audit Assumption: invalid timeout values should not crash config; risk: NaN causing axios failures; invariant: timeoutMs is finite and > 0; handling: fall back to DEFAULT_SCHOLARLY_TIMEOUT_MS.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCHOLARLY_TIMEOUT_MS;
  }

  return parsed;
}

function parseDefaultRows(rawRows: number): number {
  //audit Assumption: default rows should be a positive integer; risk: excessive load or empty results; invariant: defaultRows >= 1; handling: clamp to DEFAULT_SCHOLARLY_ROWS.
  if (!Number.isInteger(rawRows) || rawRows <= 0) {
    return DEFAULT_SCHOLARLY_ROWS;
  }
  return rawRows;
}

/**
 * Resolve CrossRef (scholarly) API configuration from environment variables.
 *
 * Inputs:
 * - CROSSREF_API_URL (optional)
 * - CROSSREF_API_TIMEOUT_MS (optional)
 * - CROSSREF_DEFAULT_ROWS (optional)
 *
 * Outputs: normalized endpoint + timeout + default rows.
 *
 * Edge cases: trims empty values, clamps invalid numbers to safe defaults.
 */
export function getScholarlyApiConfig(): ScholarlyApiConfig {
  //audit Assumption: env access via config layer enforces consistent defaults; risk: missing env leads to hardcoded endpoint; invariant: endpoint string is non-empty; handling: fallback to DEFAULT_SCHOLARLY_ENDPOINT.
  const endpointEnv = getEnv('CROSSREF_API_URL');
  const timeoutEnv = getEnv('CROSSREF_API_TIMEOUT_MS');
  const defaultRowsEnv = getEnvNumber('CROSSREF_DEFAULT_ROWS', DEFAULT_SCHOLARLY_ROWS);
  const endpoint = endpointEnv?.trim() || DEFAULT_SCHOLARLY_ENDPOINT;

  return {
    endpoint,
    timeoutMs: parseTimeout(timeoutEnv),
    defaultRows: parseDefaultRows(defaultRowsEnv),
  };
}

export const SCHOLARLY_DEFAULTS = {
  ENDPOINT: DEFAULT_SCHOLARLY_ENDPOINT,
  TIMEOUT_MS: DEFAULT_SCHOLARLY_TIMEOUT_MS,
  DEFAULT_ROWS: DEFAULT_SCHOLARLY_ROWS,
};
