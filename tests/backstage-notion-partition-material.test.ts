import { describe, expect, jest, test } from '@jest/globals';

import {
  resolveBackstageNotionPartitionPageMaterial,
  type BackstageNotionPartitionMaterialRepository,
} from '../src/services/backstageNotionPartitionMaterial.js';
import {
  chunkBackstageNotionInspectedPage,
  inspectBackstageNotionRagPage,
  type BackstageNotionInspectedRagPage,
} from '../src/shared/backstage/backstageNotionRagCore.js';
import { hashBackstageNotionPageMaterial } from '../src/shared/backstage/backstageNotionPartitionMaterialCore.js';
import { normalizeBackstageNotionScopePath } from '../src/shared/backstage/backstageNotionScopeIndex.js';

const UNIVERSE_ID = 'my-universe-2k26';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const CHUNK_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const EMBEDDING_MODEL = 'text-embedding-3-small';

function inspect(
  markdown: string,
  overrides: Partial<{
    pageId: string;
    title: string;
    path: readonly string[];
    parentPageId: string | null;
    sourceLastEditedAt: string;
  }> = {}
): BackstageNotionInspectedRagPage {
  return inspectBackstageNotionRagPage({
    universeId: UNIVERSE_ID,
    pageId: overrides.pageId ?? PAGE_ID,
    parentPageId: overrides.parentPageId ?? null,
    title: overrides.title ?? 'Monday Night Raw',
    path: overrides.path ?? ['Universe', 'Monday Night Raw'],
    markdown,
    sourceLastEditedAt: overrides.sourceLastEditedAt
      ?? '2026-08-24T12:00:00.000Z',
  });
}

function createRepository(overrides: Partial<BackstageNotionPartitionMaterialRepository> = {}) {
  const findReusablePageMaterial = jest.fn(async () => null);
  const findReusableChunkMaterials = jest.fn(async () => []);
  const storeChunkVersion = jest.fn(async () => ({
    id: CHUNK_VERSION_ID,
    reused: false,
  }));
  const storeEmbedding = jest.fn(async input => ({
    chunkVersionId: input.chunkVersionId,
    embeddingModel: input.embeddingModel,
    embeddingVersion: input.embeddingVersion,
    embeddingDimension: input.embedding.length,
    embeddingNorm: Math.hypot(...input.embedding),
    reused: false,
  }));
  const storePageVersion = jest.fn(async () => ({
    id: PAGE_VERSION_ID,
    reused: false,
  }));
  return {
    repository: {
      findReusablePageMaterial,
      findReusableChunkMaterials,
      storeChunkVersion,
      storeEmbedding,
      storePageVersion,
      ...overrides,
    } as BackstageNotionPartitionMaterialRepository,
    findReusablePageMaterial,
    findReusableChunkMaterials,
    storeChunkVersion,
    storeEmbedding,
    storePageVersion,
  };
}

function reusablePage(
  page: BackstageNotionInspectedRagPage,
  embeddingAvailable = true
) {
  const content = page.sanitizedMarkdown;
  return {
    pageVersionId: PAGE_VERSION_ID,
    pageId: page.pageId,
    contentHash: hashBackstageNotionPageMaterial(content),
    pageFormatVersion: 1,
    chunkerVersion: 1,
    chunks: [{
      ordinal: 0,
      chunkVersionId: CHUNK_VERSION_ID,
      contentHash: hashBackstageNotionPageMaterial(content),
      content,
      contentCodePoints: Array.from(content).length,
      headingPath: [],
      scopeHeadingPathKey: normalizeBackstageNotionScopePath([]),
      headingOccurrencePath: [],
      embeddingAvailable,
    }],
  } as const;
}

const resolutionContract = {
  embeddingModel: EMBEDDING_MODEL,
  embeddingVersion: 1,
  embeddingDimension: 3,
} as const;

