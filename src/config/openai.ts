import OpenAI from 'openai';
import { getConfig } from '@platform/runtime/unifiedConfig.js';

const configuredApiKey = getConfig().openaiApiKey?.trim();

//audit Assumption: non-test environments must have a configured API key when initializing concrete OpenAI clients; failure risk: opaque runtime failures; expected invariant: explicit startup error; handling strategy: fail fast with clear configuration message.
if (!configuredApiKey && process.env.NODE_ENV !== 'test') {
  throw new Error(
    'Missing OpenAI API key. Set OPENAI_API_KEY (or RAILWAY_OPENAI_API_KEY/API_KEY/OPENAI_KEY) before starting the server.'
  );
}

export const openai = new OpenAI({
  apiKey: configuredApiKey || 'test-openai-key'
});

export const DEFAULT_MODEL = process.env.ARCANOS_MODEL || 'gpt-5';

export const DEFAULT_FINE_TUNE =
  process.env.ARCANOS_FINE_TUNE || 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';
