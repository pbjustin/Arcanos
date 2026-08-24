import { describe, expect, jest, test } from '@jest/globals';

import type {
  BackstageNotionActiveManifestRoutingState,
  BackstageNotionManifestScopeOwnerResolution,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import {
  BackstageNotionPartitionRoutingUnavailableError,
  resolveBackstageNotionPartitionRequest,
  resolveBackstageNotionPartitionScopeRequest,
  type BackstageNotionPartitionRoutingDependencies,
} from '../src/services/backstageNotionPartitionRouting.js';
import { normalizeBackstageNotionScopeKey } from
  '../src/shared/backstage/backstageNotionScopeIndex.js';

const UNIVERSE_ID = 'my-universe-2k26';
const MANIFEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIGURATION_VERSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RAW_PARTITION_VERSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RAW_SNAPSHOT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ARCHIVE_PARTITION_VERSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ARCHIVE_SNAPSHOT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-24T12:00:00.000Z');
const CONFIGURATION_HASH = '1'.repeat(64);

function routingState(
  overrides: Partial<BackstageNotionActiveManifestRoutingState> = {}
): BackstageNotionActiveManifestRoutingState {
  return {
    universeId: UNIVERSE_ID,
    manifestId: MANIFEST_ID,
    manifestGeneration: '4',
    configurationVersionId: CONFIGURATION_VERSION_ID,
    configurationGeneration: 'partition-generation-1',
    configurationHash: CONFIGURATION_HASH,
    configurationCurrent: true,
    embeddingModel: 'text-embedding-test',
    embeddingVersion: 1,
    embeddingDimension: 2,
    indexFormatVersion: 1,
    manifestCreatedAt: new Date('2026-08-24T11:58:00.000Z'),
    manifestSealedAt: new Date('2026-08-24T11:59:00.000Z'),
    pageCount: 2,
    chunkCount: 2,
    members: [{
      shardKey: 'raw/2026',
      partitionVersionId: RAW_PARTITION_VERSION_ID,
      snapshotId: RAW_SNAPSHOT_ID,
      retrievalTier: 'hot',
      required: true,
      decision: 'fresh',
      verifiedAt: new Date('2026-08-24T11:55:00.000Z'),
      snapshotCreatedAt: new Date('2026-08-24T11:54:00.000Z'),
      snapshotSealedAt: new Date('2026-08-24T11:54:30.000Z'),
      pageCount: 1,
      chunkCount: 1,
      scopeTags: ['brand:raw', 'year:2026'],
      categoryTags: ['current'],
    }, {
      shardKey: 'archive/raw/2025',
      partitionVersionId: ARCHIVE_PARTITION_VERSION_ID,
      snapshotId: ARCHIVE_SNAPSHOT_ID,
      retrievalTier: 'archive',
      required: false,
      decision: 'retained_last_known_good',
      verifiedAt: new Date('2026-08-20T12:00:00.000Z'),
      snapshotCreatedAt: new Date('2026-08-20T11:58:00.000Z'),
      snapshotSealedAt: new Date('2026-08-20T11:59:00.000Z'),
      pageCount: 1,
      chunkCount: 1,
      scopeTags: ['brand:raw', 'year:2025'],
      categoryTags: ['archive'],
    }],
    omissions: [],
    ...overrides,
  };
}

function repository(
  state: BackstageNotionActiveManifestRoutingState | null,
  owner: BackstageNotionManifestScopeOwnerResolution = { status: 'not_found' }
) {
  return {
    loadActiveManifestRoutingState: jest.fn(async () => state),
    resolveManifestScopeOwner: jest.fn(async () => owner),
  };
}

function authorizedDependencies(
  mockRepository: ReturnType<typeof repository>,
  overrides: Omit<
    BackstageNotionPartitionRoutingDependencies,
    'repository' | 'resolveAuthorityRoot'
  > = {}
): BackstageNotionPartitionRoutingDependencies {
  return {
    repository: mockRepository,
    resolveAuthorityRoot: async universeId => ({
      universeId,
      rootPageId: PAGE_ID,
      displayName: 'Test Universe',
    }),
    ...overrides,
  };
}

function rawIntent() {
  return {
    kind: 'relevant',
    cardinality: 'all_matching',
    allowedTiers: ['hot'],
    explicitArchive: false,
    selectors: [{
      allScopeTags: ['brand:raw'],
      allCategoryTags: ['current'],
    }],
  };
}

describe('Backstage Notion partition request routing', () => {
  test('admits an exact-boundary hot shard without loading a stale unselected archive', async () => {
    const mockRepository = repository(routingState());
    const readMaximumStalenessMs = jest.fn(() => 5 * 60 * 1_000);

    const resolved = await resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      rawIntent(),
      authorizedDependencies(mockRepository, {
        now: () => NOW,
        readMaximumStalenessMs,
      })
    );

    expect(resolved).toMatchObject({
      status: 'resolved',
      configurationCurrent: true,
      shards: [{ shardKey: 'raw/2026', snapshotId: RAW_SNAPSHOT_ID }],
    });
    expect(resolved.status === 'resolved' ? resolved.shards : []).toHaveLength(1);
    expect(mockRepository.loadActiveManifestRoutingState).toHaveBeenCalledTimes(1);
    expect(mockRepository.resolveManifestScopeOwner).not.toHaveBeenCalled();
    expect(readMaximumStalenessMs).toHaveBeenCalledTimes(1);
  });

  test('fails only when a stale or excessive-future shard is selected', async () => {
    const oneMillisecondStale = routingState({
      members: [{
        ...routingState().members[0]!,
        verifiedAt: new Date('2026-08-24T11:54:59.999Z'),
      }],
      pageCount: 1,
      chunkCount: 1,
    });
    await expect(resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      rawIntent(),
      authorizedDependencies(repository(oneMillisecondStale), {
        now: () => NOW,
        maximumStalenessMs: 5 * 60 * 1_000,
      })
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);

    const futureVerifiedAt = new Date(
      NOW.getTime() + 5 * 60 * 1_000 + 1
    );
    const future = routingState({
      manifestSealedAt: futureVerifiedAt,
      members: [{
        ...routingState().members[0]!,
        verifiedAt: futureVerifiedAt,
        snapshotSealedAt: futureVerifiedAt,
      }],
      pageCount: 1,
      chunkCount: 1,
    });
    await expect(resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      rawIntent(),
      authorizedDependencies(repository(future), {
        now: () => NOW,
        maximumStalenessMs: 5 * 60 * 1_000,
      })
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);

    await expect(resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      {
        kind: 'relevant',
        cardinality: 'exactly_one',
        allowedTiers: ['archive'],
        explicitArchive: true,
        selectors: [{
          allScopeTags: ['year:2025'],
          allCategoryTags: ['archive'],
        }],
      },
      authorizedDependencies(repository(routingState()), {
        now: () => NOW,
        maximumStalenessMs: 5 * 60 * 1_000,
      })
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);
  });

  test('keeps a prior active configuration readable and never auto-adds required shards', async () => {
    const state = routingState({ configurationCurrent: false });
    const resolved = await resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      rawIntent(),
      authorizedDependencies(repository(state), {
        now: () => NOW,
        maximumStalenessMs: 5 * 60 * 1_000,
      })
    );

    expect(resolved).toMatchObject({
      status: 'resolved',
      configurationCurrent: false,
      shards: [{ shardKey: 'raw/2026' }],
    });
    expect(resolved.status === 'resolved' ? resolved.shards : []).toHaveLength(1);
  });

  test('rejects malformed closed selectors before database work', async () => {
    const mockRepository = repository(routingState());

    await expect(resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      { ...rawIntent(), unexpected: true },
      authorizedDependencies(mockRepository)
    )).rejects.toThrow(/unknown fields/u);
    expect(mockRepository.loadActiveManifestRoutingState).not.toHaveBeenCalled();
  });

  test('requires the existing effective authority boundary before partition work', async () => {
    const mockRepository = repository(routingState());
    const resolveAuthorityRoot = jest.fn(async () => null);

    await expect(resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      rawIntent(),
      { repository: mockRepository, resolveAuthorityRoot }
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);
    expect(resolveAuthorityRoot).toHaveBeenCalledWith(UNIVERSE_ID);
    expect(mockRepository.loadActiveManifestRoutingState).not.toHaveBeenCalled();

    await expect(resolveBackstageNotionPartitionRequest(
      UNIVERSE_ID,
      rawIntent(),
      {
        repository: mockRepository,
        resolveAuthorityRoot: async () => ({
          universeId: 'different-universe',
          rootPageId: PAGE_ID,
          displayName: 'Wrong Universe',
        }),
      }
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);
    expect(mockRepository.loadActiveManifestRoutingState).not.toHaveBeenCalled();
  });

  test('rejects hostile scope lookups before authority or repository work', async () => {
    const mockRepository = repository(routingState());
    const resolveAuthorityRoot = jest.fn(async () => ({
      universeId: UNIVERSE_ID,
      rootPageId: PAGE_ID,
      displayName: 'Test Universe',
    }));
    const titleKey = normalizeBackstageNotionScopeKey('Monday Night Raw');
    const invoke = (lookup: unknown) => resolveBackstageNotionPartitionScopeRequest(
      UNIVERSE_ID,
      lookup,
      { repository: mockRepository, resolveAuthorityRoot }
    );

    await expect(invoke({
      pageTitleKey: titleKey,
      pagePathKey: null,
      scopeKind: 'page',
      unexpected: true,
    })).rejects.toThrow(/unknown fields/u);
    await expect(invoke({
      pageTitleKey: titleKey,
      pagePathKey: Array.from({ length: 102 }, () => titleKey),
      scopeKind: 'page',
    })).rejects.toThrow(/bounded array contract/u);

    const sparsePath = new Array(1);
    await expect(invoke({
      pageTitleKey: titleKey,
      pagePathKey: sparsePath,
      scopeKind: 'page',
    })).rejects.toThrow(/inert data property/u);
    let accessorCalls = 0;
    const accessorPath = [titleKey];
    Object.defineProperty(accessorPath, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return titleKey;
      },
    });
    await expect(invoke({
      pageTitleKey: titleKey,
      pagePathKey: accessorPath,
      scopeKind: 'page',
    })).rejects.toThrow(/inert data property/u);
    expect(accessorCalls).toBe(0);
    expect(resolveAuthorityRoot).not.toHaveBeenCalled();
    expect(mockRepository.loadActiveManifestRoutingState).not.toHaveBeenCalled();
    expect(mockRepository.resolveManifestScopeOwner).not.toHaveBeenCalled();
  });

  test('binds scope ownership to the same manifest and exact shard snapshot', async () => {
    const owner = {
      status: 'resolved' as const,
      manifestId: MANIFEST_ID,
      shardKey: 'raw/2026',
      partitionVersionId: RAW_PARTITION_VERSION_ID,
      snapshotId: RAW_SNAPSHOT_ID,
      pageId: PAGE_ID,
      pageTitle: 'Monday Night Raw',
      pagePath: ['Monday Night Raw'],
      scopeKind: 'subtree' as const,
      scopeChunkCount: 1,
      scopePageCount: 1,
    };
    const mockRepository = repository(routingState(), owner);
    const lookup = {
      pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
      pagePathKey: null,
      scopeKind: 'subtree' as const,
    };

    const resolved = await resolveBackstageNotionPartitionScopeRequest(
      UNIVERSE_ID,
      lookup,
      authorizedDependencies(mockRepository, {
        now: () => NOW,
        maximumStalenessMs: 5 * 60 * 1_000,
      })
    );

    expect(resolved).toMatchObject({
      status: 'resolved',
      owner: { pageId: PAGE_ID, shardKey: 'raw/2026' },
      routing: { shards: [{ snapshotId: RAW_SNAPSHOT_ID }] },
    });
    expect(mockRepository.resolveManifestScopeOwner).toHaveBeenCalledWith(
      UNIVERSE_ID,
      MANIFEST_ID,
      lookup
    );
  });

  test('does not widen stale-manifest scope failures or mismatched ownership', async () => {
    const invalidRepository = repository(routingState(), { status: 'invalid' });
    await expect(resolveBackstageNotionPartitionScopeRequest(
      UNIVERSE_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
        pagePathKey: null,
        scopeKind: 'page',
      },
      authorizedDependencies(invalidRepository)
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);

    const mismatchedOwner = {
      status: 'resolved' as const,
      manifestId: MANIFEST_ID,
      shardKey: 'raw/2026',
      partitionVersionId: RAW_PARTITION_VERSION_ID,
      snapshotId: ARCHIVE_SNAPSHOT_ID,
      pageId: PAGE_ID,
      pageTitle: 'Monday Night Raw',
      pagePath: ['Monday Night Raw'],
      scopeKind: 'page' as const,
      scopeChunkCount: 1,
      scopePageCount: 1,
    };
    await expect(resolveBackstageNotionPartitionScopeRequest(
      UNIVERSE_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
        pagePathKey: null,
        scopeKind: 'page',
      },
      authorizedDependencies(repository(routingState(), mismatchedOwner))
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);

    await expect(resolveBackstageNotionPartitionScopeRequest(
      UNIVERSE_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
        pagePathKey: null,
        scopeKind: 'page',
      },
      authorizedDependencies(repository(routingState(), {
        ...mismatchedOwner,
        manifestId: '22222222-2222-4222-8222-222222222222',
        snapshotId: RAW_SNAPSHOT_ID,
      }))
    )).rejects.toBeInstanceOf(BackstageNotionPartitionRoutingUnavailableError);
  });
});
