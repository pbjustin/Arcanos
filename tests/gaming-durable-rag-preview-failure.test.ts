import { jest } from '@jest/globals';
import request from 'supertest';

const actualChunks = await import('../src/services/gamingDurableDocumentChunks.js');
const actualEvidence = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const mockChunks = jest.fn(actualChunks.chunkGamingDocument);
const mockSelect = jest.fn(actualEvidence.selectStoredGamingEvidence);
jest.unstable_mockModule('../src/services/gamingDurableDocumentChunks.js', () => ({
  ...actualChunks, chunkGamingDocument: mockChunks
}));
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({
  ...actualEvidence, selectStoredGamingEvidence: mockSelect
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } =
  await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } =
  await import('../src/nativePrPreviewContract.js');

async function queryGuide() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({
    identity: { prNumber: 1487, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true })
  });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;
  readinessState.ready = true;
  return request(app).post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath).send({
    action: 'query', payload: {
      mode: 'guide', game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
      prompt: NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures.guide
    }
  });
}

describe('served Gaming durable RAG proof boundary', () => {
  beforeEach(() => {
    mockChunks.mockReset().mockImplementation(actualChunks.chunkGamingDocument);
    mockSelect.mockReset().mockImplementation(actualEvidence.selectStoredGamingEvidence);
  });

  it('adds the durable proof only after the real fixture succeeds and preserves the existing guide body', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of [
      [NATIVE_PR_PREVIEW_GAMING_CONTRACT.proofHeader, NATIVE_PR_PREVIEW_GAMING_CONTRACT.proofVersion],
      [NATIVE_PR_PREVIEW_GAMING_CONTRACT.responseProofHeader, NATIVE_PR_PREVIEW_GAMING_CONTRACT.responseProofVersion],
      [NATIVE_PR_PREVIEW_GAMING_CONTRACT.documentProofHeader, NATIVE_PR_PREVIEW_GAMING_CONTRACT.documentProofVersion],
      [NATIVE_PR_PREVIEW_GAMING_CONTRACT.durableRagProofHeader, NATIVE_PR_PREVIEW_GAMING_CONTRACT.durableRagProofVersion]
    ]) expect(response.headers[header]).toBe(version);
    expect(response.body.result).toEqual({
      ok: true, route: 'gaming', mode: 'guide', data: { response: 'Sealed preview guide response.', sources: [] }
    });
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(mockChunks).toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalled();
    expect(response.text).not.toContain('Clockwork Observatory');
  });

  it.each(['chunk coverage drift', 'retrieval drift', 'unexpected core failure'])('withholds every Gaming proof header after %s', async (scenario) => {
    if (scenario === 'chunk coverage drift') {
      mockChunks.mockImplementationOnce(async (...args) => ({ ...await actualChunks.chunkGamingDocument(...args), chunks: [] }));
    } else if (scenario === 'retrieval drift') {
      mockSelect.mockReturnValueOnce([]);
    } else {
      mockChunks.mockRejectedValueOnce(new Error('private-fixture-sentinel'));
    }
    const response = await queryGuide();
    expect(response.status).toBe(500);
    for (const header of [
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.proofHeader,
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.responseProofHeader,
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.documentProofHeader,
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.durableRagProofHeader
    ]) expect(response.headers[header]).toBeUndefined();
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_DURABLE_RAG_CONTRACT_INVALID' });
    expect(response.text).not.toContain('Sealed preview guide response.');
    expect(response.text).not.toContain('private-fixture-sentinel');
    expect(mockChunks).toHaveBeenCalled();
  });
});
