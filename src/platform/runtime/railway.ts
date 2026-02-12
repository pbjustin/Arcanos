import { getEnv, getEnvNumber } from "@platform/runtime/env.js";

export interface RailwayApiConfig {
  endpoint: string;
  timeoutMs: number;
}

const DEFAULT_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2';
const DEFAULT_GRAPHQL_TIMEOUT_MS = 15_000;

function parseTimeout(rawTimeout: string | undefined): number {
  if (!rawTimeout) return DEFAULT_GRAPHQL_TIMEOUT_MS;

  const parsed = Number.parseInt(rawTimeout.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GRAPHQL_TIMEOUT_MS;
  }

  return parsed;
}

export function getRailwayApiConfig(): RailwayApiConfig {
  // Use config layer for env access (adapter boundary pattern)
  const endpointEnv = getEnv('RAILWAY_GRAPHQL_ENDPOINT');
  const timeoutEnv = getEnv('RAILWAY_GRAPHQL_TIMEOUT_MS');
  return {
    endpoint: endpointEnv?.trim() || DEFAULT_GRAPHQL_ENDPOINT,
    timeoutMs: parseTimeout(timeoutEnv),
  };
}

export const RAILWAY_DEFAULTS = {
  GRAPHQL_ENDPOINT: DEFAULT_GRAPHQL_ENDPOINT,
  GRAPHQL_TIMEOUT_MS: DEFAULT_GRAPHQL_TIMEOUT_MS,
};
