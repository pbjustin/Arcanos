import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actual = await import('../src/shared/gaming/gamingStructuredEvidencePreviewFixture.js');
const fixture = jest.fn(actual.runGamingStructuredEvidencePreview);
jest.unstable_mockModule('../src/shared/gaming/gamingStructuredEvidencePreviewFixture.js', () => ({
  ...actual, runGamingStructuredEvidencePreview: fixture
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract } = await import('../src/nativePrPreviewContract.js');

async function query(mode: 'guide' | 'build' | 'meta' = 'guide') {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1494, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  Object.assign(readinessState, { applicationImported: true, fixturesSealed: true, ready: true });
  return request(app).post(contract.queryPath).send({ action: 'query', payload: {
    mode, game: contract.game, prompt: contract.fixtures[mode]
  } });
}

describe('served Gaming structured evidence proof boundary', () => {
  beforeEach(() => fixture.mockReset().mockImplementation(actual.runGamingStructuredEvidencePreview));

  it('runs actual structural component assertions before preserving the trusted response', async () => {
    const response = await query();
    expect(response.status).toBe(200);
    expect(fixture).toHaveBeenCalledTimes(1);
    expect(fixture).toHaveBeenCalledWith();
    expect(response.headers[contract.structuredEvidenceProofHeader]).toBe('gaming-structured-evidence/v1');
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] } });
  });

  it('withholds all Gaming proof headers and success data on an asynchronous fixture failure', async () => {
    fixture.mockRejectedValue(new Error('TEST-PRIVATE-STRUCTURE-DIAGNOSTIC'));
    const response = await query();
    expect(response.status).toBe(500);
    for (const [key, header] of Object.entries(contract)) {
      if (key === 'proofHeader' || key.endsWith('ProofHeader')) expect(response.headers[header as string]).toBeUndefined();
    }
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_STRUCTURED_EVIDENCE_CONTRACT_INVALID' });
    expect(response.text).not.toContain('TEST-PRIVATE-STRUCTURE-DIAGNOSTIC');
    expect(response.text).not.toContain('Sealed preview guide response.');
  });

  it.each(['build', 'meta'] as const)('does not claim structural proof for %s', async mode => {
    const response = await query(mode);
    expect(response.status).toBe(200);
    expect(fixture).not.toHaveBeenCalled();
    expect(response.headers[contract.structuredEvidenceProofHeader]).toBeUndefined();
  });
});