describe('Backstage Notion incremental partition material resolver', () => {
  test('reuses exact page, chunk, and embedding IDs across a placement-only move', async () => {
    const page = inspect('# Notes\n\nGeneral notes.', {
      title: 'SmackDown',
      path: ['Universe', 'SmackDown', '2026'],
      parentPageId: OTHER_PAGE_ID,
      sourceLastEditedAt: '2026-08-24T13:00:00.000Z',
    });
    const exact = reusablePage(page);
    const harness = createRepository({
      findReusablePageMaterial: jest.fn(async () => exact),
    });
    const chunkPage = jest.fn(() => {
      throw new Error('unchanged material must not be chunked');
    });
    const embedBatch = jest.fn(async () => {
      throw new Error('unchanged embeddings must not be regenerated');
    });

    const result = await resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract },
      { repository: harness.repository, chunkPage, embedBatch }
    );

    expect(result).toMatchObject({
      pageVersionId: PAGE_VERSION_ID,
      pageVersionReused: true,
      chunkingPerformed: false,
      reusedChunkCount: 1,
      embeddedChunkCount: 0,
    });
    expect(result.chunks[0]).toMatchObject({
      chunkVersionId: CHUNK_VERSION_ID,
      category: 'smackdown',
    });
    expect(chunkPage).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(harness.storeChunkVersion).not.toHaveBeenCalled();
    expect(harness.storeEmbedding).not.toHaveBeenCalled();
    expect(harness.storePageVersion).not.toHaveBeenCalled();
  });

  test('embeds only an exact page material whose requested model contract is absent', async () => {
    const page = inspect('# Raw\n\nCurrent champion.');
    const harness = createRepository({
      findReusablePageMaterial: jest.fn(async () => reusablePage(page, false)),
    });
    const embedBatch = jest.fn(async () => [[1, 0, 0]]);

    const result = await resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract },
      { repository: harness.repository, embedBatch }
    );

    expect(result.chunkingPerformed).toBe(false);
    expect(result.embeddedChunkCount).toBe(1);
    expect(embedBatch).toHaveBeenCalledWith([page.sanitizedMarkdown]);
    expect(harness.storeEmbedding).toHaveBeenCalledWith(expect.objectContaining({
      chunkVersionId: CHUNK_VERSION_ID,
      embeddingModel: EMBEDDING_MODEL,
      embeddingVersion: 1,
    }));
    expect(harness.storeChunkVersion).not.toHaveBeenCalled();
    expect(harness.storePageVersion).not.toHaveBeenCalled();
  });

  test('creates a distinct page identity while reusing identical chunk and embedding material', async () => {
    const page = inspect('# Shared\n\nIdentical canon.', { pageId: OTHER_PAGE_ID });
    const prepared = chunkBackstageNotionInspectedPage(page, {
      maximumCodePoints: 1_800,
    });
    const normalizedChunkId = CHUNK_VERSION_ID;
    const harness = createRepository({
      findReusableChunkMaterials: jest.fn(async input => input.contentHashes.map(hash => {
        const chunk = prepared.chunks.find(candidate => candidate.contentHash === hash);
        if (!chunk) {
          throw new Error('unexpected test hash');
        }
        return {
          chunkVersionId: normalizedChunkId,
          contentHash: hash,
          content: chunk.content,
          contentCodePoints: chunk.codePoints,
          embeddingAvailable: true,
        };
      })),
    });
    const chunkPage = jest.fn(chunkBackstageNotionInspectedPage);
    const embedBatch = jest.fn(async () => [[1, 0, 0]]);

    const result = await resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract },
      { repository: harness.repository, chunkPage, embedBatch }
    );

    expect(result.pageVersionId).toBe(PAGE_VERSION_ID);
    expect(result.chunkingPerformed).toBe(true);
    expect(result.reusedChunkCount).toBe(1);
    expect(result.chunks[0]?.chunkVersionId).toBe(normalizedChunkId);
    expect(result.chunks[0]?.chunkVersionId).not.toBe(prepared.chunks[0]?.chunkId);
    expect(harness.storePageVersion).toHaveBeenCalledWith(expect.objectContaining({
      pageId: OTHER_PAGE_ID,
      contentHash: hashBackstageNotionPageMaterial(page.sanitizedMarkdown),
    }));
    expect(harness.storeChunkVersion).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  test('reuses unchanged chunk hashes and embeds only newly stored unique chunks', async () => {
    const page = inspect([
      '# First',
      'A'.repeat(1_795),
      '# Second',
      'B'.repeat(1_795),
      '# Third',
      'C'.repeat(1_795),
    ].join('\n\n'));
    const prepared = chunkBackstageNotionInspectedPage(page, {
      maximumCodePoints: 1_800,
    });
    const byHash = new Map(prepared.chunks.map((chunk, index) => [
      chunk.contentHash,
      {
        chunk,
        chunkVersionId: `${String(index + 5).padStart(8, '0')}-0000-4000-8000-000000000000`,
      },
    ]));
    const hashes = [...byHash.keys()];
    expect(hashes.length).toBeGreaterThan(1);
    const stored = new Set<string>([hashes[0]!]);
    const initiallyEmbedded = hashes[0]!;
    const harness = createRepository();
    harness.repository.findReusableChunkMaterials = jest.fn(async input => (
      input.contentHashes.flatMap(hash => {
        const material = byHash.get(hash);
        if (!material || !stored.has(hash)) {
          return [];
        }
        return [{
          chunkVersionId: material.chunkVersionId,
          contentHash: hash,
          content: material.chunk.content,
          contentCodePoints: material.chunk.codePoints,
          embeddingAvailable: hash === initiallyEmbedded,
        }];
      })
    ));
    harness.repository.storeChunkVersion = jest.fn(async input => {
      stored.add(input.contentHash);
      return {
        id: byHash.get(input.contentHash)!.chunkVersionId,
        reused: false,
      };
    });
    const embedBatch = jest.fn(async contents => contents.map(() => [1, 0, 0]));

    const result = await resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract },
      { repository: harness.repository, embedBatch }
    );

    expect(result.reusedChunkCount).toBe(1);
    expect(result.embeddedChunkCount).toBe(hashes.length - 1);
    expect(harness.repository.storeChunkVersion).toHaveBeenCalledTimes(hashes.length - 1);
    expect(embedBatch.mock.calls.flatMap(call => call[0])).not.toContain(
      byHash.get(initiallyEmbedded)?.chunk.content
    );
    expect(harness.storePageVersion).toHaveBeenCalledTimes(1);
  });

  test.each([
    { label: 'wrong cardinality', vectors: [] },
    { label: 'wrong dimension', vectors: [[1, 0]] },
    { label: 'zero vector', vectors: [[0, 0, 0]] },
    { label: 'non-finite vector', vectors: [[1, Number.NaN, 0]] },
  ])('rejects $label without persisting an embedding or page', async ({ vectors }) => {
    const page = inspect('# Raw\n\nChampion.');
    const harness = createRepository({
      findReusablePageMaterial: jest.fn(async () => reusablePage(page, false)),
    });

    await expect(resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract },
      { repository: harness.repository, embedBatch: async () => vectors }
    )).rejects.toThrow();
    expect(harness.storeEmbedding).not.toHaveBeenCalled();
    expect(harness.storePageVersion).not.toHaveBeenCalled();
  });

  test('validates a complete embedding batch before persisting its first vector', async () => {
    const page = inspect([
      '# First',
      'A'.repeat(1_795),
      '# Second',
      'B'.repeat(1_795),
    ].join('\n\n'));
    const prepared = chunkBackstageNotionInspectedPage(page, {
      maximumCodePoints: 1_800,
    });
    expect(prepared.chunks.length).toBeGreaterThan(1);
    const exact = {
      pageVersionId: PAGE_VERSION_ID,
      pageId: page.pageId,
      contentHash: hashBackstageNotionPageMaterial(page.sanitizedMarkdown),
      pageFormatVersion: 1,
      chunkerVersion: 1,
      chunks: prepared.chunks.map((chunk, index) => ({
        ordinal: chunk.ordinal,
        chunkVersionId: `${String(index + 5).padStart(8, '0')}-0000-4000-8000-000000000000`,
        contentHash: chunk.contentHash,
        content: chunk.content,
        contentCodePoints: chunk.codePoints,
        headingPath: chunk.headingPath,
        scopeHeadingPathKey: normalizeBackstageNotionScopePath(chunk.headingPath),
        headingOccurrencePath: chunk.headingOccurrencePath,
        embeddingAvailable: false,
      })),
    } as const;
    const harness = createRepository({
      findReusablePageMaterial: jest.fn(async () => exact),
    });

    await expect(resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract },
      {
        repository: harness.repository,
        embedBatch: async contents => contents.map((_, index) => (
          index === contents.length - 1
            ? [1, Number.NaN, 0]
            : [1, 0, 0]
        )),
      }
    )).rejects.toThrow('invalid component');
    expect(harness.storeEmbedding).not.toHaveBeenCalled();
    expect(harness.storePageVersion).not.toHaveBeenCalled();
  });

  test('honors abort while embedding and performs no material writes afterward', async () => {
    const page = inspect('# Raw\n\nChampion.');
    const controller = new AbortController();
    const harness = createRepository({
      findReusablePageMaterial: jest.fn(async () => reusablePage(page, false)),
    });
    const embedBatch = jest.fn(async () => {
      controller.abort(new Error('stop material work'));
      return [[1, 0, 0]];
    });

    await expect(resolveBackstageNotionPartitionPageMaterial(
      { page, ...resolutionContract, signal: controller.signal },
      { repository: harness.repository, embedBatch }
    )).rejects.toThrow('stop material work');
    expect(harness.storeEmbedding).not.toHaveBeenCalled();
    expect(harness.storePageVersion).not.toHaveBeenCalled();
  });
});
