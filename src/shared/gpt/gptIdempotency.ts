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

function compareStringKeys(leftKey: string, rightKey: string): number {
  if (leftKey < rightKey) {
    return -1;
  }

  if (leftKey > rightKey) {
    return 1;
  }

  return 0;
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
      .sort(([leftKey], [rightKey]) => compareStringKeys(leftKey, rightKey));

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
    .sort(([leftKey], [rightKey]) => compareStringKeys(leftKey, rightKey))
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
  fingerprintDomain?: string | null;
}

export interface GptIdempotencyDescriptor {
  source: 'explicit' | 'derived';
  publicIdempotencyKey: string;
  explicitIdempotencyKey?: string;
  scopeHash: string;
  fingerprintHash: string;
  idempotencyKeyHash: string;
}

export type GptJobCreationSurface =
  | 'public-gpt'
  | 'custom-gpt-bridge'
  | 'gpt-access';

export type PublicGptJobCreationSurface = Exclude<
  GptJobCreationSurface,
  'gpt-access'
>;

const PUBLIC_GPT_REQUEST_PATH_PATTERN =
  /^\/gpt\/[^/?#]+\/?(?:[?#]|$)/iu;
const CUSTOM_GPT_BRIDGE_REQUEST_PATH = '/api/bridge/gpt';
const GPT_ACCESS_JOB_CREATE_REQUEST_PATH = '/gpt-access/jobs/create';
const CUSTOM_GPT_BRIDGE_EXECUTION_REASONS = new Set([
  'bridge_query',
  'bridge_query_and_wait',
  'bridge_echo',
  'bridge_health_echo',
]);

function readJobRequestPath(input: unknown): string | null {
  if (!isPlainObject(input) || typeof input.requestPath !== 'string') {
    return null;
  }

  const requestPath = input.requestPath.trim();
  return requestPath.length > 0 ? requestPath : null;
}

function readJobExecutionModeReason(input: unknown): string | null {
  if (!isPlainObject(input) || typeof input.executionModeReason !== 'string') {
    return null;
  }

  const executionModeReason = input.executionModeReason.trim();
  return executionModeReason.length > 0 ? executionModeReason : null;
}

/**
 * Recover the trusted server-side creation surface stored with a GPT job.
 *
 * Public callers cannot choose these values: the three enqueue paths persist
 * them after request parsing. Unknown or legacy provenance remains unclassified.
 */
export function resolveGptJobCreationSurface(
  input: unknown
): GptJobCreationSurface | null {
  const requestPath = readJobRequestPath(input);
  if (!requestPath) {
    return null;
  }

  if (PUBLIC_GPT_REQUEST_PATH_PATTERN.test(requestPath)) {
    return 'public-gpt';
  }

  if (requestPath === CUSTOM_GPT_BRIDGE_REQUEST_PATH) {
    return CUSTOM_GPT_BRIDGE_EXECUTION_REASONS.has(
      readJobExecutionModeReason(input) ?? ''
    )
      ? 'custom-gpt-bridge'
      : null;
  }

  if (requestPath === GPT_ACCESS_JOB_CREATE_REQUEST_PATH) {
    return readJobExecutionModeReason(input) === 'gpt_access_create_ai_job'
      ? 'gpt-access'
      : null;
  }

  return null;
}

export function resolvePublicGptJobCreationSurface(
  input: unknown
): PublicGptJobCreationSurface | null {
  const surface = resolveGptJobCreationSurface(input);
  return surface === 'public-gpt' || surface === 'custom-gpt-bridge'
    ? surface
    : null;
}

export function buildGptIdempotencyScopeHash(input: {
  surface: GptJobCreationSurface;
  actorKey: string;
}): string {
  return sha256(`${input.surface}\n${input.actorKey.trim()}`);
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
  const normalizedBody = normalizeGptRequestBody(input.body);
  const fingerprintDomain = typeof input.fingerprintDomain === 'string'
    ? input.fingerprintDomain.trim().toLowerCase()
    : '';
  const normalizedFingerprintPayload = {
    ...(fingerprintDomain.length > 0 ? { fingerprintDomain } : {}),
    gptId: input.gptId.trim().toLowerCase(),
    action: typeof input.action === 'string' && input.action.trim().length > 0
      ? input.action.trim().toLowerCase()
      : 'query',
    body: canonicalizeValue(normalizedBody ?? input.body)
  };

  return sha256(stableStringify(normalizedFingerprintPayload));
}

export function buildGptIdempotencyDescriptor(input: {
  gptId: string;
  action?: string | null;
  body: unknown;
  fingerprintDomain?: string | null;
  surface: GptJobCreationSurface;
  actorKey: string;
  explicitIdempotencyKey?: string | null;
}): GptIdempotencyDescriptor {
  const explicitIdempotencyKey = normalizeExplicitIdempotencyKey(input.explicitIdempotencyKey);
  const fingerprintHash = buildGptRequestFingerprintHash({
    gptId: input.gptId,
    action: input.action,
    body: input.body,
    fingerprintDomain: input.fingerprintDomain,
  });
  const scopeHash = buildGptIdempotencyScopeHash({
    surface: input.surface,
    actorKey: input.actorKey,
  });

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
