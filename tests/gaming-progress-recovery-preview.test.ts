import { jest } from '@jest/globals';

const context = await import('../src/shared/gaming/gamingPlayerContext.js');
const progression = await import('../src/shared/gaming/gamingProgressionPolicy.js');
const retrieval = await import('../src/shared/gaming/gamingRetrievalPolicy.js');
const evidence = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const identity = await import('../src/shared/gaming/gamingGameIdentity.js');
const recovery = await import('../src/shared/gaming/gamingRecoveryResponse.js');
const mockContext = jest.fn(context.resolveGamingPlayerContext);
const mockAssess = jest.fn(progression.assessGamingProgressionRequest);
const mockTerms = jest.fn(retrieval.buildGamingRetrievalTerms);
const mockSelect = jest.fn(evidence.selectStoredGamingEvidence);
const mockFormat = jest.fn(evidence.formatStoredGamingEvidence);
const mockNormalizeIdentity = jest.fn(identity.normalizeGamingGameIdentity);
const mockResolveIdentity = jest.fn(identity.resolveGamingGuideIdentity);
const mockClass = jest.fn(recovery.resolveGamingRecoveryClass);
const mockResponse = jest.fn(recovery.buildGamingRecoveryResponse);
jest.unstable_mockModule('../src/shared/gaming/gamingPlayerContext.js', () => ({ ...context, resolveGamingPlayerContext: mockContext }));
jest.unstable_mockModule('../src/shared/gaming/gamingProgressionPolicy.js', () => ({ ...progression, assessGamingProgressionRequest: mockAssess }));
jest.unstable_mockModule('../src/shared/gaming/gamingRetrievalPolicy.js', () => ({ ...retrieval, buildGamingRetrievalTerms: mockTerms }));
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({ ...evidence, selectStoredGamingEvidence: mockSelect, formatStoredGamingEvidence: mockFormat }));
jest.unstable_mockModule('../src/shared/gaming/gamingGameIdentity.js', () => ({ ...identity, normalizeGamingGameIdentity: mockNormalizeIdentity, resolveGamingGuideIdentity: mockResolveIdentity }));
jest.unstable_mockModule('../src/shared/gaming/gamingRecoveryResponse.js', () => ({ ...recovery, resolveGamingRecoveryClass: mockClass, buildGamingRecoveryResponse: mockResponse }));
const { runGamingProgressRecoveryPreview, GAMING_PROGRESS_RECOVERY_PREVIEW_VERSION } = await import('../src/shared/gaming/gamingProgressRecoveryPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_PROGRESS_RECOVERY_CONTRACT_INVALID';

describe('sealed Gaming progression and recovery production-core proof', () => {
  beforeEach(() => {
    mockContext.mockReset().mockImplementation(context.resolveGamingPlayerContext);
    mockAssess.mockReset().mockImplementation(progression.assessGamingProgressionRequest);
    mockTerms.mockReset().mockImplementation(retrieval.buildGamingRetrievalTerms);
    mockSelect.mockReset().mockImplementation(evidence.selectStoredGamingEvidence);
    mockFormat.mockReset().mockImplementation(evidence.formatStoredGamingEvidence);
    mockNormalizeIdentity.mockReset().mockImplementation(identity.normalizeGamingGameIdentity);
    mockResolveIdentity.mockReset().mockImplementation(identity.resolveGamingGuideIdentity);
    mockClass.mockReset().mockImplementation(recovery.resolveGamingRecoveryClass);
    mockResponse.mockReset().mockImplementation(recovery.buildGamingRecoveryResponse);
  });

  it('repeats the fixed production-core corpus without caller data', () => {
    expect(runGamingProgressRecoveryPreview).not.toThrow();
    expect(runGamingProgressRecoveryPreview).not.toThrow();
    expect(GAMING_PROGRESS_RECOVERY_PREVIEW_VERSION).toBe('gaming-progress-recovery/v1');
    expect(mockAssess).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'What next?', currentArea: 'Copper Quay' }));
    expect(mockTerms).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'I have not found the Zephyrglass Compass.' }));
    expect(mockSelect).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ currentArea: 'Glass Observatory', limit: 1 }), expect.objectContaining({ maxContextChars: 2400, maxChunks: 3 }));
    expect(mockNormalizeIdentity).toHaveBeenCalledWith('Lantern Voyage HD 1.5 Remix');
    expect(mockResolveIdentity).toHaveBeenCalledWith('Lantern Voyage: Remake', 'Remake');
    expect(mockClass).toHaveBeenCalledWith(expect.objectContaining({ sourceKnown: true, evidenceSelected: false, timedOut: true }));
    expect(mockClass).toHaveBeenCalledWith(expect.objectContaining({ evidenceSelected: true, timedOut: true }));
  });

  it.each(['What next?', "I haven't defeated the Glass Warden. What next?", 'If I defeated the Glass Warden, what next?'])('fails closed when %s stops clarifying', prompt => {
    mockAssess.mockImplementation(input => ({ ...progression.assessGamingProgressionRequest(input), ...(input.prompt === prompt ? { clarificationNeeded: false } : {}) }));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when conflicting player claims are erased', () => {
    mockContext.mockImplementation((...args) => ({ ...context.resolveGamingPlayerContext(...args), contextConflicts: [] }));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when a named negative task loses its retrieval target', () => {
    mockTerms.mockImplementation(input => input.prompt === 'I have not found the Zephyrglass Compass.'
      ? { requestTerms: [], contextTerms: ['copper', 'quay'], focusTerms: ['copper', 'quay'] }
      : retrieval.buildGamingRetrievalTerms(input));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when unrelated current-area evidence replaces a named target', () => {
    mockSelect.mockImplementation((...args) => evidence.selectStoredGamingEvidence(...args).map(candidate =>
      candidate.evidence.recordId === 'named-target' ? { ...candidate, evidence: { ...candidate.evidence, recordId: 'generic-area' } } : candidate));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when checkpoint context selects the other progression point', () => {
    mockSelect.mockImplementation((...args) => evidence.selectStoredGamingEvidence(...args).map(candidate =>
      candidate.evidence.recordId === 'early-checkpoint' ? { ...candidate, evidence: { ...candidate.evidence, recordId: 'later-checkpoint' } } : candidate));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when selected evidence is lost during formatting', () => {
    mockFormat.mockImplementation((...args) => ({ ...evidence.formatStoredGamingEvidence(...args), context: '' }));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when precise titles collapse to the base game', () => {
    mockNormalizeIdentity.mockReturnValue('lantern-voyage');
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when an explicit edition stops narrowing identity', () => {
    mockResolveIdentity.mockImplementation(game => identity.normalizeGamingGameIdentity(game));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when a known catalog source is treated as selected evidence', () => {
    mockClass.mockImplementation(input => input.prompt === 'How do I beat the Glass Warden?' && input.sourceKnown && !input.evidenceSelected && input.timedOut
      ? 'provider_timeout_with_evidence' : recovery.resolveGamingRecoveryClass(input));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when timeout recovery is misclassified as a source failure', () => {
    mockClass.mockImplementation(input => input.evidenceSelected && input.timedOut ? 'source_unavailable' : recovery.resolveGamingRecoveryClass(input));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when recovery invents gameplay actions', () => {
    mockResponse.mockImplementation(input => `${recovery.buildGamingRecoveryResponse(input)} Upgrade your gear and stock healing items.`);
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('fails closed when recovery falsely advertises an unknown guide', () => {
    mockResponse.mockImplementation(input => recovery.buildGamingRecoveryResponse({ ...input, sourceKnown: true }));
    expect(runGamingProgressRecoveryPreview).toThrow(FAILURE);
  });

  it('returns only the fixed failure message after an unexpected production-seam exception', () => {
    mockSelect.mockImplementation(() => { throw new Error('private-preview-sentinel'); });
    let failure: unknown;
    try { runGamingProgressRecoveryPreview(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain('private-preview-sentinel');
  });
});
