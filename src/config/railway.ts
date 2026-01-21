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
  return {
    endpoint: process.env.RAILWAY_GRAPHQL_ENDPOINT?.trim() || DEFAULT_GRAPHQL_ENDPOINT,
    timeoutMs: parseTimeout(process.env.RAILWAY_GRAPHQL_TIMEOUT_MS),
  };
}

export const RAILWAY_DEFAULTS = {
  GRAPHQL_ENDPOINT: DEFAULT_GRAPHQL_ENDPOINT,
  GRAPHQL_TIMEOUT_MS: DEFAULT_GRAPHQL_TIMEOUT_MS,
};
