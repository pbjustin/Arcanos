const parseIntegerEnv = (key: string, defaultValue: number): number => {
  const raw = process.env[key];
  if (!raw) return defaultValue;

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

const parseStringEnv = (key: string, defaultValue: string): string => {
  const raw = process.env[key];
  return raw && raw.trim().length > 0 ? raw.trim() : defaultValue;
};

export const DEFAULT_SYSTEM_PROMPT = parseStringEnv(
  'OPENAI_SYSTEM_PROMPT',
  'You are a helpful AI assistant.'
);

export const CACHE_TTL_MS = parseIntegerEnv('OPENAI_CACHE_TTL_MS', 5 * 60 * 1000); // 5 minutes

export const REQUEST_ID_HEADER = 'X-Request-ID';

export const DEFAULT_MAX_RETRIES = parseIntegerEnv('OPENAI_MAX_RETRIES', 3);

export const IMAGE_PROMPT_TOKEN_LIMIT = parseIntegerEnv('OPENAI_IMAGE_PROMPT_TOKEN_LIMIT', 256);

// Default values for completion parameters
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 1;
const DEFAULT_FREQUENCY_PENALTY = 0;
const DEFAULT_PRESENCE_PENALTY = 0;

export const OPENAI_COMPLETION_DEFAULTS = {
  TEMPERATURE: parseFloat(process.env.OPENAI_DEFAULT_TEMPERATURE || String(DEFAULT_TEMPERATURE)),
  TOP_P: parseFloat(process.env.OPENAI_DEFAULT_TOP_P || String(DEFAULT_TOP_P)),
  FREQUENCY_PENALTY: parseFloat(process.env.OPENAI_DEFAULT_FREQUENCY_PENALTY || String(DEFAULT_FREQUENCY_PENALTY)),
  PRESENCE_PENALTY: parseFloat(process.env.OPENAI_DEFAULT_PRESENCE_PENALTY || String(DEFAULT_PRESENCE_PENALTY))
} as const;
