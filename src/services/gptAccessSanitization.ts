import { redactSensitive } from '@shared/redaction.js';

const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(?:railway|rwy)[_-]?[A-Za-z0-9]{16,}\b/gi, '[REDACTED_RAILWAY_TOKEN]'],
  [/\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:authorization|cookie|set-cookie|api[_-]?key|token|secret|password|session(?:id)?|database_url)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]'],
  [/\b(email|password)\s*[:=]\s*["']?[^"'\s,;}]+/gi, '$1=[REDACTED]']
];

const PROMPT_LOG_FIELD_KEYS = new Set([
  'prompt',
  'prompttext',
  'prompt_text',
  'promptpreview',
  'prompt_preview',
  'rawprompt',
  'raw_prompt',
  'normalizedprompt',
  'normalized_prompt',
  'task',
  'taskpreview',
  'task_preview',
  'summarypreview',
  'summary_preview',
  'inputpreview',
  'input_preview',
  'outputpreview',
  'output_preview',
  'messages'
]);

const DIAGNOSTIC_PAYLOAD_FIELD_KEYS = new Set([
  'completion',
  'completiontext',
  'completion_text',
  'completions',
  'providerpayload',
  'provider_payload',
  'providerpayloads',
  'provider_payloads',
  'providerrequest',
  'provider_request',
  'providerresponse',
  'provider_response',
  'providerraw',
  'provider_raw'
]);

export function sanitizeGptAccessString(value: string): string {
  return STRING_REDACTIONS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
}

export function sanitizeGptAccessPayload(payload: unknown): unknown {
  const redacted = redactSensitive(payload);
  return sanitizeStringsDeep(redacted);
}

function sanitizeStringsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeGptAccessString(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeStringsDeep);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const reservedKeys = new Set(entries.map(([key]) => key));
  const projectedKeys = new Set<string>();
  let redactedKeyIndex = 0;

  return Object.fromEntries(
    entries.map(([key, entry]) => {
      let projectedKey = key;
      if (sanitizeGptAccessString(key) !== key) {
        do {
          redactedKeyIndex += 1;
          projectedKey = `[REDACTED_KEY_${redactedKeyIndex}]`;
        } while (
          reservedKeys.has(projectedKey) ||
          projectedKeys.has(projectedKey)
        );
      }
      projectedKeys.add(projectedKey);

      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'email' || normalizedKey.includes('password')) {
        return [projectedKey, '[REDACTED]'];
      }
      if (PROMPT_LOG_FIELD_KEYS.has(normalizedKey)) {
        return [projectedKey, '[REDACTED_PROMPT]'];
      }
      if (DIAGNOSTIC_PAYLOAD_FIELD_KEYS.has(normalizedKey)) {
        return [projectedKey, '[REDACTED_DIAGNOSTIC_PAYLOAD]'];
      }
      return [projectedKey, sanitizeStringsDeep(entry)];
    })
  );
}
