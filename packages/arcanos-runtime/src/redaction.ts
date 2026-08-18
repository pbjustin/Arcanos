/**
 * Redaction / Sanitization Utilities
 *
 * Single source of truth for removing sensitive data from logs, telemetry, and worker payloads.
 */

export const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'token',
  'password',
  'apikey',
  'api_key',
  'secret',
  'privatekey',
  'private_key',
  'connectionstring',
  'connection_string',
  'database_url',
  'databaseurl',
  'redis_url',
  'redisurl',
  'arcanos_backstage_notion_universe_pages_json',
  'dsn',
  'credential',
  'session'
] as const;

export const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bsk-[a-zA-Z0-9_*_-]{6,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{12,}\b/i,
  /\b(?:railway|rwy)[_-]?[a-zA-Z0-9]{16,}\b/i,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s]+/i,
  /\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]{8,}/i,
  /\b[a-zA-Z0-9_-]*dsn[a-zA-Z0-9_-]*\s*[:=]\s*["']?[^\s"']+/i,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

const PROTOTYPE_SENSITIVE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype'
]);

export function redactString(value: string): string {
  if (!value) return value;
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return '[REDACTED]';
  }
  return value;
}

export function redactSensitive(
  data: unknown,
  options: { depth?: number; maxDepth?: number } = {}
): unknown {
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? 12;

  if (depth > maxDepth) return '[max depth reached]';

  if (typeof data === 'string') return redactString(data);
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitive(item, { depth: depth + 1, maxDepth }));
  }

  const entries = Object.entries(data as Record<string, unknown>);
  // Reserve caller-owned keys first so opaque replacements cannot overwrite data.
  const reservedKeys = new Set(entries.map(([key]) => key));
  const projectedKeys = new Set<string>();
  let redactedKeyIndex = 0;

  return Object.fromEntries(
    entries.map(([key, value]) => {
      const keyLower = key.toLowerCase();
      const isUnsafeKey = PROTOTYPE_SENSITIVE_KEYS.has(key)
        || redactString(key) !== key;
      let projectedKey = key;

      if (isUnsafeKey) {
        do {
          redactedKeyIndex += 1;
          projectedKey = `[REDACTED_KEY_${redactedKeyIndex}]`;
        } while (
          reservedKeys.has(projectedKey)
          || projectedKeys.has(projectedKey)
        );
      }
      projectedKeys.add(projectedKey);

      const isSensitiveKey = SENSITIVE_KEYS.some((sensitiveKey) =>
        keyLower.includes(String(sensitiveKey))
      );
      const projectedValue = isSensitiveKey
        ? '[REDACTED]'
        : redactSensitive(value, { depth: depth + 1, maxDepth });

      return [projectedKey, projectedValue];
    })
  );
}
