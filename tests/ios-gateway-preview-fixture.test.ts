import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

import {
  createIosGatewayPreviewFixture,
  IOS_GATEWAY_PREVIEW_CONTRACT as contract,
  isIosGatewayPreviewAdmission,
  type IosGatewayPreviewRequest,
} from '../src/shared/ios/iosGatewayPreviewFixture.js';

const identity = { prNumber: 1495, sourceCommit: 'b'.repeat(40) };
const snapshot = JSON.parse(readFileSync(new URL('../clients/ios/scripts/gateway-contract.generated.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addFormat('uuid', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  && Number.isFinite(Date.parse(value)));
const validators = Object.fromEntries(Object.keys(snapshot.schemas).map((name) => [name, ajv.compile({
  components: { schemas: snapshot.schemas }, $ref: `#/components/schemas/${name}`,
})]));

function assertContract(name: string, value: unknown) {
  const validate = validators[name];
  const valid = validate(value);
  expect(validate.errors).toBeNull();
  expect(valid).toBe(true);
}

function request(path: string, body?: Record<string, unknown>, idempotencyKey?: string): IosGatewayPreviewRequest {
  return { method: body === undefined ? 'GET' : 'POST', path,
    fixture: contract.selector, authorization: contract.bearer,
    body, rawBody: body === undefined ? undefined : JSON.stringify(body), idempotencyKey };
}

function aiBody(task = contract.fixtures.aiTask, idempotencyKey = 'synthetic-ai-request') {
  return { gptId: 'arcanos-core', task, maxOutputTokens: 1024, idempotencyKey };
}

function runBody(action = 'tests.run') {
  return { action, payload: action === 'tests.run' ? { profile: contract.fixtures.testProfile }
    : action === 'patch.preview' ? { patch: contract.fixtures.patch }
      : { patch: contract.fixtures.patch, expectedPatchSha256: contract.fixtures.patchSha256 } };
}

function approved(original: IosGatewayPreviewRequest, token: unknown): IosGatewayPreviewRequest {
  const rawBody = `${original.rawBody!.slice(0, -1)},"confirmation_token":${JSON.stringify(token)}}`;
  return { ...original, rawBody, body: JSON.parse(rawBody) };
}

describe('sealed iOS Gateway HTTP fixture peer', () => {
  it('publishes bounded synthetic metadata and all five source-derived operations', () => {
    const fixture = createIosGatewayPreviewFixture(identity);
    const metadata = fixture.handle(request(contract.metadataPath));
    expect(metadata.payload).toEqual({ schemaVersion: 1, proofVersion: contract.proofVersion,
      synthetic: true, ...identity, contractSource: contract.contractSource,
      fixtures: contract.fixtures, protectedEffectsEnabled: false });
    expect(JSON.stringify(metadata.payload).length).toBeLessThan(4096);
    assertContract('CapabilitiesV1Response', fixture.handle(request(contract.listPath)).payload);
    assertContract('CapabilityV1DetailResponse', fixture.handle(request(contract.detailPath)).payload);
    expect(snapshot.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'post', path: contract.createPath }),
      expect.objectContaining({ method: 'post', path: contract.resultPath }),
      expect.objectContaining({ method: 'get', path: contract.listPath }),
      expect.objectContaining({ method: 'get', path: '/gpt-access/capabilities/v1/{id}' }),
      expect.objectContaining({ method: 'post', path: '/gpt-access/capabilities/v1/{id}/run' }),
    ]));
  });

  it('denies unknown route/method/selector/bearer and requires synthetic authentication before body parsing', () => {
    const fixture = createIosGatewayPreviewFixture(identity);
    const baseline = request(contract.createPath, aiBody());
    for (const change of [{ method: 'DELETE' }, { path: '/gpt-access/openapi.json' },
      { path: `${contract.createPath}?query=1` }, { fixture: undefined }, { authorization: 'Bearer test-wrong-synthetic-value' }]) {
      const input = { ...baseline, ...change };
      expect(isIosGatewayPreviewAdmission(input)).toBe(false);
      expect(fixture.handle(input).statusCode).toBe(404);
    }
    const missingBearer = { ...baseline, authorization: undefined, rawBody: 'not-json' };
    expect(isIosGatewayPreviewAdmission(missingBearer)).toBe(true);
    const response = fixture.handle(missingBearer);
    expect(response.statusCode).toBe(401);
    assertContract('ErrorResponse', response.payload);
  });

  it('uses source-derived create/result DTOs for pending, complete, failed, and unavailable AI jobs', () => {
    const fixture = createIosGatewayPreviewFixture(identity);
    for (const task of [contract.fixtures.aiTask, contract.fixtures.failedTask]) {
      const body = aiBody(task, task);
      assertContract('CreateAiJobRequest', body);
      const receipt = fixture.handle(request(contract.createPath, body));
      expect(receipt.statusCode).toBe(202);
      assertContract('CreateAiJobResponse', receipt.payload);
      const lookup = request(contract.resultPath, { jobId: receipt.payload.jobId, traceId: 'ios-preview' });
      assertContract('JobResultRequest', lookup.body);
      const pending = fixture.handle(lookup);
      assertContract('JobResultResponse', pending.payload);
      expect(pending.payload.status).toBe('pending');
      const completed = fixture.handle(lookup);
      assertContract('JobResultResponse', completed.payload);
      expect(completed.payload.status).toBe(task === contract.fixtures.aiTask ? 'completed' : 'failed');
      if (task === contract.fixtures.aiTask) expect(completed.payload.result).toEqual({ ok: true, result: { result: contract.fixtures.aiAnswer } });
      else expect(completed.payload.result).toBeNull();
    }
    const unavailable = fixture.handle(request(contract.createPath, aiBody(contract.fixtures.unavailableTask)));
    expect(unavailable.statusCode).toBe(503);
    assertContract('ErrorResponse', unavailable.payload);
  });

  it('deduplicates same AI bytes, rejects conflicting keys, and never accepts arbitrary context/tasks', () => {
    const fixture = createIosGatewayPreviewFixture(identity);
    const input = request(contract.createPath, aiBody());
    const first = fixture.handle(input);
    const repeated = fixture.handle(input);
    expect(repeated.payload.jobId).toBe(first.payload.jobId);
    expect(repeated.payload.deduped).toBe(true);
    expect(fixture.handle(request(contract.createPath, aiBody(contract.fixtures.failedTask))).statusCode).toBe(409);
    for (const body of [{ ...aiBody(), context: 'private note' }, aiBody('arbitrary user request'), { ...aiBody(), maxOutputTokens: 5000 }]) {
      expect(fixture.handle(request(contract.createPath, body)).statusCode).toBe(400);
    }
    expect(fixture.handle({ ...input, rawBody: '{"task":"mismatch"}' }).statusCode).toBe(400);
  });

  it.each(['tests.run', 'patch.apply'])('binds %s approval to exact original bytes and permits one retry only', (action) => {
    const fixture = createIosGatewayPreviewFixture(identity);
    const original = request(contract.runPath, runBody(action), 'synthetic-capability-key');
    assertContract('CapabilityRunRequest', original.body);
    const challenge = fixture.handle(original);
    expect(challenge.statusCode).toBe(403);
    assertContract('ConfirmationRequiredResponse', challenge.payload);
    const token = (challenge.payload.confirmationChallenge as { id: string }).id;
    const retry = approved(original, token);
    assertContract('CapabilityRunRequest', retry.body);
    const accepted = fixture.handle(retry);
    expect(accepted.statusCode).toBe(200);
    assertContract('CapabilityRunResponse', accepted.payload);
    const receipt = accepted.payload.result as { jobId: string };
    const completed = fixture.handle(request(contract.resultPath, { jobId: receipt.jobId }));
    assertContract('JobResultResponse', completed.payload);
    expect(completed.payload.status).toBe('completed');
    expect(fixture.handle(retry).statusCode).toBe(403);
  });

  it('rejects semantic or byte changes, changed idempotency, and arbitrary patches/actions', () => {
    for (const mutation of ['bytes', 'key']) {
      const fixture = createIosGatewayPreviewFixture(identity);
      const original = request(contract.runPath, runBody(), 'synthetic-capability-key');
      const challenge = fixture.handle(original).payload.confirmationChallenge as { id: string };
      const retry = approved(original, challenge.id);
      const modified = mutation === 'bytes' ? { ...retry, rawBody: retry.rawBody!.replace('{', '{ ') }
        : { ...retry, idempotencyKey: 'different-key' };
      expect(fixture.handle(modified).statusCode).toBe(403);
      expect(fixture.handle(retry).statusCode).toBe(403);
    }
    const fixture = createIosGatewayPreviewFixture(identity);
    for (const body of [{ action: 'shell', payload: {} }, { action: 'patch.preview', payload: { patch: 'arbitrary patch' } },
      { action: 'tests.run', payload: { profile: 'arbitrary profile' } }]) {
      expect(fixture.handle(request(contract.runPath, body, 'fixture-key')).statusCode).toBe(400);
    }
  });

  it('returns repeatable completed fixed patch previews for the client race proof', () => {
    const fixture = createIosGatewayPreviewFixture(identity);
    const receipt = fixture.handle(request(contract.runPath, runBody('patch.preview'), 'preview-key'));
    expect(receipt.statusCode).toBe(200);
    const jobId = (receipt.payload.result as { jobId: string }).jobId;
    const lookup = request(contract.resultPath, { jobId });
    const first = fixture.handle(lookup);
    expect(first.payload.status).toBe('completed');
    expect(fixture.handle(lookup)).toEqual(first);
    expect(first.payload.result).toMatchObject({ outcome: 'succeeded', output: { applicable: true, patchSha256: contract.fixtures.patchSha256 } });
  });

  it('bounds retained jobs/challenges and expires both without timers or effects', () => {
    let now = 1_800_000_000_000;
    const fixture = createIosGatewayPreviewFixture(identity, { now: () => now });
    let firstJob: unknown;
    let firstChallenge: unknown;
    for (let index = 0; index < 64; index++) {
      const receipt = fixture.handle(request(contract.createPath, aiBody(contract.fixtures.aiTask, `key-${index}`)));
      expect(receipt.statusCode).toBe(202);
      firstJob ??= receipt.payload.jobId;
      const challenge = fixture.handle(request(contract.runPath, runBody(), `key-${index}`));
      expect(challenge.statusCode).toBe(403);
      firstChallenge ??= (challenge.payload.confirmationChallenge as { id: string }).id;
    }
    expect(fixture.handle(request(contract.createPath, aiBody(contract.fixtures.aiTask, 'overflow'))).statusCode).toBe(429);
    expect(fixture.handle(request(contract.runPath, runBody(), 'overflow')).statusCode).toBe(429);
    now += 120_000;
    const missing = fixture.handle(request(contract.resultPath, { jobId: firstJob }));
    expect(missing.payload.status).toBe('not_found');
    assertContract('JobResultResponse', missing.payload);
    expect(fixture.handle(approved(request(contract.runPath, runBody(), 'key-0'), firstChallenge)).statusCode).toBe(403);
    expect(fixture.handle(request(contract.createPath, aiBody(contract.fixtures.aiTask, 'after-expiry'))).statusCode).toBe(202);
  });
});
