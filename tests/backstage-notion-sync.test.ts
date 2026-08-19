import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT,
  BackstageNotionSyncLeaseError,
  type ActivateBackstageNotionSnapshotInput,
  type BackstageNotionActiveInventory,
  type BackstageNotionAuthorityHead,
  type BackstageNotionRagRepository,
  type BackstageNotionSnapshotRecord,
  type BackstageNotionSyncLease,
} from '../src/core/db/repositories/backstageNotionRagRepository.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import {
  BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME,
} from '../src/shared/backstage/backstageNotionContextCore.js';
import {
  BACKSTAGE_NOTION_RAG_CHUNK_CODE_POINTS,
  BACKSTAGE_NOTION_RAG_PAGE_FORMAT,
} from '../src/shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME,
  type BackstageNotionAuthorityRoot,
} from '../src/services/backstageNotionAuthority.js';
import {
  BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
  BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
  BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
  BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
  syncBackstageNotionAuthorityRoot,
  syncConfiguredBackstageNotionAuthorities,
  type BackstageNotionSyncDependencies,
} from '../src/services/backstageNotionSync.js';

const universeId = 'my-universe-2k26';
const notionToken = `ntn_${'s'.repeat(48)}`;
const holderId = 'backstage-notion-sync-test';
const fixedTime = new Date('2026-08-19T12:00:00.000Z');
const lease: BackstageNotionSyncLease = {
  universeId,
  holderId,
  leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  acquiredAt: new Date('2026-08-19T11:59:00.000Z'),
  expiresAt: new Date('2026-08-19T12:14:00.000Z'),
};

interface TestNotionPage {
  pageId: string;
  parentPageId: string | null;
  title: string;
  markdown: string;
  lastEditedAt?: Date;
  inTrash?: boolean;
  truncated?: boolean;
  unknownBlockIds?: string[];
}

interface FetchOptions {
  metadataParentOverrides?: ReadonlyMap<string, string | null>;
  driftPageId?: string;
  retryMetadataPageId?: string;
}

