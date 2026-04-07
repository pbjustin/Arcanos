import crypto from 'node:crypto';

const PROMPT_LIKE_KEYS = new Set([
  'message',
  'prompt',
  'userinput',
  'content',
  'text',
  'query'
]);

const REQUEST_META_KEYS = new Set([
  'requestid',
  'traceid',
  'timestamp',
  'createdat',
  'updatedat',
  'submittedat',
  'receivedat',
  'jobid',
  'waitforresultms',
  'pollintervalms',
  'timeoutms',
  'tracing',
  'metadata'
]);

const TRANSPORT_HINT_KEYS = new Set([
  'async',
  'executionmode',
  'responsemode'
]);

function normalizePromptLikeString(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function shouldDropKey(path: string[], key: string): boolean {
  const normalizedKey = key.trim().toLowerCase();

  if (REQUEST_META_KEYS.has(normalizedKey) || TRANSPORT_HINT_KEYS.has(normalizedKey)) {
    return true;
  }

  if (path.length === 0 && normalizedKey === 'gptid') {
    return true;
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseBodyRecord(value: string): Record<string, unknown> | null {
  try {
    const parsedValue = JSON.parse(value);
    return isPlainObject(parsedValue) ? parsedValue : null;
  } catch {
    return null;
  }
}

export function normalizeGptRequestBody(body: unknown): Record<string, unknown> | null {
  if (isPlainObject(body)) {
    const bodyEntries = Object.entries(body);
    if (bodyEntries.length === 1) {
      const [candidateJson, candidateValue] = bodyEntries[0];
      if (candidateValue === '' || candidateValue === null) {
        return tryParseBodyRecord(candidateJson) ?? body;
      }
    }

    return body;
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return tryParseBodyRecord(body);
  }

  return null;
}

function canonicalizeValue(value: unknown, path: string[] = []): unknown {
  if (typeof value === 'string') {
    const pathKey = path[path.length - 1]?.toLowerCase() ?? '';
    if (PROMPT_LIKE_KEYS.has(pathKey) || pathKey === 'content') {
      return normalizePromptLikeString(value);
    }

    return value.trim();
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeValue(item, [...path, String(index)]));
  }

  if (isPlainObject(value)) {
    const normalizedEntries = Object.entries(value)
      .filter(([key]) => !shouldDropKey(path, key))
      .map(([key, entryValue]) => [
        key,
        canonicalizeValue(entryValue, [...path, key])
      ] as const)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    return Object.fromEntries(normalizedEntries);
  }

  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const normalizedEntries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${normalizedEntries.join(',')}}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface GptRequestFingerprintInput {
  gptId: string;
  action?: string | null;
  body: unknown;
}

export interface GptIdempotencyDescriptor {
  source: 'explicit' | 'derived';
  publicIdempotencyKey: string;
  explicitIdempotencyKey?: string;
  scopeHash: string;
  fingerprintHash: string;
  idempotencyKeyHash: string;
}

export function normalizeExplicitIdempotencyKey(rawValue: string | undefined | null): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmedValue = rawValue.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

export function summarizeFingerprintHash(hash: string | null | undefined): string | null {
  if (typeof hash !== 'string' || hash.trim().length === 0) {
    return null;
  }

  return hash.slice(0, 12);
}

export function buildGptRequestFingerprintHash(input: GptRequestFingerprintInput): string {
  const normalizedBody = canonicalizeValue(normalizeGptRequestBody(input.body) ?? {});
  const normalizedFingerprintPayload = {
    gptId: input.gptId.trim().toLowerCase(),
    action: typeof input.action === 'string' && input.action.trim().length > 0
      ? input.action.trim().toLowerCase()
      : 'query',
    body: normalizedBody
  };

  return sha256(stableStringify(normalizedFingerprintPayload));
}

export function buildGptIdempotencyDescriptor(input: {
  gptId: string;
  action?: string | null;
  body: unknown;
  actorKey: string;
  explicitIdempotencyKey?: string | null;
}): GptIdempotencyDescriptor {
  const explicitIdempotencyKey = normalizeExplicitIdempotencyKey(input.explicitIdempotencyKey);
  const fingerprintHash = buildGptRequestFingerprintHash({
    gptId: input.gptId,
    action: input.action,
    body: input.body
  });
  const scopeHash = sha256(input.actorKey.trim());

  if (explicitIdempotencyKey) {
    return {
      source: 'explicit',
      publicIdempotencyKey: explicitIdempotencyKey,
      explicitIdempotencyKey,
      scopeHash,
      fingerprintHash,
      idempotencyKeyHash: sha256(explicitIdempotencyKey)
    };
  }

  return {
    source: 'derived',
    publicIdempotencyKey: `derived:${fingerprintHash}`,
    scopeHash,
    fingerprintHash,
    idempotencyKeyHash: sha256(`derived:${fingerprintHash}`)
  };
}
