import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import type {
  BackstageNotionManifestScopeChunk,
  BackstageNotionPartitionRankedCandidate,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import {
  BackstageNotionCursorInvalidError,
  BackstageNotionIndexUnavailableError,
} from '../src/services/backstageNotionRag.js';
import {
  BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_MAX_LENGTH,
  retrieveBackstageNotionPartitionRagContext,
  type BackstageNotionPartitionRetrievalDependencies,
  type BackstageNotionPartitionRetrievalPlan,
} from '../src/services/backstageNotionPartitionRetrieval.js';
import {
  runWithBackstageNotionEnrichmentAuthorization,
  wasBackstageNotionEnrichmentUsed,
} from '../src/services/backstageNotionEnrichmentAuthorization.js';
import type { BackstageNotionPartitionScopeRoutingResolution } from
  '../src/services/backstageNotionPartitionRouting.js';
import type {
  BackstageNotionPartitionRoutingIntent,
  BackstageNotionPartitionRoutingResolution,
} from '../src/shared/backstage/backstageNotionPartitionRoutingCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';
import { isBackstageContinuityCursorRequestValid } from
  '../src/shared/backstage/backstageContinuityQueryCore.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '../src/shared/backstage/backstageNotionScopeIndex.js';

const UNIVERSE_ID = 'my-universe-2k26';
const MANIFEST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANIFEST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFIGURATION_VERSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTITION_VERSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PAGE_VERSION_ID = '77777777-7777-4777-8777-777777777777';
const CONFIGURATION_HASH = '1'.repeat(64);
const RESOLUTION_DIGEST_A = '2'.repeat(64);
const RESOLUTION_DIGEST_B = '3'.repeat(64);
const CURSOR_SECRET = 'partition-retrieval-test-secret-32-bytes-minimum';
const PREVIOUS_CURSOR_SECRET =
  'partition-retrieval-previous-test-secret-32-bytes-minimum';

const RELEVANT_INTENT = Object.freeze({
  kind: 'relevant' as const,
  cardinality: 'all_matching' as const,
  allowedTiers: Object.freeze(['hot'] as const),
  explicitArchive: false,
  selectors: Object.freeze([Object.freeze({
    allScopeTags: Object.freeze(['brand:raw']),
    allCategoryTags: Object.freeze(['current']),
  })]),
});

const COMPLETE_INTENT = Object.freeze({
  kind: 'complete_all' as const,
  cardinality: 'all_matching' as const,
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuid(index: number): string {
  return `90000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function routing(input: {
  manifestId?: string;
  manifestGeneration?: string;
  resolutionDigest?: string;
  intent?: BackstageNotionPartitionRoutingIntent;
  complete?: boolean;
  configurationCurrent?: boolean;
  shardKey?: string;
} = {}): Extract<BackstageNotionPartitionRoutingResolution, { status: 'resolved' }> {
  const shardKey = input.shardKey ?? 'raw/2026';
  return {
    routingVersion: 1,
    status: 'resolved',
    universeId: UNIVERSE_ID,
    manifestId: input.manifestId ?? MANIFEST_A,
    manifestGeneration: input.manifestGeneration ?? '1',
    configurationVersionId: CONFIGURATION_VERSION_ID,
    configurationHash: CONFIGURATION_HASH,
    configurationCurrent: input.configurationCurrent ?? true,
    embeddingModel: 'text-embedding-test',
    embeddingVersion: 1,
    embeddingDimension: 2,
    indexFormatVersion: 1,
    intent: input.intent ?? RELEVANT_INTENT,
    resolutionDigest: input.resolutionDigest ?? RESOLUTION_DIGEST_A,
    cardinality: (input.intent ?? RELEVANT_INTENT).cardinality,
    complete: input.complete ?? true,
    shards: [{
      shardKey,
      partitionVersionId: PARTITION_VERSION_ID,
      snapshotId: SNAPSHOT_ID,
      retrievalTier: 'hot',
      required: true,
      decision: 'fresh',
      verifiedAt: '2026-08-24T12:00:00.000Z',
    }],
    matchingOmissions: [],
  };
}

function material(input: {
  index?: number;
  pageId?: string;
  ordinal?: number;
  content?: string;
  pagePath?: readonly string[];
  headingPath?: readonly string[];
  headingOccurrencePath?: readonly number[];
  shardKey?: string;
} = {}): BackstageNotionPartitionRankedCandidate {
  const index = input.index ?? 1;
  const content = input.content ?? `Current canon material ${index}.`;
  const resolvedPageId = input.pageId ?? PAGE_ID;
  return {
    shardKey: input.shardKey ?? 'raw/2026',
    partitionVersionId: PARTITION_VERSION_ID,
    snapshotId: SNAPSHOT_ID,
    pageId: resolvedPageId,
    pageVersionId: resolvedPageId === PAGE_ID
      ? PAGE_VERSION_ID
      : OTHER_PAGE_VERSION_ID,
    parentPageId: null,
    pageContentHash: sha256(`page:${resolvedPageId}`),
    pageTitle: 'Monday Night Raw',
    pagePath: input.pagePath ?? ['WWE Universe', 'Monday Night Raw'],
    canonicalUrl: 'https://www.notion.so/example',
    sourceLastEditedAt: new Date('2026-08-24T11:50:00.000Z'),
    ordinal: input.ordinal ?? index - 1,
    chunkVersionId: uuid(index),
    contentHash: sha256(content),
    contentCodePoints: Array.from(content).length,
    content,
    headingPath: input.headingPath ?? [],
    headingOccurrencePath: input.headingOccurrencePath ?? [],
    category: 'general',
    semanticScore: 1 - index / 100,
    lexicalScore: 1 - index / 200,
    score: 1 - index / 300,
  };
}

function scopeChunk(input: Parameters<typeof material>[0] = {}): BackstageNotionManifestScopeChunk {
  const {
    semanticScore: _semanticScore,
    lexicalScore: _lexicalScore,
    score: _score,
    ...chunk
  } = material(input);
  return chunk;
}

function scopeResolution(input: {
  manifestId?: string;
  section?: boolean;
  chunkCount?: number;
  pageCount?: number;
  scopeKind?: 'page' | 'subtree';
} = {}): Extract<BackstageNotionPartitionScopeRoutingResolution, { status: 'resolved' }> {
  const manifestId = input.manifestId ?? MANIFEST_A;
  const section = input.section ?? false;
  const scopeKind = input.scopeKind ?? 'page';
  return {
    status: 'resolved',
    owner: {
      status: 'resolved',
      manifestId,
      shardKey: 'raw/2026',
      partitionVersionId: PARTITION_VERSION_ID,
      snapshotId: SNAPSHOT_ID,
      pageId: PAGE_ID,
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe', 'Monday Night Raw'],
      sectionPath: section ? ['Championships'] : null,
      sectionOccurrencePath: section ? [2] : null,
      scopeKind,
      scopeChunkCount: input.chunkCount ?? 1,
      scopePageCount: input.pageCount ?? 1,
    },
    routing: routing({
      manifestId,
      intent: {
        kind: 'resolved_scope',
        cardinality: 'exactly_one',
        shardKey: 'raw/2026',
      },
    }),
  };
}

function harness(input: {
  activeRouting?: Extract<BackstageNotionPartitionRoutingResolution, { status: 'resolved' }>;
  pinnedRouting?: Extract<BackstageNotionPartitionRoutingResolution, { status: 'resolved' }>;
  scope?: Extract<BackstageNotionPartitionScopeRoutingResolution, { status: 'resolved' }>;
  rankedCandidates?: readonly BackstageNotionPartitionRankedCandidate[];
  selectedChunkCount?: number;
  page?: {
    readonly scopeChunkCount: number;
    readonly scopePageCount: number;
    readonly hasMore: boolean;
    readonly chunks: readonly BackstageNotionManifestScopeChunk[];
  };
  secret?: string;
  previousSecret?: string;
} = {}) {
  const activeRouting = input.activeRouting ?? routing();
  const pinnedRouting = input.pinnedRouting ?? activeRouting;
  const resolvedScope = input.scope ?? scopeResolution({
    manifestId: activeRouting.manifestId,
  });
  const rankedCandidates = input.rankedCandidates ?? [material()];
  const resolveRequest = jest.fn(async () => activeRouting);
  const resolvePinnedRequest = jest.fn(async () => pinnedRouting);
  const resolveScopeRequest = jest.fn(async () => resolvedScope);
  const resolvePinnedScopeRequest = jest.fn(async () => ({
    ...resolvedScope,
    owner: { ...resolvedScope.owner, manifestId: pinnedRouting.manifestId },
    routing: pinnedRouting,
  }));
  const rankManifestShardCandidates = jest.fn(async () => ({
    status: 'ready' as const,
    searchVersion: 1 as const,
    manifestId: activeRouting.manifestId,
    strategy: 'exact_float8_hybrid_v1' as const,
    exhaustive: true,
    selectedShardCount: activeRouting.shards.length,
    selectedChunkCount: input.selectedChunkCount ?? rankedCandidates.length,
    candidatePoolCount: rankedCandidates.length,
    candidates: rankedCandidates,
  }));
  const loadManifestScopeChunkPage = jest.fn(async (request: {
    readonly manifestId: string;
  }) => ({
    status: 'ready' as const,
    manifestId: request.manifestId,
    selectedShardCount: activeRouting.shards.length,
    scopeChunkCount: input.page?.scopeChunkCount ?? 1,
    scopePageCount: input.page?.scopePageCount ?? 1,
    hasMore: input.page?.hasMore ?? false,
    chunks: input.page?.chunks ?? [scopeChunk()],
  }));
  const embedQuery = jest.fn(async () => [1, 0]);
  const resolveCursorEncryptionSecret = jest.fn(() => input.secret ?? CURSOR_SECRET);
  const resolvePreviousCursorEncryptionSecret = jest.fn(
    () => input.previousSecret
  );
  const dependencies: BackstageNotionPartitionRetrievalDependencies = {
    repository: {
      rankManifestShardCandidates,
      loadManifestScopeChunkPage,
    },
    resolveRequest,
    resolvePinnedRequest,
    resolveScopeRequest,
    resolvePinnedScopeRequest,
    embedQuery,
    resolveCursorEncryptionSecret,
    resolvePreviousCursorEncryptionSecret,
  };
  return {
    dependencies,
    embedQuery,
    loadManifestScopeChunkPage,
    rankManifestShardCandidates,
    resolveCursorEncryptionSecret,
    resolvePreviousCursorEncryptionSecret,
    resolvePinnedRequest,
    resolvePinnedScopeRequest,
    resolveRequest,
    resolveScopeRequest,
  };
}

async function retrieveAuthorized(
  plan: BackstageNotionPartitionRetrievalPlan,
  dependencies: BackstageNotionPartitionRetrievalDependencies
) {
  return runWithBackstageNotionEnrichmentAuthorization(true, async () => {
    const result = await retrieveBackstageNotionPartitionRagContext(
      UNIVERSE_ID,
      plan,
      dependencies
    );
    return { result, enrichmentUsed: wasBackstageNotionEnrichmentUsed() };
  });
}

describe('Backstage Notion partition retrieval', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ranks one bounded database candidate set and applies the cross-page cap', async () => {
    const secondPage = '44444444-4444-4444-8444-444444444444';
    const candidates = [
      ...Array.from({ length: 5 }, (_, index) => material({
        index: index + 1,
        ordinal: index,
      })),
      ...Array.from({ length: 2 }, (_, index) => material({
        index: index + 6,
        pageId: secondPage,
        ordinal: index,
      })),
    ];
    const state = harness({ rankedCandidates: candidates });

    const { result, enrichmentUsed } = await retrieveAuthorized({
      query: 'Book Raw from current canon',
      relevantRoutingIntent: RELEVANT_INTENT,
    }, state.dependencies);

    expect(state.resolveRequest).toHaveBeenCalledWith(UNIVERSE_ID, RELEVANT_INTENT);
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
    expect(state.resolveCursorEncryptionSecret).not.toHaveBeenCalled();
    expect(state.resolvePreviousCursorEncryptionSecret).not.toHaveBeenCalled();
    expect(state.rankManifestShardCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        universeId: UNIVERSE_ID,
        manifestId: MANIFEST_A,
        limit: 128,
        scope: null,
        queryEmbedding: [1, 0],
      })
    );
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      universeId: UNIVERSE_ID,
      manifestId: MANIFEST_A,
      chunkCount: 5,
      retrievalMode: 'relevant',
    });
    expect(Object.hasOwn(result, 'snapshotId')).toBe(false);
    expect(result.citations.map(citation => citation.pageId)).toEqual([
      PAGE_ID,
      PAGE_ID,
      PAGE_ID,
      secondPage,
      secondPage,
    ]);
    expect(result.citations[0]).toMatchObject({
      shardKey: 'raw/2026',
      partitionVersionId: PARTITION_VERSION_ID,
      snapshotId: SNAPSHOT_ID,
      pageVersionId: PAGE_VERSION_ID,
      chunkVersionId: uuid(1),
    });
    expect(enrichmentUsed).toBe(true);
    const logMetadata = jest.mocked(logger.info).mock.calls.at(-1)?.[1];
    expect(logMetadata).not.toEqual(expect.objectContaining({
      universeId: expect.anything(),
      manifestId: expect.anything(),
      selectionDigest: expect.anything(),
    }));
    expect(JSON.stringify(logMetadata)).not.toContain(UNIVERSE_ID);
    expect(JSON.stringify(logMetadata)).not.toContain(MANIFEST_A);
    expect(JSON.stringify(logMetadata)).not.toContain(result.selectionDigest);
  });

  test('fails relevant retrieval closed when any selected shard is omitted', async () => {
    const incompleteRouting = {
      ...routing({ complete: false }),
      matchingOmissions: [{
        shardKey: 'raw/2026',
        partitionVersionId: 'aaaaaaaa-0000-4000-8000-000000000001',
        retrievalTier: 'hot' as const,
        decision: 'optional_unavailable' as const,
        safeReasonCode: 'SHARD_SYNC_INCOMPLETE',
      }],
    };
    const state = harness({ activeRouting: incompleteRouting });

    await expect(retrieveAuthorized({
      query: 'Book Raw from current canon',
      relevantRoutingIntent: RELEVANT_INTENT,
    }, state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.resolveRequest).toHaveBeenCalledTimes(1);
    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.rankManifestShardCandidates).not.toHaveBeenCalled();
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();
  });

  test('resolves an exact section and pushes its immutable occurrence fence into ranking', async () => {
    const section = scopeResolution({ section: true });
    const candidate = material({
      headingPath: ['Championships', 'World Heavyweight Championship'],
      headingOccurrencePath: [2, 1],
    });
    const state = harness({
      scope: section,
      rankedCandidates: [candidate],
      selectedChunkCount: 1,
    });
    const query = {
      query: 'Who holds the championship?',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: ['WWE Universe', 'Monday Night Raw'],
        sectionPath: ['Championships'],
        scopeKind: 'page' as const,
      },
      retrievalMode: 'relevant' as const,
    };

    const { result } = await retrieveAuthorized({ query }, state.dependencies);

    expect(state.resolveScopeRequest).toHaveBeenCalledWith(UNIVERSE_ID, {
      pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
      pagePathKey: normalizeBackstageNotionScopePath([
        'WWE Universe',
        'Monday Night Raw',
      ]),
      sectionPathKey: normalizeBackstageNotionScopePath(['Championships']),
      scopeKind: 'page',
    });
    expect(state.rankManifestShardCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          shardKey: 'raw/2026',
          partitionVersionId: PARTITION_VERSION_ID,
          snapshotId: SNAPSHOT_ID,
          pageId: PAGE_ID,
          scopeKind: 'page',
          sectionOccurrencePath: [2],
          expectedPageCount: 1,
          expectedChunkCount: 1,
        },
      })
    );
    expect(result.resolvedScope).toEqual({
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe', 'Monday Night Raw'],
      sectionPath: ['Championships'],
    });
  });

  test('rejects an out-of-subtree candidate instead of widening repository scope', async () => {
    const subtree = scopeResolution({
      scopeKind: 'subtree',
      chunkCount: 2,
      pageCount: 2,
    });
    const state = harness({
      scope: subtree,
      selectedChunkCount: 2,
      rankedCandidates: [
        material({ index: 1 }),
        material({
          index: 2,
          pageId: '55555555-5555-4555-8555-555555555555',
          pagePath: ['WWE Universe', 'Friday Night SmackDown'],
        }),
      ],
    });

    await expect(retrieveAuthorized({
      query: {
        query: 'Find the strongest continuity match',
        retrievalMode: 'relevant',
        retrievalScope: {
          pageTitle: 'Monday Night Raw',
          pagePath: ['WWE Universe', 'Monday Night Raw'],
          scopeKind: 'subtree',
        },
      },
    }, state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.rankManifestShardCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          scopeKind: 'subtree',
          expectedPageCount: 2,
          expectedChunkCount: 2,
        }),
      })
    );
  });

  test('uses opaque authenticated keyset cursors and keeps continuation on manifest A', async () => {
    const firstChunks = Array.from({ length: 12 }, (_, index) => scopeChunk({
      index: index + 1,
      ordinal: index,
    }));
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      pinnedRouting: routing({
        manifestGeneration: '2',
        resolutionDigest: RESOLUTION_DIGEST_B,
        intent: COMPLETE_INTENT,
        configurationCurrent: false,
      }),
      page: {
        scopeChunkCount: 13,
        scopePageCount: 1,
        hasMore: true,
        chunks: firstChunks,
      },
    });
    const query = {
      query: 'Read every selected canon chunk',
      retrievalMode: 'complete_scope' as const,
    };

    const first = await retrieveAuthorized({ query }, state.dependencies);
    const firstSelectionDigest = first.result.selectionDigest;
    expect(Object.hasOwn(first.result, 'manifestGeneration')).toBe(false);
    expect(Object.hasOwn(first.result, 'routingResolutionDigest')).toBe(false);
    const cursor = first.result.nextCursor;
    expect(state.loadManifestScopeChunkPage).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: MANIFEST_A,
        after: null,
        limit: 12,
        scope: null,
      })
    );
    expect(cursor).toEqual(expect.any(String));
    expect(cursor!.length).toBeLessThanOrEqual(
      BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_MAX_LENGTH
    );
    expect(isBackstageContinuityCursorRequestValid({
      cursor,
      retrievalMode: 'complete_scope',
    })).toBe(true);
    const envelopeText = Buffer.from(cursor!, 'base64url').toString('latin1');
    for (const secretIdentifier of [
      MANIFEST_A,
      SNAPSHOT_ID,
      PARTITION_VERSION_ID,
      PAGE_ID,
      firstChunks.at(-1)!.chunkVersionId,
      'raw/2026',
    ]) {
      expect(cursor).not.toContain(secretIdentifier);
      expect(envelopeText).not.toContain(secretIdentifier);
    }

    state.resolveRequest.mockClear();
    state.resolvePinnedRequest.mockClear();
    const activeB = routing({
      manifestId: MANIFEST_B,
      manifestGeneration: '2',
      resolutionDigest: RESOLUTION_DIGEST_B,
      intent: COMPLETE_INTENT,
    });
    state.resolveRequest.mockImplementation(async () => activeB);
    state.loadManifestScopeChunkPage.mockImplementationOnce(async request => ({
      status: 'ready',
      manifestId: request.manifestId,
      selectedShardCount: 1,
      scopeChunkCount: 13,
      scopePageCount: 1,
      hasMore: false,
      chunks: [scopeChunk({ index: 13, ordinal: 12 })],
    }));
    const second = await retrieveAuthorized({
      query: { ...query, cursor: cursor! },
    }, state.dependencies);

    expect(state.resolveRequest).not.toHaveBeenCalled();
    expect(state.resolvePinnedRequest).toHaveBeenCalledWith(
      UNIVERSE_ID,
      MANIFEST_A,
      COMPLETE_INTENT
    );
    expect(state.loadManifestScopeChunkPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        manifestId: MANIFEST_A,
        after: {
          shardKey: 'raw/2026',
          pageId: PAGE_ID,
          ordinal: 11,
          chunkVersionId: uuid(12),
        },
      })
    );
    expect(second.result.manifestId).toBe(MANIFEST_A);
    expect(second.result.selectionDigest).toBe(firstSelectionDigest);
    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.rankManifestShardCandidates).not.toHaveBeenCalled();

    state.resolveRequest.mockClear();
    state.resolvePinnedRequest.mockClear();
    state.loadManifestScopeChunkPage.mockImplementationOnce(async request => ({
      status: 'ready',
      manifestId: request.manifestId,
      selectedShardCount: 1,
      scopeChunkCount: 1,
      scopePageCount: 1,
      hasMore: false,
      chunks: [scopeChunk({ index: 13, ordinal: 0 })],
    }));
    const freshAfterFlip = await retrieveAuthorized({ query }, state.dependencies);
    expect(state.resolveRequest).toHaveBeenCalledWith(UNIVERSE_ID, COMPLETE_INTENT);
    expect(state.resolvePinnedRequest).not.toHaveBeenCalled();
    expect(freshAfterFlip.result.manifestId).toBe(MANIFEST_B);
    expect(freshAfterFlip.result.selectionDigest).not.toBe(firstSelectionDigest);
  });

  test('accepts a previous cursor key during rotation and resolves each key once per request', async () => {
    const oldSecret = PREVIOUS_CURSOR_SECRET;
    const newSecret = CURSOR_SECRET;
    const firstChunks = Array.from({ length: 12 }, (_, index) => scopeChunk({
      index: index + 1,
      ordinal: index,
    }));
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      secret: oldSecret,
      page: {
        scopeChunkCount: 13,
        scopePageCount: 1,
        hasMore: true,
        chunks: firstChunks,
      },
    });
    const query = {
      query: 'Read every selected canon chunk',
      retrievalMode: 'complete_scope' as const,
    };
    const first = await retrieveAuthorized({ query }, state.dependencies);
    const cursor = first.result.nextCursor!;

    state.resolveCursorEncryptionSecret.mockClear();
    state.resolvePreviousCursorEncryptionSecret.mockClear();
    state.resolveCursorEncryptionSecret.mockImplementation(() => newSecret);
    state.resolvePreviousCursorEncryptionSecret.mockImplementation(() => oldSecret);
    state.loadManifestScopeChunkPage.mockImplementationOnce(async request => ({
      status: 'ready',
      manifestId: request.manifestId,
      selectedShardCount: 1,
      scopeChunkCount: 13,
      scopePageCount: 1,
      hasMore: false,
      chunks: [scopeChunk({ index: 13, ordinal: 12 })],
    }));

    const continued = await retrieveAuthorized({
      query: { ...query, cursor },
    }, state.dependencies);

    expect(continued.result.manifestId).toBe(MANIFEST_A);
    expect(state.resolveCursorEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(state.resolvePreviousCursorEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(state.resolvePinnedRequest).toHaveBeenCalledWith(
      UNIVERSE_ID,
      MANIFEST_A,
      COMPLETE_INTENT
    );
  });

  test('encrypts new cursors with only the current key', async () => {
    const firstChunks = Array.from({ length: 12 }, (_, index) => scopeChunk({
      index: index + 1,
      ordinal: index,
    }));
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      secret: CURSOR_SECRET,
      previousSecret: PREVIOUS_CURSOR_SECRET,
      page: {
        scopeChunkCount: 13,
        scopePageCount: 1,
        hasMore: true,
        chunks: firstChunks,
      },
    });
    const query = {
      query: 'Read every selected canon chunk',
      retrievalMode: 'complete_scope' as const,
    };
    const first = await retrieveAuthorized({ query }, state.dependencies);
    const cursor = first.result.nextCursor!;
    state.resolveRequest.mockClear();
    state.resolvePinnedRequest.mockClear();
    state.loadManifestScopeChunkPage.mockClear();

    const previousOnlyDependencies = {
      ...state.dependencies,
      resolveCursorEncryptionSecret: () => PREVIOUS_CURSOR_SECRET,
      resolvePreviousCursorEncryptionSecret: () => undefined,
    };
    await expect(retrieveAuthorized({
      query: { ...query, cursor },
    }, previousOnlyDependencies)).rejects.toBeInstanceOf(
      BackstageNotionCursorInvalidError
    );
    expect(state.resolvePinnedRequest).not.toHaveBeenCalled();
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();
  });

  test('rejects duplicate cursor keys before routing or repository effects', async () => {
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      secret: CURSOR_SECRET,
      previousSecret: CURSOR_SECRET,
    });

    await expect(retrieveAuthorized({
      query: {
        query: 'Read every selected canon chunk',
        retrievalMode: 'complete_scope',
      },
    }, state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.resolveCursorEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(state.resolvePreviousCursorEncryptionSecret).toHaveBeenCalledTimes(1);
    expect(state.resolveRequest).not.toHaveBeenCalled();
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();
  });

  test('emits a preflight-safe cursor at maximum legal counts and shard-key length', async () => {
    const shardKey = `a${'b'.repeat(127)}`;
    const maximumScopeChunkCount =
      BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
      * BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS;
    const maximumScopePageCount =
      BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
      * BACKSTAGE_NOTION_PARTITION_MAX_PAGES;
    const chunks = Array.from({ length: 12 }, (_, index) => scopeChunk({
      index: index + 1,
      ordinal: BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS - 12 + index,
      shardKey,
    }));
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT, shardKey }),
      page: {
        scopeChunkCount: maximumScopeChunkCount,
        scopePageCount: maximumScopePageCount,
        hasMore: true,
        chunks,
      },
    });

    const first = await retrieveAuthorized({
      query: {
        query: 'Read every selected canon chunk',
        retrievalMode: 'complete_scope',
      },
    }, state.dependencies);
    const cursor = first.result.nextCursor!;

    expect(shardKey).toHaveLength(128);
    expect(cursor.length).toBeLessThanOrEqual(
      BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_MAX_LENGTH
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,1024}$/u);
    expect(isBackstageContinuityCursorRequestValid({
      cursor,
      retrievalMode: 'complete_scope',
    })).toBe(true);
  });

  test('pins scoped continuation to manifest A and binds exact accepted scope spelling', async () => {
    const activeScope = scopeResolution({ section: true, chunkCount: 13 });
    const pinnedScopeRouting = routing({
      manifestGeneration: '2',
      resolutionDigest: RESOLUTION_DIGEST_B,
      intent: activeScope.routing.intent,
    });
    const firstChunks = Array.from({ length: 12 }, (_, index) => scopeChunk({
      index: index + 1,
      ordinal: index,
      headingPath: ['Championships'],
      headingOccurrencePath: [2, index + 1],
    }));
    const state = harness({
      activeRouting: activeScope.routing,
      pinnedRouting: pinnedScopeRouting,
      scope: activeScope,
      page: {
        scopeChunkCount: 13,
        scopePageCount: 1,
        hasMore: true,
        chunks: firstChunks,
      },
    });
    const query = {
      query: 'Read the full championship section',
      retrievalMode: 'complete_scope' as const,
      retrievalScope: {
        pageTitle: ' Monday Night Raw ',
        pagePath: ['WWE Universe', 'Monday Night Raw'],
        sectionPath: ['Championships'],
        scopeKind: 'page' as const,
      },
    };
    const first = await retrieveAuthorized({ query }, state.dependencies);
    const cursor = first.result.nextCursor!;
    state.resolveScopeRequest.mockClear();
    state.resolvePinnedScopeRequest.mockClear();

    await expect(retrieveAuthorized({
      query: {
        ...query,
        cursor,
        retrievalScope: {
          ...query.retrievalScope,
          pageTitle: 'Monday Night Raw',
        },
      },
    }, state.dependencies)).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(state.resolveScopeRequest).not.toHaveBeenCalled();
    expect(state.resolvePinnedScopeRequest).not.toHaveBeenCalled();

    state.loadManifestScopeChunkPage.mockImplementationOnce(async request => ({
      status: 'ready',
      manifestId: request.manifestId,
      selectedShardCount: 1,
      scopeChunkCount: 13,
      scopePageCount: 1,
      hasMore: false,
      chunks: [scopeChunk({
        index: 13,
        ordinal: 12,
        headingPath: ['Championships'],
        headingOccurrencePath: [2, 13],
      })],
    }));
    const second = await retrieveAuthorized({
      query: { ...query, cursor },
    }, state.dependencies);

    expect(state.resolveScopeRequest).not.toHaveBeenCalled();
    expect(state.resolvePinnedScopeRequest).toHaveBeenCalledWith(
      UNIVERSE_ID,
      MANIFEST_A,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
        pagePathKey: normalizeBackstageNotionScopePath([
          'WWE Universe',
          'Monday Night Raw',
        ]),
        sectionPathKey: normalizeBackstageNotionScopePath(['Championships']),
        scopeKind: 'page',
      }
    );
    expect(second.result.manifestId).toBe(MANIFEST_A);
    expect(second.result.selectionDigest).toBe(first.result.selectionDigest);
  });

  test('authenticates cursors before pinned routing and fails closed without a strong secret', async () => {
    const firstChunks = Array.from({ length: 12 }, (_, index) => scopeChunk({
      index: index + 1,
      ordinal: index,
    }));
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      page: {
        scopeChunkCount: 13,
        scopePageCount: 1,
        hasMore: true,
        chunks: firstChunks,
      },
    });
    const query = {
      query: 'Read every selected canon chunk',
      retrievalMode: 'complete_scope' as const,
    };
    const first = await retrieveAuthorized({ query }, state.dependencies);
    const cursor = first.result.nextCursor!;
    const replacement = cursor.endsWith('A') ? 'B' : 'A';
    const tampered = `${cursor.slice(0, -1)}${replacement}`;
    state.resolveRequest.mockClear();
    state.resolvePinnedRequest.mockClear();
    state.loadManifestScopeChunkPage.mockClear();

    await expect(retrieveAuthorized({
      query: { ...query, cursor: tampered },
    }, state.dependencies)).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(state.resolveRequest).not.toHaveBeenCalled();
    expect(state.resolvePinnedRequest).not.toHaveBeenCalled();
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();

    const weakSecret = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      secret: 'too-short',
    });
    await expect(retrieveAuthorized({ query }, weakSecret.dependencies))
      .rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(weakSecret.resolveRequest).not.toHaveBeenCalled();
    expect(weakSecret.loadManifestScopeChunkPage).not.toHaveBeenCalled();

    const weakPreviousSecret = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
      previousSecret: 'too-short',
    });
    await expect(retrieveAuthorized({ query }, weakPreviousSecret.dependencies))
      .rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(weakPreviousSecret.resolveRequest).not.toHaveBeenCalled();
    expect(weakPreviousSecret.loadManifestScopeChunkPage).not.toHaveBeenCalled();
  });

  test('rejects an oversized cursor before key, routing, or repository effects', async () => {
    const state = harness({
      activeRouting: routing({ intent: COMPLETE_INTENT }),
    });

    await expect(retrieveAuthorized({
      query: {
        query: 'Read every selected canon chunk',
        retrievalMode: 'complete_scope',
        cursor: 'A'.repeat(
          BACKSTAGE_NOTION_PARTITION_RETRIEVAL_CURSOR_MAX_LENGTH + 1
        ),
      },
    }, state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionCursorInvalidError
    );
    expect(state.resolveCursorEncryptionSecret).not.toHaveBeenCalled();
    expect(state.resolvePreviousCursorEncryptionSecret).not.toHaveBeenCalled();
    expect(state.resolveRequest).not.toHaveBeenCalled();
    expect(state.resolvePinnedRequest).not.toHaveBeenCalled();
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();
  });

  test('rejects non-inert plan, query, scope, and path inputs before effects', async () => {
    const state = harness();
    let accessorCalls = 0;
    const planAccessor = {};
    Object.defineProperty(planAccessor, 'query', {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 'do not execute';
      },
    });
    const queryAccessor = {};
    Object.defineProperty(queryAccessor, 'query', {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 'do not execute';
      },
    });
    const scopeAccessor = {};
    Object.defineProperty(scopeAccessor, 'pageTitle', {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 'Monday Night Raw';
      },
    });
    const pathAccessor = ['WWE Universe'];
    Object.defineProperty(pathAccessor, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 'WWE Universe';
      },
    });
    const symbolPlan = {
      query: 'do not execute',
      relevantRoutingIntent: RELEVANT_INTENT,
      [Symbol('unknown')]: true,
    };
    const prototypePlan = Object.assign(Object.create({}), {
      query: 'do not execute',
      relevantRoutingIntent: RELEVANT_INTENT,
    }) as object;
    const inheritedQuery = Object.create({ query: 'do not execute' }) as object;
    const symbolQuery = {
      query: 'do not execute',
      [Symbol('unknown')]: true,
    };
    const prototypeScope = Object.assign(Object.create({}), {
      pageTitle: 'Monday Night Raw',
    }) as object;
    const sparsePath = new Array(1);
    const cases: unknown[] = [
      planAccessor,
      {
        query: 'do not execute',
        relevantRoutingIntent: RELEVANT_INTENT,
        unexpected: true,
      },
      { query: queryAccessor, relevantRoutingIntent: RELEVANT_INTENT },
      { query: symbolQuery, relevantRoutingIntent: RELEVANT_INTENT },
      {
        query: {
          query: 'do not execute',
          retrievalMode: 'relevant',
          unexpected: true,
        },
        relevantRoutingIntent: RELEVANT_INTENT,
      },
      {
        query: {
          query: 'do not execute',
          retrievalScope: scopeAccessor,
        },
      },
      {
        query: {
          query: 'do not execute',
          retrievalScope: {
            pageTitle: 'Monday Night Raw',
            unexpected: true,
          },
        },
      },
      {
        query: {
          query: 'do not execute',
          retrievalScope: {
            pageTitle: 'Monday Night Raw',
            [Symbol('unknown')]: true,
          },
        },
      },
      {
        query: {
          query: 'do not execute',
          retrievalScope: prototypeScope,
        },
      },
      {
        query: {
          query: 'do not execute',
          retrievalScope: {
            pageTitle: 'Monday Night Raw',
            pagePath: pathAccessor,
          },
        },
      },
      {
        query: {
          query: 'do not execute',
          retrievalScope: {
            pageTitle: 'Monday Night Raw',
            pagePath: sparsePath,
          },
        },
      },
      { query: inheritedQuery, relevantRoutingIntent: RELEVANT_INTENT },
      symbolPlan,
      prototypePlan,
    ];

    for (const hostile of cases) {
      await expect(retrieveAuthorized(
        hostile as BackstageNotionPartitionRetrievalPlan,
        state.dependencies
      )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    }
    expect(accessorCalls).toBe(0);
    expect(state.resolveRequest).not.toHaveBeenCalled();
    expect(state.resolveScopeRequest).not.toHaveBeenCalled();
    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.rankManifestShardCandidates).not.toHaveBeenCalled();
    expect(state.loadManifestScopeChunkPage).not.toHaveBeenCalled();
  });

  test('requires authorization and rejects malformed selected content before prompt use', async () => {
    const malformed = {
      ...material(),
      contentHash: sha256('different content'),
    };
    const state = harness({ rankedCandidates: [malformed] });
    const plan = {
      query: 'Book Raw from current canon',
      relevantRoutingIntent: RELEVANT_INTENT,
    };

    await expect(retrieveBackstageNotionPartitionRagContext(
      UNIVERSE_ID,
      plan,
      state.dependencies
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(state.resolveRequest).not.toHaveBeenCalled();

    await expect(retrieveAuthorized(plan, state.dependencies))
      .rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(state.rankManifestShardCandidates).toHaveBeenCalledTimes(1);
  });
});
