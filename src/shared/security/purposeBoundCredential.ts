import { timingSafeEqualOpaqueSecret } from './opaqueSecret.js';

export const MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH = 32;
export const MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH = 4_096;

const PLACEHOLDER_CREDENTIAL_PATTERN =
  /^(?:<[^>]+>|(?:change[-_]?me|example|placeholder)(?:[-_].*)?|replace[-_]?with(?:[-_].*)?)$/iu;

/**
 * Canonical ARCANOS application credentials that must not reuse another
 * purpose-bound application credential. Provider, infrastructure, and
 * script-only test credentials remain outside this application-auth registry.
 */
export const PURPOSE_BOUND_CREDENTIAL_ENV_NAMES = Object.freeze([
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN',
  'ARCANOS_CORE_ADVISORY_ACCESS_TOKEN',
  'ARCANOS_AI_RUNTIME_ACCESS_TOKEN',
  'ARCANOS_GPT_ACCESS_TOKEN',
  'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
  'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY',
  'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY',
  'ARCANOS_GAMING_SOURCE_ACCESS_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN',
  'ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN',
  'ARCANOS_AUTOMATION_SECRET',
  'ARCANOS_CLI_BRIDGE_TOKEN',
  'ARCANOS_DAEMON_ACCESS_TOKEN',
  'ARCANOS_DEBUG_CMD_TOKEN',
  'ARCANOS_JOB_READ_CAPABILITY_SECRET',
  'ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET',
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
] as const);

export type PurposeBoundCredentialEnvName =
  (typeof PURPOSE_BOUND_CREDENTIAL_ENV_NAMES)[number];

export type PurposeBoundCredentialEnvironmentReader =
  (environmentName: PurposeBoundCredentialEnvName) => string | undefined;

function readConfiguredPurposeBoundCredential(
  value: string | undefined
): string | null {
  if (
    typeof value !== 'string'
    || value.length < MIN_PURPOSE_BOUND_CREDENTIAL_LENGTH
    || value.length > MAX_PURPOSE_BOUND_CREDENTIAL_LENGTH
    || value !== value.trim()
    || PLACEHOLDER_CREDENTIAL_PATTERN.test(value)
  ) {
    return null;
  }

  return value;
}

/**
 * Detect whether one boundary's effective credential reuses a configured peer.
 *
 * Boundary-specific parsing remains owned by the caller. Collision comparison
 * trims only for the isolation decision so legacy boundaries can preserve their
 * existing request/configuration grammar while still failing closed when two
 * purpose-bound environment values resolve to the same secret.
 */
export function hasConfiguredPurposeBoundCredentialCollision(options: {
  credential: string;
  ownEnvironmentName: PurposeBoundCredentialEnvName;
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader;
}): boolean {
  const credential = options.credential.trim();
  if (credential.length === 0) {
    return false;
  }

  return PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.some((environmentName) => {
    if (environmentName === options.ownEnvironmentName) {
      return false;
    }

    const rawCandidate = options.readEnvironmentValue(environmentName);
    if (typeof rawCandidate !== 'string') {
      return false;
    }

    const candidate = rawCandidate.trim();
    return (
      candidate.length > 0
      && timingSafeEqualOpaqueSecret(credential, candidate)
    );
  });
}

export function resolveConfiguredPurposeBoundCredential(options: {
  ownEnvironmentName: PurposeBoundCredentialEnvName;
  readEnvironmentValue: PurposeBoundCredentialEnvironmentReader;
}): string | null {
  const credential = readConfiguredPurposeBoundCredential(
    options.readEnvironmentValue(options.ownEnvironmentName)
  );
  if (
    !credential
    || hasConfiguredPurposeBoundCredentialCollision({
      credential,
      ownEnvironmentName: options.ownEnvironmentName,
      readEnvironmentValue: options.readEnvironmentValue,
    })
  ) {
    return null;
  }

  return credential;
}
