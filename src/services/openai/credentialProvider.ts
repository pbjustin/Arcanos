const OPENAI_KEY_ENV_PRIORITY = [
  'OPENAI_API_KEY',
  'RAILWAY_OPENAI_API_KEY',
  'API_KEY',
  'OPENAI_KEY'
] as const;

const OPENAI_KEY_PLACEHOLDERS = new Set([
  '',
  'your-openai-api-key-here',
  'your-openai-key-here'
]);

let resolvedApiKey: string | null | undefined;
let resolvedApiKeySource: string | null = null;
let cachedDefaultModel: string | null = null;

const baseUrlCandidates = [
  process.env.OPENAI_BASE_URL,
  process.env.OPENAI_API_BASE_URL,
  process.env.OPENAI_API_BASE
].filter((value): value is string => Boolean(value && value.trim().length > 0));

function computeDefaultModelFromEnv(): string {
  return (
    process.env.OPENAI_MODEL ||
    process.env.RAILWAY_OPENAI_MODEL ||
    process.env.FINETUNED_MODEL_ID ||
    process.env.FINE_TUNED_MODEL_ID ||
    process.env.AI_MODEL ||
    'gpt-4o'
  );
}

export function resolveOpenAIBaseURL(): string | undefined {
  return baseUrlCandidates[0]?.trim();
}

export function resolveOpenAIKey(): string | null {
  if (resolvedApiKey !== undefined) {
    return resolvedApiKey;
  }

  for (const envName of OPENAI_KEY_ENV_PRIORITY) {
    const rawValue = process.env[envName];
    if (!rawValue) continue;

    const trimmed = rawValue.trim();
    if (OPENAI_KEY_PLACEHOLDERS.has(trimmed)) {
      continue;
    }

    resolvedApiKey = trimmed;
    resolvedApiKeySource = envName;
    return resolvedApiKey;
  }

  resolvedApiKey = null;
  resolvedApiKeySource = null;
  return null;
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
    cachedDefaultModel = computeDefaultModelFromEnv();
  }
  return cachedDefaultModel;
}

export function getFallbackModel(): string {
  return (
    process.env.FALLBACK_MODEL ||
    process.env.AI_FALLBACK_MODEL ||
    process.env.RAILWAY_OPENAI_FALLBACK_MODEL ||
    process.env.FINETUNED_MODEL_ID ||
    process.env.FINE_TUNED_MODEL_ID ||
    process.env.AI_MODEL ||
    'gpt-4'
  );
}

export function getGPT5Model(): string {
  return process.env.GPT51_MODEL || process.env.GPT5_MODEL || 'gpt-5.2';
}

