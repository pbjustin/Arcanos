import crypto from 'node:crypto';

const GPT_ID = 'arcanos-core' as const;
const JOB_CREATE_PATH = '/gpt-access/jobs/create' as const;
const JOB_RESULT_PATH = '/gpt-access/jobs/result' as const;
const IDEMPOTENCY_VERSION = 'arcanos-core-advisory:v1' as const;
const MAX_TASK_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_DEADLINE_MS = 180_000;
const DEFAULT_MAX_POLLS = 90;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const SENSITIVE_INPUT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;}]{8,}/i
] as const;

const SENSITIVE_RESPONSE_KEYS = [
  'apikey',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'databaseurl',
  'header',
  'password',
  'providerbody',
  'providerpayload',
  'rawpayload',
  'secret',
  'token'
] as const;

const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]'],
  [/\b(authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;}]+/gi, '$1=[REDACTED]']
];

export type ArcanosCoreAdvisoryErrorCode =
  | 'ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID'
  | 'ARCANOS_CORE_ADVISORY_REQUEST_REJECTED'
  | 'ARCANOS_CORE_ADVISORY_GATEWAY_UNAVAILABLE'
  | 'ARCANOS_CORE_ADVISORY_GATEWAY_REJECTED'
  | 'ARCANOS_CORE_ADVISORY_RESPONSE_INVALID'
  | 'ARCANOS_CORE_ADVISORY_RESPONSE_TOO_LARGE'
  | 'ARCANOS_CORE_ADVISORY_JOB_FAILED'
  | 'ARCANOS_CORE_ADVISORY_JOB_EXPIRED'
  | 'ARCANOS_CORE_ADVISORY_JOB_NOT_FOUND'
  | 'ARCANOS_CORE_ADVISORY_POLL_LIMIT';

const ERROR_MESSAGES: Record<ArcanosCoreAdvisoryErrorCode, string> = {
  ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID: 'Advisory bridge configuration is unavailable.',
  ARCANOS_CORE_ADVISORY_REQUEST_REJECTED: 'The advisory consultation request was rejected.',
  ARCANOS_CORE_ADVISORY_GATEWAY_UNAVAILABLE: 'The advisory gateway is unavailable.',
  ARCANOS_CORE_ADVISORY_GATEWAY_REJECTED: 'The advisory gateway rejected the request.',
  ARCANOS_CORE_ADVISORY_RESPONSE_INVALID: 'The advisory gateway returned an invalid response.',
  ARCANOS_CORE_ADVISORY_RESPONSE_TOO_LARGE: 'The advisory gateway response exceeded the allowed size.',
  ARCANOS_CORE_ADVISORY_JOB_FAILED: 'The advisory consultation failed.',
  ARCANOS_CORE_ADVISORY_JOB_EXPIRED: 'The advisory consultation expired.',
  ARCANOS_CORE_ADVISORY_JOB_NOT_FOUND: 'The advisory consultation could not be found.',
  ARCANOS_CORE_ADVISORY_POLL_LIMIT: 'The advisory consultation did not complete within the polling limit.'
};

export class ArcanosCoreAdvisoryError extends Error {
  constructor(readonly code: ArcanosCoreAdvisoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ArcanosCoreAdvisoryError';
  }
}

export interface ArcanosCoreAdvisoryRequest {
  task: string;
  context?: string;
  maxOutputTokens?: number;
}

export interface ArcanosCoreAdvisoryResult {
  ok: true;
  gptId: typeof GPT_ID;
  jobId: string;
  traceId?: string;
  result: unknown;
}

export interface ArcanosCoreAdvisoryPort {
  consult(input: ArcanosCoreAdvisoryRequest): Promise<ArcanosCoreAdvisoryResult>;
}

export interface ArcanosCoreAdvisoryClientOptions {
  baseUrl: string;
  credential: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
  maxPolls?: number;
  maxResponseBytes?: number;
  sleepFn?: (milliseconds: number) => Promise<void>;
  nowFn?: () => number;
}

export interface ArcanosCoreAdvisoryConfig {
  baseUrl: string;
  credential: string;
}

type JsonObject = Record<string, unknown>;

interface NormalizedRequest {
  task: string;
  context?: string;
  maxOutputTokens: number;
}

interface GatewayResponse {
  status: number;
  payload: unknown;
}

function advisoryError(code: ArcanosCoreAdvisoryErrorCode): ArcanosCoreAdvisoryError {
  return new ArcanosCoreAdvisoryError(code);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
  }

  return parsed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
  }
  return value;
}

