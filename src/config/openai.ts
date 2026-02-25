import OpenAI from 'openai';
import { getConfig } from '@platform/runtime/unifiedConfig.js';

const configuredApiKey = getConfig().openaiApiKey?.trim();
const strictOpenAIKeyRequired =
  (process.env.STRICT_OPENAI_KEY_REQUIRED || '').toLowerCase() === 'true';

//audit Assumption: some environments intentionally run in mock mode without OpenAI credentials; failure risk: startup crash in CI/tooling flows; expected invariant: fail only when strict key enforcement is explicitly enabled; handling strategy: conditional strict gate + safe mock fallback key.
if (!configuredApiKey && strictOpenAIKeyRequired) {
  throw new Error(
    'Missing OpenAI API key. Set OPENAI_API_KEY (or RAILWAY_OPENAI_API_KEY/API_KEY/OPENAI_KEY) before starting the server.'
  );
}

if (!configuredApiKey) {
  console.warn('[OpenAI] API key is not configured. Running in mock/fallback mode.');
}

export const openai = new OpenAI({
  apiKey: configuredApiKey || 'mock-openai-key'
});

export const DEFAULT_MODEL = process.env.ARCANOS_MODEL || 'gpt-5';

export const DEFAULT_FINE_TUNE =
  process.env.ARCANOS_FINE_TUNE || 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';
