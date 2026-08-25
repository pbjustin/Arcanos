import { createHash } from 'node:crypto';

import { describe, expect, jest, test } from '@jest/globals';
import type { Pool } from 'pg';

import {
  BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS,
  BackstageNotionPartitionRepositoryError,
  PostgresBackstageNotionPartitionRepository,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import { normalizeBackstageNotionScopePath } from '../src/shared/backstage/backstageNotionScopeIndex.js';

const UNIVERSE_ID = 'my-universe-2k26';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const CHUNK_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const EMBEDDING_MODEL = 'text-embedding-3-small';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function queryPool(rows: readonly Record<string, unknown>[]) {
  const query = jest.fn(async () => ({ rows: [...rows], rowCount: rows.length }));
  return {
    query,
    pool: { query } as unknown as Pool,
  };
}

function pageLookupInput() {
  return {
    universeId: UNIVERSE_ID,
    pageId: PAGE_ID,
    contentHash: hash('# Raw'),
    pageFormatVersion: 1,
    chunkerVersion: 1,
    embeddingModel: EMBEDDING_MODEL,
    embeddingVersion: 1,
    embeddingDimension: 3,
  } as const;
}

function pageRow(overrides: Record<string, unknown> = {}) {
  const content = '# Raw';
  return {
    page_version_id: PAGE_VERSION_ID,
    page_id: PAGE_ID,
    page_content_hash: hash('# Raw'),
    page_format_version: 1,
    chunker_version: 1,
    chunk_count: 1,
    ordinal: 0,
    chunk_version_id: CHUNK_VERSION_ID,
    chunk_content_hash: hash(content),
    chunk_content: content,
    chunk_content_code_points: 5,
    heading_path: ['Raw'],
    scope_heading_path_key: normalizeBackstageNotionScopePath(['Raw']),
    heading_occurrence_path: [0],
    embedding_available: true,
    ...overrides,
  };
}

describe('Backstage Notion partition material repository lookups', () => {
  test('loads one sealed page as bounded ordered references without embedding vectors', async () => {
    const harness = queryPool([pageRow()]);
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.findReusablePageMaterial(pageLookupInput())).resolves.toEqual({
      pageVersionId: PAGE_VERSION_ID,
      pageId: PAGE_ID,
      contentHash: hash('# Raw'),
      pageFormatVersion: 1,
      chunkerVersion: 1,
      chunks: [{
        ordinal: 0,
        chunkVersionId: CHUNK_VERSION_ID,
        contentHash: hash('# Raw'),
        content: '# Raw',
        contentCodePoints: 5,
        headingPath: ['Raw'],
        scopeHeadingPathKey: normalizeBackstageNotionScopePath(['Raw']),
        headingOccurrencePath: [0],
        embeddingAvailable: true,
      }],
    });

    const [sql, values] = harness.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("page.state = 'sealed'");
    expect(String(sql)).toContain('LIMIT 2049');
    expect(String(sql)).not.toMatch(/embedding\.embedding(?:\s|,)/u);
    expect(values).toEqual([
      UNIVERSE_ID,
      PAGE_ID,
      hash('# Raw'),
      1,
      1,
      EMBEDDING_MODEL,
      1,
      3,
    ]);
  });

  test('fails closed when a sealed page lookup returns partial or corrupt rows', async () => {
    const partial = queryPool([pageRow({ chunk_count: 2 })]);
    await expect(new PostgresBackstageNotionPartitionRepository(partial.pool)
      .findReusablePageMaterial(pageLookupInput())).rejects.toBeInstanceOf(
      BackstageNotionPartitionRepositoryError
    );

    const corrupt = queryPool([pageRow({ chunk_content: 'tampered' })]);
    await expect(new PostgresBackstageNotionPartitionRepository(corrupt.pool)
      .findReusablePageMaterial(pageLookupInput())).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_MATERIAL_COLLISION',
    });
  });

  test('returns only requested normalized chunk metadata for the exact embedding contract', async () => {
    const content = 'Reusable canon';
    const harness = queryPool([{
      chunk_version_id: CHUNK_VERSION_ID,
      content_hash: hash(content),
      content,
      content_code_points: 14,
      embedding_available: false,
    }]);
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);

    await expect(repository.findReusableChunkMaterials({
      universeId: UNIVERSE_ID,
      contentHashes: [hash(content)],
      chunkerVersion: 1,
      embeddingModel: EMBEDDING_MODEL,
      embeddingVersion: 2,
      embeddingDimension: 3,
    })).resolves.toEqual([{
      chunkVersionId: CHUNK_VERSION_ID,
      contentHash: hash(content),
      content,
      contentCodePoints: 14,
      embeddingAvailable: false,
    }]);

    const [sql, values] = harness.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('LIMIT 129');
    expect(String(sql)).toContain('embedding.embedding_dimension = $6');
    expect(String(sql)).not.toMatch(/embedding\.embedding(?:\s|,)/u);
    expect(values).toEqual([
      UNIVERSE_ID,
      1,
      EMBEDDING_MODEL,
      2,
      [hash(content)],
      3,
    ]);
  });

  test('rejects oversized or duplicate chunk lookups before touching PostgreSQL', async () => {
    const harness = queryPool([]);
    const repository = new PostgresBackstageNotionPartitionRepository(harness.pool);
    const base = {
      universeId: UNIVERSE_ID,
      chunkerVersion: 1,
      embeddingModel: EMBEDDING_MODEL,
      embeddingVersion: 1,
      embeddingDimension: 3,
    } as const;

    await expect(repository.findReusableChunkMaterials({
      ...base,
      contentHashes: Array.from(
        { length: BACKSTAGE_NOTION_PARTITION_MATERIAL_LOOKUP_MAX_CHUNKS + 1 },
        (_, index) => index.toString(16).padStart(64, '0')
      ),
    })).rejects.toThrow('outside its supported range');
    await expect(repository.findReusableChunkMaterials({
      ...base,
      contentHashes: [hash('same'), hash('same')],
    })).rejects.toThrow('must be unique');
    expect(harness.query).not.toHaveBeenCalled();
  });
});
