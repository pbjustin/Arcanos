import { jest } from '@jest/globals';
import request from 'supertest';

const actualCore = await import('../src/shared/gaming/gamingArchiveResourceCore.js');
const mockResolveArchive = jest.fn(actualCore.resolveGamingArchiveResourceCore);
jest.unstable_mockModule('../src/shared/gaming/gamingArchiveResourceCore.js', () => ({
  ...actualCore,
  resolveGamingArchiveResourceCore: mockResolveArchive
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } =
  await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } =
  await import('../src/nativePrPreviewContract.js');

describe('served Gaming Archive component-proof failure boundary', () => {
  beforeEach(() => {
    mockResolveArchive.mockReset().mockImplementation(actualCore.resolveGamingArchiveResourceCore);
  });

  it.each(['missing evidence', 'unexpected failure'])('rejects a sealed guide after resolver %s without a success marker', async (scenario) => {
    if (scenario === 'missing evidence') {
      mockResolveArchive.mockResolvedValueOnce(null);
    } else {
      mockResolveArchive.mockRejectedValueOnce(new Error('private-fixture-sentinel'));
    }
    const readinessState = createNativePrPreviewReadinessState();
    const app = createNativePrPreviewApplication({
      identity: { prNumber: 1483, sourceCommit: 'a'.repeat(40) },
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
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name])
      .toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_ARCHIVE_GROUNDING_CONTRACT_INVALID' });
    expect(response.text).not.toContain('Sealed preview guide response.');
    expect(response.text).not.toContain('private-fixture-sentinel');
    expect(mockResolveArchive).toHaveBeenCalledTimes(1);
  });
});
