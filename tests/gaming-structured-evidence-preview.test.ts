import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actualExtract = await import('../src/services/gamingDocumentEvidence.js');
const actualStructural = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const actualSource = await import('../src/shared/gaming/gamingClearSource.js');
const actualClear = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualChunks = await import('../src/services/gamingDurableDocumentChunks.js');
const actualStored = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const extract = jest.fn(actualExtract.extractGamingDocumentEvidence);
const structural = jest.fn(actualStructural.assessGamingStructuralUsability);
const source = jest.fn(actualSource.assessGamingClearSource);
const intact = jest.fn(actualSource.gamingClearIntactSourceText);
const clear = jest.fn(actualClear.assessGamingClearEvidence);
const chunks = jest.fn(actualChunks.chunkGamingDocument);
const hash = jest.fn(actualChunks.hashGamingDocumentRevision);
const select = jest.fn(actualStored.selectStoredGamingEvidence);
const format = jest.fn(actualStored.formatStoredGamingEvidence);
jest.unstable_mockModule('../src/services/gamingDocumentEvidence.js', () => ({ ...actualExtract, extractGamingDocumentEvidence: extract }));
jest.unstable_mockModule('../src/shared/gaming/gamingStructuralEvidence.js', () => ({ ...actualStructural, assessGamingStructuralUsability: structural }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearSource.js', () => ({ ...actualSource, assessGamingClearSource: source, gamingClearIntactSourceText: intact }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...actualClear, assessGamingClearEvidence: clear }));
jest.unstable_mockModule('../src/services/gamingDurableDocumentChunks.js', () => ({ ...actualChunks, chunkGamingDocument: chunks, hashGamingDocumentRevision: hash }));
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({ ...actualStored, selectStoredGamingEvidence: select, formatStoredGamingEvidence: format }));
const { runGamingStructuredEvidencePreview, GAMING_STRUCTURED_EVIDENCE_PREVIEW_VERSION } =
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
  });

  it('runs actual extraction, source/evidence CLEAR, chunking and stored selection repeatedly without caller data', async () => {
    await expect(runGamingStructuredEvidencePreview()).resolves.toBeUndefined();
    await expect(runGamingStructuredEvidencePreview()).resolves.toBeUndefined();
    expect(GAMING_STRUCTURED_EVIDENCE_PREVIEW_VERSION).toBe('gaming-structured-evidence/v1');
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'application/json' }));
    expect(source).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: expect.any(String), evidenceUnits: expect.any(Array) }), expect.any(Object));
    expect(source.mock.calls.some(([, doc]) => doc.text.length < 120 && !/[.!?]$/u.test(doc.text))).toBe(true);
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({ game: 'Ashfall' }));
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({ game: 'Rift Seasons' }));
    expect(chunks.mock.calls.some(([text]) => text.length > 100_000)).toBe(true);
    expect(select.mock.calls.some(([rows]) => rows[0]?.revisionId === 'synthetic-structured-revision')).toBe(true);
    expect(clear).toHaveBeenCalled();
    expect(hash).toHaveBeenCalled();
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
