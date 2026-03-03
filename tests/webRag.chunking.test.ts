import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createEmbeddingMock = jest.fn();
const requireOpenAIClientOrAdapterMock = jest.fn();
const saveRagDocMock = jest.fn();
const loadAllRagDocsMock = jest.fn();
const initializeDatabaseMock = jest.fn();
const getStatusMock = jest.fn();
const fetchAndCleanMock = jest.fn();

const loggerChildMock = {
  debug: jest.fn(),
  warn: jest.fn(),
};

let chunkText: typeof import('../src/services/webRag.js').chunkText;
let ingestContent: typeof import('../src/services/webRag.js').ingestContent;

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

  jest.unstable_mockModule('../src/services/openai/embeddings.js', () => ({
    createEmbedding: createEmbeddingMock,
  }));

  jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
    requireOpenAIClientOrAdapter: requireOpenAIClientOrAdapterMock,
  }));

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    getDefaultModel: () => 'gpt-5',
    hasValidAPIKey: () => true,
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
    cosineSimilarity: () => 0,
  }));

  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    logger: {
      child: () => loggerChildMock,
    },
  }));

  ({ chunkText, ingestContent } = await import('../src/services/webRag.js'));
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
});