function containsSensitiveMaterial(value: string): boolean {
  return SENSITIVE_INPUT_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeRequest(input: ArcanosCoreAdvisoryRequest): NormalizedRequest {
  if (!input || typeof input !== 'object') {
    throw advisoryError('ARCANOS_CORE_ADVISORY_REQUEST_REJECTED');
  }

  const task = typeof input.task === 'string' ? input.task.trim() : '';
  const context = typeof input.context === 'string' ? input.context.trim() : undefined;
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  if (
    task.length === 0 ||
    task.length > MAX_TASK_CHARS ||
    (context !== undefined && context.length > MAX_CONTEXT_CHARS) ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > MAX_OUTPUT_TOKENS ||
    task.includes('\0') ||
    context?.includes('\0') ||
    containsSensitiveMaterial(task) ||
    (context !== undefined && containsSensitiveMaterial(context))
  ) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_REQUEST_REJECTED');
  }

  return {
    task,
    ...(context ? { context } : {}),
    maxOutputTokens
  };
}

function buildIdempotencyKey(input: NormalizedRequest): string {
  const fingerprint = JSON.stringify({
    version: 1,
    gptId: GPT_ID,
    task: input.task,
    context: input.context ?? null,
    maxOutputTokens: input.maxOutputTokens
  });
  const digest = crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
  return `${IDEMPOTENCY_VERSION}:${digest}`;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function containsConfiguredSensitiveValue(value: string, sensitiveValues: readonly string[]): boolean {
  return sensitiveValues.some((sensitiveValue) => value.includes(sensitiveValue));
}

function isSensitiveResponseKey(key: string, sensitiveValues: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_RESPONSE_KEYS.some((fragment) => normalized.includes(fragment)) ||
    containsSensitiveMaterial(key) ||
    containsConfiguredSensitiveValue(key, sensitiveValues);
}

function redactString(value: string, sensitiveValues: readonly string[]): string {
  const patternRedacted = STRING_REDACTIONS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value
  );
  return sensitiveValues.reduce(
    (redacted, sensitiveValue) => redacted.split(sensitiveValue).join('[REDACTED]'),
    patternRedacted
  );
}

function sanitizeResult(value: unknown, sensitiveValues: readonly string[], depth = 0): unknown {
  if (depth > 32) {
    return '[REDACTED_DEPTH_LIMIT]';
  }
  if (typeof value === 'string') {
    return redactString(value, sensitiveValues);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeResult(entry, sensitiveValues, depth + 1));
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
      isSensitiveResponseKey(key, sensitiveValues)
        ? []
        : [[key, sanitizeResult(entry, sensitiveValues, depth + 1)]]
    ));
  }
  return null;
}

async function readBoundedJsonUnchecked(response: Response, maxResponseBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_TOO_LARGE');
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
  }

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_TOO_LARGE');
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
  }
}

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  try {
    return await readBoundedJsonUnchecked(response, maxResponseBytes);
  } catch (error) {
    if (error instanceof ArcanosCoreAdvisoryError) {
      throw error;
    }
    throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
  }
}

function requireCreatePayload(
  payload: unknown,
  sensitiveValues: readonly string[]
): { jobId: string; traceId?: string } {
  if (
    !isObject(payload) ||
    payload.ok !== true ||
    typeof payload.jobId !== 'string' ||
    !UUID_PATTERN.test(payload.jobId) ||
    !['queued', 'running', 'completed', 'failed'].includes(String(payload.status)) ||
    typeof payload.deduped !== 'boolean' ||
    payload.resultEndpoint !== JOB_RESULT_PATH ||
    (payload.traceId !== undefined && typeof payload.traceId !== 'string')
  ) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
  }
  const traceId = typeof payload.traceId === 'string' &&
    SAFE_TRACE_ID_PATTERN.test(payload.traceId) &&
    !isSensitiveResponseKey(payload.traceId, sensitiveValues)
    ? payload.traceId
    : undefined;
  return {
    jobId: payload.jobId,
    ...(traceId ? { traceId } : {})
  };
}

export function resolveArcanosCoreAdvisoryConfig(
  env: Record<string, string | undefined> = process.env
): ArcanosCoreAdvisoryConfig {
  const baseUrl = env.ARCANOS_CORE_ADVISORY_BASE_URL?.trim();
  const credential = env.ARCANOS_CORE_ADVISORY_ACCESS_TOKEN?.trim();
  if (!baseUrl || !credential || credential.length < 16 || credential.length > 4_096) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
  }
  normalizeOrigin(baseUrl);
  return { baseUrl, credential };
}

