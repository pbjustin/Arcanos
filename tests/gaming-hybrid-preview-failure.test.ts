import { jest } from '@jest/globals';
import request from 'supertest';

const actualPolicy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const actualFreshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const actualContract = await import('../src/shared/gaming/gamingHybridContract.js');
const actualIdentity = await import('../src/shared/gaming/gamingGameIdentity.js');
const actualApplicability = await import('../src/shared/gaming/gamingGuideApplicability.js');
const actualStructural = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const actualPlatform = await import('../src/shared/gaming/gamingPlatformIdentity.js');
const mockAttempt = jest.fn(actualPolicy.resolveGamingHybridCandidateAttempt);
const mockRetention = jest.fn(actualPolicy.projectGamingHybridCandidateRetention);
const mockApproval = jest.fn(actualPolicy.isGamingApprovedArtifactCurrent);
const mockFreshness = jest.fn(actualFreshness.evaluateGamingFreshness);
const mockExtract = jest.fn(actualFreshness.extractGamingFreshnessMetadata);
const mockSuppliedGuides = jest.fn(actualPolicy.projectGamingHybridSuppliedGuides);
const mockCandidatesSafeParse = jest.fn((input: unknown) => actualContract.gamingHybridCandidatesSchema.safeParse(input));
const mockEdition = jest.fn(actualIdentity.resolveGamingRequestEdition);
const mockScopeRequired = jest.fn(actualApplicability.gamingApplicabilityScopeRequired);
const mockEditionRequirements = jest.fn(actualStructural.classifyGamingEditionRequirements);
const mockPlatformMatches = jest.fn(actualPlatform.gamingPlatformEvidenceMatchesRequest);
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({
  ...actualPolicy, resolveGamingHybridCandidateAttempt: mockAttempt,
  projectGamingHybridCandidateRetention: mockRetention, isGamingApprovedArtifactCurrent: mockApproval,
  projectGamingHybridSuppliedGuides: mockSuppliedGuides
}));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridContract.js', () => ({ ...actualContract,
  gamingHybridCandidatesSchema: { ...actualContract.gamingHybridCandidatesSchema, safeParse: mockCandidatesSafeParse } }));
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({
  ...actualFreshness, evaluateGamingFreshness: mockFreshness, extractGamingFreshnessMetadata: mockExtract
}));
jest.unstable_mockModule('../src/shared/gaming/gamingGameIdentity.js', () => ({ ...actualIdentity,
  resolveGamingRequestEdition: mockEdition }));
jest.unstable_mockModule('../src/shared/gaming/gamingGuideApplicability.js', () => ({ ...actualApplicability,
  gamingApplicabilityScopeRequired: mockScopeRequired }));
jest.unstable_mockModule('../src/shared/gaming/gamingStructuralEvidence.js', () => ({ ...actualStructural,
  classifyGamingEditionRequirements: mockEditionRequirements }));
jest.unstable_mockModule('../src/shared/gaming/gamingPlatformIdentity.js', () => ({ ...actualPlatform,
  gamingPlatformEvidenceMatchesRequest: mockPlatformMatches }));
const { createNativePrPreviewApplication, createNativePrPreviewReadinessState } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_GAMING_CONTRACT: contract, NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER } = await import('../src/nativePrPreviewContract.js');

