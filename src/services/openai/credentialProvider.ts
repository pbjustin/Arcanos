import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { config } from "@platform/runtime/config.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";

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
  return appConfig.defaultModel || APPLICATION_CONSTANTS.MODEL_GPT_4_1_MINI;
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
  if (OPENAI_KEY_PLACEHOLDERS.has(trimmed)) {
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

export function getGPT5Model(): string {
  const appConfig = getConfig();
  return appConfig.gpt51Model || APPLICATION_CONSTANTS.MODEL_GPT_5_1;
}

