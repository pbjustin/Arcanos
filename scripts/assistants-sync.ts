const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_BEARER_LENGTH = 4_096;
const CONFIRMATION_CHALLENGE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface SyncSuccessPayload {
  ok: true;
  changed: boolean;
  count: number;
}

function fail(message: string, exitCode = 1): never {
  console.error(message);
  process.exitCode = exitCode;
  throw new Error('assistant-sync-script-exit');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function resolveSyncEndpoint(): URL {
  const configured = process.env.ASSISTANTS_BACKEND_URL
    || process.env.SERVER_URL
    || DEFAULT_BACKEND_URL;
  let backendUrl: URL;
  try {
    backendUrl = new URL(configured);
  } catch {
    return fail('Assistant sync backend URL is invalid.');
  }
  if (
    (backendUrl.protocol !== 'https:' && backendUrl.protocol !== 'http:')
    || backendUrl.username
    || backendUrl.password
    || backendUrl.search
    || backendUrl.hash
    || (backendUrl.protocol === 'http:' && !isLoopbackHostname(backendUrl.hostname))
  ) {
    return fail('Assistant sync backend URL is not permitted.');
  }
  const normalizedPath = backendUrl.pathname.replace(/\/+$/u, '');
  if (normalizedPath !== '') {
    return fail('Assistant sync backend URL must not contain a path.');
  }
  backendUrl.pathname = '/api/assistants/sync';
  return backendUrl;
}

function resolveBearerToken(): string {
  const token = process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;
  if (
    typeof token !== 'string'
    || token.length < 32
    || token.length > MAX_BEARER_LENGTH
    || token !== token.trim()
    || !/^[\x21-\x7E]+$/u.test(token)
  ) {
    return fail('Control-plane bearer configuration is unavailable.');
  }
  return token;
}

function resolveTimeoutMs(): number {
  const configured = process.env.ASSISTANTS_SYNC_TIMEOUT_MS;
  if (configured === undefined || configured === '') {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(configured);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1_000
    || parsed > MAX_TIMEOUT_MS
  ) {
    return fail('Assistant sync timeout configuration is invalid.');
  }
  return parsed;
}

function resolveConfirmationChallenge(): string | undefined {
  const argumentIndex = process.argv.indexOf('--challenge');
  const argumentValue = argumentIndex >= 0
    ? process.argv[argumentIndex + 1]
    : undefined;
  const challenge = argumentValue
    || process.env.ASSISTANTS_SYNC_CONFIRMATION_CHALLENGE;
  if (challenge === undefined || challenge === '') {
    return undefined;
  }
  if (!CONFIRMATION_CHALLENGE_PATTERN.test(challenge)) {
    return fail('Assistant sync confirmation challenge is invalid.');
  }
  return challenge;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength
    && (
      !/^\d+$/u.test(declaredLength)
      || Number(declaredLength) > MAX_RESPONSE_BYTES
    )
  ) {
    throw new Error('response-too-large');
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response-too-large');
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isSyncSuccessPayload(
  payload: Record<string, unknown> | null
): payload is Record<string, unknown> & SyncSuccessPayload {
  return payload?.ok === true
    && typeof payload.changed === 'boolean'
    && Number.isSafeInteger(payload.count)
    && Number(payload.count) >= 0
    && Number(payload.count) <= 1_000;
}

async function invokeSync(
  endpoint: URL,
  bearerToken: string,
  timeoutMs: number,
  challenge?: string
): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: abortController.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
        ...(challenge ? { 'x-confirmed': `token:${challenge}` } : {}),
      },
      body: '{}',
    });
    const content = await readBoundedResponse(response);
    const payload = parseJsonObject(content);

    if (!challenge && response.status === 403) {
      const issuedChallenge = response.headers.get('x-confirmation-challenge');
      if (
        issuedChallenge
        && CONFIRMATION_CHALLENGE_PATTERN.test(issuedChallenge)
      ) {
        console.log(`Confirmation challenge issued: ${issuedChallenge}`);
        console.log(
          'After operator approval, rerun with --challenge <challenge-id>.'
        );
        process.exitCode = 2;
        return;
      }
    }
    if (response.ok && isSyncSuccessPayload(payload)) {
      console.log(
        `Assistant registry sync complete: changed=${payload.changed} count=${payload.count}`
      );
      return;
    }
    if (response.status === 409) {
      const retryAfter = response.headers.get('retry-after');
      const boundedRetryAfter = retryAfter && /^\d{1,3}$/u.test(retryAfter)
        ? Math.min(300, Math.max(1, Number(retryAfter)))
        : 5;
      console.error(
        `Assistant registry sync is already running; retry after ${boundedRetryAfter}s.`
      );
      process.exitCode = 1;
      return;
    }
    console.error(`Assistant registry sync failed with status ${response.status}.`);
    process.exitCode = 1;
  } catch {
    console.error('Assistant registry sync request failed.');
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const endpoint = resolveSyncEndpoint();
  const bearerToken = resolveBearerToken();
  const timeoutMs = resolveTimeoutMs();
  const challenge = resolveConfirmationChallenge();
  await invokeSync(endpoint, bearerToken, timeoutMs, challenge);
}

main().catch((error: unknown) => {
  if (!(error instanceof Error && error.message === 'assistant-sync-script-exit')) {
    console.error('Assistant registry sync request failed.');
    process.exitCode = 1;
  }
});
