import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  findOrCreateGptJob,
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError,
} from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  buildQueuedGptJobInput,
  buildQueuedGptPendingResponse,
} from '@shared/gpt/asyncGptJob.js';
import {
  buildGptIdempotencyDescriptor,
  normalizeExplicitIdempotencyKey,
} from '@shared/gpt/gptIdempotency.js';
import { resolveGptJobLifecycleStatus, summarizeGptJobTimings } from '@shared/gpt/gptJobLifecycle.js';
import { GPT_QUERY_ACTION, GPT_QUERY_AND_WAIT_ACTION } from '@shared/gpt/gptJobResult.js';
import { planAutonomousWorkerJob } from './workerAutonomyService.js';
import {
  resolveAsyncGptPollIntervalMs,
  resolveAsyncGptWaitForResultMs,
  waitForQueuedGptJobCompletion,
} from './queuedGptCompletionService.js';

export type BridgeErrorSource = 'routing' | 'queue' | 'worker' | 'provider' | 'timeout' | 'auth';

type BridgeFailureCounters = Record<BridgeErrorSource, number>;

const BRIDGE_FAILURE_COUNTERS: BridgeFailureCounters = {
  routing: 0,
  queue: 0,
  worker: 0,
  provider: 0,
  timeout: 0,
  auth: 0,
};
const BRIDGE_FAILURE_EVENTS: Array<{ source: BridgeErrorSource; timestampMs: number }> = [];
const DEFAULT_BRIDGE_FAILURE_COUNTER_WINDOW_MS = 15 * 60 * 1000;
const BRIDGE_IDEMPOTENCY_FINGERPRINT_VERSION = 2;

const bridgeMetadataSchema = z.record(z.unknown()).default({});
const bridgeGptIdSchema = z.string().trim().min(1).max(128);

const bridgeRequestSchema = z
  .object({
    gptId: bridgeGptIdSchema.optional(),
    prompt: z.string().trim().min(1).max(50000),
    action: z.enum([GPT_QUERY_ACTION, GPT_QUERY_AND_WAIT_ACTION]).default(GPT_QUERY_ACTION),
    metadata: bridgeMetadataSchema,
  })
  .strict();

export interface CustomGptBridgeRequest {
  gptId: string;
  prompt: string;
  action: typeof GPT_QUERY_ACTION | typeof GPT_QUERY_AND_WAIT_ACTION;
  metadata: Record<string, unknown>;
}

export interface ParseBridgeRequestResult {
  ok: boolean;
  statusCode: number;
  request?: CustomGptBridgeRequest;
  body?: Record<string, unknown>;
}

