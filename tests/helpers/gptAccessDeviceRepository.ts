import {
  GptAccessDeviceAuthError,
  type GptAccessDeviceGrant, type GptAccessDeviceRecord,
  type GptAccessDeviceRepository, type GptAccessPairingRecord
} from '../../src/shared/security/gptAccessDevice.js';

/** Deterministic synthetic persistence; production always uses PostgreSQL. */
export class SyntheticGptAccessDeviceRepository implements GptAccessDeviceRepository {
  readonly pairings = new Map<string, GptAccessPairingRecord>();
  readonly devices = new Map<string, GptAccessDeviceRecord>();
  failReads = false;
  async createPairing(record: GptAccessPairingRecord): Promise<void> {
    this.pairings.set(record.pairingHash, structuredClone(record));
  }
  async consumePairing(hash: string, device: Omit<GptAccessDeviceRecord, keyof GptAccessDeviceGrant>, now: string, origin: string) {
    const pairing = this.pairings.get(hash);
    if (!pairing) throw new GptAccessDeviceAuthError('PAIRING_INVALID', 400);
    if (pairing.consumedAt) throw new GptAccessDeviceAuthError('PAIRING_USED', 409);
    if (Date.parse(pairing.expiresAt) <= Date.parse(now)) throw new GptAccessDeviceAuthError('PAIRING_EXPIRED', 410);
    if (pairing.origin !== origin) throw new GptAccessDeviceAuthError('DEVICE_ORIGIN_DENIED', 403);
    const record: GptAccessDeviceRecord = {
      ...device, principalId: pairing.principalId, workspaceId: pairing.workspaceId,
      origin: pairing.origin, scopes: [...pairing.scopes], capabilityActions: [...pairing.capabilityActions]
    };
    pairing.consumedAt = now;
    this.devices.set(device.deviceId, record);
    return structuredClone(record);
  }
  async findByCredentialHash(hash: string) {
    if (this.failReads) throw new Error('Synthetic persistence outage');
    const record = [...this.devices.values()].find(value => value.credentialHash === hash);
    return record ? structuredClone(record) : null;
  }
  async rotate(hash: string, replacementHash: string, issuedAt: string, expiresAt: string) {
    const record = [...this.devices.values()].find(value => value.credentialHash === hash);
    if (!record) throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID');
    if (record.revokedAt) throw new GptAccessDeviceAuthError('DEVICE_REVOKED');
    if (Date.parse(record.renewalExpiresAt) <= Date.parse(issuedAt)) throw new GptAccessDeviceAuthError('DEVICE_RENEWAL_REQUIRED');
    if (Date.parse(record.expiresAt) <= Date.parse(issuedAt)) throw new GptAccessDeviceAuthError('DEVICE_CREDENTIAL_EXPIRED');
    Object.assign(record, { credentialHash: replacementHash, issuedAt, expiresAt });
    return structuredClone(record);
  }
  async revoke(deviceId: string, principalId: string, workspaceId: string, now: string) {
    const record = this.devices.get(deviceId);
    if (!record || record.principalId !== principalId || record.workspaceId !== workspaceId) return false;
    record.revokedAt ??= now;
    return true;
  }
}
