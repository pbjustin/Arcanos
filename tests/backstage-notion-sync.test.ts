import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
  BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT,
  BackstageNotionSnapshotDeadlineError,
  BackstageNotionSnapshotWriteError,
  BackstageNotionSyncLeaseError,
  type ActivateBackstageNotionSnapshotInput,
  type BackstageNotionActiveInventory,
  type BackstageNotionAuthorityHead,
  type BackstageNotionRagRepository,
  type BackstageNotionSnapshotRecord,
  type BackstageNotionSyncLease,
} from '../src/core/db/repositories/backstageNotionRagRepository.js';
import type {
  BackstageNotionSyncAttemptRecord,
  BackstageNotionSyncStatusRepository,
} from '../src/core/db/repositories/backstageNotionSyncStatusRepository.js';
import {
  getOpenAIAdapter,
  resetOpenAIAdapter,
  type OpenAIAdapter,
} from '../src/core/adapters/openai.adapter.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import {
  readRuntimeEnv,
  unsetRuntimeEnv,
  writeRuntimeEnv,
} from '../src/platform/runtime/env.js';
import {
  BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME,
  BACKSTAGE_NOTION_MAX_DATA_SOURCE_QUERY_RESULTS,
  BACKSTAGE_NOTION_MAX_METADATA_RESPONSE_BYTES,
} from '../src/shared/backstage/backstageNotionContextCore.js';
import {
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
  BACKSTAGE_NOTION_RAG_PAGE_FORMAT,
  prepareBackstageNotionRagPage,
} from '../src/shared/backstage/backstageNotionRagCore.js';
import {
  BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME,
  type BackstageNotionAuthorityRoot,
} from '../src/services/backstageNotionAuthority.js';
import {
  BACKSTAGE_NOTION_RAG_INDEX_FORMAT,
  BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
  BACKSTAGE_NOTION_SYNC_CYCLE_TIMEOUT_MS,
  BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE,
  BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
  BACKSTAGE_NOTION_SYNC_MAX_COLD_EMBEDDING_REQUESTS,
  BACKSTAGE_NOTION_SYNC_MAX_PAGES,
  BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS,
  BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
  BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
  syncBackstageNotionAuthorityRoot,
  syncConfiguredBackstageNotionAuthorities,
  validateBackstageNotionSynchronizationConfiguration,
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
  retryMetadataStatus?: 409 | 429 | 500 | 502 | 503 | 504 | 529;
  retryMetadataFailures?: number;
  retryAfterSeconds?: number;
}

function pageId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-1111-4111-8111-${index
    .toString(16)
    .padStart(12, '0')}`;
}

const titleAnnotations = Object.freeze({
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
});

function titleText(plainText: string): Record<string, unknown> {
  return {
    type: 'text',
    text: { content: plainText, link: null },
    annotations: titleAnnotations,
    plain_text: plainText,
    href: null,
  };
}

function titleInlineReference(
  plainText: string,
  index: number
): Record<string, unknown> {
  const referenceId = pageId(10_000 + index);
  return index % 2 === 0
    ? {
        type: 'mention',
        mention: { type: 'page', page: { id: referenceId } },
        annotations: titleAnnotations,
        plain_text: plainText,
        href: `https://www.notion.so/${compactPageId(referenceId)}`,
      }
    : {
        type: 'mention',
        mention: {
          type: 'user',
          user: { object: 'user', id: referenceId, type: 'person' },
        },
        annotations: titleAnnotations,
        plain_text: plainText,
        href: null,
      };
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

