import { queryAndWaitGptRoute } from "./backend.js";

export const ARCANOS_DEGRADED_FALLBACK_MESSAGE =
  "ARCANOS completed in degraded fallback mode; documentation generation must be split into smaller tasks.";

const DEFAULT_GPT_ID = "arcanos-core";
const DEFAULT_DIRECT_TIMEOUT_MS = 25_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 5_000;
const MAX_ERROR_BODY_CHARS = 1_000;

export type ArcanosJobStatus =
  | "completed"
  | "queued"
  | "running"
  | "failed"
  | "cancelled"
  | "expired"
  | "not_found"
  | "timeout"
  | "degraded"
  | string;

export interface RunArcanosJobOptions {
  baseUrl: string;
  gptId?: string;
  directTimeoutMs?: number;
  totalTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  headers?: Record<string, string>;
  context?: Record<string, unknown>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  randomFn?: () => number;
}

export interface PollArcanosJobOptions {
  baseUrl: string;
  pollUrl?: string;
  streamUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  randomFn?: () => number;
}

export interface ArcanosJobResult {
  ok: boolean;
  status: ArcanosJobStatus;
  jobStatus?: string;
  jobId?: string;
  poll?: string;
  stream?: string;
  timedOut: boolean;
  degraded: boolean;
  result?: unknown;
  error?: unknown;
  raw: Record<string, unknown>;
}

interface NormalizeMetadata {
  jobId?: string;
  poll?: string;
  stream?: string;
}

/**
 * Runs one ARCANOS writing job through `/gpt/{gptId}` and follows async completion through `/jobs/{id}/result`.
 * Inputs/Outputs: prompt + operator-side transport settings -> normalized terminal result with job metadata.
 * Edge cases: timed-out, queued, or running acknowledgements must include a job id; fallback completions are typed as degraded.
 */
export async function runArcanosJob(
  prompt: string,
  options: RunArcanosJobOptions
): Promise<ArcanosJobResult> {
  if (!prompt.trim()) {
    throw new Error("ARCANOS job prompt is required.");
  }

  const initialPayload = await queryAndWaitGptRoute({
    baseUrl: options.baseUrl,
    gptId: options.gptId ?? DEFAULT_GPT_ID,
    prompt,
    timeoutMs: options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    headers: options.headers,
    context: options.context,
    fetchFn: options.fetchFn,
  });
  const initialResult = normalizeArcanosResult(initialPayload);

  if (initialResult.status === "completed" || initialResult.status === "degraded") {
    return initialResult;
  }

  if (
    initialResult.timedOut ||
    initialResult.status === "queued" ||
    initialResult.status === "running" ||
    initialResult.status === "timeout"
  ) {
    if (!initialResult.jobId) {
      throw new Error("ARCANOS async response is missing jobId; cannot poll for completion.");
    }

    const finalResult = await pollArcanosJob(initialResult.jobId, {
      baseUrl: options.baseUrl,
      pollUrl: initialResult.poll,
      streamUrl: initialResult.stream,
      timeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxIntervalMs: options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
      headers: options.headers,
      fetchFn: options.fetchFn,
      sleepFn: options.sleepFn,
      nowFn: options.nowFn,
      randomFn: options.randomFn,
    });
    return {
      ...finalResult,
      timedOut: finalResult.timedOut || initialResult.timedOut,
    };
  }

  if (isFailureStatus(initialResult.status)) {
    throw new Error(formatTerminalJobFailure(initialResult));
  }

  return initialResult;
}

/**
 * Polls `/jobs/{id}/result` until the job reaches a terminal status or the bounded timeout expires.
 * Inputs/Outputs: job id + poll settings -> normalized terminal result.
 * Edge cases: relative and absolute poll URLs are accepted, but polling never routes through `/gpt/{gptId}`.
 */
