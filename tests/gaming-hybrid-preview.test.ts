import { jest } from '@jest/globals';

const freshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const policy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const contract = await import('../src/shared/gaming/gamingHybridContract.js');
const identity = await import('../src/shared/gaming/gamingGameIdentity.js');
const source = await import('../src/shared/gaming/gamingClearSource.js');
const evidence = await import('../src/shared/gaming/gamingClearEvidence.js');
const structural = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const platform = await import('../src/shared/gaming/gamingPlatformIdentity.js');
const player = await import('../src/shared/gaming/gamingPlayerContext.js');
const mockEvaluate = jest.fn(freshness.evaluateGamingFreshness);
const mockExtract = jest.fn(freshness.extractGamingFreshnessMetadata);
const mockSourcePolicy = jest.fn(freshness.assessGamingSourcePolicy);
const mockAttempt = jest.fn(policy.resolveGamingHybridCandidateAttempt);
const mockRetention = jest.fn(policy.projectGamingHybridCandidateRetention);
const mockArtifact = jest.fn(policy.isGamingApprovedArtifactCurrent);
const mockSuppliedGuides = jest.fn(policy.projectGamingHybridSuppliedGuides);
const mockQuerySafeParse = jest.fn((input: unknown) => contract.gamingHybridQuerySchema.safeParse(input));
const mockCandidatesSafeParse = jest.fn((input: unknown) => contract.gamingHybridCandidatesSchema.safeParse(input));
const mockQualification = jest.fn(identity.buildGamingSourceEditionQualification);
const mockSourceIdentity = jest.fn(source.assessGamingClearSourceIdentity);
const mockClearEvidence = jest.fn(evidence.assessGamingClearEvidence);
const mockRequirements = jest.fn(structural.classifyGamingEditionRequirements);
const mockPlatformMatch = jest.fn(platform.gamingPlatformEvidenceMatchesRequest);
const mockPlatformIdentity = jest.fn(platform.normalizeGamingPlatformIdentity);
const mockQuestionScope = jest.fn(player.resolveGamingQuestionScope);
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...freshness,
  evaluateGamingFreshness: mockEvaluate, extractGamingFreshnessMetadata: mockExtract, assessGamingSourcePolicy: mockSourcePolicy }));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({ ...policy,
  resolveGamingHybridCandidateAttempt: mockAttempt, projectGamingHybridCandidateRetention: mockRetention,
  isGamingApprovedArtifactCurrent: mockArtifact, projectGamingHybridSuppliedGuides: mockSuppliedGuides }));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridContract.js', () => ({ ...contract,
  gamingHybridCandidatesSchema: { ...contract.gamingHybridCandidatesSchema, safeParse: mockCandidatesSafeParse },
  gamingHybridQuerySchema: { ...contract.gamingHybridQuerySchema, safeParse: mockQuerySafeParse,
    parse: (input: unknown) => contract.gamingHybridQuerySchema.parse(input) } }));
jest.unstable_mockModule('../src/shared/gaming/gamingGameIdentity.js', () => ({ ...identity,
  buildGamingSourceEditionQualification: mockQualification }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({ ...source,
  assessGamingClearSourceIdentity: mockSourceIdentity }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...evidence,
  assessGamingClearEvidence: mockClearEvidence }));
jest.unstable_mockModule('../src/shared/gaming/gamingStructuralEvidence.js', () => ({ ...structural,
  classifyGamingEditionRequirements: mockRequirements }));
jest.unstable_mockModule('../src/shared/gaming/gamingPlatformIdentity.js', () => ({ ...platform,
  gamingPlatformEvidenceMatchesRequest: mockPlatformMatch, normalizeGamingPlatformIdentity: mockPlatformIdentity }));
jest.unstable_mockModule('../src/shared/gaming/gamingPlayerContext.js', () => ({ ...player,
  resolveGamingQuestionScope: mockQuestionScope }));
