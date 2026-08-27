export const GPT_CLIENT_AUTHENTICATION_TYPES = [
  'managed-api-key',
  'oauth',
] as const;

export type GptClientAuthenticationType =
  (typeof GPT_CLIENT_AUTHENTICATION_TYPES)[number];

export const GPT_REGISTERED_MODEL_PROFILES = [
  'pro',
  'thinking',
  'instant',
] as const;

export type GptRegisteredModelProfile =
  (typeof GPT_REGISTERED_MODEL_PROFILES)[number];

export const MODEL_IDENTITY_ASSURANCE_VALUES = [
  'openai-attested',
  'credential-bound-profile',
  'self-declared',
  'unknown',
] as const;

export type ModelIdentityAssurance =
  (typeof MODEL_IDENTITY_ASSURANCE_VALUES)[number];

export type GptClientRegistrationStatus = 'active' | 'inactive';

interface GptClientRegistrationDefinitionBase {
  clientId: string;
  gptId: string;
  displayName: string;
  registeredModelProfile: GptRegisteredModelProfile | null;
  status: GptClientRegistrationStatus;
}

export type GptClientRegistrationDefinition =
  | (GptClientRegistrationDefinitionBase & {
      authenticationType: 'managed-api-key';
      oauthClientId?: never;
    })
  | (GptClientRegistrationDefinitionBase & {
      authenticationType: 'oauth';
      oauthClientId: string;
    });

interface RegisteredGptClientBase {
  readonly clientId: string;
  readonly gptId: string;
  readonly displayName: string;
  readonly registeredModelProfile: GptRegisteredModelProfile | null;
  /** Actual caller runtime model. It remains unknown without trusted attestation. */
  readonly runtimeModel: null;
  readonly modelIdentityAssurance:
    | 'credential-bound-profile'
    | 'unknown';
  readonly status: GptClientRegistrationStatus;
}

export type RegisteredGptClient =
  | (RegisteredGptClientBase & {
      readonly authenticationType: 'managed-api-key';
    })
  | (RegisteredGptClientBase & {
      readonly authenticationType: 'oauth';
      readonly oauthClientId: string;
    });

export interface GptClientOAuthUserIdentity {
  readonly subject: string;
  readonly oauthClientId: string;
  readonly scopes: readonly string[];
}

export type TrustedGptClientAuthentication =
  | {
      readonly authenticationType: 'managed-api-key';
    }
  | {
      readonly authenticationType: 'oauth';
      /** Supplied only by a future trusted OAuth verifier, never request JSON. */
      readonly authenticatedUser: GptClientOAuthUserIdentity;
    };

interface AuthenticatedGptClientIdentityBase {
  readonly clientId: string;
  readonly gptId: string;
  readonly registeredModelProfile: GptRegisteredModelProfile | null;
  /** Actual caller runtime model. It remains unknown without trusted attestation. */
  readonly runtimeModel: null;
  readonly modelIdentityAssurance:
    | 'credential-bound-profile'
    | 'unknown';
}

export type AuthenticatedGptClientIdentity =
  | (AuthenticatedGptClientIdentityBase & {
      readonly authenticationType: 'managed-api-key';
      readonly authenticatedUser?: never;
    })
  | (AuthenticatedGptClientIdentityBase & {
      readonly authenticationType: 'oauth';
      readonly authenticatedUser: GptClientOAuthUserIdentity;
    });

export interface GptClientIdentityTelemetry {
  readonly clientId: string;
  readonly gptId: string;
  readonly authenticationType: GptClientAuthenticationType;
  readonly registeredModelProfile: GptRegisteredModelProfile | null;
  readonly modelIdentityAssurance:
    | 'credential-bound-profile'
    | 'unknown';
}

interface GptClientJobProvenanceBase {
  readonly version: 1;
  readonly source: 'gpt-client-registry';
  readonly clientId: string;
  readonly gptId: string;
  readonly registeredModelProfile: GptRegisteredModelProfile | null;
  readonly runtimeModel: null;
  readonly modelIdentityAssurance:
    | 'credential-bound-profile'
    | 'unknown';
}

