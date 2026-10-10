import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';
import { jest } from '@jest/globals';

const actualSource = await import('../src/shared/gaming/gamingClearSource.js');
const actualExtraction = await import('../src/services/gamingDocumentEvidence.js');
const actualStructural = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const mockIdentity = jest.fn(actualSource.assessGamingClearSourceIdentity);
const mockExtract = jest.fn(actualExtraction.extractGamingDocumentEvidence);
const mockUsability = jest.fn(actualStructural.assessGamingStructuralUsability);
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({
  ...actualSource, assessGamingClearSourceIdentity: mockIdentity
}));
jest.unstable_mockModule('../src/services/gamingDocumentEvidence.js', () => ({
  ...actualExtraction, extractGamingDocumentEvidence: mockExtract
}));
jest.unstable_mockModule('../src/shared/gaming/gamingStructuralEvidence.js', () => ({
  ...actualStructural, assessGamingStructuralUsability: mockUsability
}));
const { runGamingLiveSourceValidationPreview, GAMING_LIVE_SOURCE_VALIDATION_PREVIEW_CASES } =
  await import('../src/shared/gaming/gamingLiveSourceValidationPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_LIVE_SOURCE_VALIDATION_CONTRACT_INVALID';

describe('sealed synthetic live-source identity and extraction proof', () => {
  beforeEach(() => {
    mockIdentity.mockReset().mockImplementation(actualSource.assessGamingClearSourceIdentity);
    mockExtract.mockReset().mockImplementation(actualExtraction.extractGamingDocumentEvidence);
    mockUsability.mockReset().mockImplementation(actualStructural.assessGamingStructuralUsability);
  });

  it('executes identity, long prose, independent structural integrity and rejection assertions', () => {
    const report = runGamingLiveSourceValidationPreview();
    expect(report).toEqual(expect.objectContaining({ version: 'gaming-live-source-validation/v1',
      scope: 'pure-synthetic-identity-structural-extraction', cases: expect.any(Array) }));
    expect(report.cases.map(entry => entry.id)).toEqual([...GAMING_LIVE_SOURCE_VALIDATION_PREVIEW_CASES]);
    expect(report.cases.map(entry => entry.checks)).toEqual([...NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.liveSourceValidationReportChecks]);
    expect(report.cases.every(entry => entry.checks > 0 && entry.passed === entry.checks
      && Object.keys(entry.values).length > 0)).toBe(true);
    expect(GAMING_LIVE_SOURCE_VALIDATION_PREVIEW_CASES).toContain('deep-independent-structured-records');
    expect(mockIdentity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { title: 'Dexterity build guide' }
    }), expect.objectContaining({ game: 'Elden Ring', edition: 'base game' }), expect.anything());
    expect(mockExtract).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'text/html', sourceUrl: 'https://live-source-preview.example/elden-ring/samurai', transportTruncated: false
    }));
  });

  it('executes primary qualification rejection against supported structural tuples', () => {
    const report = runGamingLiveSourceValidationPreview();
    for (const id of ['deep-independent-structured-records', 'embedded-json-late-qualification']) {
      expect(report.cases.find(entry => entry.id === id)?.values).toEqual(expect.objectContaining({
        unqualifiedClaimSupported: true, primaryQualifierVariants: 8,
        primaryUnconfirmedRetained: true, primaryUnavailableRetained: true,
        qualifiedClaimSupported: false, qualifiedReason: 'QUALIFIED_RECORD_NOT_AFFIRMATIVE'
      }));
    }
  });

  it('fails closed when primary qualifications disappear from comparison-shaped prose', () => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return input.body.includes('Unlike earlier versions,') ? { ...result,
        units: result.units.map(unit => ({ ...unit, context: { ...unit.context, qualifiers: [] } })) } : result;
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it('fails closed when primary qualified tuples receive affirmative structural support', () => {
    mockUsability.mockImplementation(input => {
      const result = actualStructural.assessGamingStructuralUsability(input);
      return input.units?.some(unit => unit.context.qualifiers?.some(value => value.startsWith('Unlike earlier versions,')))
        ? { ...result, claimSupported: true, reasonCodes: ['INTACT_RECORD_CLAIM_SUPPORTED'] } : result;
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
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

  it('fails closed when an adjacent inline comparison contaminates record edition scope', () => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return input.body.includes('Unlike <strong>Correction:') ? { ...result,
        units: result.units.map(unit => ({ ...unit, context: { ...unit.context,
          qualifiers: ['Correction: Nightreign equipment is no longer available.'] } })) } : result;
    });
    expect(runGamingLiveSourceValidationPreview).toThrow(FAILURE);
  });

  it.each([false, true])('fails closed when formatted correction is lost from JSON=%s records', jsonOnly => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return input.body.includes('<strong>Correction:</strong>') ? { ...result,
        units: result.units.map(unit => Boolean(unit.provenance.jsonOnly) === jsonOnly
          ? { ...unit, context: { ...unit.context, qualifiers: [] } } : unit) } : result;
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