export interface BridgeSecretValidationInput {
  authorization?: string | null;
  actionSecret?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface BridgeSecretValidationResult {
  ok: boolean;
  statusCode: number;
  body?: Record<string, unknown>;
}

export interface ExecuteBridgeRequestInput {
  request: CustomGptBridgeRequest;
  requestId: string;
  actorKey: string;
  explicitIdempotencyKey?: string | null;
}

export interface ExecuteBridgeRequestResult {
  statusCode: number;
  body: Record<string, unknown>;
  errorSource?: BridgeErrorSource;
}

interface BridgeTimingInput {
  startedAtMs: number;
  enqueueStartedAtMs: number;
  enqueueCompletedAtMs: number;
  waitStartedAtMs?: number;
  waitCompletedAtMs?: number;
  job?: JobData | null;
  output?: unknown;
}

function readRequiredSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.OPENAI_ACTION_SHARED_SECRET?.trim();
  return value ? value : null;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secureEquals(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

function extractBearerToken(authorization?: string | null): string | null {
  if (!authorization) {
    return null;
  }
  const [scheme, ...rest] = authorization.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return null;
  }
  const token = rest.join(' ').trim();
  return token ? token : null;
}

function pollUrl(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`;
}

function resultUrl(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/result`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumberCandidate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readMetadataNumber(metadata: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = readNumberCandidate(metadata[key]);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function readEnvNumber(name: string): number | undefined {
  return readNumberCandidate(process.env[name]);
}

function resolveBridgeFailureCounterWindowMs(): number {
  const configuredWindowMs = readEnvNumber('OPENAI_ACTION_BRIDGE_FAILURE_COUNTER_WINDOW_MS');
  if (configuredWindowMs === undefined) {
    return DEFAULT_BRIDGE_FAILURE_COUNTER_WINDOW_MS;
  }
  if (configuredWindowMs <= 0) {
    return DEFAULT_BRIDGE_FAILURE_COUNTER_WINDOW_MS;
  }
  return Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Math.trunc(configuredWindowMs)));
}

function pruneBridgeFailureEvents(now = Date.now()): void {
  const cutoffMs = now - resolveBridgeFailureCounterWindowMs();
  while (BRIDGE_FAILURE_EVENTS.length > 0 && BRIDGE_FAILURE_EVENTS[0].timestampMs < cutoffMs) {
    BRIDGE_FAILURE_EVENTS.shift();
  }
}

function emptyFailureCounters(): BridgeFailureCounters {
  return {
    routing: 0,
    queue: 0,
    worker: 0,
    provider: 0,
    timeout: 0,
    auth: 0,
  };
}

function resolveDefaultGptId(): { ok: true; value: string } | { ok: false; reason: 'missing' | 'invalid'; message: string } {
  if (process.env.DEFAULT_GPT_ID === undefined) {
    return {
      ok: false,
      reason: 'missing',
      message: 'gptId is required when DEFAULT_GPT_ID is not configured.',
    };
  }

  const parsedDefaultGptId = bridgeGptIdSchema.safeParse(process.env.DEFAULT_GPT_ID);
  if (!parsedDefaultGptId.success) {
    return {
      ok: false,
      reason: 'invalid',
      message: `DEFAULT_GPT_ID is invalid: ${parsedDefaultGptId.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    };
  }

  return {
    ok: true,
    value: parsedDefaultGptId.data,
  };
}

function resolveBridgeWaitForResultMs(request: CustomGptBridgeRequest): number {
  const metadataWaitMs = readMetadataNumber(request.metadata, [
    'waitForResultMs',
    'wait_for_result_ms',
    'timeoutMs',
    'timeout_ms',
  ]);
  if (metadataWaitMs !== undefined) {
    return resolveAsyncGptWaitForResultMs(metadataWaitMs);
  }
  const envWaitMs =
    readEnvNumber('OPENAI_ACTION_BRIDGE_WAIT_TIMEOUT_MS') ??
    (request.action === GPT_QUERY_ACTION
      ? readEnvNumber('OPENAI_ACTION_BRIDGE_QUERY_WAIT_TIMEOUT_MS')
      : undefined);
  if (envWaitMs !== undefined) {
    return resolveAsyncGptWaitForResultMs(envWaitMs);
  }
  return request.action === GPT_QUERY_AND_WAIT_ACTION ? resolveAsyncGptWaitForResultMs(undefined) : 0;
}

function resolveBridgePollIntervalMs(request: CustomGptBridgeRequest): number {
  const metadataPollMs = readMetadataNumber(request.metadata, ['pollIntervalMs', 'poll_interval_ms']);
  return resolveAsyncGptPollIntervalMs(metadataPollMs ?? readEnvNumber('OPENAI_ACTION_BRIDGE_POLL_INTERVAL_MS'));
}

function buildInternalGptBody(request: CustomGptBridgeRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: request.prompt,
  };
  if (Object.keys(request.metadata).length > 0) {
    body.metadata = request.metadata;
  }
  if (request.action === GPT_QUERY_ACTION) {
    body.action = GPT_QUERY_ACTION;
  } else {
    body.executionMode = 'async';
  }
  return body;
}

function buildBridgeIdempotencyBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    bridgeFingerprintVersion: BRIDGE_IDEMPOTENCY_FINGERPRINT_VERSION,
  };
}

function normalizeCompletedJobOutput(output: unknown): unknown {
  if (isPlainRecord(output) && output.ok === true && 'result' in output) {
    return output.result;
  }
  return output;
}

function readLatencyCandidate(value: unknown, keys: string[]): number | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const candidate = readNumberCandidate(value[key]);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return null;
}

function extractNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isPlainRecord(cursor)) {
      return null;
    }
    cursor = cursor[key];
  }
  return isPlainRecord(cursor) ? cursor : null;
}

function extractProviderLatencyMs(output: unknown): number | null {
  const direct = readLatencyCandidate(output, ['providerLatencyMs', 'provider_latency_ms', 'latencyMs']);
  if (direct !== null) {
    return direct;
  }
  for (const path of [
    ['metrics'],
    ['diagnostics'],
    ['metadata'],
    ['meta'],
    ['result', 'metrics'],
    ['result', 'diagnostics'],
    ['result', 'metadata'],
    ['result', 'meta'],
  ]) {
    const nested = extractNestedRecord(output, path);
    const candidate = readLatencyCandidate(nested, ['providerLatencyMs', 'provider_latency_ms', 'latencyMs']);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

function extractModelLatencyMs(output: unknown): number | null {
  const direct = readLatencyCandidate(output, ['modelLatencyMs', 'model_latency_ms']);
  if (direct !== null) {
    return direct;
  }
  for (const path of [['metrics'], ['diagnostics'], ['metadata'], ['meta'], ['result', 'metrics']]) {
    const nested = extractNestedRecord(output, path);
    const candidate = readLatencyCandidate(nested, ['modelLatencyMs', 'model_latency_ms']);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

function buildBridgeTiming(input: BridgeTimingInput): Record<string, unknown> {
  const now = Date.now();
  const jobTimings = input.job ? summarizeGptJobTimings(input.job) : null;
  return {
    total_ms: Math.max(0, now - input.startedAtMs),
    enqueue_ms: Math.max(0, input.enqueueCompletedAtMs - input.enqueueStartedAtMs),
    wait_ms:
      input.waitStartedAtMs !== undefined && input.waitCompletedAtMs !== undefined
        ? Math.max(0, input.waitCompletedAtMs - input.waitStartedAtMs)
        : 0,
    queue_wait_ms: jobTimings?.queueWaitMs ?? null,
    worker_execution_ms: jobTimings?.executionMs ?? null,
    provider_latency_ms: input.output === undefined ? null : extractProviderLatencyMs(input.output),
    model_latency_ms: input.output === undefined ? null : extractModelLatencyMs(input.output),
  };
}

function buildObservabilityPayload(input: {
  requestId: string;
  gptId: string;
  action: string;
  waitForResultMs: number;
  pollIntervalMs: number;
  deduped?: boolean;
  idempotencyKey?: string | null;
  idempotencySource?: 'explicit' | 'derived' | null;
}): Record<string, unknown> {
  return {
    request_id: input.requestId,
    gpt_id: input.gptId,
    action: input.action,
    wait_for_result_ms: input.waitForResultMs,
    poll_interval_ms: input.pollIntervalMs,
    deduped: input.deduped ?? false,
    idempotency_key: input.idempotencyKey ?? null,
    idempotency_source: input.idempotencySource ?? null,
  };
}

function buildPendingPayload(input: {
  request: CustomGptBridgeRequest;
  requestId: string;
  job: JobData;
  timing: Record<string, unknown>;
  waitForResultMs: number;
  pollIntervalMs: number;
  deduped: boolean;
  idempotencyKey: string | null;
  idempotencySource: 'explicit' | 'derived' | null;
}): Record<string, unknown> {
  const lifecycleStatus = resolveGptJobLifecycleStatus(input.job.status);
  const pending = buildQueuedGptPendingResponse({
    action: input.request.action,
    jobId: input.job.id,
    gptId: input.request.gptId,
    requestId: input.requestId,
    jobStatus: input.job.status,
    lifecycleStatus,
    deduped: input.deduped,
    idempotencyKey: input.idempotencyKey,
    idempotencySource: input.idempotencySource,
  });
  return {
    ok: true,
    status: 'pending',
    jobId: input.job.id,
    poll_url: pollUrl(input.job.id),
    result_url: resultUrl(input.job.id),
    action: input.request.action,
    job_status: input.job.status,
    lifecycle_status: lifecycleStatus,
    request_id: input.requestId,
    timing: input.timing,
    observability: buildObservabilityPayload({
      requestId: input.requestId,
      gptId: input.request.gptId,
      action: input.request.action,
      waitForResultMs: input.waitForResultMs,
      pollIntervalMs: input.pollIntervalMs,
      deduped: input.deduped,
      idempotencyKey: input.idempotencyKey,
      idempotencySource: input.idempotencySource,
    }),
    poll: pending.poll,
    result: {
      method: 'GET',
      url: resultUrl(input.job.id),
    },
  };
}

function buildCompletedPayload(input: {
  request: CustomGptBridgeRequest;
  requestId: string;
  job: JobData;
  output: unknown;
  timing: Record<string, unknown>;
  waitForResultMs: number;
  pollIntervalMs: number;
  deduped: boolean;
  idempotencyKey: string | null;
  idempotencySource: 'explicit' | 'derived' | null;
}): Record<string, unknown> {
  return {
    ok: true,
    status: 'completed',
    jobId: input.job.id,
    poll_url: pollUrl(input.job.id),
    result_url: resultUrl(input.job.id),
    output: input.output,
    action: input.request.action,
    request_id: input.requestId,
    timing: input.timing,
    observability: buildObservabilityPayload({
      requestId: input.requestId,
      gptId: input.request.gptId,
      action: input.request.action,
      waitForResultMs: input.waitForResultMs,
      pollIntervalMs: input.pollIntervalMs,
      deduped: input.deduped,
      idempotencyKey: input.idempotencyKey,
      idempotencySource: input.idempotencySource,
    }),
  };
}

function buildBridgeErrorPayload(input: {
  source: BridgeErrorSource;
  status: string;
  message: string;
  requestId?: string;
  jobId?: string;
  timing?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ok: false,
    status: input.status,
    error: {
      source: input.source,
      message: input.message,
    },
    request_id: input.requestId ?? null,
    jobId: input.jobId,
    timing: input.timing,
  };
}

export function recordCustomGptBridgeFailure(source: BridgeErrorSource): void {
  BRIDGE_FAILURE_COUNTERS[source] += 1;
  BRIDGE_FAILURE_EVENTS.push({ source, timestampMs: Date.now() });
  pruneBridgeFailureEvents();
}

export function getCustomGptBridgeFailureCounters(): BridgeFailureCounters {
  pruneBridgeFailureEvents();
  const recentCounters = emptyFailureCounters();
  for (const event of BRIDGE_FAILURE_EVENTS) {
    recentCounters[event.source] += 1;
  }
  return recentCounters;
}

export function getCustomGptBridgeFailureCountersSinceStart(): BridgeFailureCounters {
  return { ...BRIDGE_FAILURE_COUNTERS };
}

export function validateCustomGptBridgeSecret(
  input: BridgeSecretValidationInput,
): BridgeSecretValidationResult {
  const expectedSecret = readRequiredSecret(input.env);
  if (!expectedSecret) {
    return {
      ok: false,
      statusCode: 503,
      body: buildBridgeErrorPayload({
        source: 'auth',
        status: 'misconfigured',
        message: 'OPENAI_ACTION_SHARED_SECRET is not configured.',
      }),
    };
  }
  const providedSecret = extractBearerToken(input.authorization) ?? input.actionSecret?.trim() ?? null;
  if (!providedSecret || !secureEquals(providedSecret, expectedSecret)) {
    return {
      ok: false,
      statusCode: 401,
      body: buildBridgeErrorPayload({
        source: 'auth',
        status: 'unauthorized',
        message: 'Missing or invalid bridge shared secret.',
      }),
    };
  }
  return { ok: true, statusCode: 200 };
}

export function parseCustomGptBridgeRequest(rawBody: unknown): ParseBridgeRequestResult {
  const parsed = bridgeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      statusCode: 400,
      body: buildBridgeErrorPayload({
        source: 'routing',
        status: 'invalid_request',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      }),
    };
  }
  const defaultGptId = parsed.data.gptId ? { ok: true as const, value: parsed.data.gptId } : resolveDefaultGptId();
  if (defaultGptId?.ok === false) {
    return {
      ok: false,
      statusCode: defaultGptId.reason === 'invalid' ? 503 : 400,
      body: buildBridgeErrorPayload({
        source: 'routing',
        status: defaultGptId.reason === 'invalid' ? 'misconfigured' : 'invalid_request',
        message: defaultGptId.message,
      }),
    };
  }
  return {
    ok: true,
    statusCode: 200,
    request: {
      gptId: defaultGptId.value,
      prompt: parsed.data.prompt,
      action: parsed.data.action,
      metadata: parsed.data.metadata,
    },
  };
}

export async function executeCustomGptBridgeRequest(
  input: ExecuteBridgeRequestInput,
): Promise<ExecuteBridgeRequestResult> {
  const startedAtMs = Date.now();
  const internalBody = buildInternalGptBody(input.request);
  const effectiveAction = GPT_QUERY_ACTION;
  const explicitIdempotencyKey = normalizeExplicitIdempotencyKey(input.explicitIdempotencyKey);
  const descriptor = buildGptIdempotencyDescriptor({
    gptId: input.request.gptId,
    action: effectiveAction,
    body: buildBridgeIdempotencyBody(internalBody),
    actorKey: input.actorKey,
    explicitIdempotencyKey,
  });
  const waitForResultMs = resolveBridgeWaitForResultMs(input.request);
  const pollIntervalMs = resolveBridgePollIntervalMs(input.request);
  const queuedInput = buildQueuedGptJobInput({
    gptId: input.request.gptId,
    body: internalBody,
    prompt: input.request.prompt,
    requestId: input.requestId,
    routeHint: effectiveAction,
    requestPath: '/api/bridge/gpt',
    executionModeReason: input.request.action === GPT_QUERY_AND_WAIT_ACTION ? 'bridge_query_and_wait' : 'bridge_query',
  });
  const enqueueStartedAtMs = Date.now();
  try {
    const plannedJob = await planAutonomousWorkerJob('gpt', queuedInput);
    const jobResult = await findOrCreateGptJob({
      workerId: process.env.WORKER_ID ?? 'api',
      input: queuedInput,
      requestFingerprintHash: descriptor.fingerprintHash,
      idempotencyScopeHash: descriptor.scopeHash,
      idempotencyKeyHash: explicitIdempotencyKey ? descriptor.idempotencyKeyHash : null,
      idempotencyOrigin: descriptor.source,
      createOptions: plannedJob,
    });
    const enqueueCompletedAtMs = Date.now();
    const basePendingInput = {
      request: input.request,
      requestId: input.requestId,
      waitForResultMs,
      pollIntervalMs,
      deduped: jobResult.deduped,
      idempotencyKey: descriptor.publicIdempotencyKey,
      idempotencySource: descriptor.source,
    };

    if (jobResult.job.status === 'completed') {
      const output = normalizeCompletedJobOutput(jobResult.job.output);
      return {
        statusCode: 200,
        body: buildCompletedPayload({
          ...basePendingInput,
          job: jobResult.job,
          output,
          timing: buildBridgeTiming({
            startedAtMs,
            enqueueStartedAtMs,
            enqueueCompletedAtMs,
            job: jobResult.job,
            output,
          }),
        }),
      };
    }

    if (waitForResultMs <= 0) {
      return {
        statusCode: 202,
        body: buildPendingPayload({
          ...basePendingInput,
          job: jobResult.job,
          timing: buildBridgeTiming({ startedAtMs, enqueueStartedAtMs, enqueueCompletedAtMs, job: jobResult.job }),
        }),
      };
    }

    const waitStartedAtMs = Date.now();
    const completion = await waitForQueuedGptJobCompletion(jobResult.job.id, {
      waitForResultMs,
      pollIntervalMs,
    });
    const waitCompletedAtMs = Date.now();

    if (completion.state === 'completed') {
      const output = normalizeCompletedJobOutput(completion.job.output);
      return {
        statusCode: 200,
        body: buildCompletedPayload({
          ...basePendingInput,
          job: completion.job,
          output,
          timing: buildBridgeTiming({
            startedAtMs,
            enqueueStartedAtMs,
            enqueueCompletedAtMs,
            waitStartedAtMs,
            waitCompletedAtMs,
            job: completion.job,
            output,
          }),
        }),
      };
    }

    if (completion.state === 'pending') {
      return {
        statusCode: 202,
        errorSource: 'timeout',
        body: buildPendingPayload({
          ...basePendingInput,
          job: completion.job ?? jobResult.job,
          timing: buildBridgeTiming({
            startedAtMs,
            enqueueStartedAtMs,
            enqueueCompletedAtMs,
            waitStartedAtMs,
            waitCompletedAtMs,
            job: completion.job ?? jobResult.job,
          }),
        }),
      };
    }

    const errorSource: BridgeErrorSource =
      completion.state === 'missing' ? 'queue' : completion.state === 'expired' ? 'timeout' : 'worker';
    return {
      statusCode: completion.state === 'missing' ? 404 : completion.state === 'expired' ? 410 : 500,
      errorSource,
      body: buildBridgeErrorPayload({
        source: errorSource,
        status: completion.state,
        message: `Queued GPT job ended with state ${completion.state}.`,
        requestId: input.requestId,
        jobId: completion.job?.id ?? jobResult.job.id,
        timing: buildBridgeTiming({
          startedAtMs,
          enqueueStartedAtMs,
          enqueueCompletedAtMs,
          waitStartedAtMs,
          waitCompletedAtMs,
          job: completion.job ?? jobResult.job,
        }),
      }),
    };
  } catch (error) {
    const source: BridgeErrorSource =
      error instanceof IdempotencyKeyConflictError || error instanceof JobRepositoryUnavailableError
        ? 'queue'
        : 'routing';
    const statusCode =
      error instanceof IdempotencyKeyConflictError ? 409 : error instanceof JobRepositoryUnavailableError ? 503 : 500;
    return {
      statusCode,
      errorSource: source,
      body: buildBridgeErrorPayload({
        source,
        status: source === 'queue' ? 'queue_error' : 'routing_error',
        message: resolveErrorMessage(error),
        requestId: input.requestId,
        timing: buildBridgeTiming({
          startedAtMs,
          enqueueStartedAtMs,
          enqueueCompletedAtMs: Date.now(),
        }),
      }),
    };
  }
}

export async function buildCustomGptBridgeHealthPayload(requestId: string): Promise<Record<string, unknown>> {
  const defaultGptIdResult = resolveDefaultGptId();
  const defaultGptId = defaultGptIdResult.ok ? defaultGptIdResult.value : null;
  const bridgeSecretConfigured = Boolean(readRequiredSecret());
  const failureCounterWindowMs = resolveBridgeFailureCounterWindowMs();
  let databaseHealth: Record<string, unknown>;
  try {
    const { getStatus } = await import('@core/db/index.js');
    databaseHealth = getStatus() as unknown as Record<string, unknown>;
  } catch (error) {
    databaseHealth = {
      connected: false,
      error: resolveErrorMessage(error),
    };
  }
  let routeReachability: Record<string, unknown> = {
    bridge_gpt: {
      method: 'POST',
      path: '/api/bridge/gpt',
      reachable: true,
    },
    bridge_health: {
      method: 'GET',
      path: '/api/bridge/health',
      reachable: true,
    },
    jobs_status: {
      method: 'GET',
      path: '/jobs/{id}',
      reachable: true,
    },
    jobs_result: {
      method: 'GET',
      path: '/jobs/{id}/result',
      reachable: true,
    },
  };
  if (defaultGptId) {
    const { resolveGptRouting } = await import('@routes/_core/gptDispatch.js');
    const routing = await resolveGptRouting(defaultGptId, requestId);
    routeReachability = {
      ...routeReachability,
      default_gpt: {
        method: 'POST',
        path: `/gpt/${defaultGptId}`,
        reachable: routing.ok,
        source: routing.ok ? routing.plan.route : 'unregistered',
        message: routing.ok ? undefined : routing.error.message,
      },
    };
  }

  let workerStatus: Record<string, unknown>;
  try {
    const { getWorkerControlHealth } = await import('./workerControlService.js');
    workerStatus = (await getWorkerControlHealth()) as unknown as Record<string, unknown>;
  } catch (error) {
    workerStatus = {
      ok: false,
      status: 'unavailable',
      error: resolveErrorMessage(error),
    };
  }

  const missingRequired = [
    bridgeSecretConfigured ? null : 'OPENAI_ACTION_SHARED_SECRET',
    defaultGptId ? null : 'DEFAULT_GPT_ID',
  ].filter((value): value is string => Boolean(value));

  return {
    ok: missingRequired.length === 0,
    status: missingRequired.length === 0 ? 'ok' : 'degraded',
    request_id: requestId,
    env: {
      OPENAI_ACTION_SHARED_SECRET: { configured: bridgeSecretConfigured },
      DEFAULT_GPT_ID: {
        configured: process.env.DEFAULT_GPT_ID !== undefined,
        valid: defaultGptIdResult.ok,
        value: defaultGptId,
        error: defaultGptIdResult.ok ? null : defaultGptIdResult.message,
      },
      OPENAI_ACTION_BRIDGE_WAIT_TIMEOUT_MS: {
        configured: process.env.OPENAI_ACTION_BRIDGE_WAIT_TIMEOUT_MS !== undefined,
      },
      OPENAI_ACTION_BRIDGE_QUERY_WAIT_TIMEOUT_MS: {
        configured: process.env.OPENAI_ACTION_BRIDGE_QUERY_WAIT_TIMEOUT_MS !== undefined,
      },
      OPENAI_ACTION_BRIDGE_POLL_INTERVAL_MS: {
        configured: process.env.OPENAI_ACTION_BRIDGE_POLL_INTERVAL_MS !== undefined,
      },
      DATABASE_URL: { configured: Boolean(process.env.DATABASE_URL) },
      DATABASE_PRIVATE_URL: { configured: Boolean(process.env.DATABASE_PRIVATE_URL) },
      RAILWAY_ENVIRONMENT: { configured: Boolean(process.env.RAILWAY_ENVIRONMENT) },
    },
    missing_required_env: missingRequired,
    route_reachability: routeReachability,
    database: databaseHealth,
    worker_status: workerStatus,
    recent_failure_counters: {
      window_ms: failureCounterWindowMs,
      window_started_at: new Date(Date.now() - failureCounterWindowMs).toISOString(),
      counts: getCustomGptBridgeFailureCounters(),
    },
    failure_counters_since_start: getCustomGptBridgeFailureCountersSinceStart(),
  };
}