const { runGamingHybridKnowledgePreview, GAMING_HYBRID_KNOWLEDGE_PREVIEW_VERSION,
  GAMING_DISCOVERY_RECOVERY_PROTOCOL_PREVIEW_VERSION, GAMING_EDITION_CONTEXT_REGRESSIONS_PREVIEW_VERSION
} = await import('../src/shared/gaming/gamingHybridKnowledgePreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_HYBRID_KNOWLEDGE_CONTRACT_INVALID';

describe('sealed Gaming hybrid knowledge production-core proof', () => {
  beforeEach(() => {
    mockEvaluate.mockReset().mockImplementation(freshness.evaluateGamingFreshness);
    mockExtract.mockReset().mockImplementation(freshness.extractGamingFreshnessMetadata);
    mockSourcePolicy.mockReset().mockImplementation(freshness.assessGamingSourcePolicy);
    mockAttempt.mockReset().mockImplementation(policy.resolveGamingHybridCandidateAttempt);
    mockRetention.mockReset().mockImplementation(policy.projectGamingHybridCandidateRetention);
    mockArtifact.mockReset().mockImplementation(policy.isGamingApprovedArtifactCurrent);
    mockSuppliedGuides.mockReset().mockImplementation(policy.projectGamingHybridSuppliedGuides);
    mockQuerySafeParse.mockReset().mockImplementation(input => contract.gamingHybridQuerySchema.safeParse(input));
    mockCandidatesSafeParse.mockReset().mockImplementation(input => contract.gamingHybridCandidatesSchema.safeParse(input));
    mockQualification.mockReset().mockImplementation(identity.buildGamingSourceEditionQualification);
    mockSourceIdentity.mockReset().mockImplementation(source.assessGamingClearSourceIdentity);
    mockClearEvidence.mockReset().mockImplementation(evidence.assessGamingClearEvidence);
    mockRequirements.mockReset().mockImplementation(structural.classifyGamingEditionRequirements);
    mockPlatformMatch.mockReset().mockImplementation(platform.gamingPlatformEvidenceMatchesRequest);
    mockPlatformIdentity.mockReset().mockImplementation(platform.normalizeGamingPlatformIdentity);
    mockQuestionScope.mockReset().mockImplementation(player.resolveGamingQuestionScope);
  });

  it('repeats fixed schema, freshness, retry, capacity and refetch assertions without caller input', () => {
    expect(runGamingHybridKnowledgePreview).not.toThrow();
    expect(runGamingHybridKnowledgePreview).not.toThrow();
    expect(GAMING_HYBRID_KNOWLEDGE_PREVIEW_VERSION).toBe('gaming-hybrid-knowledge/v1');
    expect(GAMING_DISCOVERY_RECOVERY_PROTOCOL_PREVIEW_VERSION).toBe('gaming-discovery-recovery-protocol/v1');
    expect(GAMING_EDITION_CONTEXT_REGRESSIONS_PREVIEW_VERSION).toBe('gaming-edition-context-regressions/v1');
    expect(mockCandidatesSafeParse).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: contract.GAMING_HYBRID_V2_CONTRACT_VERSION, expectedRevision: 0 }));
    expect(mockCandidatesSafeParse).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: contract.GAMING_HYBRID_V2_CONTRACT_VERSION, expectedRevision: undefined }));
    expect(mockAttempt).toHaveBeenCalledWith(expect.objectContaining({ requestedKey: 'synthetic-v2-candidates-2', round: 1, maxRounds: 2 }));
    expect(mockSuppliedGuides).toHaveBeenCalledWith(expect.objectContaining({ requiredUrls: ['https://community.example/guides/beam#section'] }));
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ question: 'What are the latest hotfix beam damage values this season?' }));
    expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Platforms:') }),
      expect.objectContaining({ game: 'Prism Siege' }), new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({ publicUrl: 'https://prism.example/updates/current',
      canonicalUrl: `https://prism.example/updates/current/${'A'.repeat(120)}?build=%7Bprivate-preview-build-payload` }),
      expect.objectContaining({ game: 'Prism Siege' }), new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(mockAttempt).toHaveBeenCalledWith(expect.objectContaining({ operationKey: 'synthetic-candidates-1', round: 1, nextAction: 'retry_later' }));
    expect(mockRetention).toHaveBeenCalledWith(expect.objectContaining({ retainedChars: 12_000_000, candidateChars: 1 }));
    expect(mockArtifact).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }));
    expect(mockSourceIdentity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { title: 'Early-game Samurai blade build guide' } }),
      expect.objectContaining({ class: 'Samurai', progressPoint: 'just left the tutorial' }), expect.any(Object));
    expect(mockClearEvidence).toHaveBeenCalledWith(expect.not.objectContaining({ edition: expect.anything() }),
      expect.objectContaining({ evidence: expect.arrayContaining([expect.objectContaining({
        publicUrl: 'https://context-preview.example/guides/samurai', text: expect.stringContaining('Uchigatana') })]) }),
      expect.objectContaining({ allowAdvisoryFreshness: true, requireRequestCoverage: true }));
    expect(mockQualification).toHaveBeenCalledWith('Java', expect.objectContaining({
      prompt: 'The submitted guide is titled "Minecraft Java". How do I craft a crafting table?' }));
    expect(mockRequirements).toHaveBeenCalledWith('This weapon is available only in Shadow of the Erdtree.');
    expect(mockPlatformMatch).toHaveBeenCalledWith(['constructor'], 'PS5');
  });

  it('fails closed when an ordinary Samurai recommendation fails the CLEAR evidence gate', () => {
    mockClearEvidence.mockImplementation((...args) => ({ ...evidence.assessGamingClearEvidence(...args), decision: 'reject' }));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when an acquired Samurai topic heading alone establishes game identity', () => {
    mockSourceIdentity.mockImplementation((document, ...args) => document.metadata.title === 'Early-game Samurai blade build guide'
      && !document.text.includes('In Elden Ring,')
      ? { status: 'verified', reasonCodes: ['TOPIC_TITLE_ONLY'] } : source.assessGamingClearSourceIdentity(document, ...args));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when a source-attributed Java edition loses its required qualification', () => {
    mockQualification.mockReturnValue('');
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when advisory Samurai evidence is asserted to prove the current patch', () => {
    mockEvaluate.mockImplementation(input => input.game === 'Elden Ring' && input.question.startsWith('Recommend an early-game Samurai')
      ? { ...freshness.evaluateGamingFreshness(input), usable: true, status: 'current' }
      : freshness.evaluateGamingFreshness(input));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when an uncertain acquired expansion requirement becomes a claimed contradiction', () => {
    mockRequirements.mockImplementation((text, ...args) => text.startsWith('This weapon may be available only')
      ? 'conflict' : structural.classifyGamingEditionRequirements(text, ...args));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it.each(['PS4', 'Steam Deck', 'constructor', '__proto__'])(
    'fails closed when the acquired platform %s becomes compatible with a different platform', incompatible => {
      mockPlatformMatch.mockImplementation((values, requested) => values?.includes(incompatible) || requested === incompatible
        ? true : platform.gamingPlatformEvidenceMatchesRequest(values, requested));
      expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
    });

  it('fails closed when platform normalization collapses distinct console generations', () => {
    mockPlatformIdentity.mockImplementation(value => value === 'PlayStation 4'
      ? 'ps5' : platform.normalizeGamingPlatformIdentity(value));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when ambiguous user controls choose a platform', () => {
    mockQuestionScope.mockImplementation(prompt => prompt === 'What are the controls on PS5 or PC?'
      ? { platform: 'PlayStation 5' } : player.resolveGamingQuestionScope(prompt));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
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

  it.each(['missing revision', 'v1 revision upgrade'])('fails closed when the candidate contract accepts %s', scenario => {
    mockCandidatesSafeParse.mockImplementation(input => {
      const result = contract.gamingHybridCandidatesSchema.safeParse(input);
      if (!input || typeof input !== 'object' || !('contractVersion' in input)) return result;
      const request = input as Record<string, unknown>;
      const bypass = scenario === 'missing revision'
        ? request.contractVersion === contract.GAMING_HYBRID_V2_CONTRACT_VERSION && request.expectedRevision === undefined
        : request.contractVersion === contract.GAMING_HYBRID_CONTRACT_VERSION && 'expectedRevision' in request;
      return bypass ? { success: true, data: contract.gamingHybridCandidatesSchema.parse({ ...request,
        contractVersion: contract.GAMING_HYBRID_V2_CONTRACT_VERSION, expectedRevision: 0 }) } : result;
    });
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it.each(['second recovery revoked', 'third recovery allowed', 'v1 recovery upgraded', 'currentness renewed'])(
    'fails closed when %s', scenario => {
      mockAttempt.mockImplementation(input => {
        if (scenario === 'second recovery revoked' && input.requestedKey === 'synthetic-v2-candidates-2'
          && input.round === 1 && input.maxRounds === 2) return 'deny';
        if (scenario === 'third recovery allowed' && input.requestedKey === 'synthetic-v2-candidates-3') return 'begin';
        if (scenario === 'v1 recovery upgraded' && input.requestedKey === 'synthetic-v2-candidates-2'
          && input.maxRounds === 1 && input.nextAction === 'search') return 'begin';
        if (scenario === 'currentness renewed' && input.requestedKey === 'synthetic-v2-candidates-2'
          && input.nextAction === 'verify_currentness') return 'begin';
        return policy.resolveGamingHybridCandidateAttempt(input);
      });
      expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
    });

  it.each(['actor', 'workflow', 'expiry', 'target', 'source', 'evidence', 'empty evidence', 'public citation'])(
    'fails closed when supplied-guide %s binding is bypassed', scenario => {
      mockSuppliedGuides.mockImplementation(input => {
        const candidate = input.accepted[0];
        const bypass = scenario === 'actor' && candidate.actorScopeHash !== input.actorScopeHash
          || scenario === 'workflow' && candidate.workflowId !== input.workflowId
          || scenario === 'expiry' && candidate.expiresAt <= input.now
          || scenario === 'target' && input.requiredUrls.includes('https://community.example/guides/other')
          || scenario === 'source' && input.knowledge.sources.length === 0
          || scenario === 'evidence' && input.knowledge.evidence?.length === 0
          || scenario === 'empty evidence' && input.knowledge.evidence?.some(chunk => !chunk.text.trim())
          || scenario === 'public citation' && input.knowledge.evidence?.some(chunk => chunk.publicUrl !== candidate.publicUrl);
        return bypass ? [{ requestedUrl: candidate.document.requestedUrl, sourceId: candidate.candidateId,
          publicUrl: candidate.publicUrl }] : policy.projectGamingHybridSuppliedGuides(input);
      });
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

  it('fails closed when a shortened public citation grants current-index authority to an acquired article', () => {
    mockExtract.mockImplementation((document, ...args) => freshness.extractGamingFreshnessMetadata(
      { ...document, canonicalUrl: undefined }, ...args));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when private acquired identity leaks into public freshness evidence', () => {
    mockExtract.mockImplementation((document, ...args) => ({ ...freshness.extractGamingFreshnessMetadata(document, ...args),
      ...(document.canonicalUrl ? { url: document.canonicalUrl } : {}) }));
    expect(runGamingHybridKnowledgePreview).toThrow(FAILURE);
  });

  it('fails closed when public freshness evidence merges distinct ordinary query identities', () => {
    mockExtract.mockImplementation((document, ...args) => {
      const result = freshness.extractGamingFreshnessMetadata(document, ...args);
      return document.publicUrl.includes('?guide=') ? { ...result, id: document.publicUrl.split('?')[0] } : result;
    });
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
