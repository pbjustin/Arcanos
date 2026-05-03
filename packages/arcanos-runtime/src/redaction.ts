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

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const keyLower = key.toLowerCase();
    const isSensitiveKey = SENSITIVE_KEYS.some((k) => keyLower.includes(String(k)));
    if (isSensitiveKey) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    sanitized[key] = redactSensitive(value, { depth: depth + 1, maxDepth });
  }
  return sanitized;
}
