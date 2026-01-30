import { APPLICATION_CONSTANTS } from '../../utils/constants.js';
import config from '../../config/index.js';
import { getConfig } from '../../config/unifiedConfig.js';

const OPENAI_KEY_PLACEHOLDERS = new Set([
  '',
  'your-openai-api-key-here',
  'your-openai-key-here'
]);

let resolvedApiKey: string | null | undefined;
let resolvedApiKeySource: string | null = null;
let cachedDefaultModel: string | null = null;

/** Backend prefers fine-tuned model when set; otherwise OPENAI_MODEL then fallback. */
function computeDefaultModelFromConfig(): string {
  const appConfig = getConfig();
  return appConfig.defaultModel || 'gpt-4o-mini';
}

export function resolveOpenAIBaseURL(): string | undefined {
  const appConfig = getConfig();
  return appConfig.openaiBaseUrl;
}

export function resolveOpenAIKey(): string | null {
  if (resolvedApiKey !== undefined) {
    return resolvedApiKey;
  }

  // Get from config (config layer handles env access)
  const appConfig = getConfig();
  const apiKey = appConfig.openaiApiKey;

  if (!apiKey) {
    resolvedApiKey = null;
    resolvedApiKeySource = null;
    return null;
  }

  const trimmed = apiKey.trim();
  if (OPENAI_KEY_PLACEHOLDERS.has(trimmed)) {
    resolvedApiKey = null;
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
  return appConfig.fallbackModel || APPLICATION_CONSTANTS.MODEL_GPT_4;
}

/** Model for complex tasks (e.g. final ARCANOS stage). Prefers fine-tune when set; else OPENAI_COMPLEX_MODEL / vision / gpt-4o. */
export function getComplexModel(): string {
  const appConfig = getConfig();
  // Prefer default model, fallback to gpt-4o
  return appConfig.defaultModel || APPLICATION_CONSTANTS.MODEL_GPT_4O;
}

export function getGPT5Model(): string {
  const appConfig = getConfig();
  return appConfig.gpt51Model || APPLICATION_CONSTANTS.MODEL_GPT_5_1;
}

