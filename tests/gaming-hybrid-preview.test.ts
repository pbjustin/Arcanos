import { jest } from '@jest/globals';

const freshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const policy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const contract = await import('../src/shared/gaming/gamingHybridContract.js');
const mockEvaluate = jest.fn(freshness.evaluateGamingFreshness);
const mockExtract = jest.fn(freshness.extractGamingFreshnessMetadata);
const mockSourcePolicy = jest.fn(freshness.assessGamingSourcePolicy);
const mockAttempt = jest.fn(policy.resolveGamingHybridCandidateAttempt);
const mockRetention = jest.fn(policy.projectGamingHybridCandidateRetention);
const mockArtifact = jest.fn(policy.isGamingApprovedArtifactCurrent);
const mockQuerySafeParse = jest.fn((input: unknown) => contract.gamingHybridQuerySchema.safeParse(input));
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...freshness,
  evaluateGamingFreshness: mockEvaluate, extractGamingFreshnessMetadata: mockExtract, assessGamingSourcePolicy: mockSourcePolicy }));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({ ...policy,
  resolveGamingHybridCandidateAttempt: mockAttempt, projectGamingHybridCandidateRetention: mockRetention,
  isGamingApprovedArtifactCurrent: mockArtifact }));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridContract.js', () => ({ ...contract,
  gamingHybridQuerySchema: { ...contract.gamingHybridQuerySchema, safeParse: mockQuerySafeParse,
    parse: (input: unknown) => contract.gamingHybridQuerySchema.parse(input) } }));
const { runGamingHybridKnowledgePreview, GAMING_HYBRID_KNOWLEDGE_PREVIEW_VERSION } = await import('../src/shared/gaming/gamingHybridKnowledgePreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_HYBRID_KNOWLEDGE_CONTRACT_INVALID';

describe('sealed Gaming hybrid knowledge production-core proof', () => {
  beforeEach(() => {
    mockEvaluate.mockReset().mockImplementation(freshness.evaluateGamingFreshness);
    mockExtract.mockReset().mockImplementation(freshness.extractGamingFreshnessMetadata);
    mockSourcePolicy.mockReset().mockImplementation(freshness.assessGamingSourcePolicy);
    mockAttempt.mockReset().mockImplementation(policy.resolveGamingHybridCandidateAttempt);
    mockRetention.mockReset().mockImplementation(policy.projectGamingHybridCandidateRetention);
    mockArtifact.mockReset().mockImplementation(policy.isGamingApprovedArtifactCurrent);
    mockQuerySafeParse.mockReset().mockImplementation(input => contract.gamingHybridQuerySchema.safeParse(input));
  });

  it('repeats fixed schema, freshness, retry, capacity and refetch assertions without caller input', () => {
    expect(runGamingHybridKnowledgePreview).not.toThrow();
    expect(runGamingHybridKnowledgePreview).not.toThrow();
    expect(GAMING_HYBRID_KNOWLEDGE_PREVIEW_VERSION).toBe('gaming-hybrid-knowledge/v1');
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ question: 'What are the latest hotfix beam damage values this season?' }));
    expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Platforms:') }),
      expect.objectContaining({ game: 'Prism Siege' }), new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(mockAttempt).toHaveBeenCalledWith(expect.objectContaining({ operationKey: 'synthetic-candidates-1', round: 1, nextAction: 'retry_later' }));
    expect(mockRetention).toHaveBeenCalledWith(expect.objectContaining({ retainedChars: 12_000_000, candidateChars: 1 }));
    expect(mockArtifact).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }));
  });

  it('fails closed when caller authority fields are accepted by the public query contract', () => {
    mockQuerySafeParse.mockImplementation(input => input && typeof input === 'object' && 'canStore' in input
      ? { success: true, data: contract.gamingHybridQuerySchema.parse({ contractVersion: contract.GAMING_HYBRID_CONTRACT_VERSION,
        idempotencyKey: 'synthetic-query-1', game: 'Prism Siege', question: 'How do I open the copper gate?' }) }
      : contract.gamingHybridQuerySchema.safeParse(input));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when candidate hints inherit official source authority', () => {
    mockSourcePolicy.mockImplementation((...args) => ({ ...freshness.assessGamingSourcePolicy(...args), authority: 'official' }));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when a season-only index admits patch-sensitive questions', () => {
    mockEvaluate.mockImplementation(input => {
      const result = freshness.evaluateGamingFreshness(input);
      return result.classification === 'seasonal' && input.question.includes('hotfix')
        ? { ...result, usable: true, status: 'current' } : result;
    });
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when malformed restrictions disappear into unspecified scope', () => {
    mockExtract.mockImplementation((...args) => ({ ...freshness.extractGamingFreshnessMetadata(...args), metadataUnverified: undefined }));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when excluded weaker-source mechanics contaminate the remaining evidence', () => {
    mockEvaluate.mockImplementation(input => {
      const result = freshness.evaluateGamingFreshness(input);
      return result.reasons.includes('LOWER_AUTHORITY_CONFLICT_EXCLUDED') ? { ...result, usable: false, status: 'conflicting' } : result;
    });
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when a stale index becomes usable', () => {
    mockEvaluate.mockImplementation(input => {
      const result = freshness.evaluateGamingFreshness(input);
      return result.status === 'stale' ? { ...result, usable: true, status: 'current' } : result;
    });
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it.each(['deny-resume', 'allow-alternative'])('fails closed on candidate retry decision drift: %s', scenario => {
    mockAttempt.mockImplementation(input => {
      if (scenario === 'deny-resume' && input.operationKey === input.requestedKey) return 'deny';
      if (scenario === 'allow-alternative' && input.requestedKey === 'alternative-candidates-1') return 'begin';
      return policy.resolveGamingHybridCandidateAttempt(input);
    });
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when overflow artifacts retain an ingestible candidate identifier', () => {
    mockRetention.mockImplementation(input => {
      const projected = policy.projectGamingHybridCandidateRetention(input);
      if (!projected.retainArtifacts) projected.decisions[0].candidateId = '20000000-0000-4000-8000-000000000001';
      return projected;
    });
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when an artifact at the exact retention cap is rejected', () => {
    mockRetention.mockImplementation(input => ({ ...policy.projectGamingHybridCandidateRetention(input), retainArtifacts: false }));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it.each(['truncated', 'instructionFiltered', 'changed'])('fails closed when %s refetches remain approved', scenario => {
    mockArtifact.mockImplementation(input => input.truncated && scenario === 'truncated'
      || input.instructionFiltered && scenario === 'instructionFiltered'
      || input.approvedContentHash !== input.documentContentHash && scenario === 'changed'
      ? true : policy.isGamingApprovedArtifactCurrent(input));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('returns only the fixed failure after an unexpected production-core exception', () => {
    mockArtifact.mockImplementation(() => { throw new Error('private-hybrid-preview-sentinel'); });
    let failure: unknown;
    try { runGamingHybridKnowledgePreview(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain('private-hybrid-preview-sentinel');
  });
});
