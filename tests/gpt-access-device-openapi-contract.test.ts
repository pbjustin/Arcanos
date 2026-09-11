import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { buildGptAccessOpenApiDocument } from '../src/services/gptAccessGateway.js';
import {
  GPT_ACCESS_DEVICE_ACTIONS, GPT_ACCESS_DEVICE_AUDIENCE, GPT_ACCESS_DEVICE_GPT_IDS,
  GPT_ACCESS_DEVICE_SCOPES, GptAccessPairingCompleteSchema
} from '../src/shared/security/gptAccessDevice.js';
import { GptAccessDeviceCredentialService } from '../src/services/gptAccessDeviceCredentials.js';
import { SyntheticGptAccessDeviceRepository } from './helpers/gptAccessDeviceRepository.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const snapshot = JSON.parse(readFileSync(new URL('../clients/ios/scripts/gateway-contract.generated.json', import.meta.url), 'utf8'));
const document = buildGptAccessOpenApiDocument({ serverUrl: 'https://gateway.example.test' });
const ajv = new Ajv({ strict: false });
ajv.addFormat('uuid', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  && Number.isFinite(Date.parse(value)));
ajv.addFormat('uri', (value: string) => { try { return Boolean(new URL(value).protocol); } catch { return false; } });
const validators = Object.fromEntries(Object.entries(document.components.schemas)
  .filter(([name]) => name.startsWith('Device'))
  .map(([name, schema]) => [name, ajv.compile(schema)]));
const deviceId = '8b24df13-1036-4a43-aec0-4a7a35cc22ee';
const credential = {
  ok: true, deviceId, credential: `agd1.${'a'.repeat(43)}`, tokenType: 'Bearer',
  audience: 'gpt-access-device-v1', origin: 'https://gateway.example.test',
  issuedAt: '2026-09-11T12:00:00.000Z', expiresAt: '2026-09-11T13:00:00.000Z',
  renewalExpiresAt: '2026-10-11T12:00:00.000Z', scopes: ['jobs.create', 'jobs.result'],
  capabilityActions: ['git.status'], gptIds: ['arcanos-core']
};

