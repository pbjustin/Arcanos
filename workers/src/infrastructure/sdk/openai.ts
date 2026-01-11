/**
 * Workers OpenAI Client
 * Shared OpenAI client instance with lazy initialization
 * 
 * Note: This uses the same pattern as src/lib/openai-client.ts
 * but is duplicated here due to TypeScript build constraints.
 * Both implementations follow the same credential resolution logic.
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

function resolveOpenAIKey(): string | null {
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

function resolveOpenAIBaseURL(): string | undefined {
  return baseUrlCandidates[0]?.trim();
}

let openaiInstance: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiInstance) {
    return openaiInstance;
  }

  const apiKey = resolveOpenAIKey();
  if (!apiKey) {
    throw new Error('Missing OpenAI API key. Please set OPENAI_API_KEY environment variable.');
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

export default new Proxy({} as OpenAI, {
  get(_target, prop) {
    const client = getOpenAIClient();
    return client[prop as keyof OpenAI];
  }
});
