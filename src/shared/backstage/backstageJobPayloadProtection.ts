import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  hasConfiguredPurposeBoundCredentialCollision,
  resolveConfiguredPurposeBoundCredential,
  type PurposeBoundCredentialEnvironmentReader,
  type PurposeBoundCredentialEnvName,
} from '@shared/security/purposeBoundCredential.js';

export const BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME =
  'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY';
export const BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME =
  'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY';

export const BACKSTAGE_JOB_PAYLOAD_ENVELOPE_VERSION = 1;
export const BACKSTAGE_JOB_PAYLOAD_ALGORITHM = 'A256GCM';
export const BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE =
  'backstage-booker-job-input';
export const BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE =
  'backstage-booker-job-output';

const AES_256_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_AUTH_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IDENTITY_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export type BackstageJobPayloadPurpose =
  | typeof BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE
  | typeof BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE;

export type BackstageJobPayloadProtectionEnvironmentName =
  | typeof BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME
  | typeof BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME
  | PurposeBoundCredentialEnvName;

export type BackstageJobPayloadProtectionEnvironmentReader = (
  environmentName: BackstageJobPayloadProtectionEnvironmentName
) => string | undefined;

export type BackstageJobPayloadIdentity = {
  gptId: string;
  action: string;
  universeId: string;
} & (
  | { envelopeId: string; jobId?: never }
  | { envelopeId?: never; jobId: string }
);

export interface BackstageJobPayloadEnvelope {
  version: typeof BACKSTAGE_JOB_PAYLOAD_ENVELOPE_VERSION;
  algorithm: typeof BACKSTAGE_JOB_PAYLOAD_ALGORITHM;
  purpose: BackstageJobPayloadPurpose;
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export type BackstageJobPayloadProtectionErrorCode =
  | 'BACKSTAGE_JOB_PAYLOAD_CONFIG_MISSING'
  | 'BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID'
  | 'BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION'
  | 'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
  | 'BACKSTAGE_JOB_PAYLOAD_ENVELOPE_INVALID'
  | 'BACKSTAGE_JOB_PAYLOAD_SERIALIZATION_FAILED'
  | 'BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED';

const ERROR_MESSAGES: Readonly<Record<BackstageJobPayloadProtectionErrorCode, string>> =
  Object.freeze({
    BACKSTAGE_JOB_PAYLOAD_CONFIG_MISSING:
      'Backstage job payload protection is unavailable.',
    BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID:
      'Backstage job payload protection configuration is invalid.',
    BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION:
      'Backstage job payload protection credential isolation failed.',
    BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID:
      'Backstage job payload identity is invalid.',
    BACKSTAGE_JOB_PAYLOAD_ENVELOPE_INVALID:
      'Backstage job payload envelope is invalid.',
    BACKSTAGE_JOB_PAYLOAD_SERIALIZATION_FAILED:
      'Backstage job payload serialization failed.',
    BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED:
      'Backstage job payload authentication failed.',
  });

export class BackstageJobPayloadProtectionError extends Error {
  constructor(public readonly code: BackstageJobPayloadProtectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BackstageJobPayloadProtectionError';
  }
}

interface ResolvedKeyMaterial {
  keyId: string;
  key: Buffer;
}

interface ResolvedProtectionMaterial {
  current: ResolvedKeyMaterial;
  previous: ResolvedKeyMaterial | null;
}

export interface BackstageJobPayloadProtectionConfig {
  readonly currentKeyId: string;
  readonly previousKeyId: string | null;
}

interface NormalizedBackstageJobPayloadIdentity {
  identityKind: 'envelopeId' | 'jobId';
  identityValue: string;
  gptId: string;
  action: string;
  universeId: string;
}

const resolvedProtectionMaterial =
  new WeakMap<BackstageJobPayloadProtectionConfig, ResolvedProtectionMaterial>();

function fail(code: BackstageJobPayloadProtectionErrorCode): never {
  throw new BackstageJobPayloadProtectionError(code);
}

function readProcessEnvironment(
  environmentName: BackstageJobPayloadProtectionEnvironmentName
): string | undefined {
  return process.env[environmentName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function decodeCanonicalBase64(
  value: unknown,
  options: { exactBytes?: number; maximumBytes?: number }
): Buffer | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    return null;
  }

  if (
    options.maximumBytes !== undefined
    && value.length > Math.ceil(options.maximumBytes / 3) * 4
  ) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.toString('base64') !== value
    || (options.exactBytes !== undefined && decoded.length !== options.exactBytes)
    || (options.maximumBytes !== undefined && decoded.length > options.maximumBytes)
  ) {
    return null;
  }

  return decoded;
}