describe('paired-device canonical OpenAPI and Swift contract', () => {
  it('regenerates deterministically without importing backend runtime dependencies', () => {
    expect(execFileSync(process.execPath, ['clients/ios/scripts/derive-gateway-contract.mjs', '--check'],
      { cwd: root, encoding: 'utf8', timeout: 30_000 })).toContain('contract verified:');
  });

  it('keeps every generated schema and selected authentication class equal to the canonical builder', () => {
    expect(snapshot.securitySchemes).toEqual(document.components.securitySchemes);
    for (const [name, schema] of Object.entries(snapshot.schemas)) {
      expect(schema).toEqual(document.components.schemas[name as keyof typeof document.components.schemas]);
    }
    for (const operation of snapshot.operations) {
      const methods = document.paths[operation.path as keyof typeof document.paths] as Record<string, { operationId: string; security: unknown }>;
      expect(operation.operationId).toBe(methods[operation.method].operationId);
      expect(operation.security).toEqual(methods[operation.method].security);
    }
  });

  it('preserves operator-only administration and requires both device bearer and approved origin', () => {
    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/gpt-access/devices/pairing'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/gpt-access/devices/pair'].post.security).toEqual([]);
    expect(document.paths['/gpt-access/devices/pair'].post.parameters).toContainEqual(expect.objectContaining({
      name: 'X-Arcanos-Device-Origin', in: 'header', required: true
    }));
    expect(document.paths['/gpt-access/devices/session'].get.security).toEqual([{ deviceBearerAuth: [], deviceOrigin: [] }]);
    expect(document.paths['/gpt-access/devices/renew'].post.security).toEqual([{ deviceBearerAuth: [], deviceOrigin: [] }]);
    expect(document.paths['/gpt-access/jobs/create'].post.security).toEqual([
      { bearerAuth: [] }, { deviceBearerAuth: [], deviceOrigin: [] }
    ]);
    for (const path of ['/gpt-access/jobs/timeline', '/gpt-access/diagnostics/deep', '/gpt-access/mcp'] as const) {
      expect(document.paths[path].post.security).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('agrees with runtime grants, audience, GPT limits, and sensitive model annotations', () => {
    const schema = document.components.schemas.DeviceCredentialResponse;
    expect(schema.properties.scopes.items.enum).toEqual([...GPT_ACCESS_DEVICE_SCOPES]);
    expect(schema.properties.capabilityActions.items.enum).toEqual([...GPT_ACCESS_DEVICE_ACTIONS]);
    expect(schema.properties.gptIds.items.const).toBe(GPT_ACCESS_DEVICE_GPT_IDS[0]);
    expect(schema.properties.audience.const).toBe(GPT_ACCESS_DEVICE_AUDIENCE);
    expect(schema.properties.credential['x-arcanos-sensitive']).toBe(true);
    expect(document.components.schemas.DevicePairingResponse.properties.pairingToken['x-arcanos-sensitive']).toBe(true);
    expect(document.components.schemas.DevicePairRequest.properties.pairingToken['x-arcanos-sensitive']).toBe(true);
    const pair = { pairingToken: `agp1.${'a'.repeat(43)}`, localIdentity: deviceId };
    for (const body of [pair, { ...pair, localIdentity: 'not-a-uuid' }, { ...pair, principalId: 'forged' },
      { ...pair, pairingToken: `agd1.${'a'.repeat(43)}` }]) {
      expect(validators.DevicePairRequest(body)).toBe(GptAccessPairingCompleteSchema.safeParse(body).success);
    }
  });

  it('validates real service response projections against the generated client contract using isolated persistence', async () => {
    const service = new GptAccessDeviceCredentialService(new SyntheticGptAccessDeviceRepository(),
      () => Date.parse('2026-09-11T12:00:00.000Z'));
    const owner = { principalId: 'operator:contract', workspaceId: 'workspace:contract' };
    const pairing = await service.createPairing({ ...owner, origin: credential.origin,
      scopes: ['jobs.create', 'jobs.result'], capabilityActions: ['git.status'] });
    expect(validators.DevicePairingResponse(pairing)).toBe(true);
    const issued = await service.completePairing(pairing.pairingToken, deviceId, credential.origin);
    expect(validators.DeviceCredentialResponse(issued)).toBe(true);
    expect(validators.DeviceSessionResponse(await service.inspect(issued.credential, credential.origin))).toBe(true);
    const rotated = await service.renew(issued.credential, credential.origin);
    expect(validators.DeviceCredentialResponse(rotated)).toBe(true);
    expect(validators.DeviceRevokeResponse(await service.revoke(rotated.deviceId, owner.principalId, owner.workspaceId))).toBe(true);
  });

  it('accepts bounded pairing shapes and denies caller-owned principal, origin, TTL, and privilege escalation', () => {
    expect(validators.DevicePairingRequest({})).toBe(true);
    expect(validators.DevicePairingRequest({ scopes: ['jobs.result'], capabilityActions: [] })).toBe(true);
    for (const body of [{ owner: 'another' }, { principalId: 'another' }, { workspaceId: 'another' },
      { origin: 'https://attacker.example' }, { ttlMs: 99999999 }, { scopes: ['queue.inspect'] },
      { scopes: ['jobs.create', 'jobs.create'] }, { scopes: [] },
      { capabilityActions: ['shell.exec'] }, { capabilityActions: ['tests.run', 'tests.run'] }]) {
      expect(validators.DevicePairingRequest(body)).toBe(false);
    }
    const pair = { pairingToken: `agp1.${'a'.repeat(43)}`, localIdentity: deviceId };
    expect(validators.DevicePairRequest(pair)).toBe(true);
    for (const body of [{ ...pair, pairingToken: '' }, { ...pair, pairingToken: 'master-token' },
      { ...pair, pairingToken: `agd1.${'a'.repeat(43)}` }, { ...pair, localIdentity: 'hardware-serial' },
      { ...pair, deviceId }, { ...pair, scopes: ['jobs.create'] }]) {
      expect(validators.DevicePairRequest(body)).toBe(false);
    }
  });

  it('accepts issued device credentials and rejects malformed secrets, audience, scope, and response drift', () => {
    expect(validators.DeviceCredentialResponse(credential)).toBe(true);
    for (const replacement of [{ credential: 'master-token' }, { credential: `agd1.${'a'.repeat(42)}` },
      { audience: 'local-agent-executor' }, { origin: 'http://gateway.example.test' },
      { scopes: ['workers.manage'] }, { capabilityActions: ['shell.exec'] },
      { gptIds: ['any-module'] }, { tokenType: 'Basic' }, { expiresAt: 'never' },
      { operatorToken: 'forbidden' }]) {
      expect(validators.DeviceCredentialResponse({ ...credential, ...replacement })).toBe(false);
    }
  });

  it('never permits credential material in session inspection and fixes revocation/renewal shapes', () => {
    const { credential: _secret, ...metadata } = credential;
    expect(validators.DeviceSessionResponse({ ...metadata, state: 'paired' })).toBe(true);
    expect(validators.DeviceSessionResponse({ ...metadata, state: 'renewal_required' })).toBe(true);
    expect(validators.DeviceSessionResponse({ ...credential, state: 'paired' })).toBe(false);
    expect(validators.DeviceSessionResponse({ ...metadata, state: 'admin' })).toBe(false);
    expect(validators.DeviceRenewRequest({})).toBe(true);
    expect(validators.DeviceRevokeRequest({})).toBe(true);
    expect(validators.DeviceRenewRequest({ scopes: ['jobs.create'] })).toBe(false);
    expect(validators.DeviceRevokeRequest({ deviceId })).toBe(false);
    expect(validators.DeviceRevokeResponse({ ok: true, deviceId, state: 'revoked' })).toBe(true);
    expect(validators.DeviceRevokeResponse({ ok: true, deviceId, state: 'paired' })).toBe(false);
  });

  it('documents the existing exact-once confirmation contract for device-capable invocations', () => {
    const operation = document.paths['/gpt-access/capabilities/v1/{id}/run'].post;
    expect(operation.description).toContain('retry this exact POST once');
    expect(operation.description).toContain('unchanged action/payload');
    expect(operation.description).toContain('Stop on failure or another challenge');
    expect(operation.responses['403'].content['application/json'].schema.oneOf).toContainEqual({
      $ref: '#/components/schemas/ConfirmationRequiredResponse'
    });
  });
});
