import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { resolveErrorMessage } from "@shared/errorUtils.js";

export type FallbackMessagesConfig = Record<string, string> & { default: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SEARCH_PATHS = [
  join(process.cwd(), 'config', 'fallbackMessages.json'),
  join(__dirname, 'fallbackMessages.json'),
  join(process.cwd(), 'src', 'config', 'fallbackMessages.json')
];

const DEFAULT_FALLBACK_MESSAGES: FallbackMessagesConfig = {
  arcanos:
    'ARCANOS system temporarily operating in fallback mode. Your request has been noted but cannot be fully processed at this time.',
  sim: 'Simulation request received but cannot be processed in degraded mode. Please retry when services are restored.',
  memory: 'Memory operation temporarily unavailable. System is operating in read-only fallback mode.',
  default: 'Service temporarily unavailable. Operating in degraded mode with limited functionality.'
};

function loadConfigFile(): Partial<FallbackMessagesConfig> | null {
  for (const candidatePath of SEARCH_PATHS) {
    if (!existsSync(candidatePath)) continue;

    try {
      const contents = readFileSync(candidatePath, 'utf-8');
      const parsed = JSON.parse(contents) as Partial<FallbackMessagesConfig>;
      assertProtectedConfigIntegrity('fallback_messages', parsed, {
        source: candidatePath
      });
      return parsed;
    } catch (error) {
      logger.error('Failed to load fallback messages configuration', {
        module: 'fallbackMessages',
        operation: 'loadConfigFile',
        error: resolveErrorMessage(error)
      });
    }
  }

  return null;
}

let cachedFallbackMessages: FallbackMessagesConfig | undefined;

export function getFallbackMessages(): FallbackMessagesConfig {
  if (cachedFallbackMessages) {
    return cachedFallbackMessages;
  }

  const configMessages = loadConfigFile() ?? {};
  const sanitizedMessages: Record<string, string> = Object.fromEntries(
    Object.entries(configMessages).filter(([, value]) => typeof value === 'string')
  ) as Record<string, string>;

  const mergedMessages: FallbackMessagesConfig = {
    ...DEFAULT_FALLBACK_MESSAGES,
    ...sanitizedMessages
  };

  cachedFallbackMessages = mergedMessages;

  return cachedFallbackMessages;
}

function applyTemplate(message: string, prompt?: string): string {
  if (!prompt) return message;
  return message.replace(/\{prompt\}/g, prompt);
}

export function getFallbackMessage(endpoint: string, prompt?: string): string {
  const messages = getFallbackMessages();
  const template = messages[endpoint] ?? messages.default;
  const truncatedPrompt = prompt?.slice(0, APPLICATION_CONSTANTS.FALLBACK_PROMPT_SNIPPET_LENGTH);

  return applyTemplate(template, truncatedPrompt);
}

export const FALLBACK_LOG_MESSAGES = {
  degraded: (endpoint: string, reason: string): string =>
    `🔄 Fallback mode activated for ${endpoint} - ${reason}`,
  preemptive: (endpoint: string): string =>
    `🔄 Preemptive fallback mode activated for ${endpoint} - OpenAI client unavailable`
} as const;

export const FALLBACK_LOG_REASON = {
  unknown: 'unknown',
  unavailable: 'OpenAI client unavailable'
} as const;

export const FALLBACK_RESPONSE_MESSAGES = {
  cacheUnavailable: 'Service temporarily unavailable - returning cached response',
  cachedResponsePlaceholder: 'Cached response available',
  degradedMode: 'AI services temporarily unavailable - operating in degraded mode',
  fallbackTestPrompt: 'Test degraded mode functionality',
  fallbackTestMessage: 'Fallback system test - this endpoint simulates degraded mode',
  defaultPrompt: 'No input provided',
  healthCheckPrompt: 'Health check triggered fallback'
} as const;