export type GptClientJobProvenance =
  | (GptClientJobProvenanceBase & {
      readonly authenticationType: 'managed-api-key';
      readonly authenticatedUser?: never;
    })
  | (GptClientJobProvenanceBase & {
      readonly authenticationType: 'oauth';
      readonly authenticatedUser: GptClientOAuthUserIdentity;
    });

export type GptClientJobProvenanceResolution =
  | {
      readonly state: 'absent';
      readonly provenance: null;
    }
  | {
      readonly state: 'valid';
      readonly provenance: GptClientJobProvenance;
    }
  | {
      readonly state: 'invalid';
      readonly provenance: null;
    };

export interface GptClientRegistry {
  resolveRegisteredClient(clientId: string): RegisteredGptClient | null;
  resolveAuthenticatedClient(input: {
    clientId: string;
    authentication: TrustedGptClientAuthentication;
  }): AuthenticatedGptClientIdentity | null;
}

const GPT_CLIENT_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OAUTH_SCOPE_PATTERN = /^[A-Za-z0-9:._/-]+$/u;
const MAX_GPT_CLIENT_IDENTIFIER_LENGTH = 64;
const MAX_GPT_CLIENT_DISPLAY_NAME_LENGTH = 128;
const MAX_OAUTH_SUBJECT_LENGTH = 256;
const MAX_OAUTH_CLIENT_ID_LENGTH = 256;
const MAX_OAUTH_SCOPE_LENGTH = 128;
const MAX_OAUTH_SCOPE_COUNT = 32;

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value;
}

function isGptClientIdentifier(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_GPT_CLIENT_IDENTIFIER_LENGTH)
    && GPT_CLIENT_IDENTIFIER_PATTERN.test(value);
}

function isRegisteredModelProfile(
  value: unknown
): value is GptRegisteredModelProfile | null {
  return value === null
    || GPT_REGISTERED_MODEL_PROFILES.includes(
      value as GptRegisteredModelProfile
    );
}

function normalizeRegistration(
  input: GptClientRegistrationDefinition
): RegisteredGptClient {
  if (!isGptClientIdentifier(input.clientId)) {
    throw new Error('GPT client registration has an invalid clientId.');
  }
  if (!isGptClientIdentifier(input.gptId)) {
    throw new Error('GPT client registration has an invalid gptId.');
  }
  if (
    !isBoundedNonEmptyString(
      input.displayName,
      MAX_GPT_CLIENT_DISPLAY_NAME_LENGTH
    )
  ) {
    throw new Error('GPT client registration has an invalid displayName.');
  }
  if (!isRegisteredModelProfile(input.registeredModelProfile)) {
    throw new Error('GPT client registration has an unknown model profile.');
  }
  if (input.status !== 'active' && input.status !== 'inactive') {
    throw new Error('GPT client registration has an invalid status.');
  }

  const identityFields = {
    clientId: input.clientId,
    gptId: input.gptId,
    displayName: input.displayName,
    registeredModelProfile: input.registeredModelProfile,
    runtimeModel: null,
    modelIdentityAssurance: input.registeredModelProfile === null
      ? 'unknown' as const
      : 'credential-bound-profile' as const,
    status: input.status,
  };

  if (input.authenticationType === 'managed-api-key') {
    return Object.freeze({
      ...identityFields,
      authenticationType: input.authenticationType,
    });
  }
  if (
    input.authenticationType === 'oauth'
    && isBoundedNonEmptyString(input.oauthClientId, MAX_OAUTH_CLIENT_ID_LENGTH)
  ) {
    return Object.freeze({
      ...identityFields,
      authenticationType: input.authenticationType,
      oauthClientId: input.oauthClientId,
    });
  }

  throw new Error('GPT client registration has invalid authentication configuration.');
}

