import { createHmac } from 'node:crypto';

import {
  resolvePublicGptJobCreationSurface,
  type PublicGptJobCreationSurface,
} from '@shared/gpt/gptIdempotency.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import {
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
} from '@shared/security/purposeBoundCredential.js';

export const JOB_READ_CAPABILITY_SECRET_ENV_NAME =
  'ARCANOS_JOB_READ_CAPABILITY_SECRET';
export const JOB_READ_CAPABILITY_PREVIOUS_SECRET_ENV_NAME =
  'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET';
export const JOB_READ_CAPABILITY_HEADER_NAME =
  'x-arcanos-job-read-token';
export const JOB_READ_AUTH_UNAVAILABLE_CODE =
  'JOB_READ_AUTH_UNAVAILABLE';
export const JOB_READ_AUTH_UNAVAILABLE_MESSAGE =
  'Async job reads are temporarily unavailable.';
export const JOB_READ_PROVENANCE_UNAVAILABLE_CODE =
  'JOB_READ_PROVENANCE_UNAVAILABLE';
export const JOB_READ_PROVENANCE_UNAVAILABLE_MESSAGE =
  'Async job continuation is temporarily unavailable.';

const JOB_READ_CAPABILITY_VERSION = 'v1';
const JOB_READ_CAPABILITY_CONTEXT = 'arcanos:job-read:v1:';
const JOB_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const JOB_READ_CAPABILITY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;

export type GenericJobCapabilitySurface =
  | 'ask'
  | PublicGptJobCreationSurface;

export interface GenericJobCapabilityCandidate {
  job_type?: unknown;
  input?: unknown;
}

function readProcessEnvironment(
  environmentName: Parameters<PurposeBoundCredentialEnvironmentReader>[0]
): string | undefined {
  return process.env[environmentName];
}

function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim().toLowerCase();
  if (!JOB_ID_PATTERN.test(normalized)) {
    throw new Error('A canonical job identifier is required.');
  }
  return normalized;
}

/**
 * Resolve the dedicated job-read signing key without allowing credential reuse.
 */
export function resolveConfiguredJobReadCapabilitySecret(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader =
    readProcessEnvironment
): string | null {
  const secret = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: JOB_READ_CAPABILITY_SECRET_ENV_NAME,
    readEnvironmentValue,
  });

  return secret && !/\s/u.test(secret) ? secret : null;
}

export function resolveConfiguredPreviousJobReadCapabilitySecret(
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader =
    readProcessEnvironment
): string | null {
  const secret = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: JOB_READ_CAPABILITY_PREVIOUS_SECRET_ENV_NAME,
    readEnvironmentValue,
  });

  return secret && !/\s/u.test(secret) ? secret : null;
}

/**
 * Issue a deterministic, job-specific bearer capability.
 *
 * Determinism lets an idempotent enqueue response reissue the same capability
 * without persisting bearer material in the jobs table.
 */
export function issueJobReadCapability(
  jobId: string,
  secret: string
): string {
  const signature = createHmac('sha256', secret)
    .update(`${JOB_READ_CAPABILITY_CONTEXT}${normalizeJobId(jobId)}`)
    .digest('base64url');
  return `${JOB_READ_CAPABILITY_VERSION}.${signature}`;
}

export function issueConfiguredJobReadCapability(jobId: string): string | null {
  const secret = resolveConfiguredJobReadCapabilitySecret();
  return secret ? issueJobReadCapability(jobId, secret) : null;
}

/**
 * Resolve whether a persisted job belongs to a generic public continuation
 * surface. GPT jobs fail closed unless their server-owned queue provenance is
 * recognized; protected GPT Access jobs never qualify.
 */
export function resolveGenericJobCapabilitySurface(
  job: GenericJobCapabilityCandidate | null | undefined
): GenericJobCapabilitySurface | null {
  if (job?.job_type === 'ask') {
    return 'ask';
  }

  if (job?.job_type !== 'gpt') {
    return null;
  }

  return resolvePublicGptJobCreationSurface(job.input);
}

export function isGenericJobCapabilityEligible(
  job: GenericJobCapabilityCandidate | null | undefined
): boolean {
  return resolveGenericJobCapabilitySurface(job) !== null;
}

export type JobReadCapabilityVerification =
  | { available: false; authorized: false }
  | { available: true; authorized: boolean };

/**
 * Verify a presented capability for exactly one job identifier.
 *
 * Missing, malformed, cross-job, and incorrect values share the same denied
 * result so route handlers can preserve their existing not-found envelopes.
 */
export function verifyConfiguredJobReadCapability(
  jobId: string,
  presentedCapability: unknown,
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader =
    readProcessEnvironment
): JobReadCapabilityVerification {
  const secrets = [
    resolveConfiguredJobReadCapabilitySecret(readEnvironmentValue),
    resolveConfiguredPreviousJobReadCapabilitySecret(readEnvironmentValue),
  ].filter((secret): secret is string => secret !== null);
  if (secrets.length === 0) {
    return { available: false, authorized: false };
  }

  if (
    typeof presentedCapability !== 'string'
    || !JOB_READ_CAPABILITY_PATTERN.test(presentedCapability)
  ) {
    return { available: true, authorized: false };
  }

  let authorized = false;
  for (const secret of secrets) {
    const expectedCapability = issueJobReadCapability(jobId, secret);
    const matches = timingSafeEqualOpaqueSecret(
      presentedCapability,
      expectedCapability
    );
    authorized = matches || authorized;
  }

  return {
    available: true,
    authorized,
  };
}

export function buildJobReadCapabilityResponseFields(jobId: string): {
  jobReadToken: string;
  jobReadTokenHeader: typeof JOB_READ_CAPABILITY_HEADER_NAME;
} {
  const jobReadToken = issueConfiguredJobReadCapability(jobId);
  if (!jobReadToken) {
    throw new Error(JOB_READ_AUTH_UNAVAILABLE_CODE);
  }

  return {
    jobReadToken,
    jobReadTokenHeader: JOB_READ_CAPABILITY_HEADER_NAME,
  };
}
