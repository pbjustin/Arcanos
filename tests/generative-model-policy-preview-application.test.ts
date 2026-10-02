import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actualFixture = await import('../src/shared/gpt/generativeModelPolicyPreviewFixture.js');
const assertModelPolicyFixture = jest.fn(actualFixture.assertGenerativeModelPolicyPreviewFixture);
jest.unstable_mockModule('../src/shared/gpt/generativeModelPolicyPreviewFixture.js', () => ({
  ...actualFixture,
  assertGenerativeModelPolicyPreviewFixture: assertModelPolicyFixture,
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } =
  await import('../src/nativePrPreviewApplication.js');
const {
  NATIVE_PR_PREVIEW_GENERATIVE_MODEL_POLICY_CONTRACT: contract,
  NATIVE_PR_PREVIEW_IOS_DEVICE_CONTRACT,
  NATIVE_PR_PREVIEW_DAG_METRICS_CONTRACT,
  NATIVE_PR_PREVIEW_DAG_TOKEN_ACCOUNTING_CONTRACT,
  NATIVE_PR_PREVIEW_SESSION_CONTEXT_CONTRACT,
  NATIVE_PR_PREVIEW_MODE,
  NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER,
  NATIVE_PR_PREVIEW_TRUST_SCOPE,
} = await import('../src/nativePrPreviewContract.js');

const identity = { prNumber: 1518, sourceCommit: 'c'.repeat(40) };
const readinessContracts = [
  contract, NATIVE_PR_PREVIEW_IOS_DEVICE_CONTRACT, NATIVE_PR_PREVIEW_DAG_METRICS_CONTRACT,
  NATIVE_PR_PREVIEW_DAG_TOKEN_ACCOUNTING_CONTRACT, NATIVE_PR_PREVIEW_SESSION_CONTEXT_CONTRACT,
];

function buildApplication(ready = true) {
  const readinessState = createNativePrPreviewReadinessState();
  Object.assign(readinessState, { ready, applicationImported: ready, fixturesSealed: ready });
  const app = createNativePrPreviewApplication({
    identity, readinessState,
    notionConnectivityProbe: async () => {
      throw new Error('The model-policy fixture must not contact a Notion provider.');
    },
  });
  return { app, readinessState };
}

function readinessBody(ready: boolean) {
  return {
    applicationImported: true,
    fixturesSealed: true,
    mode: NATIVE_PR_PREVIEW_MODE,
    prNumber: identity.prNumber,
    processKind: 'web',
    protectedEffectsEnabled: false,
    protectsMaliciousPr: false,
    ready,
    requiresPlatformSecretIsolationForUntrustedCode: true,
    sourceCommit: identity.sourceCommit,
    trustScope: NATIVE_PR_PREVIEW_TRUST_SCOPE,
  };
}

describe('served shared generative-model policy proof boundary', () => {
  beforeEach(() => {
    assertModelPolicyFixture.mockReset().mockImplementation(actualFixture.assertGenerativeModelPolicyPreviewFixture);
  });

  it('serves the production pure-core role, authority and reply-identity proof as bounded synthetic evidence', async () => {
    const { app } = buildApplication();
    const response = await request(app).get(contract.path);
    expect(response.status).toBe(200);
    expect(response.headers[contract.proofHeader]).toBe(contract.proofVersion);
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(contract.maxResponseBytes);
    expect(response.body).toEqual({
      proofVersion: 'shared-generative-model-policy/v1',
      synthetic: true,
      roleModels: {
        intake: 'gpt-6-luna', reasoning: 'gpt-6.1-sol', final: 'ft:synthetic:preview-authority',
        'final-escalation': 'ft:synthetic:preview-authority', audit: 'gpt-6-luna', 'audit-escalation': 'gpt-6.1-sol',
      },
      checks: {
        roleResolution: 6, matchingOverrides: 6, helperRolesWithoutAuthority: 4,
        unavailableAuthority: 10, overrideConflict: 18,
        acceptedReplyIdentity: 5, rejectedReplyIdentity: 11, deniedSyntheticTransportCalls: 0,
      },
      ...identity,
    });
    expect(assertModelPolicyFixture).toHaveBeenCalledTimes(1);
  });

  it.each(['POST', 'HEAD', 'OPTIONS'] as const)('denies %s before invoking the model-policy fixture', async method => {
    const { app } = buildApplication();
    const response = await (method === 'POST' ? request(app).post(contract.path).send({})
      : method === 'HEAD' ? request(app).head(contract.path) : request(app).options(contract.path));
    expect(response.status).toBe(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(assertModelPolicyFixture).not.toHaveBeenCalled();
  });

  it.each(['?model=gpt-6.1-sol', '/extra', '%3f'])('denies a noncanonical route suffix %j before fixture execution', async suffix => {
    const { app } = buildApplication();
    const response = await request(app).get(`${contract.path}${suffix}`);
    expect(response.status).toBe(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(assertModelPolicyFixture).not.toHaveBeenCalled();
  });

  it('denies a GET body before the model-policy fixture', async () => {
    const { app } = buildApplication();
    const response = await request(app).get(contract.path).set('Content-Type', 'application/json').send({ model: 'gpt-6.1-sol' });
    expect(response.status).toBe(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(assertModelPolicyFixture).not.toHaveBeenCalled();
  });

  it.each(['Authorization', 'X-API-Key', 'Cookie'])('denies the credential carrier %s before fixture execution', async header => {
    const { app } = buildApplication();
    const response = await request(app).get(contract.path).set(header, 'synthetic-denied-carrier');
    expect(response.status).toBe(404);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(assertModelPolicyFixture).not.toHaveBeenCalled();
  });

  it('requires the model proof for GET and HEAD readiness without changing the trusted body', async () => {
    const { app } = buildApplication();
    const response = await request(app).get('/readyz');
    const head = await request(app).head('/readyz');
    expect(response.status).toBe(200);
    expect(head.status).toBe(200);
    expect(response.body).toEqual(readinessBody(true));
    expect(head.text).toBeUndefined();
    for (const proof of readinessContracts) {
      expect(response.headers[proof.proofHeader]).toBe(proof.proofVersion);
      expect(head.headers[proof.proofHeader]).toBe(proof.proofVersion);
    }
    expect(assertModelPolicyFixture).toHaveBeenCalledTimes(2);
  });

  it('skips model proof and all readiness markers while startup is incomplete or draining', async () => {
    const { app, readinessState } = buildApplication(false);
    for (const draining of [false, true]) {
      if (draining) Object.assign(readinessState, { ready: true, applicationImported: true, fixturesSealed: true, draining });
      const response = await request(app).get('/readyz');
      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
      for (const proof of readinessContracts) expect(response.headers[proof.proofHeader]).toBeUndefined();
    }
    expect(assertModelPolicyFixture).not.toHaveBeenCalled();
  });

  it('withholds the success body and model marker when the fixture fails without disclosing details', async () => {
    assertModelPolicyFixture.mockImplementation(() => { throw new Error('private-model-policy-failure-sentinel'); });
    const { app } = buildApplication();
    const response = await request(app).get(contract.path);
    expect(response.status).toBe(500);
    expect(response.headers[contract.proofHeader]).toBeUndefined();
    expect(response.body).toEqual({ ok: false, error: 'GENERATIVE_MODEL_POLICY_PREVIEW_FIXTURE_FAILED' });
    expect(response.text).not.toContain('private-model-policy-failure-sentinel');
    expect(response.text).not.toContain('roleModels');
    expect(response.text).not.toContain('preview-authority');
  });

  it('withholds every readiness proof after a model-fixture failure and recovers with the same trusted body', async () => {
    const { app } = buildApplication();
    assertModelPolicyFixture.mockImplementation(() => { throw new Error('private-model-policy-failure-sentinel'); });
    const failed = await request(app).get('/readyz');
    const failedHead = await request(app).head('/readyz');
    expect(failed.status).toBe(503);
    expect(failedHead.status).toBe(503);
    expect(failed.body).toEqual(readinessBody(false));
    for (const proof of readinessContracts) {
      expect(failed.headers[proof.proofHeader]).toBeUndefined();
      expect(failedHead.headers[proof.proofHeader]).toBeUndefined();
    }
    expect(failed.text).not.toContain('private-model-policy-failure-sentinel');
    assertModelPolicyFixture.mockImplementation(actualFixture.assertGenerativeModelPolicyPreviewFixture);
    const recovered = await request(app).get('/readyz');
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual(readinessBody(true));
    expect(recovered.headers[contract.proofHeader]).toBe(contract.proofVersion);
  });
});
