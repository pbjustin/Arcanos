import {
  GPT_ACCESS_DEVICE_AUDIENCE,
  GPT_ACCESS_DEVICE_RENEWAL_TTL_MS,
  GPT_ACCESS_DEVICE_TTL_MS,
  GptAccessDeviceAuthError,
  GptAccessDeviceGrantSchema,
  type GptAccessDevicePrincipal,
  type GptAccessDeviceRecord,
} from './gptAccessDevice.js';

/** Credential-independent policy shared by durable authentication and sealed proofs. */
export function validateGptAccessDeviceRecord(record: GptAccessDeviceRecord, origin: string, now: number): void {
  const { principalId, workspaceId, scopes, capabilityActions } = record;
  if (record.audience !== GPT_ACCESS_DEVICE_AUDIENCE
    || !GptAccessDeviceGrantSchema.safeParse({ principalId, workspaceId, scopes, capabilityActions, origin: record.origin }).success
    || record.gptIds.length !== 1 || record.gptIds[0] !== 'arcanos-core'
    || ![record.pairedAt, record.issuedAt, record.expiresAt, record.renewalExpiresAt].every(value => Number.isFinite(Date.parse(value)))
    || Date.parse(record.issuedAt) > now || Date.parse(record.pairedAt) > Date.parse(record.issuedAt)
    || Date.parse(record.expiresAt) > Date.parse(record.renewalExpiresAt)
    || Date.parse(record.expiresAt) - Date.parse(record.issuedAt) > GPT_ACCESS_DEVICE_TTL_MS
    || Date.parse(record.renewalExpiresAt) - Date.parse(record.pairedAt) > GPT_ACCESS_DEVICE_RENEWAL_TTL_MS) {
    throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID');
  }
  if (record.revokedAt) throw new GptAccessDeviceAuthError('DEVICE_REVOKED');
  if (record.origin !== origin) throw new GptAccessDeviceAuthError('DEVICE_ORIGIN_DENIED', 403);
  if (Date.parse(record.renewalExpiresAt) <= now) throw new GptAccessDeviceAuthError('DEVICE_RENEWAL_REQUIRED');
  if (Date.parse(record.expiresAt) <= now) throw new GptAccessDeviceAuthError('DEVICE_CREDENTIAL_EXPIRED');
}

/** Ownership is server-written and must match all three identity dimensions. */
export function matchesGptAccessDeviceJobOwner(
  owner: unknown,
  device: Pick<GptAccessDevicePrincipal, 'deviceId' | 'principalId' | 'workspaceId'>,
): boolean {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
  const record = owner as Record<string, unknown>;
  return record.version === 1 && record.deviceId === device.deviceId
    && record.principalId === device.principalId && record.workspaceId === device.workspaceId;
}
