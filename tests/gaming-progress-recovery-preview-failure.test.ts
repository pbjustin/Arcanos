import { jest } from '@jest/globals';
import request from 'supertest';

const actualRecovery = await import('../src/shared/gaming/gamingRecoveryResponse.js');
const mockRecovery = jest.fn(actualRecovery.buildGamingRecoveryResponse);
jest.unstable_mockModule('../src/shared/gaming/gamingRecoveryResponse.js', () => ({
  ...actualRecovery, buildGamingRecoveryResponse: mockRecovery
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } = await import('../src/nativePrPreviewContract.js');

async function queryGuide() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1490, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;
  readinessState.ready = true;
  return request(app).post(contract.queryPath).send({ action: 'query', payload: { mode: 'guide', game: contract.game, prompt: contract.fixtures.guide } });
}

describe('served Gaming progression and recovery proof boundary', () => {
  beforeEach(() => mockRecovery.mockReset().mockImplementation(actualRecovery.buildGamingRecoveryResponse));

  it('serves the unchanged body and all six markers after production-core assertions pass', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of [[contract.proofHeader, contract.proofVersion], [contract.responseProofHeader, contract.responseProofVersion],
      [contract.documentProofHeader, contract.documentProofVersion], [contract.durableRagProofHeader, contract.durableRagProofVersion],
      [contract.guideAssistanceProofHeader, contract.guideAssistanceProofVersion], [contract.progressRecoveryProofHeader, contract.progressRecoveryProofVersion]]) {
      expect(response.headers[header]).toBe(version);
    }
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide', data: { response: 'Sealed preview guide response.', sources: [] } });
    expect(mockRecovery).toHaveBeenCalled();
  });

  it.each(['recovery drift', 'unexpected failure'])('withholds all Gaming markers after %s', async scenario => {
    mockRecovery.mockImplementation(() => {
      if (scenario === 'unexpected failure') throw new Error('private-preview-sentinel');
      return 'Continue to the final boss. private-preview-sentinel';
    });
    const response = await queryGuide();
    expect(response.status).toBe(500);
    for (const header of [contract.proofHeader, contract.responseProofHeader, contract.documentProofHeader,
      contract.durableRagProofHeader, contract.guideAssistanceProofHeader, contract.progressRecoveryProofHeader]) {
      expect(response.headers[header]).toBeUndefined();
    }
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_GUIDE_RESPONSE_CONTRACT_INVALID' });
    expect(response.text).not.toContain('private-preview-sentinel');
  });
});