function normalizeOAuthUserIdentity(
  input: unknown
): GptClientOAuthUserIdentity | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<GptClientOAuthUserIdentity>;
  if (
    !isBoundedNonEmptyString(candidate.subject, MAX_OAUTH_SUBJECT_LENGTH)
    || !isBoundedNonEmptyString(
      candidate.oauthClientId,
      MAX_OAUTH_CLIENT_ID_LENGTH
    )
    || !Array.isArray(candidate.scopes)
    || candidate.scopes.length > MAX_OAUTH_SCOPE_COUNT
  ) {
    return null;
  }

  const scopes = candidate.scopes;
  if (
    scopes.some(scope => (
      !isBoundedNonEmptyString(scope, MAX_OAUTH_SCOPE_LENGTH)
      || !OAUTH_SCOPE_PATTERN.test(scope)
    ))
    || new Set(scopes).size !== scopes.length
  ) {
    return null;
  }

  return Object.freeze({
    subject: candidate.subject,
    oauthClientId: candidate.oauthClientId,
    scopes: Object.freeze([...scopes]),
  });
}

function projectIdentityFields(registration: RegisteredGptClient) {
  return {
    clientId: registration.clientId,
    gptId: registration.gptId,
    registeredModelProfile: registration.registeredModelProfile,
    runtimeModel: registration.runtimeModel,
    modelIdentityAssurance: registration.modelIdentityAssurance,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  input: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(input);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every(key => expectedKeys.includes(key));
}

/** Build a closed, server-owned registry. Registration definitions never come from a request. */
export function createGptClientRegistry(
  definitions: readonly GptClientRegistrationDefinition[]
): GptClientRegistry {
  const registrations = new Map<string, RegisteredGptClient>();

  for (const definition of definitions) {
    const registration = normalizeRegistration(definition);
    if (registrations.has(registration.clientId)) {
      throw new Error(`Duplicate GPT client registration: ${registration.clientId}`);
    }
    registrations.set(registration.clientId, registration);
  }

  return Object.freeze({
    resolveRegisteredClient(clientId: string): RegisteredGptClient | null {
      return registrations.get(clientId) ?? null;
    },
    resolveAuthenticatedClient(input: {
      clientId: string;
      authentication: TrustedGptClientAuthentication;
    }): AuthenticatedGptClientIdentity | null {
      const registration = registrations.get(input.clientId);
      if (!registration || registration.status !== 'active') {
        return null;
      }

      if (
        registration.authenticationType === 'managed-api-key'
        && input.authentication.authenticationType === 'managed-api-key'
      ) {
        return Object.freeze({
          ...projectIdentityFields(registration),
          authenticationType: 'managed-api-key',
        });
      }

      if (
        registration.authenticationType === 'oauth'
        && input.authentication.authenticationType === 'oauth'
      ) {
        const authenticatedUser = normalizeOAuthUserIdentity(
          input.authentication.authenticatedUser
        );
        if (
          !authenticatedUser
          || authenticatedUser.oauthClientId !== registration.oauthClientId
        ) {
          return null;
        }

        return Object.freeze({
          ...projectIdentityFields(registration),
          authenticationType: 'oauth',
          authenticatedUser,
        });
      }

      return null;
    },
  });
}

const BACKSTAGE_BOOKER_REGISTRATION = Object.freeze({
  clientId: 'backstage-booker',
  gptId: 'backstage-booker',
  displayName: 'Backstage Booker',
  authenticationType: 'managed-api-key',
  registeredModelProfile: null,
  status: 'active',
} as const satisfies GptClientRegistrationDefinition);

export const gptClientRegistry = createGptClientRegistry([
  BACKSTAGE_BOOKER_REGISTRATION,
]);

/** Allowlist client identity fields that are safe for structured telemetry. */
export function buildGptClientIdentityTelemetry(
  identity: AuthenticatedGptClientIdentity
): GptClientIdentityTelemetry {
  return Object.freeze({
    clientId: identity.clientId,
    gptId: identity.gptId,
    authenticationType: identity.authenticationType,
    registeredModelProfile: identity.registeredModelProfile,
    modelIdentityAssurance: identity.modelIdentityAssurance,
  });
}

/** Snapshot authenticated client provenance outside encrypted creative input. */
export function buildGptClientJobProvenance(
  identity: AuthenticatedGptClientIdentity
): GptClientJobProvenance {
  const base = {
    version: 1 as const,
    source: 'gpt-client-registry' as const,
    clientId: identity.clientId,
    gptId: identity.gptId,
    registeredModelProfile: identity.registeredModelProfile,
    runtimeModel: null,
    modelIdentityAssurance: identity.modelIdentityAssurance,
  };

  if (identity.authenticationType === 'managed-api-key') {
    return Object.freeze({
      ...base,
      authenticationType: identity.authenticationType,
    });
  }

  return Object.freeze({
    ...base,
    authenticationType: identity.authenticationType,
    authenticatedUser: Object.freeze({
      subject: identity.authenticatedUser.subject,
      oauthClientId: identity.authenticatedUser.oauthClientId,
      scopes: Object.freeze([...identity.authenticatedUser.scopes]),
    }),
  });
}

const GPT_CLIENT_JOB_PROVENANCE_BASE_KEYS = [
  'version',
  'source',
  'clientId',
  'gptId',
  'authenticationType',
  'registeredModelProfile',
  'runtimeModel',
  'modelIdentityAssurance',
] as const;

/** Parse durable provenance while distinguishing legacy absence from tampering. */
export function resolveGptClientJobProvenance(
  autonomyState: unknown
): GptClientJobProvenanceResolution {
  if (
    !isRecord(autonomyState)
    || !Object.prototype.hasOwnProperty.call(
      autonomyState,
      'gptClientProvenance'
    )
  ) {
    return Object.freeze({ state: 'absent', provenance: null });
  }

  const candidate = autonomyState.gptClientProvenance;
  if (!isRecord(candidate)) {
    return Object.freeze({ state: 'invalid', provenance: null });
  }

  const authenticationType = candidate.authenticationType;
  const expectedKeys = authenticationType === 'oauth'
    ? [...GPT_CLIENT_JOB_PROVENANCE_BASE_KEYS, 'authenticatedUser']
    : GPT_CLIENT_JOB_PROVENANCE_BASE_KEYS;
  if (
    !hasOnlyKeys(candidate, expectedKeys)
    || candidate.version !== 1
    || candidate.source !== 'gpt-client-registry'
    || !isGptClientIdentifier(candidate.clientId)
    || !isGptClientIdentifier(candidate.gptId)
    || !isRegisteredModelProfile(candidate.registeredModelProfile)
    || candidate.runtimeModel !== null
  ) {
    return Object.freeze({ state: 'invalid', provenance: null });
  }

  const expectedAssurance: GptClientJobProvenanceBase[
    'modelIdentityAssurance'
  ] = candidate.registeredModelProfile === null
    ? 'unknown'
    : 'credential-bound-profile';
  if (candidate.modelIdentityAssurance !== expectedAssurance) {
    return Object.freeze({ state: 'invalid', provenance: null });
  }

  const base = {
    version: 1 as const,
    source: 'gpt-client-registry' as const,
    clientId: candidate.clientId,
    gptId: candidate.gptId,
    registeredModelProfile: candidate.registeredModelProfile,
    runtimeModel: null,
    modelIdentityAssurance: expectedAssurance,
  };

  if (authenticationType === 'managed-api-key') {
    return Object.freeze({
      state: 'valid',
      provenance: Object.freeze({
        ...base,
        authenticationType,
      }),
    });
  }

  if (authenticationType === 'oauth') {
    const authenticatedUser = normalizeOAuthUserIdentity(
      candidate.authenticatedUser
    );
    if (!authenticatedUser) {
      return Object.freeze({ state: 'invalid', provenance: null });
    }
    return Object.freeze({
      state: 'valid',
      provenance: Object.freeze({
        ...base,
        authenticationType,
        authenticatedUser,
      }),
    });
  }

  return Object.freeze({ state: 'invalid', provenance: null });
}
