import { jest } from '@jest/globals';

const actualSource = await import('../src/shared/gaming/gamingClearSource.js');
const actualExtraction = await import('../src/services/gamingDocumentEvidence.js');
const mockIdentity = jest.fn(actualSource.assessGamingClearSourceIdentity);
const mockExtract = jest.fn(actualExtraction.extractGamingDocumentEvidence);
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({
  ...actualSource, assessGamingClearSourceIdentity: mockIdentity
}));
jest.unstable_mockModule('../src/services/gamingDocumentEvidence.js', () => ({
  ...actualExtraction, extractGamingDocumentEvidence: mockExtract
}));
const { runGamingLiveSourceValidationPreview, GAMING_LIVE_SOURCE_VALIDATION_PREVIEW_CASES } =
  await import('../src/shared/gaming/gamingLiveSourceValidationPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_LIVE_SOURCE_VALIDATION_CONTRACT_INVALID';

describe('sealed synthetic live-source identity and extraction proof', () => {
  beforeEach(() => {
    mockIdentity.mockReset().mockImplementation(actualSource.assessGamingClearSourceIdentity);
    mockExtract.mockReset().mockImplementation(actualExtraction.extractGamingDocumentEvidence);
  });

  it('executes identity, long prose, independent structural integrity and rejection assertions', () => {
    runGamingLiveSourceValidationPreview();
    expect(GAMING_LIVE_SOURCE_VALIDATION_PREVIEW_CASES).toContain('deep-independent-structured-records');
    expect(mockIdentity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { title: 'Dexterity build guide' }
    }), expect.objectContaining({ game: 'Elden Ring', edition: 'base game' }), expect.anything());
    expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'text/html', sourceUrl: 'https://live-source-preview.example/elden-ring/samurai', transportTruncated: false
    }));
  });

  it('fails closed when ordinary gameplay is classified as a conflicting game', () => {
    mockIdentity.mockImplementationOnce((doc, input, policy, partial) => ({
      ...actualSource.assessGamingClearSourceIdentity(doc, input, policy, partial),
      status: 'conflict', reasonCodes: ['GAME_MISMATCH']
    }));
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when unrelated headings cause a false conflict', () => {
    mockIdentity.mockImplementation((doc, input, policy, partial) => doc.metadata.headings
      ? { ...actualSource.assessGamingClearSourceIdentity(doc, input, policy, partial),
        status: 'conflict', reasonCodes: ['GAME_MISMATCH'] }
      : actualSource.assessGamingClearSourceIdentity(doc, input, policy, partial));
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when an unrelated recommended heading supplies positive game identity', () => {
    mockIdentity.mockImplementation((doc, input, policy, partial) => {
      const result = actualSource.assessGamingClearSourceIdentity(doc, input, policy, partial);
      return doc.metadata.headings === 'Recommended: Elden Ring build guide' ? { ...result, status: 'verified' } : result;
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when an unrelated recommended heading supplies positive edition applicability', () => {
    mockIdentity.mockImplementation((doc, input, policy, partial) => {
      const result = actualSource.assessGamingClearSourceIdentity(doc, input, policy, partial);
      return doc.metadata.headings === 'Recommended: Elden Ring Shadow of the Erdtree build guide'
        ? { ...result, status: 'verified' } : result;
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when independent complete evidence is downgraded by wrapper or prose volume', () => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return { ...result, units: result.units.map(unit => ({ ...unit,
        integrity: { status: 'partial' as const, reasons: ['required_context_missing'] } })) };
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when extracted fields lose citation provenance', () => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return { ...result, units: result.units.map(unit => ({ ...unit,
        provenance: { ...unit.provenance, sourceUrl: 'https://wrong.example/guide' } })) };
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when a contradictory primary Nightreign heading is accepted behind an SEO title', () => {
    mockIdentity.mockImplementation((doc, input, policy, partial) => {
      const result = actualSource.assessGamingClearSourceIdentity(doc, input, policy, partial);
      return doc.metadata.headings?.startsWith('Elden Ring Nightreign') ? { ...result, status: 'verified' } : result;
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when embedded JSON loses its late acquired qualification', () => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return { ...result, units: result.units.map(unit => unit.provenance.jsonOnly
        ? { ...unit, context: { ...unit.context, qualifiers: [] } } : unit) };
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });
});
