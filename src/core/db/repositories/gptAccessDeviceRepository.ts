import type { PoolClient } from 'pg';
import { query, transaction } from '@core/db/query.js';
import {
  GptAccessDeviceAuthError,
  type GptAccessDeviceGrant, type GptAccessDeviceRecord,
  type GptAccessDeviceRepository, type GptAccessPairingRecord
} from '@shared/security/gptAccessDevice.js';

interface DeviceRow {
  device_id: string; local_identity_hash: string; credential_hash: string;
  principal_id: string; workspace_id: string; origin: string; audience: GptAccessDeviceRecord['audience'];
  paired_at: Date | string; issued_at: Date | string; expires_at: Date | string;
  renewal_expires_at: Date | string; revoked_at: Date | string | null;
  scopes: GptAccessDeviceRecord['scopes']; capability_actions: GptAccessDeviceRecord['capabilityActions']; gpt_ids: string[];
}
interface PairingRow {
  principal_id: string; workspace_id: string; origin: string;
  scopes: GptAccessDeviceGrant['scopes']; capability_actions: GptAccessDeviceGrant['capabilityActions'];
  expires_at: Date | string; consumed_at: Date | string | null;
}
const iso = (value: Date | string): string => new Date(value).toISOString();
function mapDevice(row: DeviceRow): GptAccessDeviceRecord {
  return {
    deviceId: row.device_id, localIdentityHash: row.local_identity_hash, credentialHash: row.credential_hash,
    principalId: row.principal_id, workspaceId: row.workspace_id, origin: row.origin, audience: row.audience,
    pairedAt: iso(row.paired_at), issuedAt: iso(row.issued_at), expiresAt: iso(row.expires_at),
    renewalExpiresAt: iso(row.renewal_expires_at), revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    scopes: row.scopes, capabilityActions: row.capability_actions, gptIds: row.gpt_ids
  };
}

/** The exported transaction helpers also support an explicitly disposable PostgreSQL proof. */
export async function consumeGptAccessPairingWithClient(
  client: PoolClient, pairingHash: string,
  device: Omit<GptAccessDeviceRecord, keyof GptAccessDeviceGrant>, now: string, origin: string
): Promise<GptAccessDeviceRecord> {
  const selected = await client.query<PairingRow>(
    'SELECT * FROM gpt_access_device_pairings WHERE pairing_hash = $1 FOR UPDATE', [pairingHash]
  );
  const pairing = selected.rows[0];
  if (!pairing) throw new GptAccessDeviceAuthError('PAIRING_INVALID', 400);
  if (pairing.consumed_at) throw new GptAccessDeviceAuthError('PAIRING_USED', 409);
  if (new Date(pairing.expires_at).getTime() <= Date.parse(now)) throw new GptAccessDeviceAuthError('PAIRING_EXPIRED', 410);
  if (pairing.origin !== origin) throw new GptAccessDeviceAuthError('DEVICE_ORIGIN_DENIED', 403);
  const inserted = await client.query<DeviceRow>(`INSERT INTO gpt_access_devices
    (device_id, local_identity_hash, credential_hash, principal_id, workspace_id, origin, audience,
     paired_at, issued_at, expires_at, renewal_expires_at, scopes, capability_actions, gpt_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [
    device.deviceId, device.localIdentityHash, device.credentialHash, pairing.principal_id,
    pairing.workspace_id, pairing.origin, device.audience, device.pairedAt, device.issuedAt,
    device.expiresAt, device.renewalExpiresAt, pairing.scopes, pairing.capability_actions, device.gptIds
  ]);
  const consumed = await client.query(`UPDATE gpt_access_device_pairings SET consumed_at = $2
    WHERE pairing_hash = $1 AND consumed_at IS NULL
    AND expires_at > GREATEST($2::timestamptz, clock_timestamp()) RETURNING pairing_hash`, [pairingHash, now]);
  // Expiration while waiting for a row lock rolls the registration back too.
  if (consumed.rows.length !== 1) throw new GptAccessDeviceAuthError('PAIRING_EXPIRED', 410);
  return mapDevice(inserted.rows[0]);
}

export async function rotateGptAccessDeviceWithClient(
  client: PoolClient, credentialHash: string, replacementHash: string, issuedAt: string, expiresAt: string
): Promise<GptAccessDeviceRecord> {
  const selected = await client.query<DeviceRow>(
    'SELECT * FROM gpt_access_devices WHERE credential_hash = $1 FOR UPDATE', [credentialHash]
  );
  const current = selected.rows[0];
  if (!current) throw new GptAccessDeviceAuthError('DEVICE_AUTH_INVALID');
  if (current.revoked_at) throw new GptAccessDeviceAuthError('DEVICE_REVOKED');
  if (new Date(current.renewal_expires_at).getTime() <= Date.parse(issuedAt)) throw new GptAccessDeviceAuthError('DEVICE_RENEWAL_REQUIRED');
  if (new Date(current.expires_at).getTime() <= Date.parse(issuedAt)) throw new GptAccessDeviceAuthError('DEVICE_CREDENTIAL_EXPIRED');
  const result = await client.query<DeviceRow>(`UPDATE gpt_access_devices
    SET credential_hash = $2, issued_at = $3, expires_at = LEAST($4::timestamptz, renewal_expires_at)
    WHERE device_id = $1 AND credential_hash = $5 AND revoked_at IS NULL
      AND expires_at > GREATEST($3::timestamptz, clock_timestamp())
      AND renewal_expires_at > GREATEST($3::timestamptz, clock_timestamp()) RETURNING *`,
  [current.device_id, replacementHash, issuedAt, expiresAt, credentialHash]);
  if (!result.rows[0]) throw new GptAccessDeviceAuthError('DEVICE_CREDENTIAL_EXPIRED');
  return mapDevice(result.rows[0]);
}

export const gptAccessDeviceRepository: GptAccessDeviceRepository = {
  async createPairing(record: GptAccessPairingRecord) {
    await transaction(async client => {
      // Only one-way challenge hashes survive briefly for replay diagnostics.
      await client.query('DELETE FROM gpt_access_device_pairings WHERE expires_at < $1::timestamptz - INTERVAL \'24 hours\'', [record.issuedAt]);
      await client.query(`INSERT INTO gpt_access_device_pairings
        (pairing_hash, principal_id, workspace_id, origin, scopes, capability_actions, issued_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [record.pairingHash, record.principalId, record.workspaceId,
        record.origin, record.scopes, record.capabilityActions, record.issuedAt, record.expiresAt]);
    });
  },
  consumePairing(pairingHash, device, now, origin) {
    return transaction(client => consumeGptAccessPairingWithClient(client, pairingHash, device, now, origin));
  },
  async findByCredentialHash(credentialHash) {
    const result = await query('SELECT * FROM gpt_access_devices WHERE credential_hash = $1', [credentialHash], { useCache: false });
    return result.rows[0] ? mapDevice(result.rows[0] as DeviceRow) : null;
  },
  rotate(credentialHash, replacementHash, issuedAt, expiresAt) {
    return transaction(client => rotateGptAccessDeviceWithClient(client, credentialHash, replacementHash, issuedAt, expiresAt));
  },
  async revoke(deviceId, principalId, workspaceId, now) {
    const result = await query(`UPDATE gpt_access_devices SET revoked_at = COALESCE(revoked_at, $4::timestamptz)
      WHERE device_id = $1 AND principal_id = $2 AND workspace_id = $3 RETURNING device_id`,
    [deviceId, principalId, workspaceId, now], { useCache: false });
    return result.rows.length === 1;
  }
};
