import { AsyncLocalStorage } from 'node:async_hooks';

/** Known provider consumption owned by one execution attempt, independent of session totals. */
export interface AttemptTokenUsage {
  totalTokens?: number;
  /** Sticky so a provider fallback cannot hide invalid internal accounting data. */
  error?: Error;
  /** Late provider callbacks cannot mutate an already terminal attempt. */
  closed?: boolean;
}

const attemptTokenUsageStorage = new AsyncLocalStorage<AttemptTokenUsage>();

/** One SDK operation owns a sequential transport/retry sequence. Concurrent operations get separate scopes. */
export interface AttemptTokenUsageOperation {
  errorUsageObserved: boolean;
}

const operationStorage = new AsyncLocalStorage<AttemptTokenUsageOperation>();
const MAX_ERROR_USAGE_BODY_BYTES = 64 * 1024;
const ERROR_USAGE_READ_TIMEOUT_MS = 250;

export function runWithAttemptTokenUsageOperation<T>(
  operation: AttemptTokenUsageOperation,
  callback: () => T
): T {
  return operationStorage.run(operation, callback);
}

function invalidTokenUsage(): Error {
  return Object.assign(new Error('Invalid provider token usage for execution attempt.'), {
    code: 'INVALID_PROVIDER_TOKEN_USAGE',
    retryable: false
  });
}

/** Validate explicit accounting values without coercing missing usage into zero. */
export function normalizeAttemptTokenUsage(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidTokenUsage();
  }
  return value;
}

/** Read the additive internal transport field; public token metadata is deliberately excluded. */
export function readAttemptTokenUsage(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return normalizeAttemptTokenUsage((value as { attemptTokenUsage?: unknown }).attemptTokenUsage);
}

/** Known aggregate provider tokens on a DAG child envelope crossing GPT Access.
 * The wire key avoids credential-key redaction without changing that policy.
 */
export function readDagChildTokenUsage(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return normalizeAttemptTokenUsage((value as { dagAttemptUsage?: unknown }).dagAttemptUsage);
}

export function createAttemptTokenUsage(): AttemptTokenUsage {
  return {};
}

/**
 * Scope provider observations to the complete awaited attempt. The caller retains the
 * scope on rejection, so known consumption survives provider, validation, and abort errors.
 */
export async function runWithAttemptTokenUsage<T>(
  usage: AttemptTokenUsage,
  callback: () => Promise<T> | T
): Promise<T> {
  try {
    const result = await attemptTokenUsageStorage.run(usage, callback);
    if (usage.error) {
      throw usage.error;
    }
    return result;
  } catch (error) {
    // Invalid accounting remains terminal even if a later fallback fails differently.
    throw usage.error ?? error;
  } finally {
    usage.closed = true;
  }
}

function readProviderTotal(usage: unknown): number | undefined {
  if (usage === undefined || usage === null) {
    return undefined;
  }
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    throw invalidTokenUsage();
  }
  const fields = usage as Record<string, unknown>;
  if (fields.total_tokens !== undefined) {
    return normalizeAttemptTokenUsage(fields.total_tokens);
  }
  const prompt = fields.input_tokens ?? fields.prompt_tokens;
  const completion = fields.output_tokens ?? fields.completion_tokens;
  const promptTokens = normalizeAttemptTokenUsage(prompt);
  const completionTokens = normalizeAttemptTokenUsage(completion);
  // A partial usage object is not proof of a total. Never invent its missing component.
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }
  return normalizeAttemptTokenUsage(promptTokens + completionTokens);
}

/** Capture one raw provider response before output parsing or fallback can discard its usage. */
export function recordAttemptTokenUsage(rawProviderUsage: unknown): void {
  const usage = attemptTokenUsageStorage.getStore();
  if (!usage || usage.closed) {
    return;
  }
  try {
    const tokens = readProviderTotal(rawProviderUsage);
    if (tokens !== undefined) {
      usage.totalTokens = normalizeAttemptTokenUsage((usage.totalTokens ?? 0) + tokens);
    }
  } catch (error) {
    usage.error ??= error instanceof Error ? error : invalidTokenUsage();
    throw usage.error;
  }
}

/** Preserve one explicit provider error payload, excluding duplicate outer SDK serialization. */
export function recordAttemptErrorTokenUsage(
  error: unknown,
  operation: AttemptTokenUsageOperation | undefined = operationStorage.getStore()
): void {
  if (operation?.errorUsageObserved || typeof error !== 'object' || error === null) return;
  const fields = error as { usage?: unknown; response?: { usage?: unknown }; error?: { usage?: unknown } };
  const rawUsage = fields.usage !== undefined ? fields.usage
    : fields.response?.usage !== undefined ? fields.response.usage : fields.error?.usage;
  if (rawUsage === undefined) return;
  try {
    recordAttemptTokenUsage(rawUsage);
  } catch {
    // The attempt retains invalid accounting without replacing provider diagnostics here.
  }
  if (operation) operation.errorUsageObserved = true;
}

async function readBoundedErrorUsageBody(response: Response, signal?: AbortSignal | null): Promise<unknown> {
  if (signal?.aborted || !response.body) return undefined;
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_ERROR_USAGE_BODY_BYTES) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
  } catch {
    return undefined;
  }
  if (!reader) return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopReading: () => void = () => {};
  const interrupted = new Promise<undefined>(resolve => {
    stopReading = () => resolve(undefined);
    timeout = setTimeout(stopReading, ERROR_USAGE_READ_TIMEOUT_MS);
    timeout.unref?.();
    signal?.addEventListener('abort', stopReading, { once: true });
    if (signal?.aborted) stopReading();
  });
  try {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (!next) return undefined;
      if (next.done) {
        return JSON.parse(text + decoder.decode()) as unknown;
      }
      bytes += next.value.byteLength;
      if (bytes > MAX_ERROR_USAGE_BODY_BYTES) return undefined;
      text += decoder.decode(next.value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', stopReading);
    // A tee's cancellation promise can wait for the SDK's original stream. Never await it here.
    void reader.cancel().catch(() => {});
  }
}

/** Observe bounded error responses before SDK retry discards them; successful responses stay at the adapter boundary. */
export function createAttemptTokenUsageFetch(nativeFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const attempt = attemptTokenUsageStorage.getStore();
    const operation = operationStorage.getStore();
    if (operation) operation.errorUsageObserved = false;
    const response = await nativeFetch(input, init);
    if (!attempt || attempt.closed || response.ok || !operation) return response;
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return response;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const payload = await readBoundedErrorUsageBody(response, signal);
    if (!attempt.closed) recordAttemptErrorTokenUsage(payload, operation);
    return response;
  };
}
