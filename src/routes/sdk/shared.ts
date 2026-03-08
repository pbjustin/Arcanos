import type { Response } from 'express';

import { logExecution, type JobData } from '@core/db/index.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { dispatchArcanosTask } from '@platform/runtime/workerConfig.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';
import { buildTimestampedPayload } from '@transport/http/responseHelpers.js';

const SDK_ROUTE_METADATA = {
  status: 'active',
  retries: 3,
  timeout: 30,
} as const;

export const SDK_ROUTE_DEFINITIONS = [
  { name: 'worker.queue', handlerFile: 'taskProcessor.js', metadata: SDK_ROUTE_METADATA },
  { name: 'audit.cron', handlerFile: 'auditRunner.js', metadata: SDK_ROUTE_METADATA },
  { name: 'job.cleanup', handlerFile: 'cleanup.js', metadata: SDK_ROUTE_METADATA },
] as const;

export const SDK_SCHEDULED_JOBS = [
  {
    name: 'nightly-audit',
    schedule: '0 2 * * *',
    route: 'audit.cron',
    description: 'Comprehensive system audit',
  },
  {
    name: 'hourly-cleanup',
    schedule: '0 * * * *',
    route: 'job.cleanup',
    description: 'System maintenance and cleanup',
  },
  {
    name: 'async-processing',
    schedule: '*/5 * * * *',
    route: 'worker.queue',
    description: 'Async task processing',
  },
] as const;

export const SDK_ROUTE_NAMES = SDK_ROUTE_DEFINITIONS.map(route => route.name);
export const SDK_TEST_JOB_DATA = {
  type: 'test_job',
  input: 'Diagnostics verification task',
} as const;

export type JobRecord = Omit<JobData, 'created_at' | 'updated_at' | 'completed_at'> & {
  created_at?: string | Date;
  updated_at?: string | Date;
  completed_at?: string | Date;
  output?: unknown;
  status?: string;
};

/**
 * Purpose: send a standard SDK JSON payload with an ISO timestamp.
 * Inputs/outputs: accepts an Express response and payload object, then sends the timestamped JSON response.
 * Edge case behavior: preserves caller-provided timestamps through `buildTimestampedPayload`.
 */
export function sendSdkJson<T extends Record<string, unknown>>(
  res: Response,
  payload: T,
): void {
  res.json(buildTimestampedPayload(payload));
}

/**
 * Purpose: log an SDK failure and return the standardized error response envelope.
 * Inputs/outputs: accepts the response, log message, error object, and optional context; logs the error and sends a JSON failure payload.
 * Edge case behavior: non-Error throwables are normalized through `resolveErrorMessage`.
 */
export async function sendSdkFailure(
  res: Response,
  logMessage: string,
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const errorMessage = resolveErrorMessage(error);
  await logExecution('sdk-interface', 'error', logMessage, {
    error: errorMessage,
    ...context,
  });
  sendInternalErrorPayload(
    res,
    buildTimestampedPayload({
      success: false,
      error: errorMessage,
    }),
  );
}

/**
 * Purpose: build SDK route registration entries from the shared route definitions.
 * Inputs/outputs: accepts a handler prefix and returns the computed route metadata array.
 * Edge case behavior: metadata is shallow-copied to keep callers from mutating the shared constants.
 */
export function buildSdkRoutes(handlerPrefix: string) {
  return SDK_ROUTE_DEFINITIONS.map(route => ({
    name: route.name,
    handler: `${handlerPrefix}${route.handlerFile}`,
    metadata: { ...route.metadata },
  }));
}

/**
 * Purpose: build the SDK route status payload for diagnostics endpoints.
 * Inputs/outputs: accepts a handler prefix and returns active route descriptors.
 * Edge case behavior: routes are always marked active because this endpoint reports configured state rather than runtime module loading.
 */
export function buildSdkRouteStatuses(handlerPrefix: string) {
  return buildSdkRoutes(handlerPrefix).map(route => ({
    ...route,
    active: true,
  }));
}

/**
 * Purpose: build mock registration results for the SDK route-registration endpoint.
 * Inputs/outputs: returns one success record per configured SDK route.
 * Edge case behavior: keeps the existing mock-registration behavior instead of attempting dynamic module imports.
 */
export function buildSdkRouteRegistrationResults() {
  return SDK_ROUTE_DEFINITIONS.map(route => ({
    route: route.name,
    success: true,
    metadata: { ...route.metadata },
    module: `Mock handler for ${route.name}`,
  }));
}

/**
 * Purpose: build scheduler job descriptors without the human-only description field.
 * Inputs/outputs: returns the route scheduler payload used by diagnostics/system-test endpoints.
 * Edge case behavior: descriptions are omitted to preserve the existing response contract on these endpoints.
 */
export function buildSdkSchedulerJobs() {
  return SDK_SCHEDULED_JOBS.map(({ description: _description, ...job }) => ({ ...job }));
}