function deriveKeyId(key: Buffer): string {
  return createHash('sha256')
    .update('arcanos:backstage-booker:job-payload-key:v1\0', 'utf8')
    .update(key)
    .digest('base64url');
}

function hasPurposeBoundCollision(
  credential: string,
  ownEnvironmentName: string,
  readEnvironmentValue: BackstageJobPayloadProtectionEnvironmentReader
): boolean {
  return hasConfiguredPurposeBoundCredentialCollision({
    credential,
    ownEnvironmentName: ownEnvironmentName as PurposeBoundCredentialEnvName,
    readEnvironmentValue: readEnvironmentValue as PurposeBoundCredentialEnvironmentReader,
  });
}

function resolveKeyMaterial(
  rawValue: string,
  ownEnvironmentName: string,
  readEnvironmentValue: BackstageJobPayloadProtectionEnvironmentReader
): ResolvedKeyMaterial {
  const key = decodeCanonicalBase64(rawValue, { exactBytes: AES_256_KEY_BYTES });
  if (!key) {
    return fail('BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID');
  }

  if (hasPurposeBoundCollision(rawValue, ownEnvironmentName, readEnvironmentValue)) {
    return fail('BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION');
  }

  const purposeBoundCredential = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: ownEnvironmentName as PurposeBoundCredentialEnvName,
    readEnvironmentValue: readEnvironmentValue as PurposeBoundCredentialEnvironmentReader,
  });
  if (purposeBoundCredential !== rawValue) {
    return fail('BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID');
  }

  return {
    keyId: deriveKeyId(key),
    key,
  };
}

/** Resolve exact AES-256 keys while preserving the repository credential-isolation boundary. */
export function resolveBackstageJobPayloadProtectionConfig(
  readEnvironmentValue: BackstageJobPayloadProtectionEnvironmentReader =
    readProcessEnvironment
): BackstageJobPayloadProtectionConfig {
  const currentRawValue = readEnvironmentValue(
    BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME
  );
  if (currentRawValue === undefined) {
    return fail('BACKSTAGE_JOB_PAYLOAD_CONFIG_MISSING');
  }

  const previousRawValue = readEnvironmentValue(
    BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME
  );
  const current = resolveKeyMaterial(
    currentRawValue,
    BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME,
    readEnvironmentValue
  );
  const previous = previousRawValue === undefined
    ? null
    : resolveKeyMaterial(
        previousRawValue,
        BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME,
        readEnvironmentValue
      );

  if (
    previous
    && (
      current.keyId === previous.keyId
      || timingSafeEqual(current.key, previous.key)
    )
  ) {
    return fail('BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION');
  }

  const config = Object.freeze({
    currentKeyId: current.keyId,
    previousKeyId: previous?.keyId ?? null,
  });
  resolvedProtectionMaterial.set(config, { current, previous });
  return config;
}

function resolveProtectionMaterial(
  config: BackstageJobPayloadProtectionConfig | undefined
): ResolvedProtectionMaterial {
  const resolvedConfig = config ?? resolveBackstageJobPayloadProtectionConfig();
  const material = resolvedProtectionMaterial.get(resolvedConfig);
  if (!material) {
    return fail('BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID');
  }
  return material;
}

function readCanonicalIdentityValue(value: unknown, maximumCharacters: number): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maximumCharacters
    || IDENTITY_CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeIdentity(
  purpose: BackstageJobPayloadPurpose,
  rawIdentity: BackstageJobPayloadIdentity
): NormalizedBackstageJobPayloadIdentity {
  if (!isRecord(rawIdentity)) {
    return fail('BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID');
  }

  const expectedIdentityKey = purpose === BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE
    ? 'envelopeId'
    : 'jobId';
  if (!hasExactKeys(rawIdentity, [expectedIdentityKey, 'gptId', 'action', 'universeId'])) {
    return fail('BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID');
  }

  const identityValue = readCanonicalIdentityValue(rawIdentity[expectedIdentityKey], 256);
  const gptId = readCanonicalIdentityValue(rawIdentity.gptId, 128);
  const action = readCanonicalIdentityValue(rawIdentity.action, 128);
  const universeId = readCanonicalIdentityValue(rawIdentity.universeId, 256);
  if (!identityValue || !gptId || !action || !universeId) {
    return fail('BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID');
  }

  return {
    identityKind: expectedIdentityKey,
    identityValue,
    gptId,
    action,
    universeId,
  };
}

function buildAdditionalAuthenticatedData(
  purpose: BackstageJobPayloadPurpose,
  identity: NormalizedBackstageJobPayloadIdentity
): Buffer {
  return Buffer.from(JSON.stringify([
    'arcanos:backstage-booker:job-payload',
    BACKSTAGE_JOB_PAYLOAD_ENVELOPE_VERSION,
    purpose,
    identity.identityKind,
    identity.identityValue,
    identity.gptId,
    identity.action,
    identity.universeId,
  ]), 'utf8');
}

