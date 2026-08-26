export interface QueuedJobCompletionObservation<Job> {
  state: string;
  job: Job | null;
}

export interface PollQueuedJobCompletionInput<
  Job,
  Observation extends QueuedJobCompletionObservation<Job>,
> {
  jobId: string;
  waitForResultMs: number;
  pollIntervalMs: number;
  maxPolls: number;
  signal?: AbortSignal;
  /**
   * Read failures propagate unchanged. Domain wrappers may catch here when
   * their contract gives an abort reason precedence over a concurrent failure.
   */
  readJob: (jobId: string) => Promise<Job | null>;
  sleepFn: (
    milliseconds: number,
    options?: { unref?: boolean; signal?: AbortSignal }
  ) => Promise<void>;
  nowFn: () => number;
  mapObservation: (job: Job | null) => Observation;
  buildPendingObservation: (job: Job | null) => Observation;
}

function readNonNegativeInteger(
  rawValue: string | undefined,
  fallbackValue: number
): number {
  const parsedValue = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

function normalizeQueuedJobPollIntervalMs(
  value: number | string | undefined,
  fallbackValue: number
): number {
  const normalizedValue = Number(value);
  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return fallbackValue;
  }
  return Math.min(1_000, Math.max(50, Math.trunc(normalizedValue)));
}

export function resolveQueuedJobWaitForResultMs(input: {
  requestedWaitMs: number | undefined;
  configuredWaitMs: string | undefined;
  defaultWaitMs: number;
  maxWaitMs: number;
}): number {
  const defaultWaitMs = readNonNegativeInteger(
    input.configuredWaitMs,
    input.defaultWaitMs
  );
  const rawWaitMs = input.requestedWaitMs ?? defaultWaitMs;

  if (rawWaitMs === 0) {
    return 0;
  }

  const normalizedWaitMs = Number(rawWaitMs);
  if (!Number.isFinite(normalizedWaitMs) || normalizedWaitMs < 0) {
    return Math.min(input.maxWaitMs, defaultWaitMs);
  }

  return Math.min(input.maxWaitMs, Math.trunc(normalizedWaitMs));
}

export function resolveQueuedJobPollIntervalMs(input: {
  requestedPollIntervalMs: number | undefined;
  configuredPollIntervalMs: string | undefined;
  defaultPollIntervalMs: number;
}): number {
  const builtInPollIntervalMs = normalizeQueuedJobPollIntervalMs(
    input.defaultPollIntervalMs,
    50
  );
  const configuredPollIntervalMs = normalizeQueuedJobPollIntervalMs(
    input.configuredPollIntervalMs,
    builtInPollIntervalMs
  );
  return normalizeQueuedJobPollIntervalMs(
    input.requestedPollIntervalMs,
    configuredPollIntervalMs
  );
}

export function resolveQueuedJobWaitPollLimit(
  waitForResultMs: number,
  pollIntervalMs: number,
  maxPolls: number
): number {
  return Math.min(
    maxPolls,
    Math.ceil(waitForResultMs / Math.max(50, pollIntervalMs)) + 1
  );
}

/**
 * Poll one queued job within independent time and iteration bounds.
 *
 * Domain wrappers own status mapping and repository-error policy. This engine
 * owns only clock, sleep, abort, and hard-cap mechanics. The literal
 * `state: 'pending'` observation is the continuation sentinel.
 */
export async function pollQueuedJobCompletion<
  Job,
  Observation extends QueuedJobCompletionObservation<Job>,
>(
  input: PollQueuedJobCompletionInput<Job, Observation>
): Promise<Observation> {
  if (input.waitForResultMs === 0) {
    return input.buildPendingObservation(null);
  }

  input.signal?.throwIfAborted();

  const waitDeadlineMs = input.nowFn() + input.waitForResultMs;
  const pollLimit = resolveQueuedJobWaitPollLimit(
    input.waitForResultMs,
    input.pollIntervalMs,
    input.maxPolls
  );
  let pollCount = 0;
  let lastObservedJob: Job | null = null;

  while (input.nowFn() <= waitDeadlineMs && pollCount < pollLimit) {
    input.signal?.throwIfAborted();
    const job = await input.readJob(input.jobId);
    pollCount += 1;
    lastObservedJob = job;
    input.signal?.throwIfAborted();
    const observation = input.mapObservation(job);

    if (observation.state !== 'pending') {
      return observation;
    }

    const remainingWaitMs = waitDeadlineMs - input.nowFn();
    if (remainingWaitMs <= 0 || pollCount >= pollLimit) {
      return observation;
    }

    await input.sleepFn(
      Math.min(input.pollIntervalMs, remainingWaitMs),
      { signal: input.signal }
    );
    input.signal?.throwIfAborted();
  }

  if (pollCount >= pollLimit) {
    return input.buildPendingObservation(lastObservedJob);
  }

  input.signal?.throwIfAborted();
  const finalObservedJob = await input.readJob(input.jobId);
  input.signal?.throwIfAborted();
  return input.mapObservation(finalObservedJob);
}