/**
 * Purpose: build scheduler activation payloads with the original description metadata intact.
 * Inputs/outputs: returns the configured scheduled jobs for the activation endpoint.
 * Edge case behavior: shallow copies preserve immutability of the shared constants.
 */
export function buildSdkSchedulerActivationJobs() {
  return SDK_SCHEDULED_JOBS.map(job => ({ ...job }));
}

/**
 * Purpose: build the summarized scheduler state used by `init-all`.
 * Inputs/outputs: returns an activated flag plus job name/schedule pairs.
 * Edge case behavior: the summary intentionally omits route descriptions to keep the payload concise.
 */
export function buildSdkSchedulerSummary() {
  return {
    activated: true,
    jobs: SDK_SCHEDULED_JOBS.map(({ name, schedule }) => ({ name, schedule })),
  };
}

/**
 * Purpose: normalize SDK dispatch input into the string payload expected by the worker runtime.
 * Inputs/outputs: accepts arbitrary `jobData` and returns the best available string form.
 * Edge case behavior: falls back to JSON serialization when structured input/prompt/text fields are absent.
 */
export function normalizeDispatchInput(jobData: unknown): string {
  if (typeof jobData === 'string') {
    return jobData;
  }

  if (jobData && typeof jobData === 'object') {
    const record = jobData as Record<string, unknown>;
    for (const key of ['input', 'prompt', 'text']) {
      const value = record[key];
      if (typeof value === 'string') {
        return value;
      }
    }
  }

  return JSON.stringify(jobData ?? {});
}

/**
 * Purpose: dispatch one prompt through the in-process ARCANOS worker runtime.
 * Inputs/outputs: accepts the normalized input string and returns the first worker result.
 * Edge case behavior: throws when the worker runtime returns no result so callers can surface a hard failure.
 */
export async function dispatchSingleArcanosTask(input: string) {
  const [workerResult] = await dispatchArcanosTask(input);
  if (!workerResult) {
    throw new Error('ARCANOS worker did not return a result');
  }
  return workerResult;
}

/**
 * Purpose: create a persisted SDK job record, with a mock fallback when the database is unavailable.
 * Inputs/outputs: accepts worker/job metadata and returns the created or synthetic job record.
 * Edge case behavior: database import or write failures fall back to a mock pending record instead of failing the endpoint.
 */
export async function createOrMockJobRecord(
  workerId: string,
  jobType: string,
  jobData: Record<string, unknown>,
): Promise<JobRecord> {
  try {
    const { createJob } = await import('@core/db/index.js');
    return await createJob(workerId, jobType, jobData);
  } catch {
    //audit Assumption: SDK test endpoints should still respond when the DB is unavailable; failure risk: false-negative health or system-test failures; expected invariant: endpoints can emit a synthetic job record; handling strategy: return a mock pending record.
    return {
      id: `test-job-${Date.now()}`,
      worker_id: workerId,
      job_type: jobType,
      status: 'pending',
      input: JSON.stringify(jobData),
      created_at: new Date().toISOString(),
    };
  }
}

/**
 * Purpose: mark a job record complete when persistence is available.
 * Inputs/outputs: accepts the job record and output payload, then returns the updated record or the original fallback record.
 * Edge case behavior: null records stay null, and DB update failures do not block the caller response.
 */
export async function completeJobRecord(
  jobRecord: JobRecord | null | undefined,
  output: unknown,
): Promise<JobRecord | null> {
  if (!jobRecord) {
    return jobRecord ?? null;
  }

  try {
    const { updateJob } = await import('@core/db/index.js');
    return await updateJob(jobRecord.id, 'completed', output);
  } catch {
    //audit Assumption: SDK callers care more about the runtime result than the persistence write; failure risk: stale job status in the DB; expected invariant: the endpoint still returns success; handling strategy: keep the existing record when the update fails.
    return jobRecord;
  }
}

interface SdkJobExecutionResultOptions {
  processedAt?: string;
  fallbackModel?: string;
  fallbackWorkerId?: string;
  includeWorkerId?: boolean;
}

/**
 * Purpose: normalize worker execution results into the SDK job result envelope.
 * Inputs/outputs: accepts the raw worker result and optional fallback overrides, then returns the public SDK payload.
 * Edge case behavior: worker errors still generate a structured result payload so callers receive consistent fields.
 */
export function buildSdkJobExecutionResult(
  workerResult: {
    error?: unknown;
    result?: unknown;
    activeModel?: string;
    workerId?: string;
  },
  options: SdkJobExecutionResultOptions = {},
) {
  const {
    processedAt = new Date().toISOString(),
    fallbackModel = 'ARCANOS',
    fallbackWorkerId = 'arcanos-core',
    includeWorkerId = true,
  } = options;

  const base = {
    success: !workerResult?.error,
    processed: true,
    taskId: `task-${Date.now()}`,
    aiResponse: workerResult?.result || workerResult?.error || 'No response generated',
    processedAt,
    model: workerResult?.activeModel || fallbackModel,
  };

  return includeWorkerId
    ? {
        ...base,
        workerId: workerResult?.workerId || fallbackWorkerId,
      }
    : base;
}
