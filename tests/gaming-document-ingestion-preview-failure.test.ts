import { jest } from '@jest/globals';
import request from 'supertest';

const actualProjection = await import('../src/shared/gaming/gamingDocumentProjectionCore.js');
const actualIngestion = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const actualChunks = await import('../src/services/gamingDocumentChunks.js');
const mockProjection = jest.fn(actualProjection.projectGamingDocumentText);
const mockAdmission = jest.fn(actualIngestion.selectGamingSourceAdmissionUrl);
const mockExcerpt = jest.fn(actualChunks.selectGamingDocumentExcerpt);
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentProjectionCore.js', () => ({
  ...actualProjection, projectGamingDocumentText: mockProjection
}));
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentIngestionCore.js', () => ({
  ...actualIngestion, selectGamingSourceAdmissionUrl: mockAdmission
}));
jest.unstable_mockModule('../src/services/gamingDocumentChunks.js', () => ({
  ...actualChunks, selectGamingDocumentExcerpt: mockExcerpt
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } =
  await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } =
  await import('../src/nativePrPreviewContract.js');

describe('served Gaming document component-proof failure boundary', () => {
  beforeEach(() => {
    mockProjection.mockReset().mockImplementation(actualProjection.projectGamingDocumentText);
    mockAdmission.mockReset().mockImplementation(actualIngestion.selectGamingSourceAdmissionUrl);
    mockExcerpt.mockReset().mockImplementation(actualChunks.selectGamingDocumentExcerpt);
  });

  it.each(['projection drift', 'excerpt drift', 'page identity drift', 'unexpected failure'])('withholds all Gaming proof headers after %s', async (scenario) => {
    if (scenario === 'projection drift') {
      mockProjection.mockImplementation((input) => ({
        ...actualProjection.projectGamingDocumentText(input), text: input.acquiredText.slice(0, 24_000)
      }));
    } else if (scenario === 'excerpt drift') {
      mockExcerpt.mockImplementation((text, _query, maxChars) => text.slice(0, maxChars));
    } else if (scenario === 'page identity drift') {
      mockAdmission.mockImplementation((_url, description) => description.publicUrl);
    } else {
      mockProjection.mockImplementation(() => { throw new Error('private-fixture-sentinel'); });
    }
    const readinessState = createNativePrPreviewReadinessState();
    const app = createNativePrPreviewApplication({
      identity: { prNumber: 1486, sourceCommit: 'a'.repeat(40) },
      readinessState,
      notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true })
    });
    readinessState.applicationImported = true;
    readinessState.fixturesSealed = true;
    readinessState.ready = true;
    const response = await request(app)
      .post(NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath)
      .send({
        action: 'query',
        payload: {
          mode: 'guide', game: NATIVE_PR_PREVIEW_GAMING_CONTRACT.game,
          prompt: NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures.guide
        }
      });

    expect(response.status).toBe(500);
    for (const header of [
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.proofHeader,
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.responseProofHeader,
      NATIVE_PR_PREVIEW_GAMING_CONTRACT.documentProofHeader
    ]) expect(response.headers[header]).toBeUndefined();
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_DOCUMENT_INGESTION_CONTRACT_INVALID' });
    expect(response.text).not.toContain('Sealed preview guide response.');
    expect(response.text).not.toContain('private-fixture-sentinel');
    expect(mockProjection).toHaveBeenCalled();
  });
});
