import { getEnv } from "@platform/runtime/env.js";
import { parsePositiveEnvInteger } from "@platform/runtime/envParsers.js";

export interface RailwayApiConfig {
  endpoint: string;
  timeoutMs: number;
}

const DEFAULT_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2';
const DEFAULT_GRAPHQL_TIMEOUT_MS = 15_000;

/**
 * Parse Railway timeout from environment text.
 * Inputs: optional timeout string and module default timeout.
 * Outputs: a validated positive timeout integer in milliseconds.
 * Edge cases: undefined, blank, non-numeric, and non-positive values fall back to default.
 */
function parseTimeout(rawTimeout: string | undefined): number {
  //audit Assumption: timeout must be a strictly positive integer; risk: invalid values can disable request safety bounds; invariant: timeoutMs > 0; handling: delegate parsing to shared positive integer parser with fallback.
  return parsePositiveEnvInteger(rawTimeout?.trim(), DEFAULT_GRAPHQL_TIMEOUT_MS);
}

/**
 * Resolve Railway GraphQL API configuration from environment variables.
 * Inputs: RAILWAY_GRAPHQL_ENDPOINT and RAILWAY_GRAPHQL_TIMEOUT_MS env values.
 * Outputs: normalized endpoint and validated timeout in milliseconds.
 * Edge cases: empty endpoint or invalid timeout values are replaced with safe defaults.
 */
export function getRailwayApiConfig(): RailwayApiConfig {
  // Use config layer for env access (adapter boundary pattern)
  const endpointEnv = getEnv('RAILWAY_GRAPHQL_ENDPOINT');
  const timeoutEnv = getEnv('RAILWAY_GRAPHQL_TIMEOUT_MS');
  //audit Assumption: blank endpoint env values should not be used directly; risk: malformed requests to empty URLs; invariant: endpoint is non-empty; handling: trim and fallback to DEFAULT_GRAPHQL_ENDPOINT.
  const normalizedEndpoint = endpointEnv?.trim() || DEFAULT_GRAPHQL_ENDPOINT;

  return {
    endpoint: normalizedEndpoint,
    timeoutMs: parseTimeout(timeoutEnv),
  };
}

export const RAILWAY_DEFAULTS = {
  GRAPHQL_ENDPOINT: DEFAULT_GRAPHQL_ENDPOINT,
  GRAPHQL_TIMEOUT_MS: DEFAULT_GRAPHQL_TIMEOUT_MS,
};
