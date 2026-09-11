import {
  GPT_ACCESS_DEVICE_AUDIENCE,
  GPT_ACCESS_DEVICE_RENEWAL_TTL_MS,
  GPT_ACCESS_DEVICE_TTL_MS,
  GptAccessDeviceAuthError,
  GptAccessDeviceGrantSchema,
  type GptAccessDeviceErrorCode,
  type GptAccessDeviceGrant,
  type GptAccessDeviceRecord,
} from '../security/gptAccessDevice.js';
import {
  matchesGptAccessDeviceJobOwner,
  validateGptAccessDeviceRecord,
} from '../security/gptAccessDevicePolicyCore.js';
import { hashLocalAgentIdempotencyKey } from '@services/actionPlanExecution/canonical.js';

const ORIGIN = 'https://device-preview.example.invalid';
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const DEVICE_A = '14960000-0000-4000-8000-000000000001';
const DEVICE_B = '14960000-0000-4000-8000-000000000002';
const KEY = 'sealed-device-idempotency-v1';
const LEGACY_OPERATOR_HASH = '2a2a0c1fe134f85a74b5835ccffeafa1858ae423f09a9fcfc187f2b3e3cbbb7d';

function requireProof(condition: boolean): void {
  if (!condition) throw new Error('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
}

function requireDenied(operation: () => void, code: GptAccessDeviceErrorCode, statusCode = 401): void {
  try { operation(); }
  catch (error) {
    requireProof(error instanceof GptAccessDeviceAuthError && error.code === code && error.statusCode === statusCode);
    return;
  }
  requireProof(false);
}

/** Fixed server-owned values exercise production policy without creating credentials or executing work. */
export function runIosDevicePolicyPreview() {
  try {
    const grant: GptAccessDeviceGrant = {
      principalId: 'operator:sealed-device', workspaceId: 'sealed-device', origin: ORIGIN,
      scopes: ['jobs.create', 'jobs.result', 'capabilities.read', 'capabilities.run'],
      capabilityActions: ['git.status', 'tests.run', 'patch.preview', 'patch.apply'],
    };
    requireProof(GptAccessDeviceGrantSchema.safeParse(grant).success);
    for (const origin of ['http://device-preview.example.invalid', `${ORIGIN}/`, `${ORIGIN}/path`,
      `${ORIGIN}?query=value`, 'https://user@device-preview.example.invalid']) {
      requireProof(!GptAccessDeviceGrantSchema.safeParse({ ...grant, origin }).success);
    }
    for (const invalid of [
      { ...grant, scopes: [] }, { ...grant, scopes: ['jobs.create', 'jobs.create'] },
      { ...grant, scopes: ['operator.admin'] }, { ...grant, capabilityActions: ['shell.execute'] },
      { ...grant, capabilityActions: ['git.status', 'git.status'] }, { ...grant, extraAuthority: true },
    ]) requireProof(!GptAccessDeviceGrantSchema.safeParse(invalid).success);

    const record: GptAccessDeviceRecord = {
      ...grant, deviceId: DEVICE_A, localIdentityHash: 'a'.repeat(64), credentialHash: 'b'.repeat(64),
      audience: GPT_ACCESS_DEVICE_AUDIENCE, pairedAt: new Date(NOW).toISOString(), issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + GPT_ACCESS_DEVICE_TTL_MS).toISOString(),
      renewalExpiresAt: new Date(NOW + GPT_ACCESS_DEVICE_RENEWAL_TTL_MS).toISOString(),
      revokedAt: null, gptIds: ['arcanos-core'],
    };
    validateGptAccessDeviceRecord(record, ORIGIN, NOW);
    requireDenied(() => validateGptAccessDeviceRecord(record, ORIGIN, NOW + GPT_ACCESS_DEVICE_TTL_MS), 'DEVICE_CREDENTIAL_EXPIRED');
    requireDenied(() => validateGptAccessDeviceRecord(record, ORIGIN, NOW + GPT_ACCESS_DEVICE_RENEWAL_TTL_MS), 'DEVICE_RENEWAL_REQUIRED');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, issuedAt: 'invalid' }, ORIGIN, NOW), 'DEVICE_AUTH_INVALID');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, issuedAt: new Date(NOW + 1).toISOString() }, ORIGIN, NOW), 'DEVICE_AUTH_INVALID');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, expiresAt: new Date(NOW + GPT_ACCESS_DEVICE_TTL_MS + 1).toISOString() }, ORIGIN, NOW), 'DEVICE_AUTH_INVALID');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, renewalExpiresAt: new Date(NOW + GPT_ACCESS_DEVICE_RENEWAL_TTL_MS + 1).toISOString() }, ORIGIN, NOW), 'DEVICE_AUTH_INVALID');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, revokedAt: record.issuedAt }, ORIGIN, NOW), 'DEVICE_REVOKED');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, audience: 'operator' } as unknown as GptAccessDeviceRecord, ORIGIN, NOW), 'DEVICE_AUTH_INVALID');
    requireDenied(() => validateGptAccessDeviceRecord({ ...record, gptIds: ['arcanos-core', 'other'] }, ORIGIN, NOW), 'DEVICE_AUTH_INVALID');
    requireDenied(() => validateGptAccessDeviceRecord(record, 'https://other.example.invalid', NOW), 'DEVICE_ORIGIN_DENIED', 403);

    const owner = { version: 1, deviceId: DEVICE_A, principalId: grant.principalId, workspaceId: grant.workspaceId };
    requireProof(matchesGptAccessDeviceJobOwner(owner, record));
    for (const foreign of [{ ...owner, deviceId: DEVICE_B }, { ...owner, principalId: 'operator:other' },
      { ...owner, workspaceId: 'other' }, { ...owner, version: '1' }]) {
      requireProof(!matchesGptAccessDeviceJobOwner(foreign, record));
    }
    for (const absent of [null, undefined, {}, [], { deviceId: DEVICE_A }, 'owner']) {
      requireProof(!matchesGptAccessDeviceJobOwner(absent, record));
    }

    const first = hashLocalAgentIdempotencyKey(KEY, DEVICE_A);
    const second = hashLocalAgentIdempotencyKey(KEY, DEVICE_B);
    const operator = hashLocalAgentIdempotencyKey(KEY);
    requireProof(/^[0-9a-f]{64}$/u.test(first) && /^[0-9a-f]{64}$/u.test(second));
    requireProof(first !== second && first !== operator && second !== operator);
    requireProof(first === hashLocalAgentIdempotencyKey(KEY, DEVICE_A));
    requireProof(first !== hashLocalAgentIdempotencyKey(`${KEY}-other`, DEVICE_A));
    requireProof(operator === LEGACY_OPERATOR_HASH && hashLocalAgentIdempotencyKey(KEY, '') === operator);

    return {
      ok: true, synthetic: true, proofVersion: 'ios-device-policy/v1',
      boundaries: { grantSchema: true, credentialStatePolicy: true, deviceJobOwnership: true, requesterIdempotency: true },
      checks: { grantAndOriginValidation: true, credentialExpiryAndRenewal: true, revocationAndAudience: true,
        ownerIsolation: true, missingOwnerDenied: true, requesterIdempotencyIsolation: true, operatorIdempotencyCompatibility: true },
      protectedEffectsEnabled: false,
    } as const;
  } catch {
    // No policy exception, record, or private diagnostic crosses the served fixture boundary.
    throw new Error('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  }
}
