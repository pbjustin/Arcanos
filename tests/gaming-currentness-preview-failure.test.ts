import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actualFreshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const actualPolicy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const extract = jest.fn(actualFreshness.extractGamingFreshnessMetadata);
const evaluate = jest.fn(actualFreshness.evaluateGamingFreshness);
const project = jest.fn(actualPolicy.projectGamingHybridCandidateEvidence);
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...actualFreshness,
  extractGamingFreshnessMetadata: extract, evaluateGamingFreshness: evaluate }));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({ ...actualPolicy,
  projectGamingHybridCandidateEvidence: project }));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } = await import('../src/nativePrPreviewContract.js');

const proofPairs = () => [
  [contract.proofHeader, contract.proofVersion], [contract.responseProofHeader, contract.responseProofVersion],
  [contract.documentProofHeader, contract.documentProofVersion], [contract.durableRagProofHeader, contract.durableRagProofVersion],
  [contract.guideAssistanceProofHeader, contract.guideAssistanceProofVersion],
  [contract.progressRecoveryProofHeader, contract.progressRecoveryProofVersion],
  [contract.hybridKnowledgeProofHeader, contract.hybridKnowledgeProofVersion], [contract.clearProofHeader, contract.clearProofVersion],
  [contract.sourceAcquisitionProofHeader, contract.sourceAcquisitionProofVersion],
  [contract.structuredEvidenceProofHeader, contract.structuredEvidenceProofVersion],
  [contract.currentnessProofHeader, contract.currentnessProofVersion],
  [contract.currentnessContinuationProofHeader, contract.currentnessContinuationProofVersion]
];

async function queryGuide(mode: 'guide' | 'build' | 'meta' = 'guide') {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1503, sourceCommit: 'a'.repeat(40) }, readinessState,
    notionConnectivityProbe: async () => ({ apiReached: true, authenticationRejected: true }) });
  Object.assign(readinessState, { applicationImported: true, fixturesSealed: true, ready: true });
  return request(app).post(contract.queryPath).send({ action: 'query', payload: {
    mode, game: contract.game, prompt: contract.fixtures[mode]
  } });
}

describe('served Gaming currentness proof boundary', () => {
  beforeEach(() => {
    extract.mockReset().mockImplementation(actualFreshness.extractGamingFreshnessMetadata);
    evaluate.mockReset().mockImplementation(actualFreshness.evaluateGamingFreshness);
    project.mockReset().mockImplementation(actualPolicy.projectGamingHybridCandidateEvidence);
  });

  it.each(['same-URL source retained', 'prior contradiction dropped', 'evaluated contradiction dropped'])(
    'withholds every Gaming proof and success body after continuation drift: %s', async scenario => {
      project.mockImplementation(input => {
        const value = actualPolicy.projectGamingHybridCandidateEvidence(input);
        if (scenario === 'same-URL source retained') value.knowledge.sources.push(...(input.prior?.sources ?? [])
          .filter(source => source.sourceId === 'synthetic-continuation-old-index'));
        if (scenario === 'prior contradiction dropped' && input.priorFreshness?.some(item => item.metadataConflict)
          || scenario === 'evaluated contradiction dropped' && input.currentnessEvidence?.length) {
          value.freshness = value.freshness.filter(item => item.id !== 'synthetic-continuation-conflict');
        }
        return value;
      });
      const response = await queryGuide();
      expect(response.status).toBe(500);
      for (const [key, header] of Object.entries(contract)) {
        if (key === 'proofHeader' || key.endsWith('ProofHeader')) expect(response.headers[header as string]).toBeUndefined();
      }
      expect(response.body).toEqual({ error: 'PREVIEW_GAMING_CURRENTNESS_CONTRACT_INVALID' });
      expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
      expect(response.text).not.toContain('Sealed preview guide response.');
      expect(response.text).not.toContain('synthetic-continuation');
    });

  it('gates all Gaming proof headers on the fixed currentness scenario and keeps the sealed response', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of proofPairs()) expect(response.headers[header]).toBe(version);
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] } });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ game: 'Elden Ring', platform: 'PC', mode: 'build',
      evidence: expect.arrayContaining([expect.objectContaining({ url: 'https://currentness-preview.example/guides/mage' })]) }));
    expect(response.text).not.toContain('dimensionScores');
    expect(response.text).not.toContain('currentness-preview.example');
  });

  it.each(['missing build admitted', 'missing platform admitted', 'unexpected extraction error'])(
    'withholds every Gaming proof and success body after %s', async scenario => {
      extract.mockImplementation((...args) => {
        const doc = args[0];
        if (!doc.publicUrl.startsWith('https://currentness-preview.example/')) return actualFreshness.extractGamingFreshnessMetadata(...args);
        if (scenario === 'unexpected extraction error') throw new Error('private-currentness-preview-sentinel');
        const value = actualFreshness.extractGamingFreshnessMetadata(...args);
        if (value.category === 'specialist_guide' && scenario === 'missing build admitted' && !value.build) return { ...value, build: value.patch };
        if (value.category === 'specialist_guide' && scenario === 'missing platform admitted' && !value.platforms) return { ...value, platforms: ['PC'] };
        return value;
      });
      const response = await queryGuide();
      expect(response.status).toBe(500);
      for (const [key, header] of Object.entries(contract)) {
        if (key === 'proofHeader' || key.endsWith('ProofHeader')) expect(response.headers[header as string]).toBeUndefined();
      }
      expect(response.headers[NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name]).toBe(NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value);
      expect(response.body).toEqual({ error: 'PREVIEW_GAMING_CURRENTNESS_CONTRACT_INVALID' });
      expect(response.text).not.toContain('Sealed preview guide response.');
      expect(response.text).not.toContain('private-currentness-preview-sentinel');
    }
  );

  it.each(['build', 'meta'] as const)('does not claim currentness fixture execution for %s', async mode => {
    const response = await queryGuide(mode);
    expect(response.status).toBe(200);
    expect(response.headers[contract.currentnessProofHeader]).toBeUndefined();
    expect(response.headers[contract.currentnessContinuationProofHeader]).toBeUndefined();
    expect(extract.mock.calls.some(([doc]) => doc.publicUrl.startsWith('https://currentness-preview.example/'))).toBe(false);
  });
});
