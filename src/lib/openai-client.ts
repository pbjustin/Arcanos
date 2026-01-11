/**
 * Shared OpenAI Client Factory
 * Single source of truth for OpenAI client instantiation
 * Used by both main application and workers
 */

import OpenAI from 'openai';

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

const baseUrlCandidates = [
  process.env.OPENAI_BASE_URL,
  process.env.OPENAI_API_BASE_URL,
  process.env.OPENAI_API_BASE
].filter((value): value is string => Boolean(value && value.trim().length > 0));

export function resolveOpenAIKey(): string | null {
  for (const envName of OPENAI_KEY_ENV_PRIORITY) {
    const rawValue = process.env[envName];
    if (!rawValue) continue;

    const trimmed = rawValue.trim();
    if (OPENAI_KEY_PLACEHOLDERS.has(trimmed)) {
      continue;
    }

    return trimmed;
  }

  return null;
}

export function resolveOpenAIBaseURL(): string | undefined {
  return baseUrlCandidates[0]?.trim();
}

let openaiInstance: OpenAI | null = null;

/**
 * Get or create shared OpenAI client instance
 * Lazily initialized to avoid requiring API key at module load time
 * 
 * @returns OpenAI client instance or null if no API key is configured
 */
export function getSharedOpenAIClient(): OpenAI | null {
  if (openaiInstance) {
    return openaiInstance;
  }

  const apiKey = resolveOpenAIKey();
  if (!apiKey) {
    return null;
  }

  const baseURL = resolveOpenAIBaseURL();
  const timeout = parseInt(process.env.WORKER_API_TIMEOUT_MS || '60000', 10);

  openaiInstance = new OpenAI({
    apiKey,
    timeout,
    ...(baseURL ? { baseURL } : {})
  });

  return openaiInstance;
}

/**
 * Create a Proxy that lazily initializes OpenAI client on first access
 * Useful for workers that need immediate import but lazy initialization
 */
export function createLazyOpenAIClient(): OpenAI {
  return new Proxy({} as OpenAI, {
    get(_target, prop) {
      const client = getSharedOpenAIClient();
      if (!client) {
        throw new Error('Missing OpenAI API key. Please set OPENAI_API_KEY environment variable.');
      }
      return client[prop as keyof OpenAI];
    }
  });
}

/**
 * Reset the shared client instance
 * Useful for testing or when credentials change
 */
export function resetSharedOpenAIClient(): void {
  openaiInstance = null;
}
