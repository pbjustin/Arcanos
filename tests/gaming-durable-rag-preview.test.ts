import { jest } from '@jest/globals';

const actualChunks = await import('../src/services/gamingDurableDocumentChunks.js');
const actualEvidence = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const actualArchive = await import('../src/shared/gaming/gamingArchiveResourceCore.js');
const actualSearch = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const mockChunks = jest.fn(actualChunks.chunkGamingDocument);
const mockHash = jest.fn(actualChunks.hashGamingDocumentRevision);
const mockSelect = jest.fn(actualEvidence.selectStoredGamingEvidence);
const mockFormat = jest.fn(actualEvidence.formatStoredGamingEvidence);
const mockArchive = jest.fn(actualArchive.resolveGamingArchiveResourceCore);
const mockSearch = jest.fn(actualSearch.buildGamingDocumentSearchText);
jest.unstable_mockModule('../src/services/gamingDurableDocumentChunks.js', () => ({
  ...actualChunks, chunkGamingDocument: mockChunks, hashGamingDocumentRevision: mockHash
}));
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({
  ...actualEvidence, selectStoredGamingEvidence: mockSelect, formatStoredGamingEvidence: mockFormat
}));
jest.unstable_mockModule('../src/shared/gaming/gamingArchiveResourceCore.js', () => ({
  ...actualArchive, resolveGamingArchiveResourceCore: mockArchive
}));
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentIngestionCore.js', () => ({
  ...actualSearch, buildGamingDocumentSearchText: mockSearch
}));
const { runGamingDurableRagPreview } = await import('../src/shared/gaming/gamingDurableRagPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_DURABLE_RAG_CONTRACT_INVALID';

describe('sealed Gaming durable document and RAG component proof', () => {
  beforeEach(() => {
    mockChunks.mockReset().mockImplementation(actualChunks.chunkGamingDocument);
    mockHash.mockReset().mockImplementation(actualChunks.hashGamingDocumentRevision);
    mockSelect.mockReset().mockImplementation(actualEvidence.selectStoredGamingEvidence);
    mockFormat.mockReset().mockImplementation(actualEvidence.formatStoredGamingEvidence);
    mockArchive.mockReset().mockImplementation(actualArchive.resolveGamingArchiveResourceCore);
    mockSearch.mockReset().mockImplementation(actualSearch.buildGamingDocumentSearchText);
  });

  it('executes fixed large-document, ranking, formatting and Archive policies without configured I/O', async () => {
    await expect(runGamingDurableRagPreview()).resolves.toBeUndefined();
    expect(mockChunks.mock.calls[0][0].length).toBeGreaterThan(590_000);
    expect(mockChunks.mock.calls[0][0].indexOf('fictional Zephyrglass Compass')).toBeGreaterThan(590_000);
    expect(mockSelect).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ prompt: 'Zephyrglass Compass' }),
      expect.objectContaining({ chunkChars: 1_200, maxChunks: 8, maxSources: 3, maxContextChars: 12_000, structuredEvidenceChars: 8_000 }));
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxChars: 10_692 }));
    expect(mockArchive).toHaveBeenCalledWith(expect.any(String), 2_000_000,
      expect.objectContaining({ maxSelectedTextChars: 200_000 }), expect.any(Object));
  });

  it.each(['old document cap', 'gap', 'false complete', 'split surrogate'])('fails closed after chunking drift: %s', async (scenario) => {
    mockChunks.mockImplementation(async (input, options) => {
      const result = await actualChunks.chunkGamingDocument(input, options);
      if (scenario === 'old document cap') result.text = result.text.slice(0, 100_000);
      if (scenario === 'gap') result.chunks[1].startChar = result.chunks[0].endChar + 1;
      if (scenario === 'false complete' && result.documentTruncated) {
        result.documentTruncated = false;
        result.coverageStatus = 'complete';
      }
      if (scenario === 'split surrogate' && input.includes('🗝')) result.chunks[0].text += '\uD800';
      return result;
    });
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when revision identity ignores deep content', async () => {
    mockHash.mockImplementation((text, identity, version) => actualChunks.hashGamingDocumentRevision(text.slice(0, 100_000), identity, version));
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when revision identity tracks document length instead of same-length content changes', async () => {
    mockHash.mockImplementation((text, identity, version) => actualChunks.hashGamingDocumentRevision(String(text.length), identity, version));
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when the retrieved deep passage disappears', async () => {
    mockSelect.mockReturnValueOnce([]);
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when duplicate passages consume multiple selected slots', async () => {
    mockSelect.mockImplementation((records, input, limits, resolvePatch) => {
      const selected = actualEvidence.selectStoredGamingEvidence(records, input, limits, resolvePatch);
      return records.some(record => record.recordId === 'overlap-b') ? [...selected, selected[0]] : selected;
    });
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when repeated title metadata is promoted into evidence', async () => {
    mockSelect.mockImplementation((records, input, limits, resolvePatch) => actualEvidence.selectStoredGamingEvidence(
      records.map(record => record.recordId === 'metadata-only' ? { ...record, normalized: {} } : record), input, limits, resolvePatch
    ));
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it.each(['citation offset', 'context budget', 'provenance'])('fails closed after formatting drift: %s', async (scenario) => {
    mockFormat.mockImplementation((candidates, input, limits) => {
      const result = actualEvidence.formatStoredGamingEvidence(candidates, input, limits);
      if (scenario === 'citation offset') result.context = result.context.replaceAll('[Source 3]', '[Source 1]');
      if (scenario === 'context budget') result.context += 'x'.repeat(12_001);
      if (scenario === 'provenance' && result.evidence?.[0]) result.evidence[0].revisionId = 'wrong-revision';
      return result;
    });
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed if structured facts past the old 4K cutoff are omitted', async () => {
    mockSelect.mockImplementation((records, input, limits, resolvePatch) => actualEvidence.selectStoredGamingEvidence(
      records, input, { ...limits, structuredEvidenceChars: 4_000 }, resolvePatch
    ));
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed if bounded metadata displaces the end of structured search evidence', async () => {
    mockSearch.mockImplementation((input) => actualSearch.buildGamingDocumentSearchText({ ...input, maxChars: 10_600 }));
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed if the Archive core accepts a multibyte document beyond its byte limit', async () => {
    mockArchive.mockImplementation(async (...args) => {
      try { return await actualArchive.resolveGamingArchiveResourceCore(...args); }
      catch (error) {
        if (error instanceof actualArchive.GamingArchiveResolutionError && error.reason === 'DOCUMENT_TOO_LARGE') return null;
        throw error;
      }
    });
    await expect(runGamingDurableRagPreview()).rejects.toThrow(FAILURE);
  });

  it('replaces unexpected core failures with a fixed cause-free error', async () => {
    mockChunks.mockRejectedValueOnce(new Error('private-fixture-sentinel'));
    let caught: unknown;
    try { await runGamingDurableRagPreview(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(FAILURE);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).stack).not.toContain('private-fixture-sentinel');
  });
});
