import type { JobData } from '@core/db/schema.js';
import {
  isProtectedBackstageQueuedGptJobEnvelope,
  markProtectedBackstageQueuedGptJobResultMaterialized,
  resolveProtectedBackstageQueuedGptJobEnvelopeAction,
  unprotectBackstageQueuedGptJobOutput,
} from '@shared/backstage/backstageQueuedJobResultProtection.js';
import {
  projectBackstageBookerManagedJobResultPayload,
  projectBackstageBookerManagedProtectedFailurePayload,
  type BackstageBookerManagedJobResultPayload,
} from '@shared/backstage/backstageBookerAsyncContinuation.js';
import {
  readProtectedBackstageFailureCode,
  readProtectedBackstageCompletionProvenance,
} from '@shared/backstage/backstageProtectedFailure.js';
import type {
  BackstageJobPayloadProtectionConfig,
} from '@shared/backstage/backstageJobPayloadProtection.js';
import {
  buildGptIdempotencyScopeHash,
  resolvePublicGptJobCreationSurface,
} from '@shared/gpt/gptIdempotency.js';
import { isGptJobTerminalStatus } from '@shared/gpt/gptJobLifecycle.js';
import { buildGptJobResultLookupPayload } from '@shared/gpt/gptJobResult.js';

export interface BackstageBookerAsyncResultCoreReadInput {
  jobId: string;
  actorKey: string;
  legacyActorKey?: string | null;
  waitForResultMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}

export interface BackstageBookerQueuedCompletionOptions {
  waitForResultMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface BackstageBookerQueuedCompletionDependencies {
  getJobByIdFn?: (jobId: string) => Promise<JobData | null>;
}

export interface BackstageBookerQueuedCompletionResult {
  state: string;
  job: JobData | null;
}

export interface BackstageBookerAsyncResultCoreDependencies {
  getJobByIdFn: (jobId: string) => Promise<JobData | null>;
  waitForQueuedGptJobCompletionFn: (
    jobId: string,
    options?: BackstageBookerQueuedCompletionOptions,
    dependencies?: BackstageBookerQueuedCompletionDependencies
  ) => Promise<BackstageBookerQueuedCompletionResult>;
  payloadProtectionConfig?: BackstageJobPayloadProtectionConfig;
}

export class BackstageBookerAsyncResultUnavailableError extends Error {
  readonly code = 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE';

