import { describe, expect, it } from '@jest/globals';

import {
  JOB_READ_CAPABILITY_HEADER_NAME,
  issueJobReadCapability,
  resolveConfiguredJobReadCapabilitySecret,
  resolveConfiguredPreviousJobReadCapabilitySecret,
  verifyConfiguredJobReadCapability,
} from '../src/shared/jobs/jobReadCapability.js';
import type {
  PurposeBoundCredentialEnvName,
} from '../src/shared/security/purposeBoundCredential.js';

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_JOB_ID = '223e4567-e89b-42d3-a456-426614174000';
const SECRET = 'job-read-capability-test-secret-1234567890';
const PREVIOUS_SECRET =
  'previous-job-read-capability-test-secret-1234567890';

describe('job read capability', () => {
  it('issues deterministic job-bound HMAC tokens without embedding the job id or secret', () => {
    const first = issueJobReadCapability(JOB_ID, SECRET);
    const second = issueJobReadCapability(JOB_ID.toUpperCase(), SECRET);
    const otherJob = issueJobReadCapability(OTHER_JOB_ID, SECRET);

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(first).toBe(second);
    expect(otherJob).not.toBe(first);
    expect(first).not.toContain(JOB_ID);
    expect(first).not.toContain(SECRET);
    expect(JOB_READ_CAPABILITY_HEADER_NAME).toBe('x-arcanos-job-read-token');
  });

  it('fails configuration closed for invalid values and purpose-bound collisions', () => {
    const readEnvironment = (
      values: Partial<Record<PurposeBoundCredentialEnvName, string>>
    ) => (environmentName: PurposeBoundCredentialEnvName) =>
      values[environmentName];

    expect(resolveConfiguredJobReadCapabilitySecret(
      readEnvironment({
        ARCANOS_JOB_READ_CAPABILITY_SECRET: 'too-short',
      })
    )).toBeNull();
    expect(resolveConfiguredJobReadCapabilitySecret(
      readEnvironment({
        ARCANOS_JOB_READ_CAPABILITY_SECRET: `${SECRET} with-whitespace`,
      })
    )).toBeNull();
    expect(resolveConfiguredJobReadCapabilitySecret(
      readEnvironment({
        ARCANOS_JOB_READ_CAPABILITY_SECRET: SECRET,
        ARCANOS_GPT_ACCESS_TOKEN: SECRET,
      })
    )).toBeNull();
    expect(resolveConfiguredJobReadCapabilitySecret(
      readEnvironment({
        ARCANOS_JOB_READ_CAPABILITY_SECRET: SECRET,
        ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET: SECRET,
      })
    )).toBeNull();
    expect(resolveConfiguredJobReadCapabilitySecret(
      readEnvironment({
        ARCANOS_JOB_READ_CAPABILITY_SECRET: SECRET,
      })
    )).toBe(SECRET);
  });

  it('accepts one previous signing key for retained jobs while issuing only from the current key', () => {
    const readEnvironment = (
      values: Partial<Record<PurposeBoundCredentialEnvName, string>>
    ) => (environmentName: PurposeBoundCredentialEnvName) =>
      values[environmentName];
    const environment = readEnvironment({
      ARCANOS_JOB_READ_CAPABILITY_SECRET: SECRET,
      ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET: PREVIOUS_SECRET,
    });
    const currentToken = issueJobReadCapability(JOB_ID, SECRET);
    const previousToken = issueJobReadCapability(JOB_ID, PREVIOUS_SECRET);

    expect(resolveConfiguredJobReadCapabilitySecret(environment)).toBe(SECRET);
    expect(resolveConfiguredPreviousJobReadCapabilitySecret(environment))
      .toBe(PREVIOUS_SECRET);
    expect(
      verifyConfiguredJobReadCapability(JOB_ID, currentToken, environment)
    ).toEqual({ available: true, authorized: true });
    expect(
      verifyConfiguredJobReadCapability(JOB_ID, previousToken, environment)
    ).toEqual({ available: true, authorized: true });
    expect(
      verifyConfiguredJobReadCapability(OTHER_JOB_ID, previousToken, environment)
    ).toEqual({ available: true, authorized: false });
  });

  it('keeps reads available from the previous key during a current-key cutover gap', () => {
    const environment = (environmentName: PurposeBoundCredentialEnvName) =>
      environmentName === 'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET'
        ? PREVIOUS_SECRET
        : undefined;
    const previousToken = issueJobReadCapability(JOB_ID, PREVIOUS_SECRET);

    expect(
      verifyConfiguredJobReadCapability(JOB_ID, previousToken, environment)
    ).toEqual({ available: true, authorized: true });
  });

  it('rejects malformed job identifiers before issuing a token', () => {
    expect(() => issueJobReadCapability('../not-a-job-id', SECRET))
      .toThrow('A canonical job identifier is required.');
  });
});
