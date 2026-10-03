import { jest } from '@jest/globals';
import request from 'supertest';

const actualBudgetFixture = await import('../src/shared/gaming/gamingGenerationBudgetPreviewFixture.js');
const assertBudgetFixture = jest.fn(actualBudgetFixture.assertGamingGenerationBudgetPreviewFixture);
jest.unstable_mockModule('../src/shared/gaming/gamingGenerationBudgetPreviewFixture.js', () => ({
  ...actualBudgetFixture,
  assertGamingGenerationBudgetPreviewFixture: assertBudgetFixture,
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const {
  NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract,
  NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER,
} = await import('../src/nativePrPreviewContract.js');

const gamingProofHeaders = Object.entries(contract).flatMap(([key, value]) =>
  (key === 'proofHeader' || key.endsWith('ProofHeader')) && typeof value === 'string' ? [value] : []
);

async function queryGuide() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({
    identity: { prNumber: 1522, sourceCommit: 'a'.repeat(40) },
    readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }),
  });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;
  readinessState.ready = true;
  return request(app).post(contract.queryPath).send({
    action: 'query',
    payload: { mode: 'guide', game: contract.game, prompt: contract.fixtures.guide },
  });
}

describe('served Gaming generation budget proof boundary', () => {
  beforeEach(() => assertBudgetFixture.mockReset().mockImplementation(actualBudgetFixture.assertGamingGenerationBudgetPreviewFixture));

  it('adds budget proof after assertions pass and preserves the guide response', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    expect(assertBudgetFixture).toHaveBeenCalledTimes(1);
    expect(response.headers[contract.generationBudgetProofHeader]).toBe('gaming-generation-budget/v1');
    for (const header of gamingProofHeaders) expect(response.headers[header]).toBeDefined();
    expect(response.body.result).toEqual({
      ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] },
    });
  });

  it.each(['assertion failure', 'partial fixture failure'])('returns fixed 503 and withholds every Gaming marker after %s', async scenario => {
    assertBudgetFixture.mockImplementation(() => {
      if (scenario === 'partial fixture failure') actualBudgetFixture.assertGamingGenerationBudgetPreviewFixture();
      throw new Error('private-budget-preview-sentinel');
    });
    const response = await queryGuide();
    expect(response.status).toBe(503);
    expect(assertBudgetFixture).toHaveBeenCalledTimes(1);
    for (const header of gamingProofHeaders) expect(response.headers[header]).toBeUndefined();
    expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
    expect(response.body).toEqual({ error: 'PREVIEW_GAMING_GENERATION_BUDGET_CONTRACT_INVALID' });
    expect(response.text).not.toContain('private-budget-preview-sentinel');
    expect(response.text).not.toContain('Sealed preview guide response.');
  });
});