const proofPairs = () => [
  [contract.proofHeader, contract.proofVersion], [contract.responseProofHeader, contract.responseProofVersion],
  [contract.documentProofHeader, contract.documentProofVersion], [contract.durableRagProofHeader, contract.durableRagProofVersion],
  [contract.guideAssistanceProofHeader, contract.guideAssistanceProofVersion],
  [contract.progressRecoveryProofHeader, contract.progressRecoveryProofVersion],
  [contract.hybridKnowledgeProofHeader, contract.hybridKnowledgeProofVersion],
  [contract.editionContextRegressionsProofHeader, contract.editionContextRegressionsProofVersion],
  [contract.discoveryRecoveryProtocolProofHeader, contract.discoveryRecoveryProtocolProofVersion],
  [contract.discoveryRecoveryEvidenceProofHeader, contract.discoveryRecoveryEvidenceProofVersion],
  [contract.clearProofHeader, contract.clearProofVersion],
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
    mockExtract.mockReset().mockImplementation(actualFreshness.extractGamingFreshnessMetadata);
    mockSuppliedGuides.mockReset().mockImplementation(actualPolicy.projectGamingHybridSuppliedGuides);
    mockCandidatesSafeParse.mockReset().mockImplementation(input => actualContract.gamingHybridCandidatesSchema.safeParse(input));
    mockEdition.mockReset().mockImplementation(actualIdentity.resolveGamingRequestEdition);
    mockScopeRequired.mockReset().mockImplementation(actualApplicability.gamingApplicabilityScopeRequired);
    mockEditionRequirements.mockReset().mockImplementation(actualStructural.classifyGamingEditionRequirements);
    mockPlatformMatches.mockReset().mockImplementation(actualPlatform.gamingPlatformEvidenceMatchesRequest);
  });

  it('keeps the trusted response body compatible and reports every production-core proof', async () => {
    const response = await queryGuide();
    expect(response.status).toBe(200);
    for (const [header, version] of proofPairs()) expect(response.headers[header]).toBe(version);
    expect(response.body.result).toEqual({ ok: true, route: 'gaming', mode: 'guide',
      data: { response: 'Sealed preview guide response.', sources: [] } });
    for (const mock of [mockAttempt, mockRetention, mockApproval, mockFreshness, mockExtract,
      mockCandidatesSafeParse, mockSuppliedGuides]) expect(mock).toHaveBeenCalled();
  });

  it.each(['missing v2 revision', 'v1 revision upgrade', 'second recovery revoked', 'third recovery allowed',
    'supplied guide actor bypass', 'supplied guide workflow bypass', 'supplied guide expiry bypass', 'supplied guide evidence bypass',
    'retry limit bypass', 'capacity handle leak', 'partial artifact accepted', 'freshness bypass', 'public identity promotion', 'private identity leak',
    'ordinary no-edition Samurai denied', 'attributed title chooses edition', 'negated expansion accepted',
    'equipment maintenance requires region', 'available-only DLC restriction ignored', 'platform alias denied', 'unexpected failure'])(
    'withholds every Gaming proof and the success body after %s', async scenario => {
      if (scenario === 'missing v2 revision' || scenario === 'v1 revision upgrade') mockCandidatesSafeParse.mockImplementation(input => {
        const result = actualContract.gamingHybridCandidatesSchema.safeParse(input);
        if (!input || typeof input !== 'object' || !('contractVersion' in input)) return result;
        const candidateRequest = input as Record<string, unknown>;
        const bypass = scenario === 'missing v2 revision'
          ? candidateRequest.contractVersion === actualContract.GAMING_HYBRID_V2_CONTRACT_VERSION && candidateRequest.expectedRevision === undefined
          : candidateRequest.contractVersion === actualContract.GAMING_HYBRID_CONTRACT_VERSION && 'expectedRevision' in candidateRequest;
        return bypass ? { success: true, data: actualContract.gamingHybridCandidatesSchema.parse({ ...candidateRequest,
          contractVersion: actualContract.GAMING_HYBRID_V2_CONTRACT_VERSION, expectedRevision: 0 }) } : result;
      });
      else if (scenario === 'second recovery revoked' || scenario === 'third recovery allowed') mockAttempt.mockImplementation(input => {
        if (scenario === 'second recovery revoked' && input.requestedKey === 'synthetic-v2-candidates-2'
          && input.round === 1 && input.maxRounds === 2) return 'deny';
        if (scenario === 'third recovery allowed' && input.requestedKey === 'synthetic-v2-candidates-3') return 'begin';
        return actualPolicy.resolveGamingHybridCandidateAttempt(input);
      });
      else if (scenario.startsWith('supplied guide')) mockSuppliedGuides.mockImplementation(input => {
        const candidate = input.accepted[0];
        const bypass = scenario === 'supplied guide actor bypass' && candidate.actorScopeHash !== input.actorScopeHash
          || scenario === 'supplied guide workflow bypass' && candidate.workflowId !== input.workflowId
          || scenario === 'supplied guide expiry bypass' && candidate.expiresAt <= input.now
          || scenario === 'supplied guide evidence bypass' && input.knowledge.evidence?.length === 0;
        return bypass ? [{ requestedUrl: candidate.document.requestedUrl, sourceId: candidate.candidateId,
          publicUrl: candidate.publicUrl }] : actualPolicy.projectGamingHybridSuppliedGuides(input);
      });
      else if (scenario === 'retry limit bypass') mockAttempt.mockReturnValue('begin');
      else if (scenario === 'capacity handle leak') mockRetention.mockImplementation(input => ({
        retainArtifacts: true, decisions: input.decisions.map(decision => ({ ...decision }))
      }));
      else if (scenario === 'partial artifact accepted') mockApproval.mockReturnValue(true);
      else if (scenario === 'freshness bypass') mockFreshness.mockImplementation(input => ({
        ...actualFreshness.evaluateGamingFreshness(input), status: 'current', usable: true
      }));
      else if (scenario === 'public identity promotion') mockExtract.mockImplementation((document, ...args) =>
        actualFreshness.extractGamingFreshnessMetadata({ ...document, canonicalUrl: undefined }, ...args));
      else if (scenario === 'private identity leak') mockExtract.mockImplementation((document, ...args) => ({
        ...actualFreshness.extractGamingFreshnessMetadata(document, ...args),
        ...(document.canonicalUrl ? { url: document.canonicalUrl } : {})
      }));
      else if (scenario === 'ordinary no-edition Samurai denied') mockEdition.mockImplementation(input =>
        input.prompt === 'Recommend an early-game Samurai blade build after leaving the tutorial.'
          ? undefined : actualIdentity.resolveGamingRequestEdition(input));
      else if (scenario === 'attributed title chooses edition') mockEdition.mockImplementation(input =>
        input.prompt?.startsWith('The submitted guide is titled "Elden Ring Shadow of the Erdtree".')
          ? 'shadow of the erdtree' : actualIdentity.resolveGamingRequestEdition(input));
      else if (scenario === 'negated expansion accepted') mockEdition.mockImplementation(input =>
        input.prompt?.startsWith('Do not use Shadow of the Erdtree gear.')
          ? 'shadow of the erdtree' : actualIdentity.resolveGamingRequestEdition(input));
      else if (scenario === 'equipment maintenance requires region') mockScopeRequired.mockImplementation((input, scope) =>
        input.question === 'How do I keep up maintenance on my sword?' && scope === 'region'
          ? true : actualApplicability.gamingApplicabilityScopeRequired(input, scope));
      else if (scenario === 'available-only DLC restriction ignored') mockEditionRequirements.mockImplementation(text =>
        text === 'This weapon is available only in Shadow of the Erdtree.'
          ? 'clear' : actualStructural.classifyGamingEditionRequirements(text));
      else if (scenario === 'platform alias denied') mockPlatformMatches.mockImplementation((evidence, platform) =>
        evidence?.[0] === 'PlayStation 5' && platform === 'PS5'
          ? false : actualPlatform.gamingPlatformEvidenceMatchesRequest(evidence, platform));
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
