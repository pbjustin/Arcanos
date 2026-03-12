import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { getConfig, getEnvVar } from "@platform/runtime/unifiedConfig.js";

const OPENAI_KEY_PLACEHOLDERS = new Set([
  '',
  'your-openai-api-key-here',
  'your-openai-key-here',
  'mock-api-key',
  'sk-mock-for-ci-testing'
]);

let resolvedApiKey: string | null | undefined;
let resolvedApiKeySource: string | null = null;
let cachedDefaultModel: string | null = null;

function isPlaceholderOpenAIKey(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return OPENAI_KEY_PLACEHOLDERS.has(trimmed) || trimmed.startsWith('sk-mock-');
}

/** Backend prefers fine-tuned model when set; otherwise OPENAI_MODEL then fallback. */
function computeDefaultModelFromConfig(): string {
  const appConfig = getConfig();
  return appConfig.defaultModel || APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI;
}

/**
 * Purpose: Resolve the reasoning-model preference from unified runtime config.
 * Inputs/outputs: Reads the current config snapshot and returns one GPT-5 family model name.
 * Edge case behavior: Falls back to `GPT51_MODEL` and then the hard-coded default when `GPT5_MODEL` is unset.
 */
function computeGPT5ModelFromConfig(): string {
  const appConfig = getConfig();
  const configuredGPT5Model = getEnvVar('GPT5_MODEL');

  //audit Assumption: operators may intentionally steer reasoning traffic with GPT5_MODEL while keeping GPT51_MODEL as a compatibility fallback; failure risk: production continues using the legacy GPT-5.1 path even after Railway config is updated or loses legacy behavior because the normalized config always materializes a default GPT5 model; expected invariant: an explicitly configured GPT5_MODEL takes precedence, otherwise the legacy GPT51_MODEL path remains intact; handling strategy: branch on raw env presence before falling back to unified-config defaults.
  if (configuredGPT5Model) {
    return configuredGPT5Model;
  }

  if (appConfig.gpt51Model) {
    return appConfig.gpt51Model;
  }

  return APPLICATION_CONSTANTS.MODEL_GPT_5_1;
}

export function resolveOpenAIBaseURL(): string | undefined {
  const appConfig = getConfig();
  return appConfig.openaiBaseUrl;
}

export function resolveOpenAIKey(): string | null {
  // Only use cache when we have a valid key; re-check env when we had none (handles late .env load or deployment vars)
  if (resolvedApiKey !== undefined && resolvedApiKey !== null) {
    return resolvedApiKey;
  }

  // Get from config (config layer handles env access)
  const appConfig = getConfig();
  const apiKey = appConfig.openaiApiKey;

  if (!apiKey) {
    resolvedApiKeySource = null;
    return null;
  }

  const trimmed = apiKey.trim();
  //audit Assumption: CI and local test placeholder keys should never trigger live OpenAI calls; failure risk: deterministic test workflows attempt real network auth and fail noisily; expected invariant: mock/test sentinel keys are treated as missing credentials; handling strategy: reject known placeholders and mock-key prefixes.
  if (isPlaceholderOpenAIKey(trimmed)) {
    resolvedApiKeySource = null;
    return null;
  }

  resolvedApiKey = trimmed;
  resolvedApiKeySource = 'OPENAI_API_KEY'; // Config layer resolves this
  return resolvedApiKey;
}

export function getOpenAIKeySource(): string | null {
  return resolvedApiKeySource;
}

export function resetCredentialCache(): void {
  resolvedApiKey = undefined;
  resolvedApiKeySource = null;
  cachedDefaultModel = null;
}

export function hasValidAPIKey(): boolean {
  return resolveOpenAIKey() !== null;
}

export function setDefaultModel(model: string): void {
  cachedDefaultModel = model;
}

export function getDefaultModel(): string {
  if (!cachedDefaultModel) {
    cachedDefaultModel = computeDefaultModelFromConfig();
  }
  return cachedDefaultModel;
}

export function getFallbackModel(): string {
  const appConfig = getConfig();
  // Ensure the fallback model is a distinct, more capable model than the default mini variant
  return appConfig.fallbackModel || APPLICATION_CONSTANTS.MODEL_GPT_4_1;
}

/** Model for complex tasks (e.g. final ARCANOS stage). Prefers fine-tune when set; else gpt-4.1 for deep analysis. */
export function getComplexModel(): string {
  const appConfig = getConfig();
  // Prefer a specifically configured default model if it differs from the lightweight mini model.
  // Otherwise, use GPT-4.1 for complex/deep-analysis tasks.
  if (appConfig.defaultModel && appConfig.defaultModel !== APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI) {
    return appConfig.defaultModel;
  }
  return APPLICATION_CONSTANTS.MODEL_GPT_4_1;
}

/**
 * Purpose: Return the configured reasoning model used by GPT-5 execution paths.
 * Inputs/outputs: Reads the current unified runtime config and returns one model identifier string.
 * Edge case behavior: Preserves backward compatibility by falling back to `GPT51_MODEL` and then the built-in GPT-5.1 default.
 */
export function getGPT5Model(): string {
  return computeGPT5ModelFromConfig();
}
