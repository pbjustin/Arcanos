export const REDACTED = '[REDACTED]';

const SENSITIVE_EXACT_KEYS = new Set([
  'env',
  'rawenv',
  'fullenv',
  'processenv',
  'environmentvariables',
  'authorization',
  'authorizationheader',
  'cookie',
  'setcookie',
  'headers',
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'auth',
  'databaseurl',
  'databaseprivateurl',
  'databasepublicurl',
  'postgresurl',
  'redisurl',
  'dsn',
  'credential',
  'connectionstring',
  'privatekey',
  'sessionid',
]);

const SENSITIVE_KEY_FRAGMENTS = [
  'accesstoken',
  'authtoken',
  'bearertoken',
  'openaitoken',
  'railwaytoken',
  'refreshtoken',
  'sessiontoken',
  'webhooksecret',
  'clientsecret',
  'apikey',
  'secret',
  'password',
  'credential',
  'privatekey',
  'connectionstring',
  'databaseurl',
  'postgresurl',
  'redisurl',
  'authorization',
  'cookie',
];

const SECRET_STRING_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:railway|rwy|rw)_(?=[A-Za-z0-9_=]*\d)[A-Za-z0-9_=]{16,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"'`<>]+/gi,
  /\b(?=[A-Za-z0-9+/_=-]{32,}\b)(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}\b/g,
];

const ENV_VALUE_PATTERN =
  /((?:"|')?[A-Za-z0-9_.-]*(?:TOKEN|KEY|SECRET|PASSWORD|DATABASE|REDIS|POSTGRES|AUTH|COOKIE)[A-Za-z0-9_.-]*(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\[[^\]]+\]|[^\s,;}\]]+)/gi;

const CREDENTIAL_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const SENSITIVE_HEADER_PATTERN = /\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi;

export function isSensitiveKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) {
    return false;
  }

  return (
    SENSITIVE_EXACT_KEYS.has(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('key') ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectKnownSecretValues(env = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => isSensitiveKey(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
}

export function redactString(value, { knownSecrets = collectKnownSecretValues() } = {}) {
  let redacted = String(value ?? '');

  for (const secret of knownSecrets) {
    redacted = redacted.replace(new RegExp(escapeRegex(secret), 'g'), REDACTED);
  }

  redacted = redacted.replace(CREDENTIAL_URL_PATTERN, '$1[REDACTED]@');

  for (const pattern of SECRET_STRING_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => (
      /^Bearer\s+/i.test(match) ? `Bearer ${REDACTED}` : REDACTED
    ));
  }

  redacted = redacted.replace(SENSITIVE_HEADER_PATTERN, `$1: ${REDACTED}`);
  redacted = redacted.replace(ENV_VALUE_PATTERN, `$1${REDACTED}`);

  return redacted;
}

export function redactValue(value, key = '', options = {}, seen = new WeakSet(), depth = 0) {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    return redactString(value, options);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, '', options, seen, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return REDACTED;
  }

  if (depth > 20) {
    return REDACTED;
  }

  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      ['__proto__', 'constructor', 'prototype'].includes(entryKey)
        ? REDACTED
        : redactValue(entryValue, entryKey, options, seen, depth + 1),
    ])
  );
}

export function redactCommand(command = [], options = {}) {
  let redactNext = false;

  return command.map((arg) => {
    const argText = String(arg);
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }

    if (/^--?[A-Za-z0-9_.-]*(?:token|key|secret|password|database|redis|postgres|auth|cookie)[A-Za-z0-9_.-]*$/i.test(argText)) {
      redactNext = true;
      return argText;
    }

    return redactString(argText, options);
  });
}
