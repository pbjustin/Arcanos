import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gptAccessDeviceRepository } from '@core/db/repositories/gptAccessDeviceRepository.js';
import { validateGptAccessDeviceRecord } from '@shared/security/gptAccessDevicePolicyCore.js';
import {
  GPT_ACCESS_DEVICE_AUDIENCE, GPT_ACCESS_DEVICE_GPT_IDS, GPT_ACCESS_DEVICE_RENEWAL_TTL_MS,
  GPT_ACCESS_DEVICE_TOKEN_PATTERN, GPT_ACCESS_DEVICE_TTL_MS, GPT_ACCESS_PAIRING_TOKEN_PATTERN,
  GPT_ACCESS_PAIRING_TTL_MS, GptAccessDeviceAuthError, GptAccessDeviceGrantSchema,
  GptAccessPairingCompleteSchema,
  type GptAccessDeviceGrant, type GptAccessDeviceRecord, type GptAccessDeviceRepository,
  type GptAccessDeviceSession, type GptAccessDeviceSessionMetadata, type GptAccessDevicePrincipal
} from '@shared/security/gptAccessDevice.js';

export { GptAccessDeviceAuthError } from '@shared/security/gptAccessDevice.js';

export function hashGptAccessDeviceSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deviceSessionMetadata(record: GptAccessDevicePrincipal): GptAccessDeviceSessionMetadata {
  return {
    ok: true, deviceId: record.deviceId, tokenType: 'Bearer', audience: record.audience,
    origin: record.origin, issuedAt: record.issuedAt, expiresAt: record.expiresAt,
    renewalExpiresAt: record.renewalExpiresAt, scopes: [...record.scopes],
    capabilityActions: [...record.capabilityActions], gptIds: [...record.gptIds]
  };
}

/** Opaque sessions reuse the durable database boundary and have no signing/master key. */
export class GptAccessDeviceCredentialService {
  constructor(
    private readonly repository: GptAccessDeviceRepository = gptAccessDeviceRepository,
    private readonly now: () => number = Date.now
  ) {}

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof GptAccessDeviceAuthError) throw error;
      // Database exceptions may contain query parameters: never return their text/cause.
      throw new GptAccessDeviceAuthError('DEVICE_AUTH_UNAVAILABLE', 503);
    }
  }

  async createPairing(grant: GptAccessDeviceGrant) {
    const parsed = GptAccessDeviceGrantSchema.safeParse(grant);
    if (!parsed.success) throw new GptAccessDeviceAuthError('DEVICE_SCOPE_DENIED', 403);
    const pairingToken = `agp1.${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + GPT_ACCESS_PAIRING_TTL_MS).toISOString();
    await this.persist(() => this.repository.createPairing({
      ...parsed.data, pairingHash: hashGptAccessDeviceSecret(pairingToken), issuedAt, expiresAt, consumedAt: null
    }));
    return { ok: true as const, pairingToken, expiresAt, origin: parsed.data.origin };
  }

  async completePairing(pairingToken: string, localIdentity: string, origin: string): Promise<GptAccessDeviceSession> {
    if (!GptAccessPairingCompleteSchema.safeParse({ pairingToken, localIdentity }).success
      || !GPT_ACCESS_PAIRING_TOKEN_PATTERN.test(pairingToken)) {
      throw new GptAccessDeviceAuthError('PAIRING_INVALID', 400);
    }
    const now = this.now();
    const issuedAt = new Date(now).toISOString();
    const credential = `agd1.${randomBytes(32).toString('base64url')}`;
    const record = await this.persist(() => this.repository.consumePairing(
      hashGptAccessDeviceSecret(pairingToken), {
        deviceId: randomUUID(), localIdentityHash: hashGptAccessDeviceSecret(`local-identity-v1:${localIdentity.toLowerCase()}`),
        credentialHash: hashGptAccessDeviceSecret(credential), audience: GPT_ACCESS_DEVICE_AUDIENCE,
        pairedAt: issuedAt, issuedAt, expiresAt: new Date(now + GPT_ACCESS_DEVICE_TTL_MS).toISOString(),
        renewalExpiresAt: new Date(now + GPT_ACCESS_DEVICE_RENEWAL_TTL_MS).toISOString(),
        revokedAt: null, gptIds: [...GPT_ACCESS_DEVICE_GPT_IDS]
      }, issuedAt, origin
    ));
    this.validateRecord(record, record.origin, now);
    return { ...deviceSessionMetadata(record), credential };
  }

  private validateRecord(record: GptAccessDeviceRecord, origin: string, now: number): void {
    validateGptAccessDeviceRecord(record, origin, now);
  }

  async authenticate(token: string | undefined, origin: string): Promise<GptAccessDevicePrincipal> {
    if (!token) throw new GptAccessDeviceAuthError('DEVICE_AUTH_REQUIRED');
    if (!GPT_ACCESS_DEVICE_TOKEN_PATTERN.test(token)) throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID');
    const record = await this.persist(() => this.repository.findByCredentialHash(hashGptAccessDeviceSecret(token)));
    if (!record) throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID');
    this.validateRecord(record, origin, this.now());
    const { credentialHash: _credentialHash, localIdentityHash: _localIdentityHash, ...principal } = record;
    return principal;
  }

  async inspect(token: string, origin: string) {
    const record = await this.authenticate(token, origin);
    const state = Date.parse(record.expiresAt) - this.now() <= GPT_ACCESS_PAIRING_TTL_MS
      ? 'renewal_required' as const : 'paired' as const;
    return { ...deviceSessionMetadata(record), state };
  }

  async renew(token: string, origin: string): Promise<GptAccessDeviceSession> {
    const record = await this.authenticate(token, origin);
    const now = this.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(Math.min(now + GPT_ACCESS_DEVICE_TTL_MS, Date.parse(record.renewalExpiresAt))).toISOString();
    const credential = `agd1.${randomBytes(32).toString('base64url')}`;
    const updated = await this.persist(() => this.repository.rotate(hashGptAccessDeviceSecret(token), hashGptAccessDeviceSecret(credential), issuedAt, expiresAt));
    return { ...deviceSessionMetadata(updated), credential };
  }

  async revoke(deviceId: string, principalId: string, workspaceId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(deviceId)) {
      throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID', 404);
    }
    const found = await this.persist(() => this.repository.revoke(deviceId, principalId, workspaceId, new Date(this.now()).toISOString()));
    if (!found) throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID', 404);
    return { ok: true as const, deviceId, state: 'revoked' as const };
  }
}

export const gptAccessDeviceCredentials = new GptAccessDeviceCredentialService();
