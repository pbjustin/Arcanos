import {
  BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
  sealBackstageJobPayload,
  unsealBackstageJobPayload,
} from './backstageJobPayloadProtection.js';

const PROTECTED_BACKSTAGE_JOB_VERSION = 1;
const PROTECTED_BACKSTAGE_JOB_SOURCE = 'backstage-booker-http';
const PROTECTED_BACKSTAGE_JOB_RESULT_SOURCE = 'backstage-booker-worker';
const materializedProtectedBackstageResults = new WeakSet<object>();
const BACKSTAGE_UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE =
  'Protected Backstage generation cancellation requested.';

interface ProtectedBackstageBinding {
  gptId: 'backstage-booker';
  action: 'generateBooking' | 'generateBookingWithHRC';
  universeId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasProtectedBackstageQueuedGptJobMarker(
  rawInput: unknown
): boolean {
  return isRecord(rawInput)
    && Object.prototype.hasOwnProperty.call(rawInput, 'protectedBackstage');
}

export function markProtectedBackstageQueuedGptJobResultMaterialized<
  T extends object
>(job: T): T {
  materializedProtectedBackstageResults.add(job);
  return job;
}

export function isProtectedBackstageQueuedGptJobResultMaterialized(
  job: unknown
): boolean {
  return isRecord(job) && materializedProtectedBackstageResults.has(job);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function readBinding(rawInput: unknown): ProtectedBackstageBinding | null {
  if (!isRecord(rawInput) || !hasExactKeys(rawInput, [
    'gptId',
    'protectedBackstage',
    ...(['requestId', 'traceId', 'correlationId', 'routeHint', 'requestPath', 'executionModeReason']
      .filter(key => Object.prototype.hasOwnProperty.call(rawInput, key))),
  ])) {
    return null;
  }
  const descriptor = rawInput.protectedBackstage;
  if (
    rawInput.gptId !== 'backstage-booker'
    || !isRecord(descriptor)
    || !hasExactKeys(descriptor, [
      'version',
      'source',
      'envelopeId',
      'action',
      'universeId',
      'sealedPayload',
    ])
    || descriptor.version !== PROTECTED_BACKSTAGE_JOB_VERSION
    || descriptor.source !== PROTECTED_BACKSTAGE_JOB_SOURCE
    || (
      descriptor.action !== 'generateBooking'
      && descriptor.action !== 'generateBookingWithHRC'
    )
    || typeof descriptor.universeId !== 'string'
    || descriptor.universeId.length === 0
    || descriptor.universeId !== descriptor.universeId.trim()
    || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(descriptor.universeId)
  ) {
    return null;
  }
  return {
    gptId: 'backstage-booker',
    action: descriptor.action,
    universeId: descriptor.universeId,
  };
}

export function isProtectedBackstageQueuedGptJobEnvelope(
  rawInput: unknown
): boolean {
  return readBinding(rawInput) !== null;
}

function parseProtectedOutput(rawOutput: unknown): Record<string, unknown> | null {
  if (
    !isRecord(rawOutput)
    || !hasExactKeys(rawOutput, [
      'version',
      'source',
      'gptId',
      'action',
      'universeId',
      'sealedPayload',
    ])
    || rawOutput.version !== PROTECTED_BACKSTAGE_JOB_VERSION
    || rawOutput.source !== PROTECTED_BACKSTAGE_JOB_RESULT_SOURCE
  ) {
    return null;
  }
  return rawOutput;
}

/** Encrypt a private Booker terminal envelope before it reaches job_data.output. */
export function protectBackstageQueuedGptJobOutput(input: {
  jobId: string;
  rawInput: unknown;
  output: unknown;
}): unknown {
  const jobBinding = readBinding(input.rawInput);
  if (!jobBinding) {
    return input.output;
  }
  return {
    version: PROTECTED_BACKSTAGE_JOB_VERSION,
    source: PROTECTED_BACKSTAGE_JOB_RESULT_SOURCE,
    ...jobBinding,
    sealedPayload: sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: { jobId: input.jobId, ...jobBinding },
      payload: input.output,
    }),
  };
}

/** Materialize a protected terminal result after the existing job-read capability gate. */
export function unprotectBackstageQueuedGptJobOutput(input: {
  jobId: string;
  rawInput: unknown;
  output: unknown;
}): unknown {
  const jobBinding = readBinding(input.rawInput);
  if (!jobBinding) {
    if (hasProtectedBackstageQueuedGptJobMarker(input.rawInput)) {
      throw new Error('Protected Backstage job result is unavailable.');
    }
    return input.output;
  }
  if (input.output == null) {
    return input.output;
  }
  const output = parseProtectedOutput(input.output);
  if (
    !output
    || output.gptId !== jobBinding.gptId
    || output.action !== jobBinding.action
    || output.universeId !== jobBinding.universeId
  ) {
    throw new Error('Protected Backstage job result is unavailable.');
  }
  try {
    return unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: { jobId: input.jobId, ...jobBinding },
      envelope: output.sealedPayload,
    });
  } catch {
    throw new Error('Protected Backstage job result is unavailable.');
  }
}
