import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actualExtract = await import('../src/services/gamingDocumentEvidence.js');
const actualStructural = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const actualSource = await import('../src/shared/gaming/gamingClearSource.js');
const actualClear = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualChunks = await import('../src/services/gamingDurableDocumentChunks.js');
const actualStored = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const actualFreshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const extract = jest.fn(actualExtract.extractGamingDocumentEvidence);
const structural = jest.fn(actualStructural.assessGamingStructuralUsability);
const source = jest.fn(actualSource.assessGamingClearSource);
const intact = jest.fn(actualSource.gamingClearIntactSourceText);
const clear = jest.fn(actualClear.assessGamingClearEvidence);
const chunks = jest.fn(actualChunks.chunkGamingDocument);
const hash = jest.fn(actualChunks.hashGamingDocumentRevision);
const select = jest.fn(actualStored.selectStoredGamingEvidence);
const format = jest.fn(actualStored.formatStoredGamingEvidence);
const editionScope = jest.fn(actualStructural.selectGamingEditionScopedEvidence);
const freshness = jest.fn(actualFreshness.extractGamingFreshnessMetadata);
const evaluateFreshness = jest.fn(actualFreshness.evaluateGamingFreshness);
jest.unstable_mockModule('../src/services/gamingDocumentEvidence.js', () => ({ ...actualExtract, extractGamingDocumentEvidence: extract }));
jest.unstable_mockModule('../src/shared/gaming/gamingStructuralEvidence.js', () => ({ ...actualStructural,
  assessGamingStructuralUsability: structural, selectGamingEditionScopedEvidence: editionScope }));
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...actualFreshness,
  extractGamingFreshnessMetadata: freshness, evaluateGamingFreshness: evaluateFreshness }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({ ...actualSource, assessGamingClearSource: source, gamingClearIntactSourceText: intact }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...actualClear, assessGamingClearEvidence: clear }));
