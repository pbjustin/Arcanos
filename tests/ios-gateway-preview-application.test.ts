import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createNativePrPreviewApplication } from '../src/nativePrPreviewApplication.js';
import { IOS_GATEWAY_PREVIEW_CONTRACT as contract } from '../src/shared/ios/iosGatewayPreviewFixture.js';

const identity = { prNumber: 1495, sourceCommit: 'a'.repeat(40) };
function application() {
  return createNativePrPreviewApplication({
    identity,
    readinessState: { applicationImported: true, fixturesSealed: true, ready: true, draining: false },
    notionConnectivityProbe: async () => { throw new Error('Unexpected external probe'); },
  });
}
const headers = () => ({ [contract.selectorHeader]: contract.selector, authorization: contract.bearer });

describe('contained iOS Gateway HTTP admission', () => {
  it('exposes exact identity and proof only through the sealed selector', async () => {
    const app = application();
    await request(app).get(contract.metadataPath).expect(404);
    const response = await request(app).get(contract.metadataPath).set(headers()).expect(200);
    expect(response.body.prNumber).toBe(identity.prNumber);
    expect(response.body.sourceCommit).toBe(identity.sourceCommit);
    expect(response.body.proofVersion).toBe(contract.proofVersion);
    expect(response.headers[contract.proofHeader]).toBe(contract.proofVersion);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-arcanos-preview-fixture']).toBe('sealed-synthetic');
  });

  it.each(['{', 'x'.repeat(4097)])('rejects missing fixture authorization before parsing the body', async (body) => {
    const response = await request(application()).post(contract.createPath)
      .set(contract.selectorHeader, contract.selector).set('Content-Type', 'application/json')
      .send(body).expect(401);
    expect(response.body.ok).toBe(false);
  });

  it.each(['cookie', 'x-api-key', 'x-session-id', 'x-arcanos-admin'])('does not exempt other credential carriers: %s', async (header) => {
    await request(application()).get(contract.metadataPath).set(headers())
      .set(header, 'test-forbidden-value').expect(404);
  });

  it('rejects wrong, duplicated, and misrouted fixture credentials', async () => {
    const app = application();
    await request(app).get(contract.metadataPath).set(contract.selectorHeader, contract.selector)
      .set('authorization', 'Bearer test-wrong-fixture').expect(404);
    await request(app).get(contract.metadataPath).set(headers())
      .set('authorization', [contract.bearer, contract.bearer]).expect(404);
    await request(app).get('/readyz').set(headers()).expect(404);
    await request(app).get(`${contract.metadataPath}?extra=1`).set(headers()).expect(404);
    await request(app).post(contract.createPath).set('authorization', contract.bearer)
      .send({ task: contract.fixtures.aiTask }).expect(404);
  });

  it('keeps body, media, and idempotency header restrictions at the HTTP boundary', async () => {
    const app = application();
    await request(app).post(contract.createPath).set(headers())
      .set('Content-Type', 'application/json').send('x'.repeat(4097)).expect(404);
    await request(app).post(contract.createPath).set(headers())
      .set('Content-Type', 'text/plain').send('{}').expect(404);
    await request(app).post(contract.runPath).set(headers())
      .set('Idempotency-Key', 'test-not-a-uuid').send({ action: 'tests.run', payload: {} }).expect(404);
    await request(app).get(contract.listPath).set(headers())
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111').expect(404);
  });

  it('passes the actual frozen request bytes to confirmation and consumes the retry once', async () => {
    const app = application();
    const key = '11111111-1111-4111-8111-111111111111';
    const original = '{"action":"tests.run", "payload":{"profile":"typescript-unit"}}';
    const submit = (body: string) => request(app).post(contract.runPath).set(headers())
      .set('Idempotency-Key', key).set('Content-Type', 'application/json').send(body);
    const challenge = await submit(original).expect(403);
    const token = challenge.body.confirmationChallenge.id as string;
    const retry = `${original.slice(0, -1)},"confirmation_token":${JSON.stringify(token)}}`;
    const accepted = await submit(retry).expect(200);
    expect(accepted.body.result.accepted).toBe(true);
    await submit(retry).expect(403);
    const result = await request(app).post(contract.resultPath).set(headers())
      .send({ jobId: accepted.body.result.jobId }).expect(200);
    expect(result.body.status).toBe('completed');
    expect(result.body.result.output.status).toBe('passed');
  });
});
