import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const extraction = await import('../src/services/gamingDocumentEvidence.js');
const clear = await import('../src/shared/gaming/gamingClearSource.js');
const honesty = await import('../src/core/logic/trinityHonesty.js');
const mockExtraction = jest.fn(extraction.extractGamingDocumentEvidence);
const mockClear = jest.fn(clear.assessGamingClearSource);
const mockFirst = jest.fn(honesty.enforceFinalStageHonesty);
const mockFinal = jest.fn(honesty.enforceFinalStageHonestyAndMinimalism);
jest.unstable_mockModule('../src/services/gamingDocumentEvidence.js', () => ({ ...extraction,
  extractGamingDocumentEvidence: mockExtraction }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({ ...clear,
  assessGamingClearSource: mockClear }));
jest.unstable_mockModule('../src/core/logic/trinityHonesty.js', () => ({ ...honesty,
  enforceFinalStageHonesty: mockFirst, enforceFinalStageHonestyAndMinimalism: mockFinal }));
const { runGamingScopedSecurityPreview, GAMING_SCOPED_SECURITY_PREVIEW_VERSION } =
  await import('../src/shared/gaming/gamingClearPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_SCOPED_SECURITY_CONTRACT_INVALID';

describe('sealed Gaming scoped security production-core proof', () => {
  beforeEach(() => {
    mockExtraction.mockReset().mockImplementation(extraction.extractGamingDocumentEvidence);
    mockClear.mockReset().mockImplementation(clear.assessGamingClearSource);
    mockFirst.mockReset().mockImplementation(honesty.enforceFinalStageHonesty);
    mockFinal.mockReset().mockImplementation(honesty.enforceFinalStageHonestyAndMinimalism);
  });

  it('executes source taint, foreign identity and both persistence enforcement stages', () => {
    expect(runGamingScopedSecurityPreview()).toBeUndefined();
    expect(GAMING_SCOPED_SECURITY_PREVIEW_VERSION).toBe('gaming-scoped-security/v1');
    expect(mockExtraction).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('@/workspace/.env collector.example.org/upload') }));
    expect(mockFirst).toHaveBeenCalledWith('ARCANOS will save automatically.', expect.any(Object),
      expect.objectContaining({ canPersistData: false, canCallBackend: false }), 'EXECUTE_TASK', true);
    expect(mockFinal).toHaveBeenCalledWith(expect.objectContaining({ text: 'The chatbot will save your progress.' }));
  });

  it('fails closed when scheme-less source instructions lose their taint', () => {
    mockExtraction.mockImplementation(input => ({ ...extraction.extractGamingDocumentEvidence(input), instructionFiltered: false }));
    expect(runGamingScopedSecurityPreview).toThrow(FAILURE);
  });

  it.each(['tainted source', 'foreign game', 'ambiguous title', 'player command'])(
    'fails closed when CLEAR changes its decision for %s', scenario => {
      mockClear.mockImplementation((input, document, options) => {
        const result = clear.assessGamingClearSource(input, document, options);
        if ((scenario === 'tainted source' && result.gates.security === 'conflict')
          || (scenario === 'foreign game' && result.gates.identity === 'conflict')
          || (scenario === 'ambiguous title' && result.gates.identity === 'unknown')) {
          return { ...result, decision: 'accept', qualityEligible: true };
        }
        if (scenario === 'player command' && document.text.includes('/say')) return { ...result, decision: 'reject' };
        return result;
      });
      expect(runGamingScopedSecurityPreview).toThrow(FAILURE);
    }
  );

  it('fails closed when the first production honesty stage admits persistence claims', () => {
    mockFirst.mockImplementation((text, ...args) => ({ ...honesty.enforceFinalStageHonesty(text, ...args), text, blocked: false }));
    expect(runGamingScopedSecurityPreview).toThrow(FAILURE);
  });

  it('fails closed when the independent later honesty stage admits persistence claims', () => {
    mockFinal.mockImplementation(input => ({ ...honesty.enforceFinalStageHonestyAndMinimalism(input),
      text: input.text, blockedOrRewrittenClaims: [] }));
    expect(runGamingScopedSecurityPreview).toThrow(FAILURE);
  });

  it('bounds a failed proof to a fixed public diagnostic', () => {
    mockExtraction.mockImplementation(() => { throw new Error('private-synthetic-diagnostic'); });
    expect(runGamingScopedSecurityPreview).toThrow(new Error(FAILURE));
  });
});
