import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actual = await import('../src/shared/ios/iosDevicePreviewFixture.js');
const fixture = jest.fn(actual.runIosDevicePolicyPreview);
jest.unstable_mockModule('../src/shared/ios/iosDevicePreviewFixture.js', () => ({
  ...actual, runIosDevicePolicyPreview: fixture,
}));
const { createNativePrPreviewApplication } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_IOS_DEVICE_CONTRACT: contract } = await import('../src/nativePrPreviewContract.js');
const { IOS_GATEWAY_PREVIEW_CONTRACT: gateway } = await import('../src/shared/ios/iosGatewayPreviewFixture.js');

const identity = { prNumber: 1496, sourceCommit: 'a'.repeat(40) };
const privateDiagnostic = 'private-device-preview-diagnostic';

function application(ready = true) {
  return createNativePrPreviewApplication({
    identity,
    readinessState: { applicationImported: true, fixturesSealed: true, ready, draining: false },
    notionConnectivityProbe: async () => { throw new Error('Unexpected external probe'); },
  });
}

describe('served iOS device policy proof boundary', () => {
  beforeEach(() => fixture.mockReset().mockImplementation(actual.runIosDevicePolicyPreview));

  it('serves the exact fixed proof with source identity and versioned evidence', async () => {
    const response = await request(application()).get('/ios/device-contract').expect(200);
    expect(contract.path).toBe('/ios/device-contract');
    expect(fixture).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({
      ok: true,
      synthetic: true,
      proofVersion: 'ios-device-policy/v1',
      boundaries: {
        grantSchema: true, credentialStatePolicy: true, deviceJobOwnership: true, requesterIdempotency: true,
      },
      checks: {
        grantAndOriginValidation: true, credentialExpiryAndRenewal: true, revocationAndAudience: true,
        ownerIsolation: true, missingOwnerDenied: true, requesterIdempotencyIsolation: true,
        operatorIdempotencyCompatibility: true,
      },
      protectedEffectsEnabled: false,
      ...identity,
    });
    expect(response.headers[contract.proofHeader]).toBe('ios-device-policy/v1');
    expect(response.headers['x-arcanos-preview-fixture']).toBe('sealed-synthetic');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it.each(['authorization', 'cookie', 'x-api-key', 'x-session-id', 'x-arcanos-admin'])(
    'rejects the %s credential carrier before running policy fixtures', async (header) => {
      const response = await request(application()).get(contract.path)
        .set(header, 'test-forbidden-value').expect(404);
      expect(response.headers[contract.proofHeader]).toBeUndefined();
      expect(fixture).not.toHaveBeenCalled();
    },
  );

  it('rejects query parameters before running policy fixtures', async () => {
    const response = await request(application()).get(`${contract.path}?extra=1`).expect(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(fixture).not.toHaveBeenCalled();
  });

  it.each(['{}', '{'])('rejects a GET body before running policy fixtures: %s', async (body) => {
    const response = await request(application()).get(contract.path)
      .set('Content-Type', 'application/json').send(body).expect(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(fixture).not.toHaveBeenCalled();
  });

  it.each(['head', 'post'] as const)('rejects %s instead of falling through to GET', async (method) => {
    const response = await request(application())[method](contract.path).expect(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(fixture).not.toHaveBeenCalled();
  });

  it('withholds success and proof headers when a fixture assertion fails', async () => {
    fixture.mockImplementation(() => { throw new Error(privateDiagnostic); });
    const response = await request(application()).get(contract.path).expect(500);
    expect(response.body).toEqual({ ok: false, error: 'IOS_DEVICE_PREVIEW_FIXTURE_FAILED' });
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(response.text).not.toContain(privateDiagnostic);
    expect(response.text).not.toContain('"checks"');
    expect(response.text).not.toContain('"boundaries"');
  });

  it.each(['get', 'head'] as const)('requires device policy assertions before %s readiness succeeds', async (method) => {
    const response = await request(application())[method]('/readyz').expect(200);
    expect(fixture).toHaveBeenCalledTimes(1);
    expect(response.headers[contract.proofHeader]).toBe(contract.proofVersion);
    if (method === 'get') expect(response.body.ready).toBe(true);
  });

  it.each(['get', 'head'] as const)('fails %s readiness closed without device proof on assertion failure', async (method) => {
    fixture.mockImplementation(() => { throw new Error(privateDiagnostic); });
    const response = await request(application())[method]('/readyz').expect(503);
    expect(fixture).toHaveBeenCalledTimes(1);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    if (method === 'get') {
      expect(response.body.ready).toBe(false);
      expect(response.body.prNumber).toBe(identity.prNumber);
      expect(response.body.sourceCommit).toBe(identity.sourceCommit);
      expect(response.text).not.toContain(privateDiagnostic);
    }
  });

  it('keeps incomplete readiness closed without claiming or executing device proof', async () => {
    const response = await request(application(false)).get('/readyz').expect(503);
    expect(response.body.ready).toBe(false);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(fixture).not.toHaveBeenCalled();
  });
});

describe('sealed iOS Gateway device-origin header boundary', () => {
  const host = 'arcanos-v2-pr-676861-1496.up.railway.app';
  const origin = `https://${host}`;
  const originHeader = 'X-Arcanos-Device-Origin';
  const headers = () => ({
    Host: host,
    [gateway.selectorHeader]: gateway.selector,
    authorization: gateway.bearer,
    [originHeader]: origin,
  });

  beforeEach(() => fixture.mockReset().mockImplementation(actual.runIosDevicePolicyPreview));

  it('accepts the real client origin header only for the matching public fixture', async () => {
    const response = await request(application()).get(gateway.metadataPath).set(headers()).expect(200);
    expect(response.body.prNumber).toBe(identity.prNumber);
    expect(response.body.sourceCommit).toBe(identity.sourceCommit);
    expect(response.headers[gateway.proofHeader]).toBe(gateway.proofVersion);
  });

  it.each([
    'https://other.example.invalid',
    `http://${host}`,
    `${origin}/`,
    `${origin}?extra=1`,
    `${origin}:443`,
    `https://user@${host}`,
    'https://arcanos-v2-pr-676861-1495.up.railway.app',
  ])('rejects a mismatched or noncanonical device origin: %s', async (value) => {
    const response = await request(application()).get(gateway.metadataPath).set(headers())
      .set(originHeader, value).expect(404);
    expect(response.headers[gateway.proofHeader]).toBeUndefined();
  });

  it('rejects duplicate origin headers', async () => {
    await request(application()).get(gateway.metadataPath).set(headers())
      .set(originHeader, [origin, origin]).expect(404);
  });

  it('keeps other x-arcanos headers denied alongside the permitted origin', async () => {
    await request(application()).get(gateway.metadataPath).set(headers())
      .set('X-Arcanos-Admin', 'test-forbidden-value').expect(404);
  });

  it('requires the exact selector and public synthetic bearer for the origin exception', async () => {
    const app = application();
    await request(app).get(gateway.metadataPath).set(headers()).unset(gateway.selectorHeader).expect(404);
    await request(app).get(gateway.metadataPath).set(headers()).unset('authorization').expect(404);
    await request(app).get(gateway.metadataPath).set(headers())
      .set('authorization', 'Bearer test-wrong-fixture').expect(404);
    await request(app).get('/readyz').set(headers()).expect(404);
    await request(app).get(contract.path).set(headers()).expect(404);
  });

  it('rejects origin-bearing requests whose Host is outside this PR preview', async () => {
    await request(application()).get(gateway.metadataPath).set(headers())
      .set('Host', 'unowned.example.invalid').set(originHeader, 'https://unowned.example.invalid').expect(404);
  });
});
