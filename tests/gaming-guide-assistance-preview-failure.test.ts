import { jest } from '@jest/globals';
import request from 'supertest';

const actualIntake = await import('../src/shared/gaming/gamingGuideIntakeCore.js');
const mockIntake = jest.fn(actualIntake.buildGamingGuideIntakeContract);
jest.unstable_mockModule('../src/shared/gaming/gamingGuideIntakeCore.js', () => ({ ...actualIntake, buildGamingGuideIntakeContract: mockIntake }));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } = await import('../src/nativePrPreviewContract.js');

async function queryGuide() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1488, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;
  readinessState.ready = true;
  return request(app).post(contract.queryPath).send({ action: 'query', payload: { mode: 'guide', game: contract.game, prompt: contract.fixtures.guide } });
}

describe('served Gaming assistance production-core proof failure boundary', () => {
  beforeEach(() => mockIntake.mockReset().mockImplementation(actualIntake.buildGamingGuideIntakeContract));

  it('adds all five proof markers only after the actual fixed component assertions pass', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of [[contract.proofHeader, contract.proofVersion], [contract.responseProofHeader, contract.responseProofVersion],
      [contract.documentProofHeader, contract.documentProofVersion], [contract.durableRagProofHeader, contract.durableRagProofVersion],
      [contract.guideAssistanceProofHeader, contract.guideAssistanceProofVersion]]) expect(response.headers[header]).toBe(version);
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide', data: { response: 'Sealed preview guide response.', sources: [] } });
    expect(mockIntake).toHaveBeenCalled();
    expect(response.text).not.toContain('Copper Canal');
  });

  it.each(['allocation drift', 'unexpected failure'])('withholds all five Gaming markers after %s', async scenario => {
    mockIntake.mockImplementation(model => {
      if (scenario === 'unexpected failure') throw new Error('private-preview-sentinel');
      return { ...actualIntake.buildGamingGuideIntakeContract(model), outputAllocation: 501 as 500 };
    });
    const response = await queryGuide();
    expect(response.status).toBe(500);
    for (const header of [contract.proofHeader, contract.responseProofHeader, contract.documentProofHeader, contract.durableRagProofHeader, contract.guideAssistanceProofHeader]) expect(response.headers[header]).toBeUndefined();
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_GUIDE_RESPONSE_CONTRACT_INVALID' });
    expect(response.text).not.toContain('private-preview-sentinel');
  });
});