export async function pollArcanosJob(
  jobId: string,
  options: PollArcanosJobOptions
): Promise<ArcanosJobResult> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    throw new Error("ARCANOS poll requires a jobId.");
  }

  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowFn = options.nowFn ?? Date.now;
  const randomFn = options.randomFn ?? Math.random;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
  const maxIntervalMs = normalizePositiveInteger(options.maxIntervalMs, DEFAULT_MAX_POLL_INTERVAL_MS);
  let intervalMs = Math.min(
    normalizePositiveInteger(options.intervalMs, DEFAULT_POLL_INTERVAL_MS),
    maxIntervalMs
  );
  const resultUrl = buildJobResultPollUrl(options.baseUrl, options.pollUrl, normalizedJobId);
  const deadlineMs = nowFn() + timeoutMs;
  let lastStatus: string | undefined;

  while (nowFn() <= deadlineMs) {
    let rawPayload: Record<string, unknown>;
    try {
      rawPayload = await getJson(fetchFn, resultUrl, options.headers, nowFn);
    } catch (error) {
      if (!isRateLimitError(error)) {
        throw error;
      }

      lastStatus = "rate_limited";
      const remainingMs = deadlineMs - nowFn();
      if (remainingMs <= 0) {
        break;
      }

      const retryDelayMs = error.retryAfterMs ?? jitterDelayMs(intervalMs, maxIntervalMs, randomFn);
      await sleepFn(Math.min(retryDelayMs, remainingMs));
      intervalMs = nextBackoffIntervalMs(intervalMs, maxIntervalMs);
      continue;
    }

    const result = normalizeArcanosResult(rawPayload, {
      jobId: normalizedJobId,
      poll: resultUrl,
      stream: options.streamUrl,
    });
    lastStatus = result.jobStatus ?? result.status;

    if (result.status === "completed" || result.status === "degraded") {
      return result;
    }

    if (isFailureStatus(result.status)) {
      throw new Error(formatTerminalJobFailure(result));
    }

    const remainingMs = deadlineMs - nowFn();
    if (remainingMs <= 0) {
      break;
    }

    await sleepFn(Math.min(jitterDelayMs(intervalMs, maxIntervalMs, randomFn), remainingMs));
    intervalMs = nextBackoffIntervalMs(intervalMs, maxIntervalMs);
  }

  throw new Error(
    `ARCANOS job ${normalizedJobId} polling timed out after ${timeoutMs}ms` +
      `${lastStatus ? `; last status=${lastStatus}` : ""}; poll=${resultUrl}`
  );
}

/**
 * Normalizes ARCANOS GPT/job envelopes into one result shape that callers can test without route-specific branching.
 */
export function normalizeArcanosResult(
  payload: Record<string, unknown>,
  metadata: NormalizeMetadata = {}
): ArcanosJobResult {
  const raw = payload;
  const jobId = readString(raw.jobId) ?? readString(raw.id) ?? metadata.jobId;
  const poll = normalizeOptionalPollUrl(metadata.poll ?? readString(raw.poll), jobId);
  const stream = metadata.stream ?? readString(raw.stream) ?? (jobId ? `/jobs/${encodeURIComponent(jobId)}/stream` : undefined);
  const resolvedStatus = resolveStatus(raw, jobId);
  const resultPayload = extractResultPayload(raw);
  const degraded = isPipelineFallback(raw) || isPipelineFallback(resultPayload);
  const status = degraded && resolvedStatus === "completed" ? "degraded" : resolvedStatus;

  return compactResult({
    ok: raw.ok !== false && status !== "degraded" && !isFailureStatus(status),
    status,
    jobStatus: resolvedStatus,
    jobId,
    poll,
    stream,
    timedOut: Boolean(raw.timedOut) || resolvedStatus === "timeout",
    degraded,
    result: resultPayload,
    error: extractErrorPayload(raw),
    raw,
  });
}

/**
 * Detects ARCANOS core pipeline fallback metadata. Fallback output is not a successful AI generation.
 */
export function isPipelineFallback(result: unknown): boolean {
  const candidates = collectFallbackCandidates(result);

  return candidates.some((candidate) => {
    if (candidate.fallbackFlag === true) {
      return true;
    }

    if (readString(candidate.timeoutKind) === "pipeline_timeout") {
      return true;
    }

    const activeModel = readString(candidate.activeModel);
    if (activeModel?.includes("static-timeout-fallback")) {
      return true;
    }

    const auditSafe = isRecord(candidate.auditSafe) ? candidate.auditSafe : null;
    const auditFlags = Array.isArray(auditSafe?.auditFlags) ? auditSafe.auditFlags : [];
    return auditFlags.includes("CORE_PIPELINE_TIMEOUT_FALLBACK");
  });
}

export function buildJobResultPollUrl(baseUrl: string, pollUrl: string | undefined, jobId: string): string {
  const fallbackPollPath = `/jobs/${encodeURIComponent(jobId)}/result`;
  const absolutePollUrl = new URL(pollUrl?.trim() || fallbackPollPath, withTrailingSlash(baseUrl));
  const trimmedPathname = absolutePollUrl.pathname.replace(/\/+$/, "");

  absolutePollUrl.pathname = trimmedPathname.endsWith("/result")
    ? trimmedPathname
    : `${trimmedPathname}/result`;

  return absolutePollUrl.toString();
}

function collectFallbackCandidates(value: unknown): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();

  while (queue.length > 0 && candidates.length < 16) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    for (const key of ["result", "output", "response", "data", "metadata", "auditSafe"]) {
      if (key in current) {
        queue.push(current[key]);
      }
    }
  }

  return candidates;
}

