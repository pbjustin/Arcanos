import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actual = await import('../src/shared/gaming/gamingSourceAcquisitionPreviewFixture.js');
const fixture = jest.fn(actual.runGamingSourceAcquisitionPreview);
jest.unstable_mockModule('../src/shared/gaming/gamingSourceAcquisitionPreviewFixture.js', () => ({
  ...actual, runGamingSourceAcquisitionPreview: fixture
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract } = await import('../src/nativePrPreviewContract.js');

async function queryGuide(mode = 'guide') {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1493, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  Object.assign(readinessState, { applicationImported: true, fixturesSealed: true, ready: true });
  return request(app).post(contract.queryPath).send({ action: 'query', payload: {
    mode, game: contract.game, prompt: mode === 'guide' ? contract.fixtures.guide : contract.fixtures.build
  } });
}

describe('served Gaming source acquisition proof boundary', () => {
  beforeEach(() => fixture.mockReset().mockImplementation(actual.runGamingSourceAcquisitionPreview));

  it('executes the fixed production-core proof and preserves the trusted response', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    expect(fixture).toHaveBeenCalledTimes(1);
    expect(response.headers[contract.sourceAcquisitionProofHeader]).toBe(contract.sourceAcquisitionProofVersion);
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] } });
  });

  it('withholds every Gaming proof and the success body when acquisition assertions fail', async () => {
    fixture.mockImplementation(() => { throw new Error('private-acquisition-preview-diagnostic'); });
    const response = await queryGuide();
    expect(response.status).toBe(500);
    for (const header of [contract.proofHeader, contract.responseProofHeader, contract.documentProofHeader,
      contract.durableRagProofHeader, contract.guideAssistanceProofHeader, contract.progressRecoveryProofHeader,
      contract.hybridKnowledgeProofHeader, contract.clearProofHeader, contract.sourceAcquisitionProofHeader]) {
      expect(response.headers[header]).toBeUndefined();
    }
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_SOURCE_ACQUISITION_CONTRACT_INVALID' });
    expect(response.text).not.toContain('private-acquisition-preview-diagnostic');
    expect(response.text).not.toContain('Sealed preview guide response.');
  });

  it('does not claim acquisition proof for the build selector', async () => {
    const response = await queryGuide('build');
    expect(response.status).toBe(200);
    expect(fixture).not.toHaveBeenCalled();
    expect(response.headers[contract.sourceAcquisitionProofHeader]).toBeUndefined();
  });
});
