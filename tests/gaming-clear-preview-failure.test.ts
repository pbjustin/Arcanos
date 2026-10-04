import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actualSource = await import('../src/shared/gaming/gamingClearSource.js');
const actualEvidence = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualPolicy = await import('../src/shared/gaming/gamingClearPolicy.js');
const actualBinding = await import('../src/shared/gaming/gamingClearAnswerBinding.js');
const source = jest.fn(actualSource.assessGamingClearSource);
const evidence = jest.fn(actualEvidence.assessGamingClearEvidence);
const assessment = jest.fn(actualPolicy.createGamingClearAssessment);
const binding = jest.fn(actualBinding.hasBoundGamingClearAnswer);
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({ ...actualSource, assessGamingClearSource: source }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...actualEvidence, assessGamingClearEvidence: evidence }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearPolicy.js', () => ({ ...actualPolicy, createGamingClearAssessment: assessment }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearAnswerBinding.js', () => ({ ...actualBinding, hasBoundGamingClearAnswer: binding }));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } = await import('../src/nativePrPreviewContract.js');

const proofPairs = () => [
  [contract.proofHeader, contract.proofVersion], [contract.responseProofHeader, contract.responseProofVersion],
  [contract.documentProofHeader, contract.documentProofVersion], [contract.durableRagProofHeader, contract.durableRagProofVersion],
  [contract.guideAssistanceProofHeader, contract.guideAssistanceProofVersion],
  [contract.progressRecoveryProofHeader, contract.progressRecoveryProofVersion],
  [contract.hybridKnowledgeProofHeader, contract.hybridKnowledgeProofVersion], [contract.clearProofHeader, contract.clearProofVersion],
  [contract.discoveryRecoveryProtocolProofHeader, contract.discoveryRecoveryProtocolProofVersion],
  [contract.discoveryRecoveryEvidenceProofHeader, contract.discoveryRecoveryEvidenceProofVersion],
  [contract.sourceAcquisitionProofHeader, contract.sourceAcquisitionProofVersion],
  [contract.structuredEvidenceProofHeader, contract.structuredEvidenceProofVersion],
  [contract.currentnessProofHeader, contract.currentnessProofVersion],
  [contract.currentnessContinuationProofHeader, contract.currentnessContinuationProofVersion],
  [contract.advisoryFreshnessProofHeader, contract.advisoryFreshnessProofVersion],
  [contract.generationBudgetProofHeader, contract.generationBudgetProofVersion],
  [contract.executionBudgetProofHeader, contract.executionBudgetProofVersion]
];

async function queryGuide() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1492, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  Object.assign(readinessState, { applicationImported: true, fixturesSealed: true, ready: true });
  return request(app).post(contract.queryPath).send({ action: 'query', payload: {
    mode: 'guide', game: contract.game, prompt: contract.fixtures.guide
  } });
}

describe('served Gaming CLEAR proof boundary', () => {
  beforeEach(() => {
    source.mockReset().mockImplementation(actualSource.assessGamingClearSource);
    evidence.mockReset().mockImplementation(actualEvidence.assessGamingClearEvidence);
    assessment.mockReset().mockImplementation(actualPolicy.createGamingClearAssessment);
    binding.mockReset().mockImplementation(actualBinding.hasBoundGamingClearAnswer);
  });

  it('runs the production decision cores and preserves the trusted response body', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of proofPairs()) expect(response.headers[header]).toBe(version);
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] } });
    for (const mock of [source, evidence, assessment, binding]) expect(mock).toHaveBeenCalled();
    expect(response.text).not.toContain('dimensionScores');
  });

  it.each(['source acceptance bypass', 'evidence acceptance bypass', 'answer acceptance bypass', 'text binding bypass', 'unexpected error'])(
    'withholds every Gaming proof and the success body after %s', async scenario => {
      if (scenario === 'source acceptance bypass') source.mockImplementation((...args) => ({ ...actualSource.assessGamingClearSource(...args), decision: 'accept' }));
      else if (scenario === 'evidence acceptance bypass') evidence.mockImplementation((...args) => ({ ...actualEvidence.assessGamingClearEvidence(...args), decision: 'accept' }));
      else if (scenario === 'answer acceptance bypass') assessment.mockImplementation(input => ({ ...actualPolicy.createGamingClearAssessment(input),
        ...(input.profile === 'answer' ? { decision: 'accept' as const } : {}) }));
      else if (scenario === 'text binding bypass') binding.mockReturnValue(true);
      else source.mockImplementation(() => { throw new Error('private-clear-preview-sentinel'); });
      const response = await queryGuide();
      expect(response.status).toBe(500);
      for (const [header] of proofPairs()) expect(response.headers[header]).toBeUndefined();
      expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
      expect(response.body).toEqual({ error: 'PREVIEW_GAMING_CLEAR_CONTRACT_INVALID' });
      expect(response.text).not.toContain('Sealed preview guide response.');
      expect(response.text).not.toContain('private-clear-preview-sentinel');
    }
  );

  it.each(['independent rows rejected', 'missing tuple fields admitted', 'trailing pool disagreement hidden', 'inspection limit bypassed', 'compacted inspection veto lost'])(
    'withholds every Gaming proof and the success body after discovery recovery drift: %s', async scenario => {
      evidence.mockImplementation((input, data, options) => {
        const result = actualEvidence.assessGamingClearEvidence(input, data, options);
        if (!options?.requireRequestCoverage) return result;
        if (scenario === 'independent rows rejected' && input.prompt.includes('Silverblade') && result.gates.claimSupport === 'verified')
          return { ...result, decision: 'reject', gates: { ...result.gates, claimSupport: 'unknown' } };
        if (scenario === 'missing tuple fields admitted' && data.evidence?.some(chunk => chunk.evidenceUnits?.some(unit =>
          !unit.fields.some(field => field.label === 'Unit'))))
          return { ...result, decision: 'accept', gates: { ...result.gates, claimSupport: 'verified' } };
        if (scenario === 'trailing pool disagreement hidden' && (data.evidence?.length ?? 0) > 2_048)
          return { ...result, blockingFindings: result.blockingFindings.filter(finding => finding.code !== 'CONTRADICTORY_EVIDENCE') };
        if (scenario === 'inspection limit bypassed' && data.sources.length === 18)
          return { ...result, decision: 'accept', gates: { ...result.gates, claimSupport: 'verified' }, blockingFindings: [] };
        if (scenario === 'compacted inspection veto lost' && data.structuralConflictAssessmentUnavailable)
          return actualEvidence.assessGamingClearEvidence(input, { ...data, structuralConflictAssessmentUnavailable: false }, options);
        return result;
      });
      const response = await queryGuide();
      expect(response.status).toBe(500);
      for (const [header] of proofPairs()) expect(response.headers[header]).toBeUndefined();
      expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
      expect(response.body).toEqual({ error: 'PREVIEW_GAMING_CLEAR_CONTRACT_INVALID' });
      expect(response.text).not.toContain('Sealed preview guide response.');
      expect(response.text).not.toContain('Copperblade');
      expect(response.text).not.toContain('synthetic-recovery');
    }
  );
});
