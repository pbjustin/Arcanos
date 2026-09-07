import { jest } from '@jest/globals';

const context = await import('../src/shared/gaming/gamingPlayerContext.js');
const evidence = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const prompt = await import('../src/shared/gaming/gamingPromptCore.js');
const response = await import('../src/shared/gaming/gamingGuideResponseCore.js');
const intake = await import('../src/shared/gaming/gamingGuideIntakeCore.js');
const mockContext = jest.fn(context.resolveGamingPlayerContext);
const mockSelect = jest.fn(evidence.selectStoredGamingEvidence);
const mockFormat = jest.fn(evidence.formatStoredGamingEvidence);
const mockPrompt = jest.fn(prompt.buildGamingTrinityPrompt);
const mockCompose = jest.fn(response.composeGroundedGamingGuideResponse);
const mockIntake = jest.fn(intake.buildGamingGuideIntakeContract);
jest.unstable_mockModule('../src/shared/gaming/gamingPlayerContext.js', () => ({ ...context, resolveGamingPlayerContext: mockContext }));
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({ ...evidence, selectStoredGamingEvidence: mockSelect, formatStoredGamingEvidence: mockFormat }));
jest.unstable_mockModule('../src/shared/gaming/gamingPromptCore.js', () => ({ ...prompt, buildGamingTrinityPrompt: mockPrompt }));
jest.unstable_mockModule('../src/shared/gaming/gamingGuideResponseCore.js', () => ({ ...response, composeGroundedGamingGuideResponse: mockCompose }));
jest.unstable_mockModule('../src/shared/gaming/gamingGuideIntakeCore.js', () => ({ ...intake, buildGamingGuideIntakeContract: mockIntake }));
const { runGamingGuideAssistancePreview, GAMING_GUIDE_ASSISTANCE_PREVIEW_VERSION } = await import('../src/shared/gaming/gamingGuideAssistancePreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_GUIDE_ASSISTANCE_CONTRACT_INVALID';

describe('sealed Gaming guide assistance production-core component proof', () => {
  beforeEach(() => {
    mockContext.mockReset().mockImplementation(context.resolveGamingPlayerContext);
    mockSelect.mockReset().mockImplementation(evidence.selectStoredGamingEvidence);
    mockFormat.mockReset().mockImplementation(evidence.formatStoredGamingEvidence);
    mockPrompt.mockReset().mockImplementation(prompt.buildGamingTrinityPrompt);
    mockCompose.mockReset().mockImplementation(response.composeGroundedGamingGuideResponse);
    mockIntake.mockReset().mockImplementation(intake.buildGamingGuideIntakeContract);
  });

  it('composes validated context, lexical evidence, prompt and response policies for three synthetic domains', () => {
    expect(runGamingGuideAssistancePreview).not.toThrow();
    expect(GAMING_GUIDE_ASSISTANCE_PREVIEW_VERSION).toBe('gaming-guide-assistance/v1');
    for (const game of ['Lantern Vale', 'Iron Wake', 'Vector Harbor']) {
      expect(mockSelect).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ game }), expect.objectContaining({ maxContextChars: 5000, maxChunks: 6 }));
    }
    expect(mockPrompt).toHaveBeenCalledWith(expect.objectContaining({ currentArea: 'Copper Canal', spoilerMode: 'none' }), expect.stringContaining('lit bridge lamp'), true, true, expect.any(Object));
    expect(mockPrompt).toHaveBeenCalledWith(expect.objectContaining({ game: 'Iron Wake', answerDepth: 'detailed' }), expect.stringContaining('exact timings'), true, true, expect.any(Object));
    expect(mockCompose).toHaveBeenCalledWith('guide', expect.objectContaining({ data: expect.objectContaining({ fallbackReason: 'PROVIDER_COMPLETION_INCOMPLETE' }) }));
  });

  it('fails closed when a validated optional context field disappears', () => {
    mockContext.mockImplementation((...args) => {
      const result = context.resolveGamingPlayerContext(...args);
      delete result.platform;
      return result;
    });
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
  });

  it('fails closed when selection returns no support for the fixed valid guide', () => {
    mockSelect.mockReturnValueOnce([]);
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
  });

  it('fails closed when provenance or source numbering is damaged', () => {
    mockFormat.mockImplementation((...args) => {
      const result = evidence.formatStoredGamingEvidence(...args);
      return { ...result, context: result.context.replace('[Source 1]', '[Source 9]') };
    });
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
  });

  it('fails closed when the effective spoiler policy disappears from the prompt', () => {
    mockPrompt.mockImplementation((...args) => prompt.buildGamingTrinityPrompt(...args).replace('Spoilers: none.', 'Spoilers: full.'));
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
  });

  it.each(['allocation', 'attempts', 'instructions'])('fails closed after intake %s drift', drift => {
    mockIntake.mockImplementation(model => ({
      ...intake.buildGamingGuideIntakeContract(model),
      ...(drift === 'allocation' ? { outputAllocation: 501 as 500 } : {}),
      ...(drift === 'attempts' ? { maxAttempts: 2 as 1 } : {}),
      ...(drift === 'instructions' ? { instructions: 'Write a complete walkthrough.' } : {})
    }));
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
  });

  it('fails closed when incomplete fallback is accepted as ordinary guide composition', () => {
    mockCompose.mockImplementation((mode, envelope) => envelope.data.fallbackReason ? envelope : response.composeGroundedGamingGuideResponse(mode, envelope));
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
  });

  it('masks unexpected failures without reflecting private exception details', () => {
    mockIntake.mockImplementation(() => { throw new Error('private-preview-sentinel'); });
    expect(runGamingGuideAssistancePreview).toThrow(FAILURE);
    expect(runGamingGuideAssistancePreview).not.toThrow('private-preview-sentinel');
  });
});
