import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actualFixture = await import('../src/shared/memory/sessionContextPreviewFixture.js');
const assertSessionFixture = jest.fn(actualFixture.assertSessionContextPreviewFixture);
const runSessionContract = jest.fn(actualFixture.runSessionContextPreviewContract);
jest.unstable_mockModule('../src/shared/memory/sessionContextPreviewFixture.js', () => ({
  ...actualFixture,
  assertSessionContextPreviewFixture: assertSessionFixture,
  runSessionContextPreviewContract: runSessionContract,
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } =
  await import('../src/nativePrPreviewApplication.js');
const {
  NATIVE_PR_PREVIEW_SESSION_CONTEXT_CONTRACT: contract,
  NATIVE_PR_PREVIEW_GENERATIVE_MODEL_POLICY_CONTRACT,
  NATIVE_PR_PREVIEW_IOS_DEVICE_CONTRACT,
  NATIVE_PR_PREVIEW_DAG_METRICS_CONTRACT,
  NATIVE_PR_PREVIEW_DAG_TOKEN_ACCOUNTING_CONTRACT,
  NATIVE_PR_PREVIEW_MODE,
  NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER,
  NATIVE_PR_PREVIEW_TRUST_SCOPE,
} = await import('../src/nativePrPreviewContract.js');

const identity = { prNumber: 1519, sourceCommit: 'c'.repeat(40) };
const readinessContracts = [
  contract, NATIVE_PR_PREVIEW_GENERATIVE_MODEL_POLICY_CONTRACT,
  NATIVE_PR_PREVIEW_IOS_DEVICE_CONTRACT, NATIVE_PR_PREVIEW_DAG_METRICS_CONTRACT,
  NATIVE_PR_PREVIEW_DAG_TOKEN_ACCOUNTING_CONTRACT,
];
const proof = {
  ok: true,
  scope: 'sealed-component',
  proofVersion: 'session-scope-contract/v1',
  payloadForwarding: true,
  scopePrecedence: true,
  scopeNonInference: true,
  escapedUserHistory: true,
  currentPromptPreserved: true,
  originalPayloadUnchanged: true,
  requestContextIsolated: true,
  runtimeBoundaries: {
    authentication: false, persistence: false, gatewayProducer: false,
    workerExecution: false, provider: false,
  },
};

function buildApplication(ready = true) {
  const readinessState = createNativePrPreviewReadinessState();
  Object.assign(readinessState, { ready, applicationImported: ready, fixturesSealed: ready });
  const app = createNativePrPreviewApplication({
    identity, readinessState,
    notionConnectivityProbe: async () => {
      throw new Error('The session component fixture must not contact a Notion provider.');
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

function expectNoProofMarkers(headers: Record<string, unknown>) {
  expect(headers[contract.contractProofHeader]).toBeUndefined();
  for (const entry of readinessContracts) expect(headers[entry.proofHeader]).toBeUndefined();
}

describe('served sealed session scope contract boundary', () => {
  beforeEach(() => {
    assertSessionFixture.mockReset().mockImplementation(actualFixture.assertSessionContextPreviewFixture);
    runSessionContract.mockReset().mockImplementation(actualFixture.runSessionContextPreviewContract);
  });

  it('serves exact bounded component evidence and identity after real fixture assertions', async () => {
    const { app } = buildApplication();
    const response = await request(app).get(contract.contractPath);
    expect(response.status).toBe(200);
    expect(response.headers[contract.contractProofHeader]).toBe(contract.contractProofVersion);
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(contract.maxResponseBytes);
    expect(response.body).toEqual({ ...proof, ...identity });
    expect(runSessionContract).toHaveBeenCalledTimes(1);
    expect(assertSessionFixture).not.toHaveBeenCalled();
  });

  it.each(['POST', 'HEAD', 'OPTIONS'] as const)('denies %s before invoking either session fixture', async method => {
    const { app } = buildApplication();
    const response = await (method === 'POST' ? request(app).post(contract.contractPath).send({})
      : method === 'HEAD' ? request(app).head(contract.contractPath) : request(app).options(contract.contractPath));
    expect(response.status).toBe(404);
    expectNoProofMarkers(response.headers);
    expect(runSessionContract).not.toHaveBeenCalled();
    expect(assertSessionFixture).not.toHaveBeenCalled();
  });

  it.each(['?sessionId=synthetic-denied', '/extra', '%3f'])('denies noncanonical suffix %j before fixture execution', async suffix => {
    const { app } = buildApplication();
    const response = await request(app).get(`${contract.contractPath}${suffix}`);
    expect(response.status).toBe(404);
    expectNoProofMarkers(response.headers);
    expect(runSessionContract).not.toHaveBeenCalled();
    expect(assertSessionFixture).not.toHaveBeenCalled();
  });

  it('denies a GET body before fixture execution', async () => {
    const { app } = buildApplication();
    const response = await request(app).get(contract.contractPath)
      .set('Content-Type', 'application/json').send({ sessionId: 'synthetic-denied' });
    expect(response.status).toBe(404);
    expectNoProofMarkers(response.headers);
    expect(runSessionContract).not.toHaveBeenCalled();
    expect(assertSessionFixture).not.toHaveBeenCalled();
  });

  it.each(['Authorization', 'X-API-Key', 'Cookie', 'X-Arcanos-Memory-Token', 'Mcp-Session-Id'])
    ('denies credential or transport-session carrier %s before fixture execution', async header => {
      const { app } = buildApplication();
      const response = await request(app).get(contract.contractPath).set(header, 'synthetic-denied-carrier');
      expect(response.status).toBe(404);
      expectNoProofMarkers(response.headers);
      expect(runSessionContract).not.toHaveBeenCalled();
      expect(assertSessionFixture).not.toHaveBeenCalled();
    });

  it('requires both session markers for GET and HEAD readiness without changing the trusted body', async () => {
    const { app } = buildApplication();
    const response = await request(app).get('/readyz');
    const head = await request(app).head('/readyz');
    expect(response.status).toBe(200);
    expect(head.status).toBe(200);
    expect(response.body).toEqual(readinessBody(true));
    expect(head.text).toBeUndefined();
    expect(response.headers['cache-control']).toContain('no-store');
    expect(head.headers['cache-control']).toContain('no-store');
    for (const entry of readinessContracts) {
      expect(response.headers[entry.proofHeader]).toBe(entry.proofVersion);
      expect(head.headers[entry.proofHeader]).toBe(entry.proofVersion);
    }
    expect(response.headers[contract.contractProofHeader]).toBe(contract.contractProofVersion);
    expect(head.headers[contract.contractProofHeader]).toBe(contract.contractProofVersion);
    expect(assertSessionFixture).toHaveBeenCalledTimes(2);
    expect(runSessionContract).not.toHaveBeenCalled();
  });

  it.each(['ready', 'applicationImported', 'fixturesSealed', 'draining'] as const)
    ('keeps endpoint and readiness closed when %s prevents admission', async field => {
      const { app, readinessState } = buildApplication();
      readinessState[field] = field === 'draining';
      const response = await request(app).get(contract.contractPath);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ ok: false, error: 'SESSION_CONTEXT_PREVIEW_UNAVAILABLE' });
      expect(response.headers['cache-control']).toContain('no-store');
      expectNoProofMarkers(response.headers);
      for (const method of ['get', 'head'] as const) {
        const readiness = await request(app)[method]('/readyz');
        expect(readiness.status).toBe(503);
        expectNoProofMarkers(readiness.headers);
        if (method === 'get') expect(readiness.body.ready).toBe(false);
      }
      expect(runSessionContract).not.toHaveBeenCalled();
      expect(assertSessionFixture).not.toHaveBeenCalled();
    });

  it.each(['throw', 'reject'])('withholds endpoint proof after a fixture %s and sanitizes the error', async failureMode => {
    const privateDetail = 'synthetic-private-session-fixture-detail';
    runSessionContract.mockImplementation(() => {
      const error = new Error(privateDetail);
      if (failureMode === 'reject') return Promise.reject(error);
      throw error;
    });
    const { app } = buildApplication();
    const failed = await request(app).get(contract.contractPath);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ ok: false, error: 'SESSION_CONTEXT_PREVIEW_FIXTURE_FAILED' });
    expect(failed.headers['cache-control']).toContain('no-store');
    expectNoProofMarkers(failed.headers);
    expect(failed.text).not.toContain(privateDetail);
    expect(failed.text).not.toContain('runtimeBoundaries');
    runSessionContract.mockImplementation(actualFixture.runSessionContextPreviewContract);
    const recovered = await request(app).get(contract.contractPath);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual({ ...proof, ...identity });
    expect(recovered.headers[contract.contractProofHeader]).toBe(contract.contractProofVersion);
  });

  it.each(['throw', 'reject'])('withholds every readiness marker after a fixture %s and recovers', async failureMode => {
    const privateDetail = 'synthetic-private-readiness-fixture-detail';
    assertSessionFixture.mockImplementation(() => {
      const error = new Error(privateDetail);
      if (failureMode === 'reject') return Promise.reject(error);
      throw error;
    });
    const { app } = buildApplication();
    for (const method of ['get', 'head'] as const) {
      const failed = await request(app)[method]('/readyz');
      expect(failed.status).toBe(503);
      expect(failed.headers['cache-control']).toContain('no-store');
      expectNoProofMarkers(failed.headers);
      if (method === 'get') {
        expect(failed.body).toEqual(readinessBody(false));
        expect(failed.text).not.toContain(privateDetail);
      }
    }
    assertSessionFixture.mockImplementation(actualFixture.assertSessionContextPreviewFixture);
    const recovered = await request(app).get('/readyz');
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual(readinessBody(true));
    expect(recovered.headers[contract.contractProofHeader]).toBe(contract.contractProofVersion);
    expect(recovered.headers[contract.proofHeader]).toBe(contract.proofVersion);
  });

  it('awaits endpoint proof and withholds its result if draining begins during execution', async () => {
    const { app, readinessState } = buildApplication();
    let startFixture!: () => void;
    let releaseFixture!: () => void;
    const started = new Promise<void>(resolve => { startFixture = resolve; });
    const pending = new Promise<void>(resolve => { releaseFixture = resolve; });
    runSessionContract.mockImplementation(async () => {
      startFixture();
      await pending;
      return actualFixture.runSessionContextPreviewContract();
    });
    let completed = false;
    const responsePromise = request(app).get(contract.contractPath).timeout({ deadline: 5_000 }).then(response => {
      completed = true;
      return response;
    });
    try {
      await started;
      expect(completed).toBe(false);
      readinessState.draining = true;
      releaseFixture();
      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ ok: false, error: 'SESSION_CONTEXT_PREVIEW_UNAVAILABLE' });
      expectNoProofMarkers(response.headers);
      expect(response.text).not.toContain('runtimeBoundaries');
    } finally {
      releaseFixture();
      await responsePromise;
    }
  });

  it.each(['get', 'head'] as const)('awaits proof and withholds all markers if draining begins during %s readiness', async method => {
    const { app, readinessState } = buildApplication();
    let startFixture!: () => void;
    let releaseFixture!: () => void;
    const started = new Promise<void>(resolve => { startFixture = resolve; });
    const pending = new Promise<void>(resolve => { releaseFixture = resolve; });
    assertSessionFixture.mockImplementation(async () => { startFixture(); await pending; });
    let completed = false;
    const responsePromise = request(app)[method]('/readyz').timeout({ deadline: 5_000 }).then(response => {
      completed = true;
      return response;
    });
    try {
      await started;
      expect(completed).toBe(false);
      readinessState.draining = true;
      releaseFixture();
      const response = await responsePromise;
      expect(response.status).toBe(503);
      expectNoProofMarkers(response.headers);
      if (method === 'get') expect(response.body).toEqual(readinessBody(false));
    } finally {
      releaseFixture();
      await responsePromise;
    }
  });
});