function resolveStatus(raw: Record<string, unknown>, jobId: string | undefined): ArcanosJobStatus {
  const explicitStatus =
    readString(raw.status) ??
    readString(raw.jobStatus) ??
    readString(raw.lifecycleStatus) ??
    readString(raw.lifecycle_status);

  if (explicitStatus) {
    return normalizeStatus(explicitStatus);
  }

  if (raw.timedOut === true) {
    return "timeout";
  }

  if (Object.prototype.hasOwnProperty.call(raw, "result") || Object.prototype.hasOwnProperty.call(raw, "output")) {
    return "completed";
  }

  if (jobId) {
    return "queued";
  }

  return raw.ok === false ? "failed" : "completed";
}

function normalizeStatus(status: string): ArcanosJobStatus {
  const normalized = status.trim().toLowerCase();
  if (normalized === "pending") {
    return "queued";
  }

  return normalized;
}

function isFailureStatus(status: string): boolean {
  return status === "failed" || status === "cancelled" || status === "expired" || status === "not_found";
}

function formatTerminalJobFailure(result: ArcanosJobResult): string {
  const message = extractErrorMessage(result.error) ?? extractErrorMessage(result.raw) ?? "terminal failure";
  return `ARCANOS job ${result.jobId ?? "<unknown>"} ended in status=${result.status}: ${message}`;
}

function extractResultPayload(raw: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, "output")) {
    return raw.output;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "result")) {
    return raw.result;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "response")) {
    return raw.response;
  }

  return undefined;
}

function extractErrorPayload(raw: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, "error")) {
    return raw.error;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "error_message")) {
    return raw.error_message;
  }

  return undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return readString(value.message) ?? readString(value.error) ?? readString(value.code);
}

function normalizeOptionalPollUrl(pollUrl: string | undefined, jobId: string | undefined): string | undefined {
  const trimmedPollUrl = pollUrl?.trim();
  if (trimmedPollUrl) {
    const normalizedPollUrl = trimmedPollUrl.replace(/\/+$/, "");
    if (normalizedPollUrl.endsWith("/result")) {
      return normalizedPollUrl;
    }
    return `${normalizedPollUrl}/result`;
  }

  return jobId ? `/jobs/${encodeURIComponent(jobId)}/result` : undefined;
}

async function getJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
  nowFn: () => number = Date.now
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    method: "GET",
    headers,
  });
  const rawText = await response.text();
  let parsed: unknown;

  try {
    parsed = rawText.trim().length > 0 ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const retryAfterMs = response.status === 429
      ? parseRetryAfterMs(response.headers.get("retry-after"), nowFn)
      : undefined;
    throw new ArcanosHttpError(
      `ARCANOS job poll failed with HTTP ${response.status}: ${formatPayloadForError(parsed, rawText)}`,
      response.status,
      retryAfterMs
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`ARCANOS job poll returned a non-object JSON payload: ${formatPayloadForError(parsed, rawText)}`);
  }

  return parsed;
}

class ArcanosHttpError extends Error {
  status: number;
  retryAfterMs: number | undefined;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "ArcanosHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRateLimitError(error: unknown): error is ArcanosHttpError {
  return error instanceof ArcanosHttpError && error.status === 429;
}

function nextBackoffIntervalMs(intervalMs: number, maxIntervalMs: number): number {
  return Math.min(maxIntervalMs, Math.ceil(intervalMs * 1.5));
}

function jitterDelayMs(intervalMs: number, maxIntervalMs: number, randomFn: () => number): number {
  const rawRandom = randomFn();
  const normalizedRandom = Number.isFinite(rawRandom)
    ? Math.max(0, Math.min(1, rawRandom))
    : 0.5;
  const jitterFactor = 0.8 + normalizedRandom * 0.4;
  return Math.min(maxIntervalMs, Math.max(1, Math.ceil(intervalMs * jitterFactor)));
}

function parseRetryAfterMs(value: string | null, nowFn: () => number = Date.now): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAtMs = Date.parse(trimmed);
  return Number.isFinite(retryAtMs)
    ? Math.max(0, retryAtMs - nowFn())
    : undefined;
}

function formatPayloadForError(parsed: unknown, rawText: string): string {
  if (isRecord(parsed)) {
    return JSON.stringify(parsed);
  }

  const trimmedText = rawText.trim();
  if (!trimmedText) {
    return "<empty response body>";
  }

  return trimmedText.length <= MAX_ERROR_BODY_CHARS
    ? trimmedText
    : `${trimmedText.slice(0, MAX_ERROR_BODY_CHARS)}\n[truncated]`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

function compactResult(result: ArcanosJobResult): ArcanosJobResult {
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined)
  ) as unknown as ArcanosJobResult;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
