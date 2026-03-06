import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createEmbeddingMock = jest.fn();
const requireOpenAIClientOrAdapterMock = jest.fn();
const saveRagDocMock = jest.fn();
const loadAllRagDocsMock = jest.fn();
const initializeDatabaseMock = jest.fn();
const getStatusMock = jest.fn();
const fetchAndCleanMock = jest.fn();
const cosineSimilarityMock = jest.fn();
const hasValidApiKeyMock = jest.fn();

const loggerChildMock = {
  debug: jest.fn(),
  warn: jest.fn(),
};

let chunkText: typeof import('../src/services/webRag.js').chunkText;
let ingestContent: typeof import('../src/services/webRag.js').ingestContent;
let queryRagDocuments: typeof import('../src/services/webRag.js').queryRagDocuments;
let recordPersistentMemorySnippet: typeof import('../src/services/webRag.js').recordPersistentMemorySnippet;

beforeEach(async () => {
  jest.resetModules();

  createEmbeddingMock.mockReset();
  createEmbeddingMock.mockResolvedValue([0.1, 0.2, 0.3]);

  requireOpenAIClientOrAdapterMock.mockReset();
  requireOpenAIClientOrAdapterMock.mockReturnValue({
    client: {},
    adapter: { responses: { create: jest.fn() } },
  });

  saveRagDocMock.mockReset();
  saveRagDocMock.mockResolvedValue(undefined);

  loadAllRagDocsMock.mockReset();
  loadAllRagDocsMock.mockResolvedValue([]);

  initializeDatabaseMock.mockReset();
  initializeDatabaseMock.mockResolvedValue(true);

  getStatusMock.mockReset();
  getStatusMock.mockReturnValue({ connected: true });

  fetchAndCleanMock.mockReset();
  fetchAndCleanMock.mockResolvedValue('');

  cosineSimilarityMock.mockReset();
  cosineSimilarityMock.mockImplementation((a: number[], b: number[]) => {
    if (a.length !== b.length) return -1;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  });

  hasValidApiKeyMock.mockReset();
  hasValidApiKeyMock.mockReturnValue(true);

  jest.unstable_mockModule('../src/services/openai/embeddings.js', () => ({
    createEmbedding: createEmbeddingMock,
  }));

  jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
    requireOpenAIClientOrAdapter: requireOpenAIClientOrAdapterMock,
  }));

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    getDefaultModel: () => 'gpt-5',
    hasValidAPIKey: hasValidApiKeyMock,
  }));

  jest.unstable_mockModule('@core/db/index.js', () => ({
    saveRagDoc: saveRagDocMock,
    loadAllRagDocs: loadAllRagDocsMock,
    initializeDatabaseWithSchema: initializeDatabaseMock,
    getStatus: getStatusMock,
  }));

  jest.unstable_mockModule('@shared/webFetcher.js', () => ({
    fetchAndClean: fetchAndCleanMock,
  }));

  jest.unstable_mockModule('@shared/vectorUtils.js', () => ({
    cosineSimilarity: cosineSimilarityMock,
  }));

  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    logger: {
      child: () => loggerChildMock,
    },
  }));

  ({ chunkText, ingestContent, queryRagDocuments, recordPersistentMemorySnippet } = await import('../src/services/webRag.js'));
});

describe('webRag chunking and incremental ingestion', () => {
  it('splits text into overlapping chunks', () => {
    const chunks = chunkText('abcdefghij', 4, 1);

    expect(chunks).toEqual(['abcd', 'defg', 'ghij']);
    expect(chunks[1].startsWith(chunks[0].slice(-1))).toBe(true);
  });

  it('ingests each chunk with independent embeddings', async () => {
    const content = 'x'.repeat(17_000);

    const result = await ingestContent({
      id: 'guide-doc',
      content,
      source: 'gaming-guide',
      metadata: { sourceType: 'guide' },
    });

    expect(result).toEqual(expect.objectContaining({ parentId: 'guide-doc', chunkCount: 3 }));
    expect(createEmbeddingMock).toHaveBeenCalledTimes(3);
    expect(saveRagDocMock).toHaveBeenCalledTimes(3);

    const firstSavedDoc = saveRagDocMock.mock.calls[0][0];
    expect(firstSavedDoc.id).toBe('guide-doc#0');
    expect(firstSavedDoc.metadata).toEqual(expect.objectContaining({
      parentId: 'guide-doc',
      chunkIndex: 0,
      chunkCount: 3,
    }));
  });

  it('retrieves semantic matches scoped to session and source type', async () => {
    createEmbeddingMock
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 1, 0])
      .mockResolvedValueOnce([1, 0, 0]);

    await ingestContent({
      id: 'memory:alpha:1',
      content: 'Alpha memory snippet',
      source: 'memory:alpha',
      metadata: { sourceType: 'memory', sessionId: 'alpha' }
    });

    await ingestContent({
      id: 'memory:beta:1',
      content: 'Beta memory snippet',
      source: 'memory:beta',
      metadata: { sourceType: 'memory', sessionId: 'beta' }
    });

    const result = await queryRagDocuments('alpha recall', {
      sessionId: 'alpha',
      sourceTypes: ['memory'],
      minScore: 0.2,
      limit: 5
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual(
      expect.objectContaining({
        id: 'memory:alpha:1#0',
        url: 'memory:alpha'
      })
    );
    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        enabled: true,
        reason: 'ok',
        returnedCount: 1,
        sessionFilterApplied: true,
        sourceTypeFilterApplied: true
      })
    );
  });

  it('skips persistent memory ingestion when OpenAI key is unavailable', async () => {
    hasValidApiKeyMock.mockReturnValue(false);
    createEmbeddingMock.mockClear();

    const ingested = await recordPersistentMemorySnippet({
      key: 'nl-memory:alpha:test-1',
      sessionId: 'alpha',
      content: 'Should not ingest without API key'
    });

    expect(ingested).toBe(false);
    expect(createEmbeddingMock).not.toHaveBeenCalled();
  });
});
