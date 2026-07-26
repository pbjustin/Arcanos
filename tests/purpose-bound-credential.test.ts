import { describe, expect, it } from '@jest/globals';

import {
  MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH,
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
  type PurposeBoundCredentialEnvName,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  AI_RUNTIME_ACCESS_TOKEN_ENV_NAME,
  AI_RUNTIME_PURPOSE_BOUND_PEER_ENV_NAMES,
} from '../arcanos-ai-runtime/src/auth/runtimeHttpAuth.js';

const ownEnvironmentName = 'ARCANOS_WORKER_HELPER_TOKEN';
const expectedPurposeBoundCredentialEnvironmentNames = [
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN',
  'ARCANOS_CORE_ADVISORY_ACCESS_TOKEN',
  'ARCANOS_AI_RUNTIME_ACCESS_TOKEN',
  'ARCANOS_GPT_ACCESS_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN',
  'ARCANOS_AUTOMATION_SECRET',
  'ARCANOS_CLI_BRIDGE_TOKEN',
  'ARCANOS_DAEMON_ACCESS_TOKEN',
  'ARCANOS_DEBUG_CMD_TOKEN',
  'ARCANOS_MEMORY_ACCESS_TOKEN',
  'ARCANOS_WORKER_HELPER_TOKEN',
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_OPERATOR_TOKEN',
  'ACTION_PLAN_EXECUTOR_TOKEN',
  'GPT_DAG_BRIDGE_BEARER_TOKEN',
  'METRICS_AUTH_TOKEN',
  'MCP_BEARER_TOKEN',
  'OPENAI_ACTION_SHARED_SECRET',
  'ROOT_OVERRIDE_TOKEN',
  'ARCANOS_ADMIN_TOKEN',
  'DEBUG_WATCHDOG_KEY',
  'DEBUG_SERVER_TOKEN',
] as const;

function environmentReader(
  values: Partial<Record<PurposeBoundCredentialEnvName, string>>
): PurposeBoundCredentialEnvironmentReader {
  return (environmentName) => values[environmentName];
}

function resolve(
  values: Partial<Record<PurposeBoundCredentialEnvName, string>>
): string | null {
  return resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName,
    readEnvironmentValue: environmentReader(values),
  });
}

describe('purpose-bound credential configuration', () => {
  it('freezes the canonical credential registry at runtime', () => {
    expect(Object.isFrozen(PURPOSE_BOUND_CREDENTIAL_ENV_NAMES)).toBe(true);
  });

  it('matches the independently approved application credential registry', () => {
    expect(PURPOSE_BOUND_CREDENTIAL_ENV_NAMES).toEqual(
      expectedPurposeBoundCredentialEnvironmentNames
    );
  });

  it('keeps the standalone AI runtime peer registry synchronized', () => {
    expect(AI_RUNTIME_ACCESS_TOKEN_ENV_NAME)
      .toBe('ARCANOS_AI_RUNTIME_ACCESS_TOKEN');
    expect([...AI_RUNTIME_PURPOSE_BOUND_PEER_ENV_NAMES]).toEqual(
      PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.filter(
        (environmentName) => environmentName !== AI_RUNTIME_ACCESS_TOKEN_ENV_NAME
      )
    );
  });

  it.each([
    'x'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH),
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH),
  ])('accepts an exact credential at a supported length boundary', (credential) => {
    expect(resolve({ [ownEnvironmentName]: credential })).toBe(credential);
  });

  it.each([
    undefined,
    '',
    'x'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH - 1),
    'x'.repeat(MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH + 1),
    ` ${'x'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH)}`,
    `${'x'.repeat(MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH)} `,
    'change-me',
    'change_me',
    'change-me-worker-helper-token-123456',
    'example',
    'example-worker-helper-token-123456',
    'placeholder',
    'placeholder_worker_helper_token_123456',
    '<purpose-bound-token>',
    'replace-with-a-distinct-token',
    'replace_with_a_distinct_token',
  ])('rejects invalid configuration: %p', (credential) => {
    expect(resolve({
      ...(credential === undefined
        ? {}
        : { [ownEnvironmentName]: credential }),
    })).toBeNull();
  });

  it('does not compare the credential variable with itself', () => {
    const credential = 'self-exclusion-purpose-token-123456';
    expect(resolve({ [ownEnvironmentName]: credential })).toBe(credential);
  });

  it.each(
    PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.filter(
      (environmentName) => environmentName !== ownEnvironmentName
    )
  )('rejects reuse by the %s credential variable', (environmentName) => {
    const credential = 'peer-collision-purpose-token-123456';
    expect(resolve({
      [ownEnvironmentName]: credential,
      [environmentName]: credential,
    })).toBeNull();
  });

  it('normalizes only peer values when detecting a collision', () => {
    const credential = 'trimmed-peer-collision-token-123456';
    expect(resolve({
      [ownEnvironmentName]: credential,
      ARCANOS_AUTOMATION_SECRET: `${' '.repeat(512)}${credential}${' '.repeat(512)}`,
    })).toBeNull();
  });
});
