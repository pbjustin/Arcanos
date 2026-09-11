import { beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GptAccessDeviceCredentialService } from '../src/services/gptAccessDeviceCredentials.js';
import {
  GPT_ACCESS_DEVICE_RENEWAL_TTL_MS, GPT_ACCESS_DEVICE_TTL_MS, GPT_ACCESS_PAIRING_TTL_MS,
  type GptAccessDeviceGrant
} from '../src/shared/security/gptAccessDevice.js';
import { GPT_ACCESS_DEVICE_TABLE_DEFINITIONS } from '../src/core/db/gptAccessDeviceSchema.js';
import { SyntheticGptAccessDeviceRepository } from './helpers/gptAccessDeviceRepository.js';

const origin = 'https://gateway.example.test';
const grant: GptAccessDeviceGrant = {
  principalId: 'operator:phase2', workspaceId: 'workspace:phase2', origin,
  scopes: ['jobs.create', 'jobs.result', 'capabilities.read', 'capabilities.run'],
  capabilityActions: ['git.status', 'tests.run', 'patch.preview', 'patch.apply']
};

describe('paired-device credential lifecycle', () => {
  let now: number;
  let repository: SyntheticGptAccessDeviceRepository;
  let service: GptAccessDeviceCredentialService;
  beforeEach(() => {
    now = Date.parse('2026-09-11T12:00:00.000Z');
    repository = new SyntheticGptAccessDeviceRepository();
    service = new GptAccessDeviceCredentialService(repository, () => now);
  });
  async function pair(identity = randomUUID()) {
    const challenge = await service.createPairing(grant);
    return service.completePairing(challenge.pairingToken, identity, origin);
  }

  test('registers a new server identity, scopes and bounded opaque credential; stores only digests', async () => {
    const challenge = await service.createPairing(grant);
    expect(challenge.pairingToken).toMatch(/^agp1\.[A-Za-z0-9_-]{43}$/);
    const localIdentity = randomUUID();
    const session = await service.completePairing(challenge.pairingToken, localIdentity, origin);
    expect(session.credential).toMatch(/^agd1\.[A-Za-z0-9_-]{43}$/);
    expect(session.deviceId).not.toBe(localIdentity);
    expect(Date.parse(session.expiresAt) - now).toBe(GPT_ACCESS_DEVICE_TTL_MS);
    expect(Date.parse(session.renewalExpiresAt) - now).toBe(GPT_ACCESS_DEVICE_RENEWAL_TTL_MS);
    const retained = JSON.stringify([...repository.pairings.values(), ...repository.devices.values()]);
    for (const secret of [challenge.pairingToken, session.credential, localIdentity]) expect(retained).not.toContain(secret);
    expect(await service.authenticate(session.credential, origin)).toMatchObject({ deviceId: session.deviceId, ...grant });
    expect(await service.authenticate(session.credential, origin)).not.toHaveProperty('credentialHash');
    expect(await service.inspect(session.credential, origin)).not.toHaveProperty('credential');
  });

  test('consumes a pairing challenge exactly once even under concurrent requests', async () => {
    const challenge = await service.createPairing(grant);
    const results = await Promise.allSettled([
      service.completePairing(challenge.pairingToken, randomUUID(), origin),
      service.completePairing(challenge.pairingToken, randomUUID(), origin)
    ]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'PAIRING_USED' } });
    expect(repository.devices.size).toBe(1);
  });

  test('rejects malformed, missing, forged and expired pairing material', async () => {
    for (const token of ['', 'bad', `agp1.${'a'.repeat(43)}`]) {
      await expect(service.completePairing(token, randomUUID(), origin)).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    }
    const challenge = await service.createPairing(grant);
    await expect(service.completePairing(challenge.pairingToken, 'serial-number', origin)).rejects.toMatchObject({ code: 'PAIRING_INVALID' });
    now += GPT_ACCESS_PAIRING_TTL_MS;
    await expect(service.completePairing(challenge.pairingToken, randomUUID(), origin)).rejects.toMatchObject({ code: 'PAIRING_EXPIRED' });
    expect(repository.devices.size).toBe(0);
  });

  test('wrong origin cannot consume a pairing challenge', async () => {
    const challenge = await service.createPairing(grant);
    await expect(service.completePairing(challenge.pairingToken, randomUUID(), 'https://wrong.example.test')).rejects.toMatchObject({ code: 'DEVICE_ORIGIN_DENIED' });
    await expect(service.completePairing(challenge.pairingToken, randomUUID(), origin)).resolves.toMatchObject({ ok: true });
  });

  test('client identity replay creates distinct records and never replaces another credential', async () => {
    const identity = randomUUID();
    const first = await pair(identity);
    const second = await pair(identity);
    expect(first.deviceId).not.toBe(second.deviceId);
    await expect(service.authenticate(first.credential, origin)).resolves.toMatchObject({ deviceId: first.deviceId });
  });

  test.each([undefined, '', 'operator-token', `agd1.${'x'.repeat(42)}`, `agd1.${'x'.repeat(44)}`, `agp1.${'x'.repeat(43)}`, `agd1.${'x'.repeat(43)}`])('rejects missing/malformed/forged credentials: %s', async token => {
    await expect(service.authenticate(token, origin)).rejects.toMatchObject({ code: token ? 'DEVICE_AUTH_INVALID' : 'DEVICE_AUTH_REQUIRED' });
  });

  test('validates origin, audience, stored scopes and gpt IDs on every request', async () => {
    const session = await pair();
    await expect(service.authenticate(session.credential, 'https://other.example.test')).rejects.toMatchObject({ code: 'DEVICE_ORIGIN_DENIED' });
    const record = repository.devices.get(session.deviceId)!;
    const original = structuredClone(record);
    for (const mutation of [{ audience: 'local-agent-protocol' }, { scopes: ['workers.recover'] }, { gptIds: ['backstage-booker'] }]) {
      Object.assign(record, original, mutation);
      await expect(service.authenticate(session.credential, origin)).rejects.toMatchObject({ code: 'DEVICE_AUTH_INVALID' });
    }
  });

  test('near expiry requires renewal, expired sessions cannot authenticate/inspect/renew', async () => {
    const session = await pair();
    now += GPT_ACCESS_DEVICE_TTL_MS - 60_000;
    expect(await service.inspect(session.credential, origin)).toMatchObject({ state: 'renewal_required' });
    now += 60_000;
    for (const operation of [() => service.authenticate(session.credential, origin), () => service.inspect(session.credential, origin), () => service.renew(session.credential, origin)]) {
      await expect(operation()).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_EXPIRED' });
    }
  });

  test('rotation keeps device identity and atomically invalidates old token; concurrent rotation has one winner', async () => {
    const session = await pair();
    now += 60_000;
    const results = await Promise.allSettled([service.renew(session.credential, origin), service.renew(session.credential, origin)]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(value => value.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Rotation did not succeed');
    expect(winner.value.deviceId).toBe(session.deviceId);
    expect(winner.value.renewalExpiresAt).toBe(session.renewalExpiresAt);
    expect(winner.value.credential).not.toBe(session.credential);
    await expect(service.authenticate(session.credential, origin)).rejects.toMatchObject({ code: 'DEVICE_AUTH_INVALID' });
    await expect(service.authenticate(winner.value.credential, origin)).resolves.toMatchObject({ deviceId: session.deviceId });
    expect(repository.devices.size).toBe(1);
  });

  test('absolute 30-day deadline cannot be extended by renewal', async () => {
    let session = await pair();
    for (let hour = 1; hour < 720; hour++) {
      now += 59 * 60 * 1000;
      session = await service.renew(session.credential, origin);
    }
    now = Date.parse(session.renewalExpiresAt);
    await expect(service.renew(session.credential, origin)).rejects.toMatchObject({ code: 'DEVICE_RENEWAL_REQUIRED' });
  });

  test('only owning operator context can revoke; revocation immediately denies auth and renewal', async () => {
    const session = await pair();
    await expect(service.revoke(session.deviceId, 'other', grant.workspaceId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.revoke(session.deviceId, grant.principalId, 'other')).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.revoke(session.deviceId, grant.principalId, grant.workspaceId)).toMatchObject({ state: 'revoked' });
    await expect(service.authenticate(session.credential, origin)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    await expect(service.renew(session.credential, origin)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  test('fails closed when durable auth lookup fails', async () => {
    const session = await pair();
    repository.failReads = true;
    await expect(service.authenticate(session.credential, origin)).rejects.toMatchObject({ code: 'DEVICE_AUTH_UNAVAILABLE', statusCode: 503 });
  });

  test('rejects scope expansion, wildcard actions and insecure/noncanonical origins at issue', async () => {
    for (const mutation of [{ scopes: ['workers.read'] }, { capabilityActions: ['*'] }, { capabilityActions: ['shell'] },
      { origin: 'http://gateway.example.test' }, { origin: `${origin}/path` }, { origin: 'https://user:pass@gateway.example.test' }]) {
      await expect(service.createPairing({ ...grant, ...mutation } as GptAccessDeviceGrant)).rejects.toMatchObject({ code: 'DEVICE_SCOPE_DENIED' });
    }
  });

  test('runtime SQL and migration share exact table/index statements with explicit rollback', () => {
    const sql = readFileSync('migrations/20260911_gpt_access_devices_v1.sql', 'utf8');
    for (const definition of GPT_ACCESS_DEVICE_TABLE_DEFINITIONS) expect(sql).toContain(`${definition};`);
    const rollback = readFileSync('migrations/20260911_gpt_access_devices_v1.rollback.sql', 'utf8');
    expect(rollback).toContain('DROP TABLE IF EXISTS gpt_access_devices;');
    expect(rollback).not.toContain('CASCADE');
  });
});
