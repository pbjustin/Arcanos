/**
 * OpenAI client factory for the backend.
 * Centralizes SDK initialization and caching.
 */

import OpenAI from 'openai';

type EnvGetter = (key: string) => string | undefined;

export interface OpenAiConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  project?: string;
}

export interface OpenAiConfigResult {
  ok: boolean;
  config?: OpenAiConfig;
  error?: string;
}

export interface OpenAiClientResult {
  ok: boolean;
  client?: OpenAI;
  error?: string;
}

let cachedClient: OpenAI | null = null;
let cachedConfig: OpenAiConfig | null = null;

function normalizeOptionalSetting(value: string | undefined): string | undefined {
  if (!value) {
    //audit assumption: optional env can be empty; risk: empty string misused; invariant: undefined for empty; strategy: return undefined.
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    //audit assumption: whitespace-only should be ignored; risk: invalid config; invariant: undefined; strategy: return undefined.
    return undefined;
  }
  //audit assumption: trimming is safe; risk: unintended whitespace removal; invariant: normalized string; strategy: trim.
  return trimmed;
}

function isSameConfig(left: OpenAiConfig | null, right: OpenAiConfig): boolean {
  if (!left) {
    //audit assumption: no cache means config differs; risk: stale client; invariant: mismatch; strategy: return false.
    return false;
  }
  //audit assumption: config identity based on core fields; risk: stale config; invariant: equality check; strategy: compare fields.
  return (
    left.apiKey === right.apiKey &&
    left.baseURL === right.baseURL &&
    left.organization === right.organization &&
    left.project === right.project
  );
}

/**
 * Resolve OpenAI configuration from environment values.
 * Inputs/Outputs: optional env getter; returns OpenAiConfigResult with config or error.
 * Edge cases: missing OPENAI_API_KEY returns ok=false with error message.
 */
export function resolveOpenAiConfig(getEnv: EnvGetter = (key) => process.env[key]): OpenAiConfigResult {
  const apiKey = normalizeOptionalSetting(getEnv('OPENAI_API_KEY'));
  if (!apiKey) {
    //audit assumption: API key required; risk: client unusable; invariant: apiKey present; strategy: return error.
    return { ok: false, error: 'OPENAI_API_KEY is not configured' };
  }

  const baseURL = normalizeOptionalSetting(getEnv('OPENAI_BASE_URL'));
  const organization = normalizeOptionalSetting(getEnv('OPENAI_ORG_ID'));
  const project = normalizeOptionalSetting(getEnv('OPENAI_PROJECT_ID'));

  return {
    ok: true,
    config: {
      apiKey,
      baseURL,
      organization,
      project
    }
  };
}

/**
 * Get a cached OpenAI client or create a new instance.
 * Inputs/Outputs: optional env getter; returns OpenAiClientResult with client or error.
 * Edge cases: missing OPENAI_API_KEY returns ok=false; config changes rebuild client.
 */
export function getOpenAiClient(getEnv: EnvGetter = (key) => process.env[key]): OpenAiClientResult {
  const configResult = resolveOpenAiConfig(getEnv);
  if (!configResult.ok || !configResult.config) {
    //audit assumption: config must be valid; risk: client creation failure; invariant: config ok; strategy: return error.
    return { ok: false, error: configResult.error || 'OpenAI config is invalid' };
  }

  if (cachedClient && isSameConfig(cachedConfig, configResult.config)) {
    //audit assumption: cached client is valid; risk: stale client; invariant: config matches; strategy: reuse cache.
    return { ok: true, client: cachedClient };
  }

  cachedConfig = { ...configResult.config };
  cachedClient = new OpenAI({
    apiKey: configResult.config.apiKey,
    baseURL: configResult.config.baseURL,
    organization: configResult.config.organization,
    project: configResult.config.project
  });

  return { ok: true, client: cachedClient };
}

/**
 * Clear cached OpenAI client (useful for tests).
 * Inputs/Outputs: none; resets internal cache.
 * Edge cases: safe to call even when cache is empty.
 */
export function clearOpenAiClientCache(): void {
  //audit assumption: cache reset safe; risk: none; invariant: cache cleared; strategy: set to null.
  cachedClient = null;
  cachedConfig = null;
}
