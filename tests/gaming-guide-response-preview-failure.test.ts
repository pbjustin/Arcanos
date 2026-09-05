import { jest } from '@jest/globals';
import request from 'supertest';

const actualPrompt = await import('../src/shared/gaming/gamingPromptCore.js');
const actualResponse = await import('../src/shared/gaming/gamingGuideResponseCore.js');
const mockPrompt = jest.fn(actualPrompt.buildGamingPrompt);
const mockCompose = jest.fn(actualResponse.composeGroundedGamingGuideResponse);
jest.unstable_mockModule('../src/shared/gaming/gamingPromptCore.js', () => ({
  ...actualPrompt, buildGamingPrompt: mockPrompt
}));
jest.unstable_mockModule('../src/shared/gaming/gamingGuideResponseCore.js', () => ({
  ...actualResponse, composeGroundedGamingGuideResponse: mockCompose
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } =
  await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } =
  await import('../src/nativePrPreviewContract.js');

describe('served Gaming guide response component-proof failure boundary', () => {
  beforeEach(() => {
    mockPrompt.mockReset().mockImplementation(actualPrompt.buildGamingPrompt);
    mockCompose.mockReset().mockImplementation(actualResponse.composeGroundedGamingGuideResponse);
  });

  it.each(['trim regression', 'removed prompt instruction', 'unexpected failure'])('withholds both proof headers after %s', async (scenario) => {
    if (scenario === 'trim regression') {
      mockCompose.mockImplementation((mode, backendEnvelope) => {
        const result = actualResponse.composeGroundedGamingGuideResponse(mode, backendEnvelope);
        return result ? { ...result, data: { ...result.data, response: backendEnvelope.data.response } } : result;
      });
    } else if (scenario === 'removed prompt instruction') {
      mockPrompt.mockImplementation((...args) => actualPrompt.buildGamingPrompt(...args)
        .replace("Answer the user's actual gameplay question first, using the retrieved guide evidence as the primary basis.", ''));
    } else {
      mockPrompt.mockImplementation(() => { throw new Error('private-fixture-sentinel'); });
    }
    const readinessState = createNativePrPreviewReadinessState();
    const app = createNativePrPreviewApplication({
      identity: { prNumber: 1485, sourceCommit: 'a'.repeat(40) },
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
    expect(response.headers[NATIVE_PR_PREVIEW_GAMING_CONTRACT.proofHeader]).toBeUndefined();
    expect(response.headers[NATIVE_PR_PREVIEW_GAMING_CONTRACT.responseProofHeader]).toBeUndefined();
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_GUIDE_RESPONSE_CONTRACT_INVALID' });
    expect(response.text).not.toContain('Sealed preview guide response.');
    expect(response.text).not.toContain('private-fixture-sentinel');
    expect(mockPrompt).toHaveBeenCalled();
  });
});