function compactPageId(value: string): string {
  return value.replaceAll('-', '');
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

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function notionErrorResponse(
  status: number,
  code: string,
  message = 'PRIVATE-NOTION-PROVIDER-MESSAGE'
): Response {
  return jsonResponse({ object: 'error', status, code, message }, status);
}

function retryProviderCode(status: number): string {
  switch (status) {
    case 409:
      return 'conflict_error';
    case 429:
      return 'rate_limited';
    case 500:
      return 'internal_server_error';
    case 502:
      return 'bad_gateway';
    case 503:
      return 'service_unavailable';
    case 504:
      return 'gateway_timeout';
    case 529:
      return 'service_overload';
    default:
      return 'validation_error';
  }
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
      && callCount <= (options.retryMetadataFailures ?? 1)
    ) {
      return jsonResponse(
        {
          object: 'error',
          status: options.retryMetadataStatus ?? 429,
          code: retryProviderCode(options.retryMetadataStatus ?? 429),
          message: 'PRIVATE-NOTION-PROVIDER-MESSAGE',
        },
        options.retryMetadataStatus ?? 429,
        options.retryAfterSeconds === undefined
          ? {}
          : { 'retry-after': String(options.retryAfterSeconds) }
      );
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

function databaseRootFetch(options: {
  databaseMetadataDrift?: 'data_sources' | 'in_trash' | 'title';
  databaseRowCount?: number;
  firstRowTitleDrift?: boolean;
  firstRowTitleParts?: readonly string[];
  firstRowTitleShapeUncertain?: boolean;
  allRowTitleShapesUncertain?: boolean;
  duplicatePageIdAcrossDataSources?: boolean;
  duplicatePageIdAcrossQueryPages?: boolean;
  incompleteQuery?: boolean;
  membershipDrift?: boolean;
  nestedDataSource?: boolean;
  opaqueCursorTraversal?: boolean;
  repeatedCursor?: boolean;
} = {}) {
  const databaseId = pageId(0);
  const firstDataSourceId = pageId(100);
  const secondDataSourceId = pageId(101);
  const opaqueCursor = 'opaque cursor/雪:v1';
  const baseRows = [
    {
      pageId: pageId(1),
      dataSourceId: firstDataSourceId,
      title: 'Raw authority',
      markdown: '# Raw\n\nPRIVATE-RAW-CANON',
    },
    {
      pageId: pageId(2),
      dataSourceId: secondDataSourceId,
      title: 'SmackDown authority',
      markdown: '# SmackDown\n\nPRIVATE-SMACKDOWN-CANON',
    },
  ];
  const paginatedRow = {
    pageId: pageId(3),
    dataSourceId: firstDataSourceId,
    title: 'NXT authority',
    markdown: '# NXT\n\nPRIVATE-NXT-CANON',
  };
  const rows = options.databaseRowCount === undefined
    ? options.opaqueCursorTraversal
      ? [...baseRows, paginatedRow]
      : baseRows
    : Array.from({ length: options.databaseRowCount }, (_, index) => ({
        pageId: pageId(index + 1_000),
        dataSourceId: firstDataSourceId,
        title: `Authority row ${index + 1}`,
        markdown: `# Authority row ${index + 1}`,
      }));
  let databaseCalls = 0;
  const queryCalls = new Map<string, number>();
  const metadataCalls = new Map<string, number>();
  const titlePropertyCalls = new Map<string, number>();
  const requestBodies: unknown[] = [];
  const fetchMock = jest.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === `/v1/pages/${databaseId}`) {
      return notionErrorResponse(400, 'validation_error');
    }
    if (url.pathname === `/v1/databases/${databaseId}`) {
      databaseCalls += 1;
      const metadataDrift = databaseCalls >= 2
        ? options.databaseMetadataDrift
        : undefined;
      return jsonResponse({
        object: 'database',
        id: databaseId,
        parent: { type: 'workspace', workspace: true },
        title: [{
          plain_text: metadataDrift === 'title'
            ? 'Drifted provider database title'
            : 'Provider database title',
        }],
        last_edited_time: fixedTime.toISOString(),
        in_trash: metadataDrift === 'in_trash',
        data_sources: metadataDrift === 'data_sources'
          ? [{ id: firstDataSourceId, name: 'Raw' }]
          : [
              { id: firstDataSourceId, name: 'Raw' },
              { id: secondDataSourceId, name: 'SmackDown' },
            ],
      });
    }
    const queryMatch = /^\/v1\/data_sources\/([^/]+)\/query$/u.exec(
      url.pathname
    );
    if (queryMatch) {
      const dataSourceId = queryMatch[1] ?? '';
      const callCount = (queryCalls.get(dataSourceId) ?? 0) + 1;
      queryCalls.set(dataSourceId, callCount);
      const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
        page_size?: unknown;
        start_cursor?: unknown;
      };
      requestBodies.push(requestBody);
      if (options.databaseRowCount !== undefined) {
        const cursorMatch = typeof requestBody.start_cursor === 'string'
          ? /^database-row-offset:(\d+)$/u.exec(requestBody.start_cursor)
          : null;
        const offset = requestBody.start_cursor === undefined
          ? 0
          : cursorMatch
            ? Number.parseInt(cursorMatch[1] ?? '', 10)
            : Number.NaN;
        const matchingRows = rows.filter(row => row.dataSourceId === dataSourceId);
        const pageSize = BACKSTAGE_NOTION_MAX_DATA_SOURCE_QUERY_RESULTS;
        const pageRows = Number.isSafeInteger(offset)
          ? matchingRows.slice(offset, offset + pageSize)
          : [];
        const nextOffset = offset + pageRows.length;
        const hasMore = Number.isSafeInteger(offset)
          && nextOffset < matchingRows.length;
        return jsonResponse({
          object: 'list',
          type: 'page_or_data_source',
          page_or_data_source: {},
          results: pageRows.map(row => ({ object: 'page', id: row.pageId })),
          has_more: hasMore,
          next_cursor: hasMore ? `database-row-offset:${nextOffset}` : null,
          request_status: { type: 'complete' },
        });
      }
      if (options.nestedDataSource && dataSourceId === firstDataSourceId) {
        return jsonResponse({
          object: 'list',
          type: 'page_or_data_source',
          page_or_data_source: {},
          results: [{ object: 'data_source', id: pageId(300) }],
          has_more: false,
          next_cursor: null,
        });
      }
      if (
        dataSourceId === firstDataSourceId
        && (
          options.opaqueCursorTraversal
          || options.repeatedCursor
          || options.duplicatePageIdAcrossQueryPages
        )
      ) {
        const firstRow = baseRows[0]!;
        if (requestBody.start_cursor === undefined) {
          return jsonResponse({
            object: 'list',
            type: 'page_or_data_source',
            page_or_data_source: {},
            results: [{ object: 'page', id: firstRow.pageId }],
            has_more: true,
            next_cursor: opaqueCursor,
            request_status: { type: 'complete' },
          });
        }
        if (requestBody.start_cursor === opaqueCursor) {
          return jsonResponse({
            object: 'list',
            type: 'page_or_data_source',
            page_or_data_source: {},
            results: options.duplicatePageIdAcrossQueryPages
              ? [{ object: 'page', id: firstRow.pageId }]
              : options.repeatedCursor
                ? []
                : [{ object: 'page', id: paginatedRow.pageId }],
            has_more: options.repeatedCursor ?? false,
            next_cursor: options.repeatedCursor ? opaqueCursor : null,
            request_status: { type: 'complete' },
          });
        }
      }
      const row = rows.find(candidate => candidate.dataSourceId === dataSourceId);
      const returnedPageId = options.duplicatePageIdAcrossDataSources
        && dataSourceId === secondDataSourceId
        ? baseRows[0]!.pageId
        : row?.pageId;
      const omitForDrift = options.membershipDrift
        && callCount >= 2
        && dataSourceId === secondDataSourceId;
      return jsonResponse({
        object: 'list',
        type: 'page_or_data_source',
        page_or_data_source: {},
        results: returnedPageId && !omitForDrift
          ? [{ object: 'page', id: returnedPageId }]
          : [],
        has_more: false,
        next_cursor: null,
        ...(options.incompleteQuery && dataSourceId === firstDataSourceId
          ? {
              request_status: {
                type: 'incomplete',
                incomplete_reason: 'query_result_limit_reached',
              },
            }
          : { request_status: { type: 'complete' } }),
      });
    }
    const titlePropertyMatch = /^\/v1\/pages\/([^/]+)\/properties\/title$/u.exec(
      url.pathname
    );
    const titlePropertyRow = rows.find(candidate => (
      candidate.pageId === titlePropertyMatch?.[1]
    ));
    if (titlePropertyRow) {
      const callCount = (titlePropertyCalls.get(titlePropertyRow.pageId) ?? 0) + 1;
      titlePropertyCalls.set(titlePropertyRow.pageId, callCount);
      let completeTitleItems = options.firstRowTitleParts
        && titlePropertyRow.pageId === rows[0]?.pageId
        ? options.firstRowTitleParts.map(titleInlineReference)
        : [titleText(titlePropertyRow.title)];
      if (
        options.firstRowTitleDrift
        && titlePropertyRow.pageId === rows[0]?.pageId
        && callCount >= 2
      ) {
        completeTitleItems = [titleText('Drifted complete provider title')];
      }
      const rawCursor = url.searchParams.get('start_cursor');
      const cursorMatch = rawCursor === null
        ? null
        : /^title-offset:(\d+)$/u.exec(rawCursor);
      const offset = rawCursor === null
        ? 0
        : cursorMatch
          ? Number.parseInt(cursorMatch[1] ?? '', 10)
          : Number.NaN;
      const pageParts = Number.isSafeInteger(offset)
        ? completeTitleItems.slice(offset, offset + 25)
        : [];
      const nextOffset = offset + pageParts.length;
      const hasMore = Number.isSafeInteger(offset)
        && nextOffset < completeTitleItems.length;
      const nextCursor = hasMore ? `title-offset:${nextOffset}` : null;
      const nextUrl = hasMore
        ? new URL(`/v1/pages/${titlePropertyRow.pageId}/properties/title`, url.origin)
        : null;
      nextUrl?.searchParams.set('page_size', '100');
      if (nextCursor !== null) {
        nextUrl?.searchParams.set('start_cursor', nextCursor);
      }
      return jsonResponse({
        object: 'list',
        type: 'property_item',
        results: pageParts.map(title => ({
          object: 'property_item',
          id: 'title',
          type: 'title',
          title,
        })),
        has_more: hasMore,
        next_cursor: nextCursor,
        property_item: {
          id: 'title',
          type: 'title',
          title: {},
          next_url: nextUrl?.toString() ?? null,
        },
      });
    }
    const pageMatch = /^\/v1\/pages\/([^/]+)(\/markdown)?$/u.exec(url.pathname);
    const row = rows.find(candidate => candidate.pageId === pageMatch?.[1]);
    if (!row) {
      return notionErrorResponse(404, 'object_not_found');
    }
    if (pageMatch?.[2] === '/markdown') {
      return jsonResponse({
        object: 'page_markdown',
        id: row.pageId,
        markdown: row.markdown,
        truncated: false,
        unknown_block_ids: [],
      });
    }
    metadataCalls.set(
      row.pageId,
      (metadataCalls.get(row.pageId) ?? 0) + 1
    );
    return jsonResponse({
      object: 'page',
      id: row.pageId,
      parent: {
        type: 'data_source_id',
        data_source_id: row.dataSourceId,
        database_id: databaseId,
      },
      properties: {
        ArbitraryProviderTitleKey: {
          id: 'title',
          type: 'title',
          title: options.allRowTitleShapesUncertain
            || (
              options.firstRowTitleShapeUncertain
              && row.pageId === rows[0]?.pageId
            )
            ? [{ type: 'future_title_fragment', plain_text: row.title }]
            : options.firstRowTitleParts && row.pageId === rows[0]?.pageId
              ? options.firstRowTitleParts.slice(0, 25).map(titleInlineReference)
              : [titleText(row.title)],
        },
      },
      last_edited_time: fixedTime.toISOString(),
      in_trash: false,
    });
  });
  return {
    databaseCalls: () => databaseCalls,
    fetchMock,
    metadataCalls,
    queryCalls,
    requestBodies,
    rows,
    titlePropertyCalls,
  };
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
  syncStatusRepository?: BackstageNotionSyncStatusRepository;
  fetchImpl?: typeof fetch;
  embedBatch?: (inputs: readonly string[]) => Promise<number[][]>;
  readEnvironment?: (name: string) => string | undefined;
  signal?: AbortSignal;
  leaseRenewalIntervalMs?: number;
  fetchTimeoutMs?: number;
  cycleTimeoutMs?: number;
  requestSpacingMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}): BackstageNotionSyncDependencies {
  return {
    repository: input.repository,
    ...(input.syncStatusRepository
      ? { syncStatusRepository: input.syncStatusRepository }
      : {}),
    fetchImpl: input.fetchImpl,
    embedBatch: input.embedBatch ?? (async values => values.map(() => [1, 0])),
    readEnvironment: input.readEnvironment
      ?? environmentReader({ token: notionToken }),
    requestSpacingMs: input.requestSpacingMs ?? 0,
    retryBaseDelayMs: 0,
    fetchTimeoutMs: input.fetchTimeoutMs ?? 1_000,
    ...(input.cycleTimeoutMs === undefined
      ? {}
      : { cycleTimeoutMs: input.cycleTimeoutMs }),
    holderId,
    ...(input.leaseRenewalIntervalMs === undefined
      ? {}
      : { leaseRenewalIntervalMs: input.leaseRenewalIntervalMs }),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.wait ? { wait: input.wait } : {}),
    ...(input.random ? { random: input.random } : {}),
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

  it('fits the largest provider-safe batch and maximum cold root in the default budget', () => {
    const providerMaximumTokensPerInput = 8_192;
    const providerMaximumAggregateTokens = 300_000;

    expect(
      BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
        * providerMaximumTokensPerInput
    ).toBeLessThanOrEqual(providerMaximumAggregateTokens);
    expect(
      (BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE + 1)
        * providerMaximumTokensPerInput
    ).toBeGreaterThan(providerMaximumAggregateTokens);
    expect(BACKSTAGE_NOTION_SYNC_MAX_COLD_EMBEDDING_REQUESTS).toBe(
      Math.ceil(
        BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT
          / BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
      )
    );
    expect(BACKSTAGE_NOTION_SYNC_MAX_COLD_EMBEDDING_REQUESTS).toBe(114);
  });

  it('records successful activation separately from the active snapshot pointer', async () => {
    const started: BackstageNotionSyncAttemptRecord = {
      universeId,
      attemptId: '33333333-3333-4333-8333-333333333333',
      generation: '1',
      startedAt: new Date('2026-08-29T15:56:00.000Z'),
      completedAt: null,
      outcome: 'running',
      failurePhase: null,
      failureReason: null,
      pagesDiscovered: 0,
      pagesFetched: 0,
      blocksFetched: 0,
      chunksProduced: 0,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    };
    const beginSyncAttempt = jest.fn(async () => started);
    const completeSyncAttempt = jest.fn(async input => ({
      ...started,
      ...input,
      completedAt: new Date('2026-08-29T15:58:00.000Z'),
    } as BackstageNotionSyncAttemptRecord));
    const syncStatusRepository: BackstageNotionSyncStatusRepository = {
      beginSyncAttempt,
      completeSyncAttempt,
      loadLatestSyncAttempt: jest.fn(async () => null),
    };
    const { fetchMock } = notionFetch([{
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Current canon\n\nSynthetic current statement.',
    }]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        syncStatusRepository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated' });

    expect(beginSyncAttempt).toHaveBeenCalledWith({
      universeId,
      lease: expect.objectContaining({ leaseToken: lease.leaseToken }),
    });
    expect(completeSyncAttempt).toHaveBeenCalledTimes(1);
    expect(completeSyncAttempt).toHaveBeenCalledWith(expect.objectContaining({
      universeId,
      attemptId: started.attemptId,
      generation: started.generation,
      outcome: 'activated',
      failurePhase: null,
      failureReason: null,
      candidateSnapshotCreated: true,
      candidateSnapshotValidated: true,
      candidateSnapshotActivated: true,
      activatedSnapshotId: expect.any(String),
    }));
    expect(beginSyncAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      repository.activateSnapshot.mock.invocationCallOrder[0]!
    );
    expect(repository.activateSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      completeSyncAttempt.mock.invocationCallOrder[0]!
    );
  });

  it('keeps a committed activation successful when latest-attempt telemetry cannot complete', async () => {
    const started: BackstageNotionSyncAttemptRecord = {
      universeId,
      attemptId: '33333333-3333-4333-8333-333333333333',
      generation: '1',
      startedAt: new Date('2026-08-29T15:56:00.000Z'),
      completedAt: null,
      outcome: 'running',
      failurePhase: null,
      failureReason: null,
      pagesDiscovered: 0,
      pagesFetched: 0,
      blocksFetched: 0,
      chunksProduced: 0,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    };
    const syncStatusRepository: BackstageNotionSyncStatusRepository = {
      beginSyncAttempt: jest.fn(async () => started),
      completeSyncAttempt: jest.fn(async () => {
        throw new Error('PRIVATE-DATABASE-DETAIL');
      }),
      loadLatestSyncAttempt: jest.fn(async () => null),
    };
    const { fetchMock } = notionFetch([{
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Current canon\n\nSynthetic current statement.',
    }]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        syncStatusRepository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated' });

    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    expect(syncStatusRepository.completeSyncAttempt).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'backstage.notion_rag.sync_status_record_failed',
      { universeId, outcome: 'activated' }
    );
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls))
      .not.toContain('PRIVATE-DATABASE-DETAIL');
  });

  it('records a bounded failed attempt without creating or activating a candidate', async () => {
    const started: BackstageNotionSyncAttemptRecord = {
      universeId,
      attemptId: '33333333-3333-4333-8333-333333333333',
      generation: '1',
      startedAt: new Date('2026-08-29T15:56:00.000Z'),
      completedAt: null,
      outcome: 'running',
      failurePhase: null,
      failureReason: null,
      pagesDiscovered: 0,
      pagesFetched: 0,
      blocksFetched: 0,
      chunksProduced: 0,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    };
    const completeSyncAttempt = jest.fn(async input => ({
      ...started,
      ...input,
      completedAt: new Date('2026-08-29T15:58:00.000Z'),
    } as BackstageNotionSyncAttemptRecord));
    const syncStatusRepository: BackstageNotionSyncStatusRepository = {
      beginSyncAttempt: jest.fn(async () => started),
      completeSyncAttempt,
      loadLatestSyncAttempt: jest.fn(async () => null),
    };
    const { fetchMock } = notionFetch([{
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '<image source="notion://private-media">Image</image>',
    }]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        syncStatusRepository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        candidateSnapshotCreated: false,
        candidateSnapshotValidated: false,
        candidateSnapshotActivated: false,
      }),
    });

    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(completeSyncAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      failurePhase: 'normalization',
      failureReason: 'permanent_notion_error',
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    }));
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
    expect(activation?.chunks.some(chunk => (
      chunk.headingPath?.[0] === 'Universe page 0'
    ))).toBe(true);
    expect(activation?.chunks.every(chunk => (
      chunk.metadata?.headingIndexVersion
        === BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION
      && Array.isArray(chunk.metadata?.headingOccurrencePath)
      && Array.isArray(chunk.metadata?.scopeHeadingPathKey)
      && chunk.metadata.scopeHeadingPathKey.every(key => (
        typeof key === 'string' && /^[0-9a-f]{64}$/u.test(key)
      ))
    ))).toBe(true);
    expect(activation?.pages.every(page => (
      page.metadata?.headingIndexVersion
        === BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION
      && page.metadata?.indexFormat === BACKSTAGE_NOTION_RAG_INDEX_FORMAT
      && typeof page.metadata?.scopeTitleKey === 'string'
      && /^[0-9a-f]{64}$/u.test(page.metadata.scopeTitleKey)
      && Array.isArray(page.metadata?.scopePathKey)
      && page.metadata.scopePathKey.every(key => (
        typeof key === 'string' && /^[0-9a-f]{64}$/u.test(key)
      ))
    ))).toBe(true);
    expect([...metadataCalls.values()].every(count => count === 2)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(54);
    expect(fetchMock.mock.calls.some(call => (
      new URL(String(call[0])).pathname.includes('/v1/databases/')
      || new URL(String(call[0])).pathname.includes('/v1/data_sources/')
    ))).toBe(false);
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);

    const logged = JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
    ]);
    expect(logged).not.toContain(notionToken);
    expect(logged).not.toContain('PRIVATE-CONTINUITY');
    expect(logged).not.toContain(pageId(15));
  });

  it('captures every source of a database authority root before activation', async () => {
    const provider = databaseRootFetch();
    const repository = repositoryHarness();

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 2 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    );

    expect(result).toMatchObject({ status: 'activated', pageCount: 3 });
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.pages).toHaveLength(3);
    expect(activation?.pages.find(page => page.pageId === pageId(0)))
      .toMatchObject({
        parentPageId: null,
        title: 'WWE Universe Mode',
        canonicalUrl: null,
        markdown: '',
        metadata: expect.objectContaining({ sourceObjectType: 'database' }),
      });
    for (const row of provider.rows) {
      expect(activation?.pages.find(page => page.pageId === row.pageId))
        .toMatchObject({
          parentPageId: pageId(0),
          title: row.title,
          markdown: row.markdown,
          metadata: expect.objectContaining({ sourceObjectType: 'page' }),
        });
      expect(provider.metadataCalls.get(row.pageId)).toBe(2);
    }
    expect(provider.titlePropertyCalls.size).toBe(0);
    expect(provider.databaseCalls()).toBe(2);
    expect([...provider.queryCalls.values()]).toEqual([2, 2]);
    expect(provider.requestBodies).toEqual([
      { page_size: 10 },
      { page_size: 10 },
      { page_size: 10 },
      { page_size: 10 },
    ]);
    expect(provider.fetchMock.mock.calls
      .filter(call => new URL(String(call[0])).pathname.endsWith('/query'))
      .every(call => new URL(String(call[0])).searchParams.getAll(
        'filter_properties[]'
      ).join(',') === 'title')).toBe(true);
    const rootProbeCalls = provider.fetchMock.mock.calls.filter(call => (
      new URL(String(call[0])).pathname === `/v1/pages/${pageId(0)}`
    ));
    expect(rootProbeCalls).toHaveLength(1);
    expect(new URL(String(rootProbeCalls[0]?.[0])).search).toBe('');
    for (const row of provider.rows) {
      const metadataUrls = provider.fetchMock.mock.calls
        .map(call => new URL(String(call[0])))
        .filter(url => url.pathname === `/v1/pages/${row.pageId}`);
      expect(metadataUrls).toHaveLength(2);
      expect(metadataUrls.every(url => url.searchParams.getAll(
        'filter_properties[]'
      ).join(',') === 'title')).toBe(true);
    }
    const serializedTelemetry = JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
    ]);
    expect(serializedTelemetry).not.toContain(notionToken);
    expect(serializedTelemetry).not.toContain(pageId(0));
    expect(serializedTelemetry).not.toContain('PRIVATE-RAW-CANON');
  });

  it('activates only the complete paginated database-row title in both passes', async () => {
    const titleParts = [
      ...Array.from({ length: 25 }, (_, index) => `${index}.`),
      'complete',
    ];
    const completeTitle = titleParts.join('');
    const provider = databaseRootFetch({ firstRowTitleParts: titleParts });
    const repository = repositoryHarness();

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 2 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    );

    expect(result.status).toBe('activated');
    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.pages.find(page => page.pageId === provider.rows[0]?.pageId))
      .toMatchObject({
        title: completeTitle,
        path: ['WWE Universe Mode', completeTitle],
        metadata: expect.objectContaining({
          sourceObjectType: 'page',
        }),
      });
    expect(provider.titlePropertyCalls.get(provider.rows[0]!.pageId)).toBe(4);
    expect(provider.titlePropertyCalls.has(provider.rows[1]!.pageId)).toBe(false);
    const titleRequests = provider.fetchMock.mock.calls
      .map(call => new URL(String(call[0])))
      .filter(url => url.pathname.endsWith('/properties/title'));
    expect(titleRequests).toHaveLength(4);
    expect(titleRequests.every(url => url.origin === 'https://api.notion.com'))
      .toBe(true);
    expect(titleRequests.every(url => url.searchParams.get('page_size') === '100'))
      .toBe(true);
    expect(titleRequests.filter(url => url.searchParams.has('start_cursor')))
      .toHaveLength(2);
  });

  it.each([
    ['uses page metadata below', 24, 0],
    ['retrieves the complete property at', 25, 2],
  ] as const)(
    '%s the 25-inline-reference boundary',
    async (_description, inlineReferenceCount, expectedPropertyRequests) => {
      const titleParts = Array.from(
        { length: inlineReferenceCount },
        (_, index) => `${index}.`
      );
      const provider = databaseRootFetch({ firstRowTitleParts: titleParts });
      const repository = repositoryHarness();

      const result = await syncBackstageNotionAuthorityRoot(
        rootAuthority({ initialMinimumPageCount: 2 }),
        dependencies({
          repository: repository.repository,
          fetchImpl: provider.fetchMock as unknown as typeof fetch,
        })
      );

      expect(result.status).toBe('activated');
      expect(repository.activateSnapshot.mock.calls[0]?.[0].pages.find(page => (
        page.pageId === provider.rows[0]?.pageId
      ))?.title).toBe(titleParts.join(''));
      expect(provider.titlePropertyCalls.get(provider.rows[0]!.pageId) ?? 0)
        .toBe(expectedPropertyRequests);
      expect(provider.titlePropertyCalls.has(provider.rows[1]!.pageId)).toBe(false);
    }
  );

  it('retrieves the complete property when the page title shape is uncertain', async () => {
    const provider = databaseRootFetch({ firstRowTitleShapeUncertain: true });
    const repository = repositoryHarness();

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 2 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    );

    expect(result.status).toBe('activated');
    expect(provider.titlePropertyCalls.get(provider.rows[0]!.pageId)).toBe(2);
    expect(provider.titlePropertyCalls.has(provider.rows[1]!.pageId)).toBe(false);
  });

  it('rejects complete database-row title drift between verification passes', async () => {
    const provider = databaseRootFetch({
      firstRowTitleDrift: true,
      firstRowTitleParts: Array.from({ length: 25 }, (_, index) => `${index}.`),
    });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 2 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'completeness_validation',
        reason: 'source_changed',
        candidateSnapshotCreated: true,
        candidateSnapshotValidated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(provider.titlePropertyCalls.get(provider.rows[0]!.pageId)).toBe(2);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('does not count the synthetic database container toward initial coverage', async () => {
    const provider = databaseRootFetch();
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 3 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'completeness_validation',
        reason: 'completeness_mismatch',
        candidateSnapshotCreated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('admits exactly 512 real database pages plus the synthetic root', async () => {
    const provider = databaseRootFetch({
      databaseRowCount: BACKSTAGE_NOTION_SYNC_MAX_PAGES,
      allRowTitleShapesUncertain: true,
    });
    const repository = repositoryHarness();
    let elapsedMs = 0;
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => (
      fixedTime.getTime() + elapsedMs
    ));
    const wait = jest.fn(async (milliseconds: number) => {
      elapsedMs += milliseconds;
    });
    // Root probe + two database reads + two query passes + five page reads:
    // metadata, complete title property, markdown, verification metadata, and
    // verification title property.
    const expectedProviderRequestCount = 1 + 2 + 2 * (
      Math.ceil(
        BACKSTAGE_NOTION_SYNC_MAX_PAGES
          / BACKSTAGE_NOTION_MAX_DATA_SOURCE_QUERY_RESULTS
      ) + 1
    ) + BACKSTAGE_NOTION_SYNC_MAX_PAGES * 5;

    try {
      const result = await syncBackstageNotionAuthorityRoot(
        rootAuthority({
          initialMinimumPageCount: BACKSTAGE_NOTION_SYNC_MAX_PAGES,
        }),
        dependencies({
          repository: repository.repository,
          fetchImpl: provider.fetchMock as unknown as typeof fetch,
          requestSpacingMs: BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS,
          wait,
        })
      );

      expect(result).toMatchObject({
        status: 'activated',
        pageCount: BACKSTAGE_NOTION_SYNC_MAX_PAGES + 1,
        chunkCount: BACKSTAGE_NOTION_SYNC_MAX_PAGES,
      });
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
      const activation = repository.activateSnapshot.mock.calls[0]?.[0];
      expect(activation?.pages).toHaveLength(BACKSTAGE_NOTION_SYNC_MAX_PAGES + 1);
      expect(activation?.pages.filter(page => (
        page.metadata.sourceObjectType === 'page'
      ))).toHaveLength(BACKSTAGE_NOTION_SYNC_MAX_PAGES);
      expect(provider.metadataCalls.size).toBe(BACKSTAGE_NOTION_SYNC_MAX_PAGES);
      expect([...provider.metadataCalls.values()].every(count => count === 2))
        .toBe(true);
      expect(provider.titlePropertyCalls.size).toBe(
        BACKSTAGE_NOTION_SYNC_MAX_PAGES
      );
      expect([...provider.titlePropertyCalls.values()].every(count => count === 2))
        .toBe(true);
      expect(provider.fetchMock).toHaveBeenCalledTimes(
        expectedProviderRequestCount
      );
      expect(elapsedMs).toBe(
        (expectedProviderRequestCount - 1)
          * BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS
      );
      expect(elapsedMs).toBeGreaterThan(300_000);
      expect(BACKSTAGE_NOTION_SYNC_CYCLE_TIMEOUT_MS).toBe(
        14 * 60 * 1_000
          + BACKSTAGE_NOTION_SYNC_MAX_PAGES
            * 2
            * BACKSTAGE_NOTION_SYNC_REQUEST_SPACING_MS
      );
      expect(elapsedMs).toBeLessThan(BACKSTAGE_NOTION_SYNC_CYCLE_TIMEOUT_MS);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('fails closed at 513 real database pages before page or embedding work', async () => {
    const provider = databaseRootFetch({
      databaseRowCount: BACKSTAGE_NOTION_SYNC_MAX_PAGES + 1,
    });
    const repository = repositoryHarness();
    const embedBatch = jest.fn(async (inputs: readonly string[]) => (
      inputs.map(() => [1, 0])
    ));

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority({
        initialMinimumPageCount: BACKSTAGE_NOTION_SYNC_MAX_PAGES,
      }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
        embedBatch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'completeness_validation',
        reason: 'completeness_mismatch',
        candidateSnapshotCreated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(provider.databaseCalls()).toBe(1);
    expect(provider.metadataCalls.size).toBe(0);
    expect(embedBatch).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when a database query reports a nested data source', async () => {
    const provider = databaseRootFetch({ nestedDataSource: true });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'discovery',
        reason: 'completeness_mismatch',
        candidateSnapshotCreated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed on an incomplete database query response', async () => {
    const provider = databaseRootFetch({ incompleteQuery: true });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'discovery',
        reason: 'permanent_notion_error',
        notionHttpStatus: 200,
        notionEndpointKind: 'data_source_query',
        notionResponseSchemaValid: false,
        candidateSnapshotCreated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('discards a database-root candidate when query membership drifts', async () => {
    const provider = databaseRootFetch({ membershipDrift: true });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'completeness_validation',
        reason: 'source_changed',
        candidateSnapshotCreated: true,
        candidateSnapshotValidated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('traverses opaque database query cursors with exact request bodies', async () => {
    const provider = databaseRootFetch({ opaqueCursorTraversal: true });
    const repository = repositoryHarness();

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority({ initialMinimumPageCount: 3 }),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    );

    expect(result).toMatchObject({ status: 'activated', pageCount: 4 });
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.pages.map(page => page.pageId).sort()).toEqual([
      pageId(0),
      pageId(1),
      pageId(2),
      pageId(3),
    ].sort());
    expect(provider.queryCalls.get(pageId(100))).toBe(4);
    expect(provider.queryCalls.get(pageId(101))).toBe(2);
    const rawQueryBodies = provider.fetchMock.mock.calls
      .filter(call => new URL(String(call[0])).pathname.endsWith('/query'))
      .map(call => call[1]?.body);
    expect(rawQueryBodies).toEqual([
      '{"page_size":10}',
      '{"page_size":10,"start_cursor":"opaque cursor/雪:v1"}',
      '{"page_size":10}',
      '{"page_size":10}',
      '{"page_size":10,"start_cursor":"opaque cursor/雪:v1"}',
      '{"page_size":10}',
    ]);
    expect(provider.requestBodies).toEqual([
      { page_size: 10 },
      {
        page_size: 10,
        start_cursor: 'opaque cursor/雪:v1',
      },
      { page_size: 10 },
      { page_size: 10 },
      {
        page_size: 10,
        start_cursor: 'opaque cursor/雪:v1',
      },
      { page_size: 10 },
    ]);
  });

  it('fails closed when a database query repeats an opaque cursor', async () => {
    const provider = databaseRootFetch({ repeatedCursor: true });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'pagination',
        reason: 'pagination_incomplete',
        paginationRequests: 1,
        candidateSnapshotCreated: false,
        candidateSnapshotValidated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(provider.databaseCalls()).toBe(1);
    expect(provider.queryCalls.get(pageId(100))).toBe(2);
    expect(provider.queryCalls.has(pageId(101))).toBe(false);
    expect(provider.requestBodies).toEqual([
      { page_size: 10 },
      {
        page_size: 10,
        start_cursor: 'opaque cursor/雪:v1',
      },
    ]);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      'query pages',
      { duplicatePageIdAcrossQueryPages: true },
      [
        { page_size: 10 },
        {
          page_size: 10,
          start_cursor: 'opaque cursor/雪:v1',
        },
      ],
    ],
    [
      'data sources',
      { duplicatePageIdAcrossDataSources: true },
      [
        { page_size: 10 },
        { page_size: 10 },
      ],
    ],
  ] as const)(
    'fails closed on duplicate page IDs across %s',
    async (_scope, options, expectedRequestBodies) => {
      const provider = databaseRootFetch(options);
      const repository = repositoryHarness();

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: provider.fetchMock as unknown as typeof fetch,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase: 'completeness_validation',
          reason: 'completeness_mismatch',
          candidateSnapshotCreated: false,
          candidateSnapshotValidated: false,
          candidateSnapshotActivated: false,
        }),
      });
      expect(provider.databaseCalls()).toBe(1);
      expect(provider.requestBodies).toEqual(expectedRequestBodies);
      expect(provider.metadataCalls.size).toBe(0);
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['data source set', 'data_sources'],
    ['title', 'title'],
  ] as const)(
    'discards a database-root candidate when database %s drifts',
    async (_field, databaseMetadataDrift) => {
      const provider = databaseRootFetch({ databaseMetadataDrift });
      const repository = repositoryHarness();

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: provider.fetchMock as unknown as typeof fetch,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_SOURCE_DRIFT_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase: 'completeness_validation',
          reason: 'source_changed',
          candidateSnapshotCreated: true,
          candidateSnapshotValidated: false,
          candidateSnapshotActivated: false,
        }),
      });
      expect(provider.databaseCalls()).toBe(2);
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
    }
  );

  it('fails closed when a database root moves to trash during verification', async () => {
    const provider = databaseRootFetch({ databaseMetadataDrift: 'in_trash' });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: provider.fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'completeness_validation',
        reason: 'inaccessible_page',
        candidateSnapshotCreated: true,
        candidateSnapshotValidated: false,
        candidateSnapshotActivated: false,
      }),
    });
    expect(provider.databaseCalls()).toBe(2);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('exhausts nested enhanced-Markdown continuation identifiers exactly once', async () => {
    const firstContinuation = pageId(1000);
    const secondContinuation = pageId(1001);
    const pages: TestNotionPage[] = [
      {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: `# Root\n\n<unknown url="https://www.notion.so/${compactPageId(
          pageId(0)
        )}#${compactPageId(firstContinuation)}"/>`,
        truncated: true,
        unknownBlockIds: [firstContinuation],
      },
      {
        pageId: firstContinuation,
        parentPageId: null,
        title: 'Continuation A',
        markdown: `## Continued A\n\n<unknown url="notion://${secondContinuation}"/>`,
        truncated: true,
        unknownBlockIds: [secondContinuation],
      },
      {
        pageId: secondContinuation,
        parentPageId: null,
        title: 'Continuation B',
        markdown: '### Continued B\n\nSynthetic completion marker.',
      },
    ];
    const { fetchMock } = notionFetch(pages);
    const repository = repositoryHarness();

    const result = await syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    );

    expect(result).toMatchObject({ status: 'activated', pageCount: 1 });
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.pages[0]?.markdown).toContain('Synthetic completion marker.');
    expect(activation?.pages[0]?.markdown).not.toContain('<unknown');
    const markdownPaths = fetchMock.mock.calls
      .map(call => new URL(String(call[0])).pathname)
      .filter(path => path.endsWith('/markdown'));
    expect(markdownPaths).toEqual([
      `/v1/pages/${pageId(0)}/markdown`,
      `/v1/pages/${firstContinuation}/markdown`,
      `/v1/pages/${secondContinuation}/markdown`,
    ]);
  });

  it('exhausts sibling and nested Markdown continuations exactly once', async () => {
    const firstSibling = pageId(1_010);
    const secondSibling = pageId(1_011);
    const nested = pageId(1_012);
    const pages: TestNotionPage[] = [
      {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: [
          `<unknown url="notion://${firstSibling}"/>`,
          `<unknown url="notion://${secondSibling}"/>`,
        ].join('\n'),
        truncated: true,
        unknownBlockIds: [firstSibling, secondSibling],
      },
      {
        pageId: firstSibling,
        parentPageId: null,
        title: 'Sibling A',
        markdown: `## Sibling A\n\n<unknown url="notion://${nested}"/>`,
        truncated: true,
        unknownBlockIds: [nested],
      },
      {
        pageId: secondSibling,
        parentPageId: null,
        title: 'Sibling B',
        markdown: '## Sibling B\n\nSecond subtree marker.',
      },
      {
        pageId: nested,
        parentPageId: null,
        title: 'Nested',
        markdown: '### Nested\n\nNested subtree marker.',
      },
    ];
    const { fetchMock } = notionFetch(pages);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated', pageCount: 1 });

    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    expect(activation?.pages[0]?.markdown).toContain('Nested subtree marker.');
    expect(activation?.pages[0]?.markdown).toContain('Second subtree marker.');
    expect(activation?.pages[0]?.markdown).not.toContain('<unknown');
    const requestedMarkdownIds = fetchMock.mock.calls
      .map(call => new URL(String(call[0])))
      .filter(url => url.pathname.endsWith('/markdown'))
      .map(url => url.pathname.split('/').at(-2));
    expect(requestedMarkdownIds).toEqual([
      pageId(0),
      firstSibling,
      nested,
      secondSibling,
    ]);
    expect(new Set(requestedMarkdownIds).size).toBe(4);
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a cyclic enhanced-Markdown continuation graph', async () => {
    const continuation = pageId(1000);
    const pages: TestNotionPage[] = [
      {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: `<unknown url="notion://${continuation}"/>`,
        truncated: true,
        unknownBlockIds: [continuation],
      },
      {
        pageId: continuation,
        parentPageId: null,
        title: 'Continuation',
        markdown: `<unknown url="notion://${pageId(0)}"/>`,
        truncated: true,
        unknownBlockIds: [pageId(0)],
      },
    ];
    const { fetchMock } = notionFetch(pages);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'pagination',
        reason: 'pagination_incomplete',
        paginationRequests: 1,
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      chunkCount: 2_307,
      pageCount: 366,
      accepted: true,
    },
    {
      chunkCount: BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT,
      pageCount: 64,
      accepted: true,
    },
    {
      chunkCount: BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT + 1,
      pageCount: 64,
      accepted: false,
    },
  ])('enforces the bounded writer release at $chunkCount chunks', async ({
    chunkCount,
    pageCount,
    accepted,
  }) => {
    const pageStubs = Array.from({ length: pageCount }, (_, index): TestNotionPage => ({
      pageId: pageId(index),
      parentPageId: index === 0 ? null : pageId(0),
      title: index === 0 ? 'WWE Universe Mode' : `Child Universe ${index}`,
      markdown: '',
    }));
    const navigationMarkdown = pageStubs.slice(1).map(pageTag).join('\n');
    const rootStub = pageStubs[0] ?? {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '',
    };
    const navigationChunkOverhead = prepareBackstageNotionRagPage({
      universeId,
      pageId: rootStub.pageId,
      parentPageId: null,
      title: rootStub.title,
      path: [rootStub.title],
      markdown: `## Synthetic probe\n\nvalue-probe\n\n${navigationMarkdown}`,
    }).chunks.length - 1;
    const syntheticChunkCount = chunkCount - navigationChunkOverhead;
    const baseChunksPerPage = Math.floor(syntheticChunkCount / pageCount);
    const extraChunkPages = syntheticChunkCount % pageCount;
    const pages = pageStubs.map((stub, index): TestNotionPage => {
      const chunksForPage = baseChunksPerPage + (index < extraChunkPages ? 1 : 0);
      return {
        ...stub,
        markdown: Array.from(
          { length: chunksForPage },
          (_unused, chunkIndex) => (
            `## Synthetic ${index}-${chunkIndex}\n\nvalue-${index}-${chunkIndex}`
          )
        ).join('\n\n'),
      };
    });
    pages[0].markdown += `\n\n${navigationMarkdown}`;
    const continuationId = pageId(2_000);
    const continuationPage: TestNotionPage | null = accepted
      ? {
          pageId: continuationId,
          parentPageId: null,
          title: 'Synthetic continuation',
          markdown: pages[1]?.markdown ?? '',
        }
      : null;
    if (continuationPage && pages[1]) {
      pages[1].markdown = `<unknown url="https://www.notion.so/${compactPageId(
        pages[1].pageId
      )}#${compactPageId(continuationId)}"/>`;
      pages[1].truncated = true;
      pages[1].unknownBlockIds = [continuationId];
    }
    const { fetchMock } = notionFetch(
      continuationPage ? [...pages, continuationPage] : pages
    );
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
        pageCount,
        chunkCount,
      });
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
      const activatedChunks = repository.activateSnapshot.mock.calls[0]?.[0].chunks ?? [];
      expect(activatedChunks).toHaveLength(chunkCount);
      const embeddedInputs = embedBatch.mock.calls.flatMap(call => call[0]);
      expect(embeddedInputs).toHaveLength(chunkCount);
      expect(new Set(embeddedInputs).size).toBe(chunkCount);
      expect(embedBatch.mock.calls.every(call => (
        call[0].length >= 1
        && call[0].length <= BACKSTAGE_NOTION_SYNC_EMBEDDING_BATCH_SIZE
      ))).toBe(true);
      if (chunkCount === BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT) {
        expect(BACKSTAGE_NOTION_SYNC_MAX_COLD_EMBEDDING_REQUESTS).toBe(114);
        expect(embedBatch).toHaveBeenCalledTimes(
          BACKSTAGE_NOTION_SYNC_MAX_COLD_EMBEDDING_REQUESTS
        );
        expect(embedBatch.mock.calls.at(-1)?.[0]).toHaveLength(28);
      }
      expect(new Set(activatedChunks.map(chunk => chunk.chunkId)).size)
        .toBe(chunkCount);
      expect(new Set(activatedChunks.map(chunk => chunk.contentHash)).size)
        .toBe(chunkCount);
      expect(activatedChunks.every(chunk => (
        chunk.embedding.length === 2
        && chunk.embedding.every(Number.isFinite)
      ))).toBe(true);
      expect(fetchMock.mock.calls.map(call => (
        new URL(String(call[0])).pathname
      )).filter(path => (
        path.endsWith(`/v1/pages/${continuationId}/markdown`)
      ))).toHaveLength(1);
    } else {
      await expect(sync).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        diagnostics: {
          phase: 'chunking',
          reason: 'chunk_limit_reached',
          pagesDiscovered: pageCount,
          pagesFetched: pageCount,
          blocksFetched: pageCount,
          normalizedSegments: expect.any(Number),
          emptySegmentsRemoved: expect.any(Number),
          exactDuplicatesRemoved: 0,
          adjacentSegmentsMerged: expect.any(Number),
          chunksProduced: chunkCount,
          chunksEmbedded: 0,
          minimumChunkCodePoints: expect.any(Number),
          maximumChunkCodePoints: expect.any(Number),
          medianChunkCodePoints: expect.any(Number),
          reusedEmbeddingCount: 0,
          newEmbeddingCount: 0,
          notionRetryCount: 0,
          rateLimitWaitMs: 0,
          candidateSnapshotCreated: false,
          candidateSnapshotValidated: false,
          candidateSnapshotActivated: false,
          elapsedMs: expect.any(Number),
          paginationRequests: 0,
        },
      });
      expect(embedBatch).not.toHaveBeenCalled();
      expect(repository.loadReusableEmbeddings).not.toHaveBeenCalled();
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

  it('stores fixed-size scope digests for maximum bounded normalization expansion', async () => {
    const expandingTitle = '\uFDFA'.repeat(240);
    expect(Array.from(expandingTitle.normalize('NFKC')).length).toBeGreaterThan(4_000);
    const child: TestNotionPage = {
      pageId: pageId(1),
      parentPageId: pageId(0),
      title: expandingTitle,
      markdown: '# Continuity\n\nExpanded-title canon.',
    };
    const rootPage: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: pageTag(child),
    };
    const { fetchMock } = notionFetch([rootPage, child]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).resolves.toMatchObject({ status: 'activated' });

    const activation = repository.activateSnapshot.mock.calls[0]?.[0];
    const indexedPage = activation?.pages.find(page => page.pageId === child.pageId);
    expect(indexedPage?.title).toBe(expandingTitle);
    expect(indexedPage?.metadata?.scopeTitleKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(indexedPage?.metadata?.scopePathKey).toHaveLength(2);
    expect(indexedPage?.metadata?.scopePathKey?.at(-1))
      .toBe(indexedPage?.metadata?.scopeTitleKey);
    expect(indexedPage?.metadata?.scopePathKey).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/u)])
    );
    expect(Buffer.byteLength(JSON.stringify(indexedPage?.metadata), 'utf8'))
      .toBeLessThan(1_024);
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
    expect(embedBatch.mock.calls.map(call => call[0].length)).toEqual([36, 29]);
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

  it('validates startup synchronization configuration without provider or database work', () => {
    const authority = JSON.stringify({
      [universeId]: {
        rootPageId: pageId(0),
        displayName: 'WWE Universe Mode',
      },
    });

    expect(validateBackstageNotionSynchronizationConfiguration({
      readEnvironment: environmentReader(),
    })).toEqual({
      authorityConfigured: false,
      configuredUniverses: 0,
    });
    expect(validateBackstageNotionSynchronizationConfiguration({
      readEnvironment: environmentReader({ token: notionToken, authority }),
    })).toEqual({
      authorityConfigured: true,
      configuredUniverses: 1,
    });
  });

  it.each([
    ['invalid authority', environmentReader({ token: notionToken, authority: '{' })],
    ['missing token', environmentReader({ authority: JSON.stringify({
      [universeId]: {
        rootPageId: pageId(0),
        displayName: 'WWE Universe Mode',
      },
    }) })],
    ['unsafe token', environmentReader({ token: 'placeholder', authority: JSON.stringify({
      [universeId]: {
        rootPageId: pageId(0),
        displayName: 'WWE Universe Mode',
      },
    }) })],
    ['environment read failure', environmentReader({ throwOnRead: true })],
  ] as const)(
    'keeps malformed required startup configuration fatal: %s',
    (_case, readEnvironment) => {
      expect(() => validateBackstageNotionSynchronizationConfiguration({
        readEnvironment,
      })).toThrow(expect.objectContaining({
        code: BACKSTAGE_NOTION_SYNC_CONFIGURATION_ERROR_CODE,
      }));
    }
  );

  it('uses the configured runtime environment and default embedding adapter offline', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const repository = repositoryHarness();
    const originalToken = readRuntimeEnv(BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME);
    const originalAuthority = readRuntimeEnv(BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME);
    const authority = JSON.stringify({
      [universeId]: {
        rootPageId: page.pageId,
        displayName: page.title,
      },
    });

    resetOpenAIAdapter();
    writeRuntimeEnv(BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME, notionToken);
    writeRuntimeEnv(BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME, authority);
    try {
      const adapter = getOpenAIAdapter({ apiKey: 'test-openai-api-key' });
      const embeddingCreate = jest.fn<OpenAIAdapter['embeddings']['create']>(
        async params => {
          const inputCount = Array.isArray(params.input) ? params.input.length : 1;
          return {
            object: 'list',
            model: 'text-embedding-3-small',
            data: Array.from({ length: inputCount }, (_, index) => ({
              object: 'embedding',
              embedding: [1, 0],
              index,
            })),
            usage: { prompt_tokens: inputCount, total_tokens: inputCount },
          };
        }
      );
      adapter.embeddings.create = embeddingCreate;

      await expect(syncConfiguredBackstageNotionAuthorities({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        requestSpacingMs: 0,
        retryBaseDelayMs: 0,
        fetchTimeoutMs: 1_000,
        holderId,
      })).resolves.toEqual([
        expect.objectContaining({
          universeId,
          status: 'activated',
          pageCount: 1,
          chunkCount: 1,
        }),
      ]);
      expect(embeddingCreate).toHaveBeenCalledTimes(1);
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      resetOpenAIAdapter();
      if (originalToken === undefined) {
        unsetRuntimeEnv(BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME);
      } else {
        writeRuntimeEnv(BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME, originalToken);
      }
      if (originalAuthority === undefined) {
        unsetRuntimeEnv(BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME);
      } else {
        writeRuntimeEnv(BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME, originalAuthority);
      }
    }
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
      failure: {
        phase: 'pagination',
        reason: 'pagination_incomplete',
        pagesDiscovered: 1,
        pagesFetched: 0,
        blocksFetched: 1,
        candidateSnapshotActivated: false,
      },
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
      expect.objectContaining({
        universeId: firstUniverseId,
        errorCode: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
        phase: 'pagination',
        reason: 'pagination_incomplete',
        pagesDiscovered: 1,
        pagesFetched: 0,
        blocksFetched: 1,
        candidateSnapshotActivated: false,
      })
    );
  });

  it('preserves accumulated counters when a late lease renewal is fenced out', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const embeddingStarted = deferred<void>();
    const repository = repositoryHarness({
      renewLease: () => null,
    });
    const authority = JSON.stringify({
      [universeId]: {
        rootPageId: page.pageId,
        displayName: page.title,
      },
    });
    const resultPromise = syncConfiguredBackstageNotionAuthorities(
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch: async () => {
          embeddingStarted.resolve(undefined);
          return new Promise<number[][]>(() => undefined);
        },
        leaseRenewalIntervalMs: 10,
        readEnvironment: environmentReader({ token: notionToken, authority }),
      })
    );
    await embeddingStarted.promise;

    await expect(resultPromise).resolves.toEqual([expect.objectContaining({
      universeId,
      status: 'failed',
      failure: expect.objectContaining({
        phase: 'lease',
        reason: 'lease_lost',
        pagesDiscovered: 1,
        pagesFetched: 1,
        blocksFetched: 1,
        chunksProduced: 1,
        candidateSnapshotActivated: false,
      }),
    })]);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    const serializedTelemetry = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(serializedTelemetry).not.toContain(notionToken);
    expect(serializedTelemetry).not.toContain(page.pageId);
    expect(serializedTelemetry).not.toContain(page.markdown);
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
      failure: expect.objectContaining({
        phase: 'root_resolution',
        reason: 'unexpected_failure',
        candidateSnapshotActivated: false,
      }),
    })]);
    const serializedTelemetry = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(serializedTelemetry).not.toContain('PRIVATE-DATABASE-DETAIL');
    expect(serializedTelemetry).not.toContain(notionToken);
    expect(serializedTelemetry).not.toContain(pageId(0));
  });

  it.each([429, 529] as const)(
    'honors bounded Retry-After on a transient Notion %s response',
    async retryMetadataStatus => {
      const page: TestNotionPage = {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: '# Root',
      };
      const { fetchMock, metadataCalls } = notionFetch([page], {
        retryMetadataPageId: page.pageId,
        retryMetadataStatus,
        retryAfterSeconds: 2,
      });
      const repository = repositoryHarness();
      const waits: number[] = [];

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
          wait: async milliseconds => {
            waits.push(milliseconds);
          },
          random: () => 0,
        })
      )).resolves.toMatchObject({ status: 'activated' });

      expect(metadataCalls.get(page.pageId)).toBe(3);
      expect(waits).toContain(2_000);
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    }
  );

  it.each([409, 503] as const)(
    'recovers from a bounded transient %s retry',
    async retryMetadataStatus => {
      const page: TestNotionPage = {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: '# Root',
      };
      const { fetchMock, metadataCalls } = notionFetch([page], {
        retryMetadataPageId: page.pageId,
        retryMetadataStatus,
      });
      const repository = repositoryHarness();

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
          wait: async () => undefined,
          random: () => 0,
        })
      )).resolves.toMatchObject({ status: 'activated' });

      expect(metadataCalls.get(page.pageId)).toBe(3);
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    }
  );

  it('fails before persistence when embedding generation fails', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch: async () => {
          throw new Error('PRIVATE-EMBEDDING-DETAIL');
        },
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'embedding',
        reason: 'embedding_failed',
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'empty', vectors: [[]] },
    { label: 'NaN', vectors: [[Number.NaN, 0]] },
    { label: 'Infinity', vectors: [[Number.POSITIVE_INFINITY, 0]] },
  ])('classifies a malformed $label provider vector as embedding_failed', async ({
    vectors,
  }) => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch: async () => vectors,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'embedding',
        reason: 'embedding_failed',
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('rejects mixed embedding dimensions before persistence', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '## First\n\nfirst\n\n## Second\n\nsecond',
    };
    const { fetchMock } = notionFetch([page]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch: async () => [[1, 0], [1, 0, 0]],
      })
    )).rejects.toMatchObject({
      diagnostics: expect.objectContaining({
        phase: 'embedding',
        reason: 'embedding_failed',
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed when an authorized Markdown continuation is inaccessible', async () => {
    const continuation = pageId(1_000);
    const root: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: `<unknown url="notion://${continuation}"/>`,
      truncated: true,
      unknownBlockIds: [continuation],
    };
    const { fetchMock } = notionFetch([root]);
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'pagination',
        reason: 'inaccessible_page',
        paginationRequests: 1,
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['persistence', 'persistence_failed'],
    ['completeness_validation', 'completeness_mismatch'],
    ['activation', 'activation_failed'],
  ] as const)(
    'maps a typed %s write failure without activating the candidate',
    async (phase, reason) => {
      const page: TestNotionPage = {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: '# Root',
      };
      const { fetchMock } = notionFetch([page]);
      const repository = repositoryHarness();
      repository.activateSnapshot.mockRejectedValueOnce(
        new BackstageNotionSnapshotWriteError(phase)
      );

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase,
          reason,
          candidateSnapshotActivated: false,
        }),
      });
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    }
  );

  it('classifies an inaccessible Notion page without retry or activation', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => (
      notionErrorResponse(404, 'object_not_found')
    ));
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_INCOMPLETE_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'page_fetch',
        reason: 'inaccessible_page',
        notionRetryCount: 0,
        notionHttpStatus: 404,
        notionProviderCode: 'object_not_found',
        notionFailureCategory: 'inaccessible',
        notionResponseContentType: 'application/json',
        notionResponseSchemaValid: true,
        notionEndpointKind: 'page_metadata',
        candidateSnapshotActivated: false,
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'restricted_resource'],
  ] as const)(
    'classifies Notion %s/%s as an authorization failure without retry',
    async (status, providerCode) => {
      const fetchMock = jest.fn(async (): Promise<Response> => (
        notionErrorResponse(status, providerCode)
      ));
      const repository = repositoryHarness();

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase: 'authorization',
          reason: 'permanent_notion_error',
          notionRetryCount: 0,
          notionHttpStatus: status,
          notionProviderCode: providerCode,
          notionFailureCategory: 'authorization',
          notionResponseContentType: 'application/json',
          notionResponseSchemaValid: true,
          notionEndpointKind: 'page_metadata',
        }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
      const serializedTelemetry = JSON.stringify(
        (logger.warn as jest.Mock).mock.calls
      );
      expect(serializedTelemetry).not.toContain('PRIVATE-NOTION-PROVIDER-MESSAGE');
      expect(serializedTelemetry).not.toContain(pageId(0));
      expect(serializedTelemetry).not.toContain(notionToken);
    }
  );

  it.each([
    [409, 'conflict_error'],
    [500, 'internal_server_error'],
    [502, 'bad_gateway'],
    [503, 'service_unavailable'],
    [504, 'gateway_timeout'],
    [529, 'service_overload'],
  ] as const)(
    'classifies retry-exhausted Notion %s/%s without provider-body leakage',
    async (status, providerCode) => {
      const fetchMock = jest.fn(async (): Promise<Response> => (
        notionErrorResponse(status, providerCode)
      ));
      const repository = repositoryHarness();

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
          wait: async () => undefined,
          random: () => 0,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase: 'page_fetch',
          reason: 'transient_retry_exhausted',
          notionRetryCount: 2,
          notionHttpStatus: status,
          notionProviderCode: providerCode,
          notionFailureCategory: 'transient_provider',
          notionResponseContentType: 'application/json',
          notionResponseSchemaValid: true,
          notionEndpointKind: 'page_metadata',
          candidateSnapshotActivated: false,
        }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
      const serializedTelemetry = JSON.stringify(
        (logger.warn as jest.Mock).mock.calls
      );
      expect(serializedTelemetry).not.toContain('PRIVATE-NOTION-PROVIDER-MESSAGE');
      expect(serializedTelemetry).not.toContain(pageId(0));
      expect(serializedTelemetry).not.toContain(notionToken);
    }
  );

  it('probes only the database endpoint after an exact root page type error', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => (
      notionErrorResponse(400, 'validation_error')
    ));
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      diagnostics: expect.objectContaining({
        phase: 'page_fetch',
        reason: 'permanent_notion_error',
        notionRetryCount: 0,
        notionHttpStatus: 400,
        notionProviderCode: 'validation_error',
        notionFailureCategory: 'permanent_provider',
        notionResponseContentType: 'application/json',
        notionResponseSchemaValid: true,
        notionEndpointKind: 'database_metadata',
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname))
      .toEqual([
        `/v1/pages/${pageId(0)}`,
        `/v1/databases/${pageId(0)}`,
      ]);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('does not probe another object type for an unrelated root page 400', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => (
      notionErrorResponse(400, 'invalid_request')
    ));
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      diagnostics: expect.objectContaining({
        notionHttpStatus: 400,
        notionProviderCode: 'invalid_request',
        notionEndpointKind: 'page_metadata',
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      'malformed JSON',
      () => new Response('{PRIVATE-MALFORMED-BODY', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
      'application/json',
    ],
    [
      'unexpected schema',
      () => jsonResponse({
        object: 'page',
        id: pageId(0),
        private: 'PRIVATE-UNEXPECTED-SCHEMA',
      }),
      'application/json',
    ],
    [
      'unexpected content type',
      () => new Response('PRIVATE-NON-JSON-BODY', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
      'text/plain',
    ],
    [
      'invalid UTF-8 body',
      () => new Response(new Uint8Array([0xC3, 0x28]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      'application/json',
    ],
  ] as const)(
    'classifies %s as a malformed Notion response without leaking the body',
    async (_label, responseFactory, responseContentType) => {
      const fetchMock = jest.fn(async (): Promise<Response> => responseFactory());
      const repository = repositoryHarness();

      await expect(syncConfiguredBackstageNotionAuthorities(
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
          readEnvironment: environmentReader({
            token: notionToken,
            authority: JSON.stringify({
              [universeId]: {
                rootPageId: pageId(0),
                displayName: 'WWE Universe Mode',
              },
            }),
          }),
        })
      )).resolves.toEqual([expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({
          phase: 'page_fetch',
          reason: 'permanent_notion_error',
          notionHttpStatus: 200,
          notionProviderCode: null,
          notionFailureCategory: 'malformed_response',
          notionResponseContentType: responseContentType,
          notionResponseSchemaValid: false,
          notionEndpointKind: 'page_metadata',
          candidateSnapshotActivated: false,
        }),
      })]);
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
      const serializedTelemetry = JSON.stringify(
        (logger.warn as jest.Mock).mock.calls
      );
      expect(serializedTelemetry).not.toContain('PRIVATE-MALFORMED-BODY');
      expect(serializedTelemetry).not.toContain('PRIVATE-UNEXPECTED-SCHEMA');
      expect(serializedTelemetry).not.toContain('PRIVATE-NON-JSON-BODY');
      expect(serializedTelemetry).not.toContain(pageId(0));
      expect(serializedTelemetry).not.toContain(notionToken);
    }
  );

  it('classifies an oversized root response without consuming or activating it', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(
          BACKSTAGE_NOTION_MAX_METADATA_RESPONSE_BYTES + 1
        ),
      },
    }));
    const active = activeInventory('active-manifest');
    const repository = repositoryHarness({ loadActive: () => active });

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    )).rejects.toMatchObject({
      diagnostics: expect.objectContaining({
        phase: 'page_fetch',
        reason: 'permanent_notion_error',
        notionHttpStatus: 200,
        notionProviderCode: null,
        notionFailureCategory: 'response_too_large',
        notionResponseContentType: 'application/json',
        notionResponseSchemaValid: null,
        notionEndpointKind: 'page_metadata',
        candidateSnapshotActivated: false,
      }),
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(repository.markActiveSnapshotVerified).not.toHaveBeenCalled();
  });

  it('reports exhausted network failures as transient without leaking details', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => {
      throw new Error('PRIVATE-NETWORK-DETAIL');
    });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        wait: async () => undefined,
        random: () => 0,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'page_fetch',
        reason: 'transient_retry_exhausted',
        notionRetryCount: 2,
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('fails with bounded rate-limit diagnostics after Retry-After exhaustion', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page], {
      retryMetadataPageId: page.pageId,
      retryMetadataStatus: 429,
      retryMetadataFailures: 3,
      retryAfterSeconds: 2,
    });
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        wait: async () => undefined,
        random: () => 0,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'page_fetch',
        reason: 'rate_limit_exhausted',
        notionRetryCount: 2,
        rateLimitWaitMs: 4_000,
        notionHttpStatus: 429,
        notionProviderCode: 'rate_limited',
        notionFailureCategory: 'rate_limited',
        notionResponseContentType: 'application/json',
        notionResponseSchemaValid: true,
        notionEndpointKind: 'page_metadata',
        candidateSnapshotActivated: false,
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it.each([61, 100_000])(
    'does not retry before an over-policy Retry-After value of %s seconds',
    async retryAfterSeconds => {
      const page: TestNotionPage = {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: '# Root',
      };
      const { fetchMock } = notionFetch([page], {
        retryMetadataPageId: page.pageId,
        retryMetadataStatus: 429,
        retryAfterSeconds,
      });
      const repository = repositoryHarness();
      const waits: number[] = [];

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
          wait: async milliseconds => {
            waits.push(milliseconds);
          },
          random: () => 0,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase: 'page_fetch',
          reason: 'rate_limit_exhausted',
          notionRetryCount: 0,
          rateLimitWaitMs: 0,
        }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([0]);
      expect(repository.activateSnapshot).not.toHaveBeenCalled();
    }
  );

  it('reports the exact request-timeout phase and retains the inactive candidate', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => (
      new Promise<Response>(() => undefined)
    ));
    const repository = repositoryHarness();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        fetchTimeoutMs: 1,
        wait: async () => undefined,
        random: () => 0,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'page_fetch',
        reason: 'deadline_exhausted',
        notionRetryCount: 2,
        candidateSnapshotActivated: false,
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('enforces one non-renewable cycle deadline during embedding', async () => {
    const page: TestNotionPage = {
      pageId: pageId(0),
      parentPageId: null,
      title: 'WWE Universe Mode',
      markdown: '# Root',
    };
    const { fetchMock } = notionFetch([page]);
    const repository = repositoryHarness();
    const embedBatch = jest.fn(async (): Promise<number[][]> => (
      new Promise<number[][]>(() => undefined)
    ));

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        fetchImpl: fetchMock as unknown as typeof fetch,
        embedBatch,
        cycleTimeoutMs: 20,
      })
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
      diagnostics: expect.objectContaining({
        phase: 'embedding',
        reason: 'deadline_exhausted',
        pagesFetched: 1,
        blocksFetched: 1,
        chunksProduced: 1,
        candidateSnapshotActivated: false,
      }),
    });
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
  });

  it.each(['persistence', 'completeness_validation', 'activation'] as const)(
    'preserves the exact %s phase for a repository deadline',
    async phase => {
      const page: TestNotionPage = {
        pageId: pageId(0),
        parentPageId: null,
        title: 'WWE Universe Mode',
        markdown: '# Root',
      };
      const { fetchMock } = notionFetch([page]);
      const repository = repositoryHarness();
      repository.activateSnapshot.mockRejectedValueOnce(
        new BackstageNotionSnapshotDeadlineError(phase)
      );

      await expect(syncBackstageNotionAuthorityRoot(
        rootAuthority(),
        dependencies({
          repository: repository.repository,
          fetchImpl: fetchMock as unknown as typeof fetch,
        })
      )).rejects.toMatchObject({
        code: BACKSTAGE_NOTION_SYNC_ROOT_FAILED_ERROR_CODE,
        diagnostics: expect.objectContaining({
          phase,
          reason: 'deadline_exhausted',
          candidateSnapshotActivated: false,
        }),
      });
      expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
    }
  );

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

  it('verifies a readable Phase-B snapshot without rebuilding above the Phase-A writer ceiling', async () => {
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
    currentInventory = activeInventory(first.manifestHash ?? '', 2_117);
    embedBatch.mockClear();
    repository.loadReusableEmbeddings.mockClear();
    repository.activateSnapshot.mockClear();

    await expect(syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      syncDependencies
    )).resolves.toMatchObject({
      status: 'unchanged',
      chunkCount: 2_117,
    });
    expect(repository.markActiveSnapshotVerified).toHaveBeenCalledTimes(1);
    expect(repository.loadReusableEmbeddings).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it('releases the exact lease when acquisition resolves after cancellation', async () => {
    const controller = new AbortController();
    const repository = repositoryHarness();
    const pendingAcquisition = deferred<BackstageNotionSyncLease | null>();
    repository.acquireSyncLease.mockImplementationOnce(async () => pendingAcquisition.promise);
    const abortReason = new DOMException('stopped during lease acquisition', 'AbortError');

    const sync = syncBackstageNotionAuthorityRoot(
      rootAuthority(),
      dependencies({
        repository: repository.repository,
        signal: controller.signal,
      })
    );
    expect(repository.acquireSyncLease).toHaveBeenCalledTimes(1);

    controller.abort(abortReason);
    await expect(sync).rejects.toBe(abortReason);
    expect(repository.releaseSyncLease).not.toHaveBeenCalled();

    pendingAcquisition.resolve(lease);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(repository.releaseSyncLease).toHaveBeenCalledTimes(1);
    expect(repository.releaseSyncLease).toHaveBeenCalledWith(
      universeId,
      lease.holderId,
      lease.leaseToken
    );
    expect(repository.loadAuthorityHead).not.toHaveBeenCalled();
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