  constructor() {
    super('Protected Backstage generation result is unavailable.');
    this.name = 'BackstageBookerAsyncResultUnavailableError';
  }
}

/** Restrict bearer reads to exact, owned protected Booker generation jobs. */
export function isBackstageBookerBearerReadableJob(
  job: JobData | null,
  expectedScopeHashes: ReadonlySet<string>
): job is JobData {
  return job?.job_type === 'gpt'
    && typeof job.idempotency_scope_hash === 'string'
    && expectedScopeHashes.has(job.idempotency_scope_hash)
    && resolvePublicGptJobCreationSurface(job.input) === 'public-gpt'
    && isProtectedBackstageQueuedGptJobEnvelope(job.input);
}

function materializeProtectedBackstageJob(
  job: JobData,
  payloadProtectionConfig?: BackstageJobPayloadProtectionConfig
): JobData {
  let output: unknown;
  try {
    output = unprotectBackstageQueuedGptJobOutput({
      jobId: job.id,
      rawInput: job.input,
      output: job.output,
      config: payloadProtectionConfig,
    });
  } catch {
    throw new BackstageBookerAsyncResultUnavailableError();
  }

  return markProtectedBackstageQueuedGptJobResultMaterialized(
    output === job.output ? job : { ...job, output }
  );
}

/**
 * Project a terminal protected job after its originating authenticated request
 * has already established ownership. This is shared by the managed GET and the
 * short POST acceptance wait so neither path can disclose raw failure text.
 */
export function projectTrustedProtectedBackstageTerminalFailure(
  job: JobData,
  payloadProtectionConfig?: BackstageJobPayloadProtectionConfig
): BackstageBookerManagedJobResultPayload {
  if (
    job.status !== 'failed'
    && job.status !== 'cancelled'
    && job.status !== 'expired'
  ) {
    throw new BackstageBookerAsyncResultUnavailableError();
  }
  const materializedJob = materializeProtectedBackstageJob(
    job,
    payloadProtectionConfig
  );
  const action = resolveProtectedBackstageQueuedGptJobEnvelopeAction(job.input);
  const code = action
    ? readProtectedBackstageFailureCode(materializedJob.output, {
        gptId: 'backstage-booker',
        action,
      })
    : null;
  if (!code) {
    throw new BackstageBookerAsyncResultUnavailableError();
  }
  return projectBackstageBookerManagedProtectedFailurePayload(
    buildGptJobResultLookupPayload(job.id, materializedJob),
    code
  );
}

/**
 * Read one protected Booker job through an injected bounded queue waiter.
 * Unowned, malformed, and unrelated jobs share the non-disclosing not-found
 * projection and never enter the wait loop.
 */
export async function readBackstageBookerAsyncResultCore(
  input: BackstageBookerAsyncResultCoreReadInput,
  dependencies: BackstageBookerAsyncResultCoreDependencies
): Promise<BackstageBookerManagedJobResultPayload> {
  const expectedScopeHashes = new Set(
    [input.actorKey, input.legacyActorKey]
      .filter((actorKey): actorKey is string => Boolean(actorKey))
      .map(actorKey => buildGptIdempotencyScopeHash({
        surface: 'public-gpt',
        actorKey,
      }))
  );

  input.signal?.throwIfAborted();
  const initialJob = await dependencies.getJobByIdFn(input.jobId);
  input.signal?.throwIfAborted();
  if (!isBackstageBookerBearerReadableJob(initialJob, expectedScopeHashes)) {
    return projectBackstageBookerManagedJobResultPayload(
      buildGptJobResultLookupPayload(input.jobId, null)
    );
  }

  let selectedJob: JobData | null = initialJob;
  if (
    input.waitForResultMs > 0
    && !isGptJobTerminalStatus(initialJob.status)
  ) {
    let initialReadAvailable = true;
    const getOwnedJobById = async (jobId: string): Promise<JobData | null> => {
      const candidate = initialReadAvailable
        ? initialJob
        : await dependencies.getJobByIdFn(jobId);
      initialReadAvailable = false;
      return isBackstageBookerBearerReadableJob(candidate, expectedScopeHashes)
        ? candidate
        : null;
    };

    const observation = await dependencies.waitForQueuedGptJobCompletionFn(
      input.jobId,
      {
        waitForResultMs: input.waitForResultMs,
        pollIntervalMs: input.pollIntervalMs,
        signal: input.signal,
      },
      { getJobByIdFn: getOwnedJobById }
    );
    selectedJob = observation.job;
  }

  input.signal?.throwIfAborted();
  if (!isBackstageBookerBearerReadableJob(selectedJob, expectedScopeHashes)) {
    return projectBackstageBookerManagedJobResultPayload(
      buildGptJobResultLookupPayload(input.jobId, null)
    );
  }

  if (
    selectedJob.status === 'failed'
    || selectedJob.status === 'cancelled'
    || selectedJob.status === 'expired'
  ) {
    return projectTrustedProtectedBackstageTerminalFailure(
      selectedJob,
      dependencies.payloadProtectionConfig
    );
  }

  const materializedJob = materializeProtectedBackstageJob(
    selectedJob,
    dependencies.payloadProtectionConfig
  );
  const action = resolveProtectedBackstageQueuedGptJobEnvelopeAction(selectedJob.input);
  if (
    selectedJob.status === 'completed'
    && (!action || !readProtectedBackstageCompletionProvenance(
      materializedJob.output,
      { gptId: 'backstage-booker', action }
    ))
  ) {
    throw new BackstageBookerAsyncResultUnavailableError();
  }

  return projectBackstageBookerManagedJobResultPayload(
    buildGptJobResultLookupPayload(
      input.jobId,
      materializedJob
    )
  );
}
