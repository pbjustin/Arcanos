import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/structuredLogging.js';

export interface FallbackMessagesConfig {
  default: string;
  [key: string]: string;
}

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
      return parsed;
    } catch (error) {
      logger.error('Failed to load fallback messages configuration', {
        module: 'fallbackMessages',
        operation: 'loadConfigFile',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return null;
}

let cachedFallbackMessages: FallbackMessagesConfig | null = null;

export function getFallbackMessages(): FallbackMessagesConfig {
  if (cachedFallbackMessages) {
    return cachedFallbackMessages;
  }

  const configMessages = loadConfigFile();
  cachedFallbackMessages = {
    ...DEFAULT_FALLBACK_MESSAGES,
    ...(configMessages ?? {})
  };

  return cachedFallbackMessages;
}

function applyTemplate(message: string, prompt?: string): string {
  if (!prompt) return message;
  return message.replace(/\{prompt\}/g, prompt);
}

export function getFallbackMessage(endpoint: string, prompt?: string): string {
  const messages = getFallbackMessages();
  const template = messages[endpoint] ?? messages.default;
  const truncatedPrompt = prompt?.slice(0, 200);

  return applyTemplate(template, truncatedPrompt);
}