function isPurpose(value: unknown): value is BackstageJobPayloadPurpose {
  return value === BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE
    || value === BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE;
}

function parseEnvelope(rawEnvelope: unknown): {
  envelope: BackstageJobPayloadEnvelope;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
} {
  if (
    !isRecord(rawEnvelope)
    || !hasExactKeys(rawEnvelope, [
      'version',
      'algorithm',
      'purpose',
      'keyId',
      'iv',
      'ciphertext',
      'authTag',
    ])
    || rawEnvelope.version !== BACKSTAGE_JOB_PAYLOAD_ENVELOPE_VERSION
    || rawEnvelope.algorithm !== BACKSTAGE_JOB_PAYLOAD_ALGORITHM
    || !isPurpose(rawEnvelope.purpose)
    || typeof rawEnvelope.keyId !== 'string'
    || !KEY_ID_PATTERN.test(rawEnvelope.keyId)
  ) {
    return fail('BACKSTAGE_JOB_PAYLOAD_ENVELOPE_INVALID');
  }

  const iv = decodeCanonicalBase64(rawEnvelope.iv, { exactBytes: AES_GCM_IV_BYTES });
  const ciphertext = decodeCanonicalBase64(rawEnvelope.ciphertext, {
    maximumBytes: MAX_CIPHERTEXT_BYTES,
  });
  const authTag = decodeCanonicalBase64(rawEnvelope.authTag, {
    exactBytes: AES_GCM_AUTH_TAG_BYTES,
  });
  if (!iv || !ciphertext || !authTag) {
    return fail('BACKSTAGE_JOB_PAYLOAD_ENVELOPE_INVALID');
  }

  return {
    envelope: rawEnvelope as unknown as BackstageJobPayloadEnvelope,
    iv,
    ciphertext,
    authTag,
  };
}

/** Seal one queue payload with the current key and purpose-specific authenticated identity. */
export function sealBackstageJobPayload(input: {
  purpose: BackstageJobPayloadPurpose;
  identity: BackstageJobPayloadIdentity;
  payload: unknown;
  config?: BackstageJobPayloadProtectionConfig;
}): BackstageJobPayloadEnvelope {
  if (!isPurpose(input.purpose)) {
    return fail('BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID');
  }
  const identity = normalizeIdentity(input.purpose, input.identity);
  const material = resolveProtectionMaterial(input.config);

  let serializedPayload: string | undefined;
  try {
    serializedPayload = JSON.stringify(input.payload);
  } catch {
    return fail('BACKSTAGE_JOB_PAYLOAD_SERIALIZATION_FAILED');
  }
  if (serializedPayload === undefined) {
    return fail('BACKSTAGE_JOB_PAYLOAD_SERIALIZATION_FAILED');
  }

  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', material.current.key, iv, {
    authTagLength: AES_GCM_AUTH_TAG_BYTES,
  });
  cipher.setAAD(buildAdditionalAuthenticatedData(input.purpose, identity));
  const ciphertext = Buffer.concat([
    cipher.update(serializedPayload, 'utf8'),
    cipher.final(),
  ]);

  return Object.freeze({
    version: BACKSTAGE_JOB_PAYLOAD_ENVELOPE_VERSION,
    algorithm: BACKSTAGE_JOB_PAYLOAD_ALGORITHM,
    purpose: input.purpose,
    keyId: material.current.keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  });
}

/** Unseal one payload only when its envelope, purpose, key id, and full AAD identity match. */
export function unsealBackstageJobPayload<T = unknown>(input: {
  purpose: BackstageJobPayloadPurpose;
  identity: BackstageJobPayloadIdentity;
  envelope: unknown;
  config?: BackstageJobPayloadProtectionConfig;
}): T {
  if (!isPurpose(input.purpose)) {
    return fail('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  }
  const parsed = parseEnvelope(input.envelope);
  if (parsed.envelope.purpose !== input.purpose) {
    return fail('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  }
  const identity = normalizeIdentity(input.purpose, input.identity);
  const material = resolveProtectionMaterial(input.config);
  const selectedKey = [material.current, material.previous]
    .find((candidate): candidate is ResolvedKeyMaterial => (
      candidate !== null && candidate.keyId === parsed.envelope.keyId
    ));
  if (!selectedKey) {
    return fail('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  }

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', selectedKey.key, parsed.iv, {
      authTagLength: AES_GCM_AUTH_TAG_BYTES,
    });
    decipher.setAAD(buildAdditionalAuthenticatedData(input.purpose, identity));
    decipher.setAuthTag(parsed.authTag);
    plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
  } catch {
    return fail('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  }

  try {
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    return fail('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  }
}
