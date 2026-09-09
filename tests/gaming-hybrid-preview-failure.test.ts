import { jest } from '@jest/globals';
import request from 'supertest';

const actualPolicy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const actualFreshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const mockAttempt = jest.fn(actualPolicy.resolveGamingHybridCandidateAttempt);
const mockRetention = jest.fn(actualPolicy.projectGamingHybridCandidateRetention);
const mockApproval = jest.fn(actualPolicy.isGamingApprovedArtifactCurrent);
const mockFreshness = jest.fn(actualFreshness.evaluateGamingFreshness);
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({
  ...actualPolicy, resolveGamingHybridCandidateAttempt: mockAttempt,
  projectGamingHybridCandidateRetention: mockRetention, isGamingApprovedArtifactCurrent: mockApproval
}));
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({
  ...actualFreshness, evaluateGamingFreshness: mockFreshness
}));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } = await import('../src/nativePrPreviewContract.js');

const proofPairs = () => [
  [contract.proofHeader, contract.proofVersion], [contract.responseProofHeader, contract.responseProofVersion],
  [contract.documentProofHeader, contract.documentProofVersion], [contract.durableRagProofHeader, contract.durableRagProofVersion],
  [contract.guideAssistanceProofHeader, contract.guideAssistanceProofVersion],
  [contract.progressRecoveryProofHeader, contract.progressRecoveryProofVersion],
  [contract.hybridKnowledgeProofHeader, contract.hybridKnowledgeProofVersion]
];

async function queryGuide() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1491, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  Object.assign(readinessState, { applicationImported: true, fixturesSealed: true, ready: true });
  return request(app).post(contract.queryPath).send({ action: 'query', payload: {
    mode: 'guide', game: contract.game, prompt: contract.fixtures.guide
  } });
}

describe('served Gaming hybrid component-proof boundary', () => {
  beforeEach(() => {
    mockAttempt.mockReset().mockImplementation(actualPolicy.resolveGamingHybridCandidateAttempt);
    mockRetention.mockReset().mockImplementation(actualPolicy.projectGamingHybridCandidateRetention);
    mockApproval.mockReset().mockImplementation(actualPolicy.isGamingApprovedArtifactCurrent);
    mockFreshness.mockReset().mockImplementation(actualFreshness.evaluateGamingFreshness);
  });

  it('keeps the trusted response body compatible and reports all seven production-core proofs', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of proofPairs()) expect(response.headers[header]).toBe(version);
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] } });
    for (const mock of [mockAttempt, mockRetention, mockApproval, mockFreshness]) expect(mock).toHaveBeenCalled();
  });

  it.each(['retry limit bypass', 'capacity handle leak', 'partial artifact accepted', 'freshness bypass', 'unexpected failure'])(
    'withholds every Gaming proof and the success body after %s', async scenario => {
      if (scenario === 'retry limit bypass') mockAttempt.mockReturnValue('begin');
      else if (scenario === 'capacity handle leak') mockRetention.mockImplementation(input => ({
        retainArtifacts: true, decisions: input.decisions.map(decision => ({ ...decision }))
      }));
      else if (scenario === 'partial artifact accepted') mockApproval.mockReturnValue(true);
      else if (scenario === 'freshness bypass') mockFreshness.mockImplementation(input => ({
        ...actualFreshness.evaluateGamingFreshness(input), status: 'current', usable: true
      }));
      else mockAttempt.mockImplementation(() => { throw new Error('private-hybrid-preview-sentinel'); });
      const response = await queryGuide();
      expect(response.status).toBe(500);
      for (const [header] of proofPairs()) expect(response.headers[header]).toBeUndefined();
      expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
      expect(response.body).toEqual({ error: 'PREVIEW_GAMING_HYBRID_KNOWLEDGE_CONTRACT_INVALID' });
      expect(response.text).not.toContain('Sealed preview guide response.');
      expect(response.text).not.toContain('private-hybrid-preview-sentinel');
    }
  );
});