function pageId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-1111-4111-8111-${index
    .toString(16)
    .padStart(12, '0')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pageTag(page: TestNotionPage): string {
  return `<page url="notion://${page.pageId}">${page.title}</page>`;
}

function environmentReader(options: {
  token?: string;
  authority?: string;
  throwOnRead?: boolean;
} = {}) {
  return (name: string): string | undefined => {
    if (options.throwOnRead) {
      throw new Error('PRIVATE-ENVIRONMENT-DETAIL');
    }
    if (name === BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME) {
      return options.token;
    }
    if (name === BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME) {
      return options.authority;
    }
    return undefined;
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function notionFetch(
  pages: readonly TestNotionPage[],
  options: FetchOptions = {}
) {
  const byId = new Map(pages.map(page => [page.pageId, page]));
  const metadataCalls = new Map<string, number>();
  const fetchMock = jest.fn(async (
    input: string | URL | Request
  ): Promise<Response> => {
    const url = new URL(String(input));
    const match = /^\/v1\/pages\/([^/]+)(\/markdown)?$/u.exec(url.pathname);
    const requestedPageId = match?.[1] ?? '';
    const markdownRequest = match?.[2] === '/markdown';
    const page = byId.get(requestedPageId);
    if (!page) {
      return jsonResponse({ error: 'not found' }, 404);
    }

    if (markdownRequest) {
      return jsonResponse({
        object: 'page_markdown',
        id: page.pageId,
        markdown: page.markdown,
        truncated: page.truncated ?? false,
        unknown_block_ids: page.unknownBlockIds ?? [],
      });
    }

    const callCount = (metadataCalls.get(page.pageId) ?? 0) + 1;
    metadataCalls.set(page.pageId, callCount);
    if (
      options.retryMetadataPageId === page.pageId
      && callCount === 1
    ) {
      return jsonResponse({ error: 'try later' }, 429);
    }
    const lastEditedAt = options.driftPageId === page.pageId && callCount >= 2
      ? new Date((page.lastEditedAt ?? fixedTime).getTime() + 1_000)
      : page.lastEditedAt ?? fixedTime;
    const parentPageId = options.metadataParentOverrides?.has(page.pageId)
      ? options.metadataParentOverrides.get(page.pageId) ?? null
      : page.parentPageId;
    return jsonResponse({
      object: 'page',
      id: page.pageId,
      parent: parentPageId
        ? { type: 'page_id', page_id: parentPageId }
        : { type: 'workspace', workspace: true },
      last_edited_time: lastEditedAt.toISOString(),
      in_trash: page.inTrash ?? false,
    });
  });

  return { fetchMock, metadataCalls };
}

function snapshotRecord(
  input: ActivateBackstageNotionSnapshotInput
): BackstageNotionSnapshotRecord {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    universeId: input.universeId,
    rootPageId: input.rootPageId,
    manifestHash: input.manifestHash,
    embeddingModel: input.embeddingModel,
    pageCount: input.pages.length,
    chunkCount: input.chunks.length,
    sourceMaxEditedAt: input.sourceMaxEditedAt as Date | null,
    syncHolderId: input.lease.holderId,
    createdAt: new Date('2026-08-19T12:05:00.000Z'),
  };
}

function activeInventory(
  manifestHash: string,
  chunkCount = 1
): BackstageNotionActiveInventory {
  return {
    authority: 'notion',
    verifiedAt: new Date('2026-08-19T12:04:00.000Z'),
    snapshot: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      universeId,
      rootPageId: pageId(0),
      manifestHash,
      embeddingModel: 'text-embedding-3-small',
      pageCount: 1,
      chunkCount,
      sourceMaxEditedAt: fixedTime,
      syncHolderId: holderId,
      createdAt: new Date('2026-08-19T12:00:00.000Z'),
    },
    pages: [],
  };
}

function repositoryHarness(options: {
  leaseBusy?: boolean;
  authorityHead?: BackstageNotionAuthorityHead | null;
  active?: BackstageNotionActiveInventory | null;
  loadActive?: () => BackstageNotionActiveInventory | null;
  reusable?: (
    hashes: string[]
  ) => Map<string, number[]>;
  releaseFails?: boolean;
  renewLease?: () => BackstageNotionSyncLease | null | Promise<BackstageNotionSyncLease | null>;
} = {}) {
  const acquireSyncLease = jest.fn(async (
    requestedUniverseId: string,
    _holderId: string,
    _ttlMs: number
  ): Promise<BackstageNotionSyncLease | null> => (
    options.leaseBusy ? null : { ...lease, universeId: requestedUniverseId }
  ));
  const renewSyncLease = jest.fn(async (): Promise<BackstageNotionSyncLease | null> => (
    options.renewLease ? options.renewLease() : lease
  ));
  const releaseSyncLease = jest.fn(async (): Promise<boolean> => {
    if (options.releaseFails) {
      throw new Error('PRIVATE-LEASE-FAILURE');
    }
    return true;
  });
  const loadAuthorityHead = jest.fn(async (requestedUniverseId: string): Promise<
    BackstageNotionAuthorityHead | null
  > => options.authorityHead === undefined
    ? {
        universeId: requestedUniverseId,
        authority: 'postgres',
        activeSnapshotId: null,
        rootPageId: null,
      }
    : options.authorityHead);
  const loadReusableEmbeddings = jest.fn(async (
    _universeId: string,
    _embeddingModel: string,
    hashes: string[]
  ): Promise<Map<string, number[]>> => options.reusable?.(hashes) ?? new Map());
  const markActiveSnapshotVerified = jest.fn(async (): Promise<Date> => (
    new Date('2026-08-19T12:06:00.000Z')
  ));
  const activateSnapshot = jest.fn(async (
    input: ActivateBackstageNotionSnapshotInput
  ): Promise<BackstageNotionSnapshotRecord> => snapshotRecord(input));
  const loadActiveSnapshot = jest.fn(async () => null);
  const loadActiveInventory = jest.fn(async (): Promise<
    BackstageNotionActiveInventory | null
  > => options.loadActive?.() ?? options.active ?? null);
  const repository: BackstageNotionRagRepository = {
    loadAuthorityHead,
    acquireSyncLease,
    renewSyncLease,
    releaseSyncLease,
    loadReusableEmbeddings,
    markActiveSnapshotVerified,
    activateSnapshot,
    loadActiveSnapshot,
    loadActiveInventory,
  };

  return {
    repository,
    loadAuthorityHead,
    acquireSyncLease,
    renewSyncLease,
    releaseSyncLease,
    loadReusableEmbeddings,
    markActiveSnapshotVerified,
    activateSnapshot,
    loadActiveInventory,
  };
}

function rootAuthority(options: {
  initialMinimumPageCount?: number;
} = {}): BackstageNotionAuthorityRoot {
  return {
    universeId,
    rootPageId: pageId(0),
    displayName: 'WWE Universe Mode',
    ...(options.initialMinimumPageCount === undefined
      ? {}
      : { initialMinimumPageCount: options.initialMinimumPageCount }),
  };
}

function dependencies(input: {
  repository: BackstageNotionRagRepository;
  fetchImpl?: typeof fetch;
  embedBatch?: (inputs: readonly string[]) => Promise<number[][]>;
  readEnvironment?: (name: string) => string | undefined;
  signal?: AbortSignal;
  leaseRenewalIntervalMs?: number;
  fetchTimeoutMs?: number;
}): BackstageNotionSyncDependencies {
  return {
    repository: input.repository,
    fetchImpl: input.fetchImpl,
    embedBatch: input.embedBatch ?? (async values => values.map(() => [1, 0])),
    readEnvironment: input.readEnvironment
      ?? environmentReader({ token: notionToken }),
    requestSpacingMs: 0,
    retryBaseDelayMs: 0,
    fetchTimeoutMs: input.fetchTimeoutMs ?? 1_000,
    holderId,
    ...(input.leaseRenewalIntervalMs === undefined
      ? {}
      : { leaseRenewalIntervalMs: input.leaseRenewalIntervalMs }),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function hierarchyWithEighteenPages(): TestNotionPage[] {
  const pages = Array.from({ length: 18 }, (_, index): TestNotionPage => ({
    pageId: pageId(index),
    parentPageId: index === 0 ? null : pageId(Math.floor((index - 1) / 3)),
    title: index === 0 ? 'WWE Universe Mode' : `Universe page ${index}`,
    markdown: `# Universe page ${index}\n\nPRIVATE-CONTINUITY-${index}`,
  }));
  const childrenByParent = new Map<string, TestNotionPage[]>();
  for (const page of pages.slice(1)) {
    const children = childrenByParent.get(page.parentPageId ?? '') ?? [];
    children.push(page);
    childrenByParent.set(page.parentPageId ?? '', children);
  }
  for (const page of pages) {
    const children = childrenByParent.get(page.pageId) ?? [];
    page.markdown += children.length > 0
      ? `\n\n${children.map(pageTag).join('\n')}`
      : '';
  }
  pages[15].markdown = [
    '| Champion | Brand |',
    '| --- | --- |',
    '| Becky Lynch | Raw |',
    '| Lyra Valkyria | NXT |',
  ].join('\n');
  pages[17].markdown = '';
  return pages;
}

describe('Backstage Notion authority synchronization', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('captures and atomically activates a complete recursive 18-page hierarchy', async () => {
    const pages = hierarchyWithEighteenPages();
    const { fetchMock, metadataCalls } = notionFetch(pages);
    const repository = repositoryHarness();
    const embedBatch = jest.fn(async (inputs: readonly string[]) => (
      inputs.map(() => [1, 0])
    ));

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 18 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
        fetchTimeoutMs: 30_000,
      })
    );

    expect(result).toMatchObject({ status: 'activated', pageCount: 18 });
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.pages).toHaveLength(18);
    expect(activation?.pages.find(page => page.pageId === pageId(17))?.markdown)
      .toBe('');
    expect(activation?.chunks.some(chunk => chunk.content === pages[15].markdown))
      .toBe(true);
    expect([...metadataCalls.values()].every(count => count === 2)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(54);
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);

    const logged = JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
    ]);
    expect(logged).not.toContain(notionToken);
    expect(logged).not.toContain('PRIVATE-CONTINUITY');
    expect(logged).not.toContain(pageId(15));
  });

  it.each([
    {
      chunkCount: BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT,
      accepted: true,
    },
    {
      chunkCount: BACKSTAGE_NOTION_MAX_CHUNKS_PER_SNAPSHOT + 1,
      accepted: false,
    },
  ])('enforces the retrievable snapshot boundary at $chunkCount chunks', async ({
    chunkCount,
    accepted,
  }) => {
    const pageCount = 32;
    const contentChunkCount = chunkCount - 1;
    const baseChunksPerPage = Math.floor(contentChunkCount / pageCount);
    const extraChunkPages = contentChunkCount % pageCount;
    const pages = Array.from({ length: pageCount }, (_, index): TestNotionPage => {
      const chunksForPage = baseChunksPerPage + (index < extraChunkPages ? 1 : 0);
      return {
        pageId: pageId(index),
        parentPageId: index === 0 ? null : pageId(0),
        title: index === 0 ? 'WWE Universe Mode' : `Child Universe ${index}`,
        markdown: String.fromCharCode(97 + (index % 26)).repeat(
          (chunksForPage - 1) * BACKSTAGE_NOTION_RAG_CHUNK_CODE_POINTS + 1
        ),
      };
    });
    pages[0].markdown += `\n\n${pages.slice(1).map(pageTag).join('\n')}`;
    const { fetchMock } = notionFetch(pages);
    const repository = repositoryHarness();
    const embedBatch = jest.fn(async (inputs: readonly string[]) => (
      inputs.map(() => [1, 0])
    ));
    const sync = syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
        fetchTimeoutMs: 30_000,
      })
    );

    if (accepted) {
      await expect(sync).resolves.toMatchObject({
        status: 'activated',
        chunkCount,
      });
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    } else {
      await expect(sync).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      });
      expect(embedBatch).not.toHaveBeenCalled();
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      label: 'invalid child tag',
      page: { markdown: '<page url="notion://not-a-uuid">Bad child</page>' },
    },
    {
      label: 'truncated Markdown',
      page: { markdown: '# Partial', truncated: true },
    },
    {
      label: 'unknown Notion block',
      page: {
        markdown: '# Unknown',
        unknownBlockIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      },
    },
    {
      label: 'media block',
      page: { markdown: '<image source="notion://private-media">Image</image>' },
    },
  ])('rejects $label without embedding or activation', async ({ page }) => {
    const pages: TestNotionPage[] = [{
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: page.markdown,
      ...page,
    }];
    const { fetchMock } = notionFetch(pages);
    const repository = repositoryHarness();
    const embedBatch = jest.fn(async () => [[1, 0]]);

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
      })
    )).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE });

    expect(embedBatch).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed unterminated child tag that the structured parser cannot count', async () => {
    const pages: TestNotionPage[] = [{
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: `<page url="notion://${pageId(1)}"`,
    }];
    const { fetchMock } = notionFetch(pages);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('rejects child-parent mismatch and source drift without activation', async () => {
    const child: TestNotionPage = {
      pageId: pageId(1),
      parentPageId: pageId(0),
      title: 'Child',
      markdown: '# Child',
    };
    const pages: TestNotionPage[] = [{
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: pageTag(child),
    }, child];

    const parentMismatchFetch = notionFetch(pages, {
      metadataParentOverrides: new Map([[child.pageId, pageId(9)]]),
    });
    const parentRepository = repositoryHarness();
    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: parentRepository.repository,
        fetchImpl: parentMismatchFetch.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE });
    expect(parentRepository.activateSnapshot).not.toHaveBeenCalled();

    const driftRoot: TestNotionPage = {
      ...pages[0],
      markdown: '# Root',
    };
    const driftFetch = notionFetch([driftRoot], { driftPageId: pageId(0) });
    const driftRepository = repositoryHarness();
    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: driftRepository.repository,
        fetchImpl: driftFetch.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE });
    expect(driftRepository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('reverifies source metadata after embeddings and rejects an edit during embedding', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock, metadataCalls } = notionFetch([page], {
      driftPageId: page.pageId,
    });
    const repository = repositoryHarness();
    const embeddingStarted = deferred<void>();
    const finishEmbedding = deferred<void>();
    const embedBatch = jest.fn(async (inputs: readonly string[]) => {
      embeddingStarted.resolve(undefined);
      await finishEmbedding.promise;
      return inputs.map(() => [1, 0]);
    });

    const sync = syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
      })
    );
    await embeddingStarted.promise;
    expect(metadataCalls.get(page.pageId)).toBe(1);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    finishEmbedding.resolve(undefined);

    await expect(sync).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
    });
    expect(metadataCalls.get(page.pageId)).toBe(2);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('enforces initial minimum coverage only before the first activation', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const firstFetch = notionFetch([page]);
    const firstRepository = repositoryHarness();
    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 18 }),
      dependencies({
        repository: firstRepository.repository,
        fetchImpl: firstFetch.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE });
    expect(firstRepository.activateSnapshot).not.toHaveBeenCalled();

    const laterFetch = notionFetch([page]);
    const laterRepository = repositoryHarness({
      active: activeInventory('f'.repeat(64)),
    });
    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 18 }),
      dependencies({
        repository: laterRepository.repository,
        fetchImpl: laterFetch.fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated', pageCount: 1 });
  });

  it('marks an unchanged snapshot verified without loading or creating embeddings', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Kayfabe\n\nContinuity.',
    };
    const { fetchMock } = notionFetch([page]);
    let currentInventory: BackstageNotionActiveInventory | null = null;
    const repository = repositoryHarness({ loadActive: () => currentInventory });
    const embedBatch = jest.fn(async (inputs: readonly string[]) => (
      inputs.map(() => [1, 0])
    ));
    const syncDependencies = dependencies({
      repository: repository.repository,
      fetchImpl: fetchMock as unknown as typeof fetch,
      embedBatch,
    });

    const first = await syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      syncDependencies
    );
    currentInventory = activeInventory(first.manifestHash ?? '', first.chunkCount);
    embedBatch.mockClear();
    repository.loadReusableEmbeddings.mockClear();
    repository.activateSnapshot.mockClear();

    const second = await syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      syncDependencies
    );

    expect(second.status).toBe('unchanged');
    expect(repository.markActiveSnapshotVerified).toHaveBeenCalledTimes(1);
    expect(repository.loadReusableEmbeddings).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('rebuilds an unchanged manifest when the active embedding model is obsolete', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Kayfabe\n\nContinuity.',
    };
    const { fetchMock } = notionFetch([page]);
    let currentInventory: BackstageNotionActiveInventory | null = null;
    const repository = repositoryHarness({ loadActive: () => currentInventory });
    const embedBatch = jest.fn(async (inputs: readonly string[]) => (
      inputs.map(() => [1, 0])
    ));
    const syncDependencies = dependencies({
      repository: repository.repository,
      fetchImpl: fetchMock as unknown as typeof fetch,
      embedBatch,
    });
    const first = await syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      syncDependencies
    );
    currentInventory = activeInventory(first.manifestHash ?? '', first.chunkCount);
    currentInventory.snapshot.embeddingModel = 'obsolete-embedding-model';
    embedBatch.mockClear();
    repository.activateSnapshot.mockClear();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      syncDependencies
    )).resolves.toMatchObject({ status: 'activated' });
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(repository.markActiveSnapshotVerified).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a legacy manifest that does not bind the current index formats', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Kayfabe\n\nContinuity.',
    };
    const sourceHash = sha256(JSON.stringify({
      format: BACKSTAGE_NOTION_RAG_PAGE_FORMAT,
      universeId,
      pageId: page.pageId,
      parentPageId: null,
      title: page.title,
      path: [page.title],
      markdown: page.markdown,
    }));
    const legacyManifestHash = sha256(JSON.stringify({
      format: 'backstage-notion-rag-manifest-v1',
      pages: [{
        pageId: page.pageId,
        parentPageId: null,
        title: page.title,
        path: [page.title],
        sourceHash,
        lastEditedAt: fixedTime.toISOString(),
      }],
    }));
    const { fetchMock } = notionFetch([page]);
    const repository = repositoryHarness({
      active: activeInventory(legacyManifestHash),
    });

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated' });
    expect(repository.markActiveSnapshotVerified).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot.mock.calls[0]?.[0].manifestHash)
      .not.toBe(legacyManifestHash);
  });

  it('reuses content hashes and batches only missing embeddings for a changed snapshot', async () => {
    const markdown = Array.from({ length: 66 }, (_, index) => (
      `Section ${index.toString().padStart(2, '0')} ${'x'.repeat(980)}`
    )).join('\n\n');
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown,
    };
    const { fetchMock } = notionFetch([page]);
    let reusedHash = '';
    const repository = repositoryHarness({
      active: activeInventory('e'.repeat(64)),
      reusable: (hashes) => {
        reusedHash = hashes[0] ?? '';
        return reusedHash ? new Map([[reusedHash, [99, 99]]]) : new Map();
      },
    });
    const embedBatch = jest.fn(async (inputs: readonly string[]) => (
      inputs.map(() => [1, 0])
    ));

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
      })
    );

    expect(result).toMatchObject({ status: 'activated', chunkCount: 66 });
    expect(embedBatch.mock.calls.map(call => call[0].length)).toEqual([32, 32, 1]);
    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.chunks.find(chunk => chunk.contentHash === reusedHash)?.embedding)
      .toEqual([99, 99]);
  });

  it('returns lease-busy without fetching or embedding', async () => {
    const repository = repositoryHarness({ leaseBusy: true });
    const fetchMock = jest.fn();
    const embedBatch = jest.fn(async () => [[1, 0]]);

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
      })
    )).resolves.toMatchObject({ status: 'lease-busy' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(repository.releaseSyncLease).not.toHaveBeenCalled();
  });

  it('renews a valid fenced lease while work is pending and then activates', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const renewalAttempted = deferred<void>();
    const repository = repositoryHarness({
      renewLease: () => {
        renewalAttempted.resolve(undefined);
        return lease;
      },
    });
    const embeddingStarted = deferred<void>();
    const finishEmbedding = deferred<void>();
    const embedBatch = jest.fn(async (inputs: readonly string[]) => {
      embeddingStarted.resolve(undefined);
      await finishEmbedding.promise;
      return inputs.map(() => [1, 0]);
    });

    const sync = syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
        leaseRenewalIntervalMs: 1,
      })
    );
    await embeddingStarted.promise;
    await renewalAttempted.promise;
    finishEmbedding.resolve(undefined);

    await expect(sync).resolves.toMatchObject({ status: 'activated' });
    expect(repository.renewSyncLease).toHaveBeenCalled();
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
    expect(repository.renewSyncLease.mock.invocationCallOrder[0])
      .toBeLessThan(repository.releaseSyncLease.mock.invocationCallOrder[0] ?? 0);
  });

  it('aborts a pending Notion crawl when the fenced lease cannot be renewed', async () => {
    const fetchStarted = deferred<void>();
    const renewalAttempted = deferred<void>();
    const repository = repositoryHarness({
      renewLease: () => {
        renewalAttempted.resolve(undefined);
        return null;
      },
    });
    const fetchMock = jest.fn((
      _input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      fetchStarted.resolve(undefined);
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });

    const sync = syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        leaseRenewalIntervalMs: 1,
      })
    );
    await fetchStarted.promise;
    await renewalAttempted.promise;

    await expect(sync).rejects.toBeInstanceOf(BackstageNotionSyncLeaseError);
    expect(repository.renewSyncLease).toHaveBeenCalledWith(
      universeId,
      lease.holderId,
      lease.leaseToken,
      expect.any(Number)
    );
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
    expect(repository.renewSyncLease.mock.invocationCallOrder[0])
      .toBeLessThan(repository.releaseSyncLease.mock.invocationCallOrder[0] ?? 0);
  });

  it('aborts a pending embedding batch when the fenced lease cannot be renewed', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const renewalAttempted = deferred<void>();
    const repository = repositoryHarness({
      renewLease: () => {
        renewalAttempted.resolve(undefined);
        return null;
      },
    });
    const embeddingStarted = deferred<void>();
    const embedBatch = jest.fn((): Promise<number[][]> => {
      embeddingStarted.resolve(undefined);
      return new Promise(() => undefined);
    });

    const sync = syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
        leaseRenewalIntervalMs: 1,
      })
    );
    await embeddingStarted.promise;
    await renewalAttempted.promise;

    await expect(sync).rejects.toBeInstanceOf(BackstageNotionSyncLeaseError);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
  });

  it('rejects a persisted root conflict before any Notion or embedding work', async () => {
    const repository = repositoryHarness({
      authorityHead: {
        universeId,
        authority: 'notion',
        activeSnapshotId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        rootPageId: pageId(99),
      },
    });
    const fetchMock = jest.fn();
    const embedBatch = jest.fn(async () => [[1, 0]]);

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
      message: 'The configured Notion authority root conflicts with the persisted authority root.',
    });

    expect(repository.loadAuthorityHead).toHaveBeenCalledWith(universeId);
    expect(repository.loadActiveInventory).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(repository.releaseSyncLease).toHaveBeenCalledWith(
      universeId,
      lease.holderId,
      lease.leaseToken
    );
  });

  it('checks active inventory before any Notion work', async () => {
    const conflictingInventory = activeInventory('f'.repeat(64));
    conflictingInventory.snapshot.rootPageId = pageId(99);
    const repository = repositoryHarness({
      authorityHead: null,
      active: conflictingInventory,
    });
    const fetchMock = jest.fn();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
    });

    expect(repository.loadActiveInventory).toHaveBeenCalledWith(universeId);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('fails safely for missing, unreadable, or invalid authority configuration', async () => {
    const repository = repositoryHarness();
    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        readEnvironment: environmentReader(),
      })
    )).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE });
    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        readEnvironment: environmentReader({ throwOnRead: true }),
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
      message: 'Backstage Notion synchronization is not configured safely.',
    });
    await expect(syncConfiguredBackstageNotionAuthorities({
      readEnvironment: environmentReader({
        token: notionToken,
        authority: '{bad json',
      }),
    })).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE });
    await expect(syncConfiguredBackstageNotionAuthorities({
      repository: repository.repository,
      readEnvironment: environmentReader({
        authority: JSON.stringify({
          [universeId]: {
            rootPageId: pageId(0),
            displayName: 'WWE Universe Mode',
          },
        }),
      }),
    })).rejects.toMatchObject({ code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE });
    expect(repository.acquireSyncLease).not.toHaveBeenCalled();
  });

  it('isolates a bad first root and still activates a healthy later root', async () => {
    const firstUniverseId = 'first-universe';
    const secondUniverseId = 'second-universe';
    const badRoot: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'Bad Universe',
      markdown: '# Partial',
      truncated: true,
    };
    const healthyRoot: TestNotionPage = {
      pageId: pageId(1),
      parentPageId: null,
      title: 'Healthy Universe',
      markdown: '# Healthy',
    };
    const { fetchMock } = notionFetch([badRoot, healthyRoot]);
    const repository = repositoryHarness();
    const authority = JSON.stringify({
      [firstUniverseId]: {
        rootPageId: badRoot.pageId,
        displayName: badRoot.title,
      },
      [secondUniverseId]: {
        rootPageId: healthyRoot.pageId,
        displayName: healthyRoot.title,
      },
    });

    const results = await syncConfiguredBackstageNotionAuthorities(
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        readEnvironment: environmentReader({ token: notionToken, authority }),
      })
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      universeId: firstUniverseId,
      status: 'failed',
      errorCode: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
    });
    expect(results[1]).toMatchObject({
      universeId: secondUniverseId,
      status: 'activated',
    });
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot.mock.calls[0]?.[0].universeId)
      .toBe(secondUniverseId);
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_root_failed',
      {
        universeId: firstUniverseId,
        errorCode: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      }
    );
  });

  it('uses a stable aggregate error code for an unexpected root failure', async () => {
    const authority = JSON.stringify({
      [universeId]: {
        rootPageId: pageId(0),
        displayName: 'WWE Universe Mode',
      },
    });
    const repository = repositoryHarness();
    repository.loadAuthorityHead.mockRejectedValueOnce(
      new Error('PRIVATE-DATABASE-DETAIL')
    );

    await expect(syncConfiguredBackstageNotionAuthorities(
      dependencies({
        repository: repository.repository,
        readEnvironment: environmentReader({ token: notionToken, authority }),
      })
    )).resolves.toEqual([expect.objectContaining({
      universeId,
      status: 'failed',
      errorCode: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
    })]);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls))
      .not.toContain('PRIVATE-DATABASE-DETAIL');
  });

  it('retries a transient Notion response without activating a partial capture', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock, metadataCalls } = notionFetch([page], {
      retryMetadataPageId: page.pageId,
    });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated' });

    expect(metadataCalls.get(page.pageId)).toBe(3);
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('propagates abort and releases an acquired lease without activation', async () => {
    const controller = new AbortController();
    const repository = repositoryHarness();
    const fetchMock = jest.fn(async (): Promise<Response> => {
      controller.abort(new DOMException('caller stopped', 'AbortError'));
      throw new DOMException('request stopped', 'AbortError');
    });

    let caught: unknown;
    try {
      await syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
          signal: controller.signal,
        })
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { name: string }).name).toBe('AbortError');
    expect((caught as { message: string }).message).toBe('caller stopped');

    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('does not acquire a lease when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already stopped', 'AbortError'));
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        signal: controller.signal,
      })
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(repository.acquireSyncLease).not.toHaveBeenCalled();
  });
});