jest.unstable_mockModule('../src/services/gamingDurableDocumentChunks.js', () => ({ ...actualChunks, chunkGamingDocument: chunks, hashGamingDocumentRevision: hash }));
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({ ...actualStored, selectStoredGamingEvidence: select, formatStoredGamingEvidence: format }));
const { runGamingStructuredEvidencePreview, GAMING_STRUCTURED_EVIDENCE_PREVIEW_VERSION, GAMING_BASE_GAME_SCOPE_PREVIEW_VERSION } =
  await import('../src/shared/gaming/gamingStructuredEvidencePreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_STRUCTURED_EVIDENCE_CONTRACT_INVALID';

describe('sealed Gaming structured evidence component proof', () => {
  beforeEach(() => {
    extract.mockReset().mockImplementation(actualExtract.extractGamingDocumentEvidence);
    structural.mockReset().mockImplementation(actualStructural.assessGamingStructuralUsability);
    source.mockReset().mockImplementation(actualSource.assessGamingClearSource);
    intact.mockReset().mockImplementation(actualSource.gamingClearIntactSourceText);
    clear.mockReset().mockImplementation(actualClear.assessGamingClearEvidence);
    chunks.mockReset().mockImplementation(actualChunks.chunkGamingDocument);
    hash.mockReset().mockImplementation(actualChunks.hashGamingDocumentRevision);
    select.mockReset().mockImplementation(actualStored.selectStoredGamingEvidence);
    format.mockReset().mockImplementation(actualStored.formatStoredGamingEvidence);
    editionScope.mockReset().mockImplementation(actualStructural.selectGamingEditionScopedEvidence);
    freshness.mockReset().mockImplementation(actualFreshness.extractGamingFreshnessMetadata);
    evaluateFreshness.mockReset().mockImplementation(actualFreshness.evaluateGamingFreshness);
  });

  it('runs actual extraction, source/evidence CLEAR, chunking and stored selection repeatedly without caller data', async () => {
    await expect(runGamingStructuredEvidencePreview()).resolves.toBeUndefined();
    await expect(runGamingStructuredEvidencePreview()).resolves.toBeUndefined();
    expect(GAMING_STRUCTURED_EVIDENCE_PREVIEW_VERSION).toBe('gaming-structured-evidence/v1');
    expect(GAMING_BASE_GAME_SCOPE_PREVIEW_VERSION).toBe('gaming-base-game-scope/v1');
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'application/json' }));
    expect(source).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: expect.any(String), evidenceUnits: expect.any(Array) }), expect.any(Object));
    expect(source.mock.calls.some(([, doc]) => doc.text.length < 120 && !/[.!?]$/u.test(doc.text))).toBe(true);
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({ game: 'Ashfall' }));
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({ game: 'Rift Seasons' }));
    expect(chunks.mock.calls.some(([text]) => text.length > 100_000)).toBe(true);
    expect(select.mock.calls.some(([rows]) => rows[0]?.revisionId === 'synthetic-structured-revision')).toBe(true);
    expect(clear).toHaveBeenCalled();
    expect(hash).toHaveBeenCalled();
    expect(editionScope).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ game: 'Elden Ring', edition: 'Base game' }));
    expect(freshness).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ game: 'Elden Ring', edition: 'Base game' }), expect.any(Date), expect.any(Array));
    expect(evaluateFreshness).toHaveBeenCalledWith(expect.objectContaining({ game: 'Elden Ring', requestedVersion: '1.16' }));
  });

  it('detects excluded edition facts restored into the selected projection', async () => {
    editionScope.mockImplementation((doc, input) => {
      const selected = actualStructural.selectGamingEditionScopedEvidence(doc, input);
      return selected.status === 'verified' ? { ...selected, text: doc.text, units: [...doc.evidenceUnits ?? []] } : selected;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('keeps explicit DLC-only records conflicting despite a base-game prose label', async () => {
    await runGamingStructuredEvidencePreview();
    const index = editionScope.mock.calls.findIndex(([doc]) => doc.text.startsWith('Edition: Base game.')
      && doc.evidenceUnits?.some(unit => unit.fields.some(field => field.label === 'Scope' && field.value === 'Shadow of the Erdtree')));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(editionScope.mock.results[index].value).toMatchObject({ status: 'conflict', reasonCodes: ['CONFLICTING_EDITION_SCOPE'], units: [], text: '' });
    const conflictingDocument = editionScope.mock.calls[index][0];
    const assessmentIndex = source.mock.calls.findIndex(([, doc]) => doc === conflictingDocument);
    expect(assessmentIndex).toBeGreaterThanOrEqual(0);
    expect(source.mock.results[assessmentIndex].value).toMatchObject({ decision: 'reject', gates: { identity: 'verified', compatibility: 'conflict' },
      dimensionScores: { alignment: { reasonCodes: ['EDITION_CONFLICT'] } } });
  });

  it('detects explicit edition conflicts downgraded to unknown scope', async () => {
    editionScope.mockImplementation((doc, input) => {
      const selected = actualStructural.selectGamingEditionScopedEvidence(doc, input);
      return selected.status === 'conflict' && selected.reasonCodes.includes('CONFLICTING_EDITION_SCOPE')
        ? { ...selected, status: 'unverified' } : selected;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects names or unsupported scope values used as base-game proof', async () => {
    editionScope.mockImplementation((doc, input) => {
      const selected = actualStructural.selectGamingEditionScopedEvidence(doc, input);
      return selected.status === 'unverified' ? { ...selected, status: 'verified', text: doc.text, units: [...doc.evidenceUnits ?? []] } : selected;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects record-level scope granting original-page storage eligibility', async () => {
    source.mockImplementation((input, doc, options) => {
      const assessment = actualSource.assessGamingClearSource(input, doc, options);
      return input.edition === 'Base game' ? { ...assessment, qualityEligible: true } : assessment;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects excluded DLC patch metadata promoted to base-game currentness', async () => {
    freshness.mockImplementation((doc, input, ...args) => {
      const metadata = actualFreshness.extractGamingFreshnessMetadata(doc, input, ...args);
      return input.edition && doc.text.includes('DLC_SCOPE_SENTINEL') && !metadata.patch
        ? { ...metadata, patch: '1.16', metadataConfidence: 'content_extracted' } : metadata;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it.each(['global edition', 'metadata bound', 'partial metadata'])('detects loss of the %s applicability veto', async scenario => {
    freshness.mockImplementation((doc, input, ...args) => {
      const metadata = actualFreshness.extractGamingFreshnessMetadata(doc, input, ...args);
      if (!input.edition) return metadata;
      const change = scenario === 'global edition' ? metadata.edition === 'Shadow of the Erdtree'
        : scenario === 'metadata bound' ? doc.text.length > 32_000 : doc.evidenceUnits?.some(unit => unit.integrity.status !== 'complete');
      return change ? { ...metadata, edition: 'base-game', metadataUnverified: undefined } : metadata;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it.each(['no recovered units', 'padding workaround', 'wrong field association', 'lost provenance'])(
    'fails when extraction drifts: %s', async scenario => {
      extract.mockImplementationOnce(input => {
        const result = actualExtract.extractGamingDocumentEvidence(input);
        if (scenario === 'no recovered units') return { ...result, units: [] };
        return { ...result, units: result.units.map(unit => scenario === 'padding workaround'
          ? { ...unit, text: unit.text + ' Artificial padding.'.repeat(8) }
          : scenario === 'wrong field association' ? { ...unit, fields: unit.fields.map(field => field.label === 'Site' ? { ...field, value: 'PML 8' } : field) }
            : { ...unit, provenance: { ...unit.provenance, sourceUrl: 'https://other.example/records' } }) };
      });
      await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
    }
  );

  it('rejects the old downstream prose floor returning for intact short records', async () => {
    source.mockImplementation((input, doc, options) => {
      const result = actualSource.assessGamingClearSource(input, doc, options);
      return doc.text.length < 120 ? { ...result, decision: 'reject', qualityEligible: false } : result;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects field sufficiency bypasses even though the positive cases pass', async () => {
    structural.mockImplementation(input => ({ ...actualStructural.assessGamingStructuralUsability(input), claimSupported: true }));
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects source currentness bypasses after the successful structural lifecycle', async () => {
    source.mockImplementation((input, doc, options) => {
      const result = actualSource.assessGamingClearSource(input, doc, options);
      return result.gates.freshness === 'unknown' ? { ...result, decision: 'accept', gates: { ...result.gates, freshness: 'verified' } } : result;
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects truncated or ambiguous records becoming intact fallback prose', async () => {
    intact.mockImplementation(doc => doc.text);
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects chunk provenance loss', async () => {
    chunks.mockImplementationOnce(async (...args) => {
      const result = await actualChunks.chunkGamingDocument(...args);
      return { ...result, chunks: result.chunks.map(chunk => ({ ...chunk, evidenceUnits: undefined })) };
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects relevant short records lost at later stored selection', async () => {
    select.mockReturnValueOnce([]);
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects citation provenance erased during context formatting', async () => {
    format.mockImplementationOnce((...args) => {
      const result = actualStored.formatStoredGamingEvidence(...args);
      return { ...result, evidence: result.evidence?.map(evidence => ({ ...evidence, evidenceUnits: undefined })) };
    });
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects complete short evidence rejected by evidence CLEAR', async () => {
    clear.mockImplementationOnce((...args) => ({ ...actualClear.assessGamingClearEvidence(...args), decision: 'reject' }));
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('detects substantive late records omitted from revision hashes', async () => {
    hash.mockReturnValue('a'.repeat(64));
    await expect(runGamingStructuredEvidencePreview()).rejects.toThrow(FAILURE);
  });

  it('exposes only the fixed failure without a cause or underlying parser diagnostics', async () => {
    extract.mockImplementationOnce(() => { throw new Error('TEST-PRIVATE-PARSER-DIAGNOSTIC'); });
    const failure = await runGamingStructuredEvidencePreview().then(() => null, error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe(FAILURE);
    expect(failure?.cause).toBeUndefined();
    expect(String(failure)).not.toContain('TEST-PRIVATE-PARSER-DIAGNOSTIC');
  });
});
