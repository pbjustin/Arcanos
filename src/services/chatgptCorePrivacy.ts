import { redactString } from '@shared/redaction.js';
import { sanitizeGptAccessString } from './gptAccessSanitization.js';

/** Preserve safe prose while applying the established credential filters. */
export function sanitizeCoreText(value: string, key: Buffer): string {
  const normalized = sanitizeGptAccessString(value)
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/giu, '[REDACTED_PRIVATE_KEY]')
    .replaceAll(key.toString('base64url'), '[REDACTED_CORE_STORAGE_KEY]');
  return redactString(normalized);
}
