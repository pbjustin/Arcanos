import { jest } from '@jest/globals';

const actualProjection = await import('../src/shared/gaming/gamingDocumentProjectionCore.js');
const actualIngestion = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const actualChunks = await import('../src/services/gamingDocumentChunks.js');
const mockProjection = jest.fn(actualProjection.projectGamingDocumentText);
const mockSearch = jest.fn(actualIngestion.buildGamingDocumentSearchText);
const mockAdmission = jest.fn(actualIngestion.selectGamingSourceAdmissionUrl);
const mockPublicUrl = jest.fn(actualIngestion.selectGamingSourcePublicUrl);
const mockDetection = jest.fn(actualIngestion.detectGamingDocumentGame);
const mockQuality = jest.fn(actualIngestion.classifyGamingDocumentQuality);
const mockStructuredQuality = jest.fn(actualIngestion.classifyGamingStructuredExtractionQuality);
const mockExcerpt = jest.fn(actualChunks.selectGamingDocumentExcerpt);
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentProjectionCore.js', () => ({
  ...actualProjection, projectGamingDocumentText: mockProjection
}));
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentIngestionCore.js', () => ({
  ...actualIngestion,
  buildGamingDocumentSearchText: mockSearch,
  selectGamingSourceAdmissionUrl: mockAdmission,
  selectGamingSourcePublicUrl: mockPublicUrl,
  detectGamingDocumentGame: mockDetection,
  classifyGamingDocumentQuality: mockQuality,
  classifyGamingStructuredExtractionQuality: mockStructuredQuality
}));
jest.unstable_mockModule('../src/services/gamingDocumentChunks.js', () => ({
  ...actualChunks, selectGamingDocumentExcerpt: mockExcerpt
}));
const { runGamingDocumentIngestionPreview } = await import('../src/shared/gaming/gamingDocumentIngestionPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_DOCUMENT_INGESTION_CONTRACT_INVALID';

describe('sealed Gaming document and ingestion component proof', () => {
  beforeEach(() => {
    mockProjection.mockReset().mockImplementation(actualProjection.projectGamingDocumentText);
    mockSearch.mockReset().mockImplementation(actualIngestion.buildGamingDocumentSearchText);
    mockAdmission.mockReset().mockImplementation(actualIngestion.selectGamingSourceAdmissionUrl);
    mockPublicUrl.mockReset().mockImplementation(actualIngestion.selectGamingSourcePublicUrl);
    mockDetection.mockReset().mockImplementation(actualIngestion.detectGamingDocumentGame);
    mockQuality.mockReset().mockImplementation(actualIngestion.classifyGamingDocumentQuality);
    mockStructuredQuality.mockReset().mockImplementation(actualIngestion.classifyGamingStructuredExtractionQuality);
    mockExcerpt.mockReset().mockImplementation(actualChunks.selectGamingDocumentExcerpt);
  });

  it('chains real projection, search, and excerpt policies against fixed acquired guide text', async () => {
    await expect(runGamingDocumentIngestionPreview()).resolves.toBeUndefined();
    const acquired = mockProjection.mock.calls[0]?.[0].acquiredText ?? '';
    expect(acquired.indexOf('At the obsidian observatory')).toBeGreaterThan(24_000);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      cleanedText: expect.stringContaining('silver telescope'), maxChars: 100_000
    }));
    expect(mockExcerpt).toHaveBeenCalledWith(expect.stringContaining('copper telescope'), 'obsidian observatory', 1_200);
    expect(mockAdmission).toHaveBeenCalledWith('https://guides.example.org/w/index.php?curid=456', expect.anything());
    expect(mockQuality).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }));
  });

  it('fails closed when document projection silently restores the old 24,000-character cap', async () => {
    mockProjection.mockImplementation((input) => {
      const result = actualProjection.projectGamingDocumentText(input);
      return { ...result, text: result.text.slice(0, 24_000) };
    });
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when Unicode expansion truncation is reported as complete', async () => {
    mockProjection.mockImplementation((input) => {
      const result = actualProjection.projectGamingDocumentText(input);
      return input.acquiredText.includes('ﬂ') ? { ...result, truncated: false } : result;
    });
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when instruction-like prose survives the projection', async () => {
    mockProjection.mockImplementation((input) => ({
      ...actualProjection.projectGamingDocumentText(input), text: input.acquiredText.slice(0, input.maxChars)
    }));
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when search metadata displaces the end of the acquired guide', async () => {
    mockSearch.mockImplementation((input) => [input.normalizedEvidence, input.cleanedText].join('\n\n').slice(0, input.maxChars));
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when excerpt selection returns only the opening passage', async () => {
    mockExcerpt.mockImplementation((text, _query, maxChars) => text.slice(0, maxChars));
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it.each(['admission', 'persisted public URL'])('fails closed when %s drops generic page identity', async (scenario) => {
    if (scenario === 'admission') mockAdmission.mockImplementation((_url, description) => description.publicUrl);
    else mockPublicUrl.mockImplementation((_url, resolvedUrl) => resolvedUrl);
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when an Archive reader alias becomes the public identity', async () => {
    mockAdmission.mockImplementation((url) => url);
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when incidental prose is promoted into source game identity', async () => {
    mockDetection.mockReturnValue({ game: 'Elden Ring', confidence: 0.96, source: 'alias' });
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when high-confidence wrong-game metadata stops being detected', async () => {
    mockDetection.mockImplementation((input) => input.pageTitle?.includes('Destiny 2')
      ? { confidence: 0, source: 'none' } : actualIngestion.detectGamingDocumentGame(input));
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when catalog text is promoted to complete document evidence', async () => {
    mockQuality.mockImplementation((input) => input.cleanedText.startsWith('Identifier ')
      ? 'complete' : actualIngestion.classifyGamingDocumentQuality(input));
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when ordinary prose inherits a build extraction status', async () => {
    mockStructuredQuality.mockImplementation((input) => input.quality);
    await expect(runGamingDocumentIngestionPreview()).rejects.toThrow(FAILURE);
  });

  it('replaces unexpected dependency failures with a fixed cause-free error', async () => {
    mockProjection.mockImplementation(() => { throw new Error('private-fixture-sentinel'); });
    let caught: unknown;
    try { await runGamingDocumentIngestionPreview(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(FAILURE);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).stack).not.toContain('private-fixture-sentinel');
  });
});