export function createArcanosCoreAdvisoryClient(
  options: ArcanosCoreAdvisoryClientOptions
): ArcanosCoreAdvisoryPort {
  const baseUrl = normalizeOrigin(options.baseUrl);
  const credential = options.credential.trim();
  if (!credential || credential.length < 16 || credential.length > 4_096) {
    throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
  }

  const requestTimeoutMs = normalizePositiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const pollIntervalMs = normalizePositiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const pollDeadlineMs = normalizePositiveInteger(options.pollDeadlineMs, DEFAULT_POLL_DEADLINE_MS);
  const maxPolls = normalizePositiveInteger(options.maxPolls, DEFAULT_MAX_POLLS, true);
  const maxResponseBytes = normalizePositiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const sleepFn = options.sleepFn ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const nowFn = options.nowFn ?? Date.now;

  async function postJson(path: typeof JOB_CREATE_PATH | typeof JOB_RESULT_PATH, body: JsonObject): Promise<GatewayResponse> {
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw advisoryError('ARCANOS_CORE_ADVISORY_CONFIGURATION_INVALID');
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          redirect: 'manual',
          signal: abortController.signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(body)
        });
      } catch {
        throw advisoryError('ARCANOS_CORE_ADVISORY_GATEWAY_UNAVAILABLE');
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw advisoryError('ARCANOS_CORE_ADVISORY_GATEWAY_REJECTED');
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw advisoryError(
          response.status >= 500
            ? 'ARCANOS_CORE_ADVISORY_GATEWAY_UNAVAILABLE'
            : 'ARCANOS_CORE_ADVISORY_GATEWAY_REJECTED'
        );
      }
      return {
        status: response.status,
        payload: await readBoundedJson(response, maxResponseBytes)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async consult(input: ArcanosCoreAdvisoryRequest): Promise<ArcanosCoreAdvisoryResult> {
      const normalized = normalizeRequest(input);
      if (normalized.task.includes(credential) || normalized.context?.includes(credential)) {
        throw advisoryError('ARCANOS_CORE_ADVISORY_REQUEST_REJECTED');
      }
      const createResponse = await postJson(JOB_CREATE_PATH, {
        gptId: GPT_ID,
        task: normalized.task,
        ...(normalized.context ? { context: normalized.context } : {}),
        maxOutputTokens: normalized.maxOutputTokens,
        idempotencyKey: buildIdempotencyKey(normalized)
      });
      if (createResponse.status !== 202) {
        throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
      }

      const created = requireCreatePayload(createResponse.payload, [credential]);
      const pollStartedAt = nowFn();
      for (let poll = 0; poll < maxPolls; poll += 1) {
        if (nowFn() - pollStartedAt > pollDeadlineMs) {
          throw advisoryError('ARCANOS_CORE_ADVISORY_POLL_LIMIT');
        }

        const resultResponse = await postJson(JOB_RESULT_PATH, {
          jobId: created.jobId,
          ...(created.traceId ? { traceId: created.traceId } : {})
        });
        if (resultResponse.status !== 200 || !isObject(resultResponse.payload)) {
          throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
        }

        const payload = resultResponse.payload;
        if (
          payload.ok !== true ||
          payload.jobId !== created.jobId ||
          typeof payload.status !== 'string'
        ) {
          throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
        }

        if (payload.status === 'completed') {
          if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
            throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
          }
          return {
            ok: true,
            gptId: GPT_ID,
            jobId: created.jobId,
            ...(created.traceId ? { traceId: created.traceId } : {}),
            result: sanitizeResult(payload.result, [credential])
          };
        }
        if (payload.status === 'failed') {
          throw advisoryError('ARCANOS_CORE_ADVISORY_JOB_FAILED');
        }
        if (payload.status === 'expired') {
          throw advisoryError('ARCANOS_CORE_ADVISORY_JOB_EXPIRED');
        }
        if (payload.status === 'not_found') {
          throw advisoryError('ARCANOS_CORE_ADVISORY_JOB_NOT_FOUND');
        }
        if (payload.status !== 'pending') {
          throw advisoryError('ARCANOS_CORE_ADVISORY_RESPONSE_INVALID');
        }

        await sleepFn(pollIntervalMs);
      }

      throw advisoryError('ARCANOS_CORE_ADVISORY_POLL_LIMIT');
    }
  };
}
