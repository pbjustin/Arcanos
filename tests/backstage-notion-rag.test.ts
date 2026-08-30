import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  BackstageNotionActiveChunk,
  BackstageNotionActiveSnapshot,
  BackstageNotionActiveSnapshotHeader,
  BackstageNotionSnapshotCandidateSearch,
  BackstageNotionSnapshotChunkPage,
  BackstageNotionSnapshotChunkPageSelector,
  BackstageNotionSnapshotScopeLookup,
  BackstageNotionSnapshotScopeResolution,
  RankBackstageNotionSnapshotCandidatesInput,
} from '../src/core/db/repositories/backstageNotionRagRepository.js';
import type {
  BackstageNotionSyncAttemptRecord,
} from '../src/core/db/repositories/backstageNotionSyncStatusRepository.js';
import {
  getOpenAIAdapter,
  resetOpenAIAdapter,
} from '../src/core/adapters/openai.adapter.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import {
  BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
  BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE,
  BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS,
  BackstageNotionCursorInvalidError,
  BackstageNotionIndexUnavailableError,
  BackstageNotionScopeResolutionError,
  retrieveBackstageNotionBookingRagContext,
  retrieveBackstageNotionRagContext,
  type BackstageNotionRagQuery,
  type BackstageNotionRagRetrievalDependencies,
} from '../src/services/backstageNotionRag.js';
import type { BackstageNotionAuthorityRoot } from '../src/services/backstageNotionAuthority.js';
import {
  runWithBackstageNotionEnrichmentAuthorization,
  wasBackstageNotionEnrichmentUsed,
} from '../src/services/backstageNotionEnrichmentAuthorization.js';
import {
  BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
  BACKSTAGE_NOTION_RAG_PROMPT_CODE_POINTS,
} from '../src/shared/backstage/backstageNotionRagCore.js';
import {
  classifyBackstageNotionBookingCandidateScope,
  type BackstageNotionBookingScopePlan,
} from '../src/shared/backstage/backstageNotionBookingScope.js';
import {
  normalizeBackstageNotionScopeKey,
  normalizeBackstageNotionScopePath,
} from '../src/shared/backstage/backstageNotionScopeIndex.js';
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from '../src/services/openai/embeddings.js';

const UNIVERSE_ID = 'my-universe-2k26';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-19T16:00:00.000Z');
const ROOT: BackstageNotionAuthorityRoot = {
  universeId: UNIVERSE_ID,
  rootPageId: ROOT_PAGE_ID,
  displayName: 'WWE Universe Mode',
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pageId(index: number): string {
  return `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function chunk(input: {
  pageIndex?: number;
  ordinal?: number;
  content?: string;
  pageTitle?: string;
  pagePath?: string[];
  category?: string;
  embedding?: number[];
  headingPath?: string[];
  headingOccurrencePath?: number[];
} = {}): BackstageNotionActiveChunk {
  const resolvedPageId = pageId(input.pageIndex ?? 1);
  const ordinal = input.ordinal ?? 0;
  const content = input.content ?? 'General WWE Universe continuity.';
  const contentHash = sha256(content);
  return {
    id: sha256(JSON.stringify({
      format: 'backstage-notion-rag-chunk-v1',
      pageId: resolvedPageId,
      ordinal,
      contentHash,
    })),
    pageId: resolvedPageId,
    pageTitle: input.pageTitle ?? `Universe page ${input.pageIndex ?? 1}`,
    pagePath: input.pagePath ?? [
      'WWE Universe Mode',
      `Universe page ${input.pageIndex ?? 1}`,
    ],
    ordinal,
    contentHash,
    content,
    codePoints: Array.from(content).length,
    embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    embedding: input.embedding ?? [1, 0],
    headingPath: input.headingPath ?? [],
    metadata: {
      category: input.category ?? 'general',
      headingIndexVersion: BACKSTAGE_NOTION_RAG_HEADING_INDEX_VERSION,
      headingOccurrencePath: input.headingOccurrencePath
        ?? input.headingPath?.map((_segment, index) => index + 1)
        ?? [],
      sourceHash: sha256(`source:${resolvedPageId}`),
      sourceLastEditedAt: '2026-08-19T15:30:00.000Z',
    },
  };
}

function activeSnapshot(
  chunks: BackstageNotionActiveChunk[] = [chunk()]
): BackstageNotionActiveSnapshot {
  return {
    authority: 'notion',
    verifiedAt: new Date(NOW),
    snapshot: {
      id: SNAPSHOT_ID,
      universeId: UNIVERSE_ID,
      rootPageId: ROOT_PAGE_ID,
      manifestHash: sha256('manifest'),
      embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
      pageCount: new Set(chunks.map(item => item.pageId)).size,
      chunkCount: chunks.length,
      sourceMaxEditedAt: new Date('2026-08-19T15:30:00.000Z'),
      syncHolderId: 'sync-worker',
      createdAt: new Date('2026-08-19T15:45:00.000Z'),
    },
    chunks,
    truncated: false,
  };
}

function activeSnapshotHeader(
  active: BackstageNotionActiveSnapshot | null
): BackstageNotionActiveSnapshotHeader | null {
  if (!active) {
    return null;
  }
  return {
    authority: active.authority,
    verifiedAt: active.verifiedAt,
    snapshot: active.snapshot,
  };
}

function latestSyncAttempt(
  outcome: BackstageNotionSyncAttemptRecord['outcome'],
  options: Partial<BackstageNotionSyncAttemptRecord> = {}
): BackstageNotionSyncAttemptRecord {
  return {
    universeId: UNIVERSE_ID,
    attemptId: '33333333-3333-4333-8333-333333333333',
    generation: '1',
    startedAt: new Date(NOW.getTime() - 2 * 60 * 1_000),
    completedAt: outcome === 'running'
      ? null
      : new Date(NOW.getTime() - 60 * 1_000),
    outcome,
    failurePhase: outcome === 'failed' ? 'chunking' : null,
    failureReason: outcome === 'failed' ? 'chunk_limit_reached' : null,
    pagesDiscovered: 366,
    pagesFetched: 366,
    blocksFetched: 366,
    chunksProduced: outcome === 'unchanged' ? 0 : 2_307,
    chunksEmbedded: outcome === 'activated' ? 2_307 : 0,
    candidateSnapshotCreated: outcome === 'activated',
    candidateSnapshotValidated: outcome === 'activated',
    candidateSnapshotActivated: outcome === 'activated',
    activatedSnapshotId: outcome === 'activated' || outcome === 'unchanged'
      ? SNAPSHOT_ID
      : null,
    ...options,
  };
}

function snapshotScopeResolution(
  active: BackstageNotionActiveSnapshot | null,
  snapshotId: string,
  lookup: BackstageNotionSnapshotScopeLookup
): BackstageNotionSnapshotScopeResolution {
  if (!active || snapshotId !== active.snapshot.id) {
    return { status: 'invalid' };
  }
  if (active.chunks.some(candidate => (
    candidate.pagePath.length < 1
    || Array.from(candidate.pagePath).some(segment => (
      typeof segment !== 'string' || !segment.trim()
    ))
    || Array.from(candidate.headingPath).some(segment => (
      typeof segment !== 'string' || !segment.trim()
    ))
  ))) {
    return { status: 'invalid' };
  }
  const scopeKind = lookup.scopeKind ?? 'page';
  const pages = new Map<string, BackstageNotionActiveChunk[]>();
  for (const candidate of active.chunks) {
    if (
      normalizeBackstageNotionScopeKey(candidate.pageTitle) !== lookup.pageTitleKey
      || (
        lookup.pagePathKey !== null
        && JSON.stringify(normalizeBackstageNotionScopePath(candidate.pagePath))
          !== JSON.stringify(lookup.pagePathKey)
      )
    ) {
      continue;
    }
    const pageChunks = pages.get(candidate.pageId) ?? [];
    pageChunks.push(candidate);
    pages.set(candidate.pageId, pageChunks);
  }
  if (pages.size === 0) {
    return { status: 'not_found' };
  }
  if (pages.size > 1) {
    return { status: 'ambiguous' };
  }
  const pageChunks = [...pages.values()][0]?.sort((left, right) => (
    left.ordinal - right.ordinal || compareText(left.id, right.id)
  )) ?? [];
  const representative = pageChunks[0];
  if (!representative) {
    return { status: 'invalid' };
  }
  const scopedPageChunks = scopeKind === 'subtree'
    ? active.chunks.filter(candidate => (
        representative.pagePath.every((segment, index) => (
          normalizeBackstageNotionScopeKey(candidate.pagePath[index] ?? '')
            === normalizeBackstageNotionScopeKey(segment)
        ))
      ))
    : pageChunks;
  if (lookup.sectionPathKey === null) {
    return {
      status: 'resolved',
      pageTitle: representative.pageTitle,
      pagePath: [...representative.pagePath],
      sectionPath: null,
      selector: {
        pageId: representative.pageId,
        scopeKind,
        sectionOccurrencePath: null,
      },
      scopeChunkCount: scopedPageChunks.length,
      scopePageCount: new Set(scopedPageChunks.map(candidate => candidate.pageId)).size,
    };
  }
  const sectionChunks = pageChunks.filter(candidate => (
    lookup.sectionPathKey?.every((key, index) => (
      normalizeBackstageNotionScopeKey(candidate.headingPath[index] ?? '') === key
    ))
  ));
  if (sectionChunks.length === 0) {
    return { status: 'not_found' };
  }
  const occurrencePrefixes = new Map<string, number[]>();
  for (const candidate of sectionChunks) {
    const occurrences = candidate.metadata.headingOccurrencePath as number[];
    const prefix = occurrences.slice(0, lookup.sectionPathKey.length);
    occurrencePrefixes.set(JSON.stringify(prefix), prefix);
  }
  if (occurrencePrefixes.size > 1) {
    return { status: 'ambiguous' };
  }
  return {
    status: 'resolved',
    pageTitle: representative.pageTitle,
    pagePath: [...representative.pagePath],
    sectionPath: sectionChunks[0]?.headingPath.slice(0, lookup.sectionPathKey.length) ?? [],
    selector: {
      pageId: representative.pageId,
      scopeKind: 'page',
      sectionOccurrencePath: [...occurrencePrefixes.values()][0] ?? [],
    },
    scopeChunkCount: sectionChunks.length,
    scopePageCount: 1,
  };
}

function compareText(left: string, right: string): number {
  const leftPoints = Array.from(left, value => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, value => value.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function comparePath(left: readonly string[], right: readonly string[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compareText(left[index] ?? '', right[index] ?? '');
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function snapshotChunkPage(
  active: BackstageNotionActiveSnapshot | null,
  snapshotId: string,
  selector: BackstageNotionSnapshotChunkPageSelector,
  offset: number,
  limit: number
): BackstageNotionSnapshotChunkPage {
  if (!active || snapshotId !== active.snapshot.id) {
    return { scopeChunkCount: 0, chunks: [] };
  }
  let scoped = [...active.chunks];
  if (selector.pageId !== null) {
    const anchor = active.chunks.find(item => item.pageId === selector.pageId);
    scoped = anchor
      ? scoped.filter(item => (
          selector.scopeKind === 'subtree'
            ? anchor.pagePath.every((segment, index) => (
                normalizeBackstageNotionScopeKey(item.pagePath[index] ?? '')
                  === normalizeBackstageNotionScopeKey(segment)
              ))
            : item.pageId === anchor.pageId
        ))
      : [];
  }
  if (selector.sectionOccurrencePath !== null) {
    scoped = scoped.filter(item => {
      const occurrences = item.metadata.headingOccurrencePath;
      return Array.isArray(occurrences)
        && selector.sectionOccurrencePath?.every((occurrence, index) => (
          occurrences[index] === occurrence
        ));
    });
  }
  scoped.sort((left, right) => (
    comparePath(left.pagePath, right.pagePath)
    || compareText(left.pageTitle, right.pageTitle)
    || left.ordinal - right.ordinal
    || compareText(left.id, right.id)
  ));
  return {
    scopeChunkCount: scoped.length,
    chunks: scoped.slice(offset, offset + limit).map(({
      embedding: _embedding,
      ...selected
    }) => selected),
  };
}

function harness(
  active: BackstageNotionActiveSnapshot | null = activeSnapshot(),
  options: {
    embedQuery?: (query: string) => Promise<number[]>;
    loadActiveSnapshot?: (
      universeId: string,
      maxChunks: number
    ) => Promise<BackstageNotionActiveSnapshot | null>;
    loadActiveSnapshotHeader?: (
      universeId: string
    ) => Promise<BackstageNotionActiveSnapshotHeader | null>;
    resolveSnapshotScope?: (
      universeId: string,
      snapshotId: string,
      lookup: BackstageNotionSnapshotScopeLookup
    ) => Promise<BackstageNotionSnapshotScopeResolution>;
    loadSnapshotChunkPage?: (
      universeId: string,
      snapshotId: string,
      selector: BackstageNotionSnapshotChunkPageSelector,
      knownScopeChunkCount: number | null,
      offset: number,
      limit: number
    ) => Promise<BackstageNotionSnapshotChunkPage>;
    rankSnapshotCandidates?: (
      input: RankBackstageNotionSnapshotCandidatesInput
    ) => Promise<BackstageNotionSnapshotCandidateSearch>;
    latestSyncAttempt?: BackstageNotionSyncAttemptRecord | null;
    root?: BackstageNotionAuthorityRoot | null;
  } = {}
) {
  const loadActiveSnapshot = jest.fn(
    options.loadActiveSnapshot ?? (async () => active)
  );
  const loadActiveSnapshotHeader = jest.fn(
    options.loadActiveSnapshotHeader ?? (async () => activeSnapshotHeader(active))
  );
  const resolveSnapshotScope = jest.fn(
    options.resolveSnapshotScope ?? (async (
      _universeId: string,
      snapshotId: string,
      lookup: BackstageNotionSnapshotScopeLookup
    ) => snapshotScopeResolution(active, snapshotId, lookup))
  );
  const loadSnapshotChunkPage = jest.fn(
    options.loadSnapshotChunkPage ?? (async (
      _universeId: string,
      snapshotId: string,
      selector: BackstageNotionSnapshotChunkPageSelector,
      _knownScopeChunkCount: number | null,
      offset: number,
      limit: number
    ) => snapshotChunkPage(active, snapshotId, selector, offset, limit))
  );
  const rankSnapshotCandidates = jest.fn(
    options.rankSnapshotCandidates ?? (async (
      input: RankBackstageNotionSnapshotCandidatesInput
    ): Promise<BackstageNotionSnapshotCandidateSearch> => {
      const page = snapshotChunkPage(
        active,
        input.snapshotId,
        input.selector,
        0,
        active?.snapshot.chunkCount ?? input.limit
      );
      const activeById = new Map(active?.chunks.map(candidate => [candidate.id, candidate]));
      let scoped = page.chunks.map(candidate => activeById.get(candidate.id)!);
      if (input.allowedBookingBrands && input.allowedBookingBrands.length > 0) {
        const scopePlan: BackstageNotionBookingScopePlan = {
          strategy: input.allowedBookingBrands.length > 1 ? 'cross_brand' : 'brand',
          detectedBrands: input.allowedBookingBrands,
          allowedBrands: input.allowedBookingBrands,
          explicitCrossBrand: input.allowedBookingBrands.length > 1,
          fallbackReason: null,
        };
        const classified = scoped.map(candidate => ({
          candidate,
          disposition: classifyBackstageNotionBookingCandidateScope(scopePlan, {
            pageTitle: candidate.pageTitle,
            pagePath: candidate.pagePath,
            headingPath: candidate.headingPath,
            category: typeof candidate.metadata.category === 'string'
              ? candidate.metadata.category
              : undefined,
          }).disposition,
        })).filter(item => item.disposition !== 'excluded');
        const neutralLimit = Math.min(16, Math.max(1, Math.floor(input.limit / 8)));
        scoped = [
          ...classified
            .filter(item => item.disposition === 'preferred')
            .slice(0, input.limit - neutralLimit),
          ...classified
            .filter(item => item.disposition === 'neutral')
            .slice(0, neutralLimit),
        ].map(item => item.candidate);
        return {
          scopeChunkCount: page.scopeChunkCount,
          candidatePoolCount: classified.length,
          candidates: scoped,
        };
      }
      return {
        scopeChunkCount: page.scopeChunkCount,
        candidatePoolCount: scoped.length,
        candidates: scoped.slice(0, input.limit),
      };
    })
  );
  const embedQuery = jest.fn(options.embedQuery ?? (async () => [1, 0]));
  const loadLatestSyncAttempt = jest.fn(async () => (
    options.latestSyncAttempt ?? null
  ));
  const resolveAuthorityRoot = jest.fn(() => (
    options.root === undefined ? ROOT : options.root
  ));
  const dependencies: BackstageNotionRagRetrievalDependencies = {
    repository: {
      loadActiveSnapshotHeader,
      resolveSnapshotScope,
      loadSnapshotChunkPage,
      rankSnapshotCandidates,
    },
    syncStatusRepository: { loadLatestSyncAttempt },
    embedQuery,
    resolveAuthorityRoot,
    now: () => new Date(NOW),
    maximumStalenessMs: 60 * 60 * 1_000,
  };
  return {
    dependencies,
    embedQuery,
    loadActiveSnapshot,
    loadActiveSnapshotHeader,
    resolveSnapshotScope,
    loadSnapshotChunkPage,
    rankSnapshotCandidates,
    loadLatestSyncAttempt,
    resolveAuthorityRoot,
  };
}

function retrieveAuthorized(
  dependencies: BackstageNotionRagRetrievalDependencies,
  query: BackstageNotionRagQuery = 'Book the next show'
) {
  return runWithBackstageNotionEnrichmentAuthorization(
    true,
    () => retrieveBackstageNotionRagContext(UNIVERSE_ID, query, dependencies)
  );
}

function retrieveBookingAuthorized(
  dependencies: BackstageNotionRagRetrievalDependencies,
  query: string
) {
  return runWithBackstageNotionEnrichmentAuthorization(
    true,
    () => retrieveBackstageNotionBookingRagContext(
      UNIVERSE_ID,
      query,
      dependencies
    )
  );
}

function latestRetrievedLog(): Record<string, unknown> {
  const call = jest.mocked(logger.info).mock.calls
    .filter(([event]) => event === 'backstage.notion_rag.retrieved')
    .at(-1);
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

function decodeTestCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function resignTestCursor(
  decoded: Record<string, unknown>,
  active: BackstageNotionActiveSnapshot
): string {
  const payload = {
    v: decoded.v,
    snapshotId: decoded.snapshotId,
    requestBinding: decoded.requestBinding,
    scopeKind: decoded.scopeKind,
    scopeChunkCount: decoded.scopeChunkCount,
    scopePageCount: decoded.scopePageCount,
    offset: decoded.offset,
  };
  const signingKey = sha256(JSON.stringify({
    format: 'backstage-notion-rag-cursor-key-v3',
    universeId: UNIVERSE_ID,
    snapshotId: active.snapshot.id,
    manifestHash: active.snapshot.manifestHash,
    rootPageId: ROOT_PAGE_ID,
  }));
  const mac = createHmac('sha256', signingKey)
    .update(JSON.stringify(payload), 'utf8')
    .digest('base64url');
  return Buffer.from(JSON.stringify({ ...payload, mac }), 'utf8').toString('base64url');
}

describe('Backstage Notion authority RAG retrieval', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetOpenAIAdapter();
  });

  it('requires trusted request provenance before authority or database work', async () => {
    const state = harness();

    await expect(retrieveBackstageNotionRagContext(
      UNIVERSE_ID,
      'Private booking request',
      state.dependencies
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
      httpStatus: 503,
      retryable: true,
    });

    expect(state.resolveAuthorityRoot).not.toHaveBeenCalled();
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.embedQuery).not.toHaveBeenCalled();
  });

  it('requires an exact configured authority root before database or embedding work', async () => {
    for (const root of [
      null,
      { ...ROOT, universeId: 'another-universe' },
    ]) {
      const state = harness(activeSnapshot(), { root });

      await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
        BackstageNotionIndexUnavailableError
      );
      expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
      expect(state.embedQuery).not.toHaveBeenCalled();
    }
  });

  it('rejects blank and oversized queries before database or embedding work', async () => {
    for (const query of [
      '   ',
      'x'.repeat(BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS + 1),
      `${' '.repeat(BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS)}x`,
    ]) {
      const state = harness();
      await expect(retrieveAuthorized(state.dependencies, query)).rejects.toBeInstanceOf(
        BackstageNotionIndexUnavailableError
      );
      expect(state.resolveAuthorityRoot).not.toHaveBeenCalled();
      expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
      expect(state.embedQuery).not.toHaveBeenCalled();
    }
  });

  it('admits a readable fresh snapshot confirmed by the latest complete sync', async () => {
    const active = activeSnapshot();
    active.verifiedAt = new Date(NOW.getTime() - 60 * 1_000);
    const state = harness(active, {
      latestSyncAttempt: latestSyncAttempt('unchanged'),
    });

    await expect(retrieveAuthorized(state.dependencies)).resolves.toMatchObject({
      snapshotId: SNAPSHOT_ID,
      snapshotStatus: 'current_complete',
      activeSnapshotVerifiedAt: active.verifiedAt,
      activeSnapshotChunkCount: active.snapshot.chunkCount,
      latestSyncOutcome: 'unchanged',
      latestSyncFailurePhase: null,
      latestSyncFailureReason: null,
    });

    expect(state.loadLatestSyncAttempt).toHaveBeenCalledWith(UNIVERSE_ID);
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
    const statusLog = jest.mocked(logger.info).mock.calls.find(([event]) => (
      event === 'backstage.notion_rag.snapshot_status'
    ));
    expect(statusLog?.[1]).toMatchObject({
      snapshotStatus: 'current_complete',
      activeSnapshotReadable: true,
      latestSyncOutcome: 'unchanged',
      freshnessSatisfied: true,
      newerRefreshIncomplete: false,
    });
  });

  it('keeps reads pinned to the prior active snapshot while a candidate is building', async () => {
    const active = activeSnapshot();
    active.verifiedAt = new Date(NOW.getTime() - 3 * 60 * 1_000);
    const state = harness(active, {
      latestSyncAttempt: latestSyncAttempt('running'),
    });

    await expect(retrieveAuthorized(state.dependencies)).resolves.toMatchObject({
      snapshotId: SNAPSHOT_ID,
      snapshotStatus: 'last_known_good',
      activeSnapshotVerifiedAt: active.verifiedAt,
      activeSnapshotChunkCount: active.snapshot.chunkCount,
      latestSyncOutcome: 'running',
      latestSyncFailurePhase: null,
      latestSyncFailureReason: null,
    });

    expect(state.loadLatestSyncAttempt).toHaveBeenCalledWith(UNIVERSE_ID);
    expect(state.rankSnapshotCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        universeId: UNIVERSE_ID,
        snapshotId: SNAPSHOT_ID,
      })
    );
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
    const statusLog = jest.mocked(logger.info).mock.calls.find(([event]) => (
      event === 'backstage.notion_rag.snapshot_status'
    ));
    expect(statusLog?.[1]).toMatchObject({
      snapshotStatus: 'last_known_good',
      latestSyncOutcome: 'running',
      freshnessSatisfied: true,
      newerRefreshIncomplete: true,
    });
  });

  it('keeps protected booking generation fail closed while latest state is incomplete', async () => {
    const active = activeSnapshot();
    active.verifiedAt = new Date(NOW.getTime() - 3 * 60 * 1_000);
    const state = harness(active, {
      latestSyncAttempt: latestSyncAttempt('running'),
    });

    await expect(retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw while refresh is incomplete'
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
      httpStatus: 503,
      retryable: true,
    });

    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.rankSnapshotCandidates).not.toHaveBeenCalled();
  });

  it('returns explicit last_known_good metadata for continuity reads after a newer failed refresh', async () => {
    const active = activeSnapshot();
    active.verifiedAt = new Date(NOW.getTime() - 10 * 60 * 1_000);
    const priorVerifiedAt = active.verifiedAt.getTime();
    const priorSnapshot = { ...active.snapshot };
    const state = harness(active, {
      latestSyncAttempt: latestSyncAttempt('failed'),
    });

    await expect(retrieveAuthorized(state.dependencies)).resolves.toMatchObject({
      snapshotId: SNAPSHOT_ID,
      snapshotStatus: 'last_known_good',
      activeSnapshotVerifiedAt: active.verifiedAt,
      activeSnapshotChunkCount: active.snapshot.chunkCount,
      latestSyncOutcome: 'failed',
      latestSyncFailurePhase: 'chunking',
      latestSyncFailureReason: 'chunk_limit_reached',
    });

    expect(active.verifiedAt.getTime()).toBe(priorVerifiedAt);
    expect(active.snapshot).toEqual(priorSnapshot);
    expect(state.loadLatestSyncAttempt).toHaveBeenCalledWith(UNIVERSE_ID);
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
    expect(state.rankSnapshotCandidates).toHaveBeenCalledTimes(1);
    const statusCalls = jest.mocked(logger.info).mock.calls.filter(([event]) => (
      event === 'backstage.notion_rag.snapshot_status'
    ));
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.[1]).toMatchObject({
      snapshotStatus: 'last_known_good',
      activeSnapshotReadable: true,
      activeSnapshotChunkCount: active.snapshot.chunkCount,
      latestSyncOutcome: 'failed',
      latestSyncFailurePhase: 'chunking',
      latestSyncFailureReason: 'chunk_limit_reached',
      freshnessSatisfied: true,
      newerRefreshIncomplete: true,
    });
    expect(JSON.stringify(statusCalls[0]?.[1])).not.toContain(SNAPSHOT_ID);
    expect(JSON.stringify(statusCalls[0]?.[1])).not.toContain(
      '33333333-3333-4333-8333-333333333333'
    );
    expect(jest.mocked(logger.info).mock.calls.some(([event]) => (
      event === 'backstage.notion_rag.retrieved'
    ))).toBe(true);
  });

  it('keeps protected booking generation fail closed after a failed refresh', async () => {
    const active = activeSnapshot();
    active.verifiedAt = new Date(NOW.getTime() - 10 * 60 * 1_000);
    const state = harness(active, {
      latestSyncAttempt: latestSyncAttempt('failed'),
    });

    await expect(retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw after the failed refresh'
    )).rejects.toMatchObject({
      code: BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
      httpStatus: 503,
      retryable: true,
    });

    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.rankSnapshotCandidates).not.toHaveBeenCalled();
  });

  it('does not reflect malformed latest-sync state into availability telemetry', async () => {
    const privateMarker = 'PRIVATE-NOTION-CONTENT-MUST-NOT-LOG';
    const malformedAttempt = {
      ...latestSyncAttempt('failed'),
      failureReason: privateMarker,
    } as unknown as BackstageNotionSyncAttemptRecord;
    const state = harness(activeSnapshot(), {
      latestSyncAttempt: malformedAttempt,
    });

    await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );

    expect(state.embedQuery).not.toHaveBeenCalled();
    const statusLog = jest.mocked(logger.info).mock.calls.find(([event]) => (
      event === 'backstage.notion_rag.snapshot_status'
    ));
    expect(statusLog?.[1]).toMatchObject({
      snapshotStatus: 'unavailable',
      latestSyncOutcome: 'failed',
      latestSyncFailurePhase: 'chunking',
      latestSyncFailureReason: null,
    });
    expect(JSON.stringify(statusLog?.[1])).not.toContain(privateMarker);
  });

  it.each([
    ['missing', () => null],
    ['wrong authority', () => ({ ...activeSnapshot(), authority: 'postgres' })],
    ['wrong universe', () => ({
      ...activeSnapshot(),
      snapshot: { ...activeSnapshot().snapshot, universeId: 'another-universe' },
    })],
    ['wrong root', () => ({
      ...activeSnapshot(),
      snapshot: { ...activeSnapshot().snapshot, rootPageId: pageId(99) },
    })],
    ['wrong model', () => ({
      ...activeSnapshot(),
      snapshot: { ...activeSnapshot().snapshot, embeddingModel: 'other-model' },
    })],
    ['stale', () => ({
      ...activeSnapshot(),
      verifiedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
    })],
    ['future', () => ({
      ...activeSnapshot(),
      verifiedAt: new Date(NOW.getTime() + 6 * 60 * 1_000),
    })],
    ['predates snapshot', () => ({
      ...activeSnapshot(),
      verifiedAt: new Date('2026-08-19T15:44:59.999Z'),
    })],
  ])('fails closed for a %s active snapshot header', async (_label, build) => {
    const state = harness(build() as BackstageNotionActiveSnapshot | null);

    await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledWith(UNIVERSE_ID);
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.rankSnapshotCandidates).not.toHaveBeenCalled();
    expect(state.embedQuery).not.toHaveBeenCalled();
  });

  it('rejects corrupt chunk identity, model, and vector data from the bounded candidate search', async () => {
    const corruptions: Array<(value: BackstageNotionActiveChunk) => void> = [
      value => { value.id = 'a'.repeat(64); },
      value => { value.contentHash = 'b'.repeat(64); },
      value => { value.embeddingModel = 'other-model'; },
      value => { value.embedding = [Number.NaN, 1]; },
      value => { value.embedding = [0, 0]; },
      value => { value.codePoints += 1; },
    ];

    for (const corrupt of corruptions) {
      const candidate = chunk();
      corrupt(candidate);
      const state = harness(activeSnapshot([candidate]));
      await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
        BackstageNotionIndexUnavailableError
      );
      expect(state.embedQuery).toHaveBeenCalledTimes(1);
      expect(state.rankSnapshotCandidates).toHaveBeenCalledTimes(1);
      expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    }
    expect(jest.mocked(logger.info).mock.calls.some(([, metadata]) => (
      (metadata as { snapshotStatus?: unknown } | undefined)?.snapshotStatus
        === 'current_complete'
    ))).toBe(false);
  });

  it('rejects inconsistent metadata for chunks that claim the same page identity', async () => {
    const first = chunk({
      pageIndex: 1,
      ordinal: 0,
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
    });
    const conflicting = chunk({
      pageIndex: 1,
      ordinal: 1,
      pageTitle: 'Raw Archive',
      pagePath: ['WWE Universe Mode', 'Archive', 'Raw Archive'],
    });
    const state = harness(activeSnapshot([first, conflicting]));

    await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
  });

  it('fails closed when sparse indexed paths cannot satisfy an exact scope', async () => {
    const sparsePagePath = new Array<string>(3);
    sparsePagePath[0] = 'WWE Universe Mode';
    sparsePagePath[2] = 'Monday Night Raw';
    const pageCandidate = chunk({
      pageTitle: 'Monday Night Raw',
      pagePath: sparsePagePath,
    });
    const pageState = harness(activeSnapshot([pageCandidate]));

    await expect(retrieveAuthorized(pageState.dependencies, {
      query: 'read the page',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: ['WWE Universe Mode', 'Brands', 'Monday Night Raw'],
      },
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

    const sparseHeadingPath = new Array<string>(1);
    const sectionCandidate = chunk({
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
      headingPath: sparseHeadingPath,
      headingOccurrencePath: [1],
    });
    const sectionState = harness(activeSnapshot([sectionCandidate]));
    await expect(retrieveAuthorized(sectionState.dependencies, {
      query: 'read the section',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        sectionPath: ['Roster'],
      },
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
  });

  it.each([
    ['dimension mismatch', [1]],
    ['non-finite query vector', [Number.POSITIVE_INFINITY, 0]],
    ['zero query vector', [0, 0]],
  ])('fails closed for %s', async (_label, embedding) => {
    const state = harness(activeSnapshot(), {
      embedQuery: async () => embedding,
    });

    await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched corpus dimensions and non-finite similarity scores', async () => {
    const mismatchedState = harness(activeSnapshot([
      chunk({ pageIndex: 1, embedding: [1, 0] }),
      chunk({ pageIndex: 2, embedding: [1, 0, 0] }),
    ]));
    await expect(retrieveAuthorized(mismatchedState.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(mismatchedState.embedQuery).toHaveBeenCalledTimes(1);

    const overflowState = harness(activeSnapshot([
      chunk({ embedding: [Number.MAX_VALUE, Number.MAX_VALUE] }),
    ]), {
      embedQuery: async () => [Number.MAX_VALUE, Number.MAX_VALUE],
    });
    await expect(retrieveAuthorized(overflowState.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(overflowState.embedQuery).toHaveBeenCalledTimes(1);
  });

  it('uses the default embedding adapter when no dependency override is supplied', async () => {
    const adapter = getOpenAIAdapter({ apiKey: 'test-api-key' });
    const createEmbedding = jest.spyOn(adapter.embeddings, 'create').mockResolvedValue({
      data: [{ embedding: [1, 0], index: 0, object: 'embedding' }],
      model: DEFAULT_OPENAI_EMBEDDING_MODEL,
      object: 'list',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
    const state = harness();
    delete state.dependencies.embedQuery;

    const result = await retrieveAuthorized(state.dependencies, 'default embedding query');

    expect(result.chunkCount).toBe(1);
    expect(createEmbedding).toHaveBeenCalledWith({
      input: 'default embedding query',
      model: DEFAULT_OPENAI_EMBEDDING_MODEL,
    });
  });

  it.each([
    [
      'repository',
      {
        rankSnapshotCandidates: async () => {
          throw new Error('postgres://private-user:private-password@internal/index');
        },
      },
    ],
    [
      'embedding provider',
      {
        embedQuery: async () => {
          throw new Error('provider echoed PRIVATE-KAYFABE-CONTINUITY');
        },
      },
    ],
  ] as const)('normalizes a %s rejection to the bounded retryable outage', async (
    _label,
    options
  ) => {
    const state = harness(activeSnapshot(), options);

    await expect(retrieveAuthorized(state.dependencies)).rejects.toMatchObject({
      name: 'BackstageNotionIndexUnavailableError',
      code: BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE,
      message: 'The authoritative Backstage Notion index is temporarily unavailable.',
      httpStatus: 503,
      retryable: true,
    });
  });

  it('preserves an ambient abort instead of converting it to an index outage', async () => {
    const abort = new DOMException('The request was aborted.', 'AbortError');
    const state = harness(activeSnapshot(), {
      embedQuery: async () => {
        throw abort;
      },
    });

    await expect(retrieveAuthorized(state.dependencies)).rejects.toBe(abort);
  });

  it('combines cosine and lexical relevance with deterministic tie-breaking', async () => {
    const neutralA = chunk({
      pageIndex: 1,
      content: 'General weekly continuity.',
      pageTitle: 'Alpha notes',
    });
    const lexicalWinner = chunk({
      pageIndex: 2,
      content: 'General weekly continuity for this section.',
      pageTitle: 'Bravo notes',
      headingPath: ['Lyra rivalry'],
    });
    const neutralC = chunk({
      pageIndex: 3,
      content: 'General weekly continuity elsewhere.',
      pageTitle: 'Charlie notes',
    });
    const state = harness(activeSnapshot([neutralC, neutralA, lexicalWinner]));

    const result = await retrieveAuthorized(state.dependencies, 'Lyra rivalry');

    expect(result.citations.map(citation => citation.pageId)).toEqual([
      lexicalWinner.pageId,
      neutralA.pageId,
      neutralC.pageId,
    ]);
    expect(state.embedQuery).toHaveBeenCalledWith('Lyra rivalry');
  });

  it('ranks a 4,096-chunk snapshot through a bounded pinned candidate search', async () => {
    const chunks = Array.from(
      { length: BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS },
      (_unused, index) => chunk({
        pageIndex: index + 1,
        content: `Bounded continuity ${index}.`,
        embedding: [1, index % 2],
      })
    );
    const state = harness(activeSnapshot(chunks));

    const result = await retrieveAuthorized(state.dependencies, 'bounded continuity');

    expect(result.coverage).toMatchObject({
      status: 'sampled',
      exhaustive: false,
      scopeChunks: BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
    });
    expect(result.citations.length).toBeLessThanOrEqual(12);
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledTimes(1);
    expect(state.rankSnapshotCandidates).toHaveBeenCalledWith(expect.objectContaining({
      universeId: UNIVERSE_ID,
      snapshotId: SNAPSHOT_ID,
      expectedScopeChunkCount: BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
      limit: 128,
      selector: {
        pageId: null,
        scopeKind: 'all',
        sectionOccurrencePath: null,
      },
    }));
    const ranked = await state.rankSnapshotCandidates.mock.results[0]?.value;
    expect(ranked?.candidates).toHaveLength(128);
  });

  it('fails safely for missing or ambiguous exact page scopes', async () => {
    const rawA = chunk({
      pageIndex: 1,
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Brands', 'Monday Night Raw'],
    });
    const rawB = chunk({
      pageIndex: 2,
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Archive', 'Monday Night Raw'],
    });
    const active = activeSnapshot([rawA, rawB]);
    const ambiguousState = harness(active, {
      resolveSnapshotScope: async () => ({ status: 'ambiguous' }),
    });

    await expect(retrieveAuthorized(ambiguousState.dependencies, {
      query: 'current champions',
      retrievalScope: { pageTitle: 'Monday Night Raw' },
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
      reason: 'ambiguous',
      retryable: false,
    });
    const missingState = harness(active, {
      resolveSnapshotScope: async () => ({ status: 'not_found' }),
    });
    await expect(retrieveAuthorized(missingState.dependencies, {
      query: 'current champions',
      retrievalScope: { pageTitle: 'NXT' },
    })).rejects.toBeInstanceOf(BackstageNotionScopeResolutionError);
    await expect(retrieveAuthorized(missingState.dependencies, {
      query: 'current champions',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawA.pagePath,
        sectionPath: ['Missing section'],
      },
    })).rejects.toMatchObject({ reason: 'not_found' });
    expect(ambiguousState.embedQuery).not.toHaveBeenCalled();
    expect(missingState.embedQuery).not.toHaveBeenCalled();

    const state = harness(active);
    const resolved = await retrieveAuthorized(state.dependencies, {
      query: 'current champions',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: ['WWE Universe Mode', 'Archive', 'Monday Night Raw'],
      },
    });
    expect(resolved.citations.map(citation => citation.pageId)).toEqual([
      rawB.pageId,
    ]);
    expect(resolved.resolvedScope?.pagePath).toEqual(rawB.pagePath);
  });

  it('filters exact page and section scope before ranking and relaxes page diversity', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const championships = Array.from({ length: 6 }, (_unused, ordinal) => chunk({
      pageIndex: 1,
      ordinal,
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      headingPath: ordinal < 5
        ? ['Championships', ordinal === 0 ? 'World' : 'Current champions']
        : ['Recent Results'],
      headingOccurrencePath: ordinal < 5 ? [1, 1] : [2],
      content: `Raw continuity ${ordinal}.`,
    }));
    const adjacent = chunk({
      pageIndex: 2,
      pageTitle: 'SmackDown',
      pagePath: ['WWE Universe Mode', 'Brands', 'SmackDown'],
      headingPath: ['Championships'],
      content: 'SmackDown continuity.',
    });
    const state = harness(activeSnapshot([...championships, adjacent]));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'list every current champion',
      retrievalScope: {
        pageTitle: '  monday   night RAW ',
        pagePath: ['WWE Universe Mode', 'Brands', 'Monday Night Raw'],
        sectionPath: ['championships'],
      },
    });

    expect(result.citations).toHaveLength(5);
    expect(result.citations).toHaveLength(
      BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE + 2
    );
    expect(new Set(result.citations.map(citation => citation.pageId))).toEqual(
      new Set([pageId(1)])
    );
    expect(result.citations.every(citation => (
      citation.headingPath[0] === 'Championships'
    ))).toBe(true);
    expect(result.resolvedScope).toEqual({
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      sectionPath: ['Championships'],
    });
    expect(result.coverage).toMatchObject({
      status: 'sampled',
      scopeChunks: 5,
      selectedChunks: 5,
      omittedChunks: 0,
      promptTruncated: false,
      exhaustive: false,
      hasMore: false,
    });
    expect(result.prompt).toContain('heading_path: Championships /');
  });

  it('rejects duplicate exact section occurrences without rejecting their unique parent', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const chunks = [
      chunk({
        pageIndex: 1,
        ordinal: 0,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        headingPath: ['Championships'],
        headingOccurrencePath: [1],
        content: '# Championships',
      }),
      chunk({
        pageIndex: 1,
        ordinal: 1,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        headingPath: ['Championships', 'Current champions'],
        headingOccurrencePath: [1, 2],
        content: '## Current champions\nCM Punk.',
      }),
      chunk({
        pageIndex: 1,
        ordinal: 2,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        headingPath: ['Championships', 'Current champions'],
        headingOccurrencePath: [1, 3],
        content: '## Current champions\nStephanie Vaquer.',
      }),
    ];
    const active = activeSnapshot(chunks);
    const state = harness(active, {
      resolveSnapshotScope: async (_universeId, snapshotId, lookup) => (
        lookup.sectionPathKey?.length === 2
          ? { status: 'ambiguous' }
          : snapshotScopeResolution(active, snapshotId, lookup)
      ),
    });

    const parent = await retrieveAuthorized(state.dependencies, {
      query: 'read every championship fact',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        sectionPath: ['Championships'],
      },
      retrievalMode: 'complete_scope',
    });
    expect(parent.citations).toHaveLength(3);

    await expect(retrieveAuthorized(state.dependencies, {
      query: 'read current champions',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        sectionPath: ['Championships', 'Current champions'],
      },
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_SCOPE_UNRESOLVED',
      reason: 'ambiguous',
      retryable: false,
    });
    expect(state.embedQuery).not.toHaveBeenCalled();
  });

  it('reads a complete page scope without requiring page-path or section selectors', async () => {
    const raw = chunk({
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Brands', 'Monday Night Raw'],
      content: 'Raw continuity.',
    });
    const state = harness(activeSnapshot([raw]));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read all Raw continuity',
      retrievalScope: { pageTitle: 'Monday Night Raw' },
      retrievalMode: 'complete_scope',
    });

    expect(result.resolvedScope).toEqual({
      pageTitle: raw.pageTitle,
      pagePath: raw.pagePath,
    });
    expect(result.coverage).toMatchObject({
      status: 'complete',
      exhaustive: true,
      scopeChunks: 1,
      selectedChunks: 1,
    });
    expect(state.resolveSnapshotScope).toHaveBeenCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey(raw.pageTitle),
        pagePathKey: null,
        sectionPathKey: null,
        scopeKind: 'page',
      }
    );
  });

  it('retrieves and diversifies relevant chunks across an exact page subtree', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const subtreeChunks = [
      ...Array.from({ length: 5 }, (_unused, ordinal) => chunk({
        pageIndex: 1,
        ordinal,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        content: `Raw overview ${ordinal}.`,
      })),
      ...Array.from({ length: 5 }, (_unused, ordinal) => chunk({
        pageIndex: 2,
        ordinal,
        pageTitle: 'Raw Roster',
        pagePath: [...rawPath, 'Raw Roster'],
        content: `Raw roster ${ordinal}.`,
      })),
    ];
    const sibling = chunk({
      pageIndex: 3,
      pageTitle: 'SmackDown',
      pagePath: ['WWE Universe Mode', 'Brands', 'SmackDown'],
      content: 'SmackDown continuity.',
    });
    const state = harness(activeSnapshot([...subtreeChunks, sibling]));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read the Raw brand',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        scopeKind: 'subtree',
      },
    });

    expect(result.resolvedScope).toEqual({
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      scopeKind: 'subtree',
    });
    expect(result.citations).toHaveLength(6);
    expect(result.citations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: sibling.pageId }),
    ]));
    for (const selectedPageId of new Set(result.citations.map(item => item.pageId))) {
      expect(result.citations.filter(item => item.pageId === selectedPageId)).toHaveLength(3);
    }
    expect(result.coverage).toMatchObject({
      scopeChunks: 10,
      selectedChunks: 6,
      omittedChunks: 4,
      scopePages: 2,
      selectedPages: 2,
      omittedPages: 0,
    });
    expect(state.resolveSnapshotScope).toHaveBeenCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      expect.objectContaining({ scopeKind: 'subtree' })
    );
    expect(logger.info).toHaveBeenCalledWith(
      'backstage.notion_rag.retrieved',
      expect.objectContaining({
        scopeKind: 'subtree',
        scopePages: 2,
        selectedPages: 2,
        omittedPages: 0,
      })
    );
  });

  it('accepts a blank navigation page as a relevant subtree root', async () => {
    const anchorPageId = pageId(9);
    const anchorPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const descendants = [
      chunk({
        pageIndex: 10,
        pageTitle: 'Raw Roster',
        pagePath: [...anchorPath, 'Raw Roster'],
        content: 'Raw roster continuity.',
      }),
      chunk({
        pageIndex: 11,
        pageTitle: 'Raw Stories',
        pagePath: [...anchorPath, 'Raw Stories'],
        content: 'Raw storyline continuity.',
      }),
    ];
    const active = activeSnapshot(descendants);
    active.snapshot.pageCount = 3;
    const state = harness(active, {
      resolveSnapshotScope: async () => ({
        status: 'resolved',
        pageTitle: 'Monday Night Raw',
        pagePath: anchorPath,
        sectionPath: null,
        selector: {
          pageId: anchorPageId,
          scopeKind: 'subtree',
          sectionOccurrencePath: null,
        },
        scopeChunkCount: 2,
        scopePageCount: 2,
      }),
      rankSnapshotCandidates: async () => ({
        scopeChunkCount: 2,
        candidatePoolCount: 2,
        candidates: descendants,
      }),
    });

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read Raw continuity',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: anchorPath,
        scopeKind: 'subtree',
      },
    });

    expect(result.citations.map(item => item.pageId).sort()).toEqual(
      descendants.map(item => item.pageId).sort()
    );
    expect(result.coverage).toMatchObject({
      scopePages: 2,
      selectedPages: 2,
      omittedPages: 0,
    });
  });

  it.each([
    ['chunk count', 2, 2],
    ['page count', 3, 1],
  ] as const)(
    'fails closed when relevant subtree %s disagrees with the active projection',
    async (_case, scopeChunkCount, scopePageCount) => {
      const anchorPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
      const rawChunks = [
        chunk({
          pageIndex: 1,
          ordinal: 0,
          pageTitle: 'Monday Night Raw',
          pagePath: anchorPath,
          content: 'Raw overview.',
        }),
        chunk({
          pageIndex: 1,
          ordinal: 1,
          pageTitle: 'Monday Night Raw',
          pagePath: anchorPath,
          content: 'Raw overview two.',
        }),
        chunk({
          pageIndex: 2,
          pageTitle: 'Raw Roster',
          pagePath: [...anchorPath, 'Raw Roster'],
          content: 'Raw roster continuity.',
        }),
      ];
      const active = activeSnapshot(rawChunks);
      const state = harness(active, {
        resolveSnapshotScope: async () => ({
          status: 'resolved',
          pageTitle: 'Monday Night Raw',
          pagePath: anchorPath,
          sectionPath: null,
          selector: {
            pageId: rawChunks[0]!.pageId,
            scopeKind: 'subtree',
            sectionOccurrencePath: null,
          },
          scopeChunkCount,
          scopePageCount,
        }),
      });

      await expect(retrieveAuthorized(state.dependencies, {
        query: 'read Raw continuity',
        retrievalScope: {
          pageTitle: 'Monday Night Raw',
          pagePath: anchorPath,
          scopeKind: 'subtree',
        },
      })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

      expect(state.embedQuery).toHaveBeenCalledTimes(1);
    }
  );

  it('paginates complete subtrees with a re-resolved v3 cursor and no internal selector', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const rawChunks = [
      chunk({
        pageIndex: 1,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        content: 'Raw overview.',
      }),
      ...Array.from({ length: 6 }, (_unused, ordinal) => chunk({
        pageIndex: 2,
        ordinal,
        pageTitle: 'Raw Roster',
        pagePath: [...rawPath, 'Raw Roster'],
        content: `Raw roster ${ordinal}.`,
      })),
      ...Array.from({ length: 6 }, (_unused, ordinal) => chunk({
        pageIndex: 3,
        ordinal,
        pageTitle: 'Raw Stories',
        pagePath: [...rawPath, 'Raw Stories'],
        content: `Raw story ${ordinal}.`,
      })),
    ];
    const state = harness(activeSnapshot(rawChunks));
    const request = {
      query: 'read all Raw continuity',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        scopeKind: 'subtree' as const,
      },
      retrievalMode: 'complete_scope' as const,
    };

    const first = await retrieveAuthorized(state.dependencies, request);
    const decoded = decodeTestCursor(first.nextCursor ?? '');
    expect(decoded).toMatchObject({
      v: 3,
      scopeKind: 'subtree',
      scopeChunkCount: 13,
      scopePageCount: 3,
      offset: 12,
    });
    expect(decoded).not.toHaveProperty('scopeSelector');
    expect(JSON.stringify(decoded)).not.toContain(rawChunks[0]?.pageId);
    expect(first.coverage).toMatchObject({
      scopePages: 3,
      selectedPages: 3,
      omittedPages: 0,
      hasMore: true,
    });

    const second = await retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.citations).toHaveLength(1);
    expect(second.coverage).toMatchObject({
      scopePages: 3,
      selectedPages: 1,
      omittedPages: 2,
      hasMore: false,
    });
    expect(state.resolveSnapshotScope).toHaveBeenCalledTimes(2);
    expect(state.loadSnapshotChunkPage).toHaveBeenLastCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: rawChunks[0]?.pageId,
        scopeKind: 'subtree',
        sectionOccurrencePath: null,
      },
      13,
      12,
      12
    );
  });

  it('rejects a subtree continuation when re-resolved coverage counts drift', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const rawChunks = Array.from({ length: 13 }, (_unused, ordinal) => chunk({
      pageIndex: 1,
      ordinal,
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      content: `Raw continuity ${ordinal}.`,
    }));
    const active = activeSnapshot(rawChunks);
    let resolutionCalls = 0;
    const state = harness(active, {
      resolveSnapshotScope: async (_universeId, snapshotId, lookup) => {
        const resolution = snapshotScopeResolution(active, snapshotId, lookup);
        resolutionCalls += 1;
        return resolution.status === 'resolved' && resolutionCalls > 1
          ? { ...resolution, scopeChunkCount: resolution.scopeChunkCount - 1 }
          : resolution;
      },
    });
    const request = {
      query: 'read all Raw continuity',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        scopeKind: 'subtree' as const,
      },
      retrievalMode: 'complete_scope' as const,
    };
    const first = await retrieveAuthorized(state.dependencies, request);

    await expect(retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(state.resolveSnapshotScope).toHaveBeenCalledTimes(2);
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_found', BackstageNotionScopeResolutionError],
    ['ambiguous', BackstageNotionScopeResolutionError],
    ['invalid', BackstageNotionIndexUnavailableError],
  ] as const)('fails closed for a %s complete-scope resolution', async (
    status,
    expectedError
  ) => {
    const state = harness(activeSnapshot(), {
      resolveSnapshotScope: async () => ({ status }),
    });

    await expect(retrieveAuthorized(state.dependencies, {
      query: 'read the page',
      retrievalScope: { pageTitle: 'Universe page 1' },
      retrievalMode: 'complete_scope',
    })).rejects.toBeInstanceOf(expectedError);
    expect(state.loadSnapshotChunkPage).not.toHaveBeenCalled();
  });

  it('rejects malformed resolved scope selectors and page-only section metadata', async () => {
    const active = activeSnapshot();
    const malformedResolutions: BackstageNotionSnapshotScopeResolution[] = [
      {
        status: 'resolved',
        pageTitle: 'Universe page 1',
        pagePath: ['WWE Universe Mode', 'Universe page 1'],
        sectionPath: null,
        selector: {
          pageId: undefined as unknown as string,
          scopeKind: 'page',
          sectionOccurrencePath: null,
        },
        scopeChunkCount: 1,
        scopePageCount: 1,
      },
      {
        status: 'resolved',
        pageTitle: 'Universe page 1',
        pagePath: ['WWE Universe Mode', 'Universe page 1'],
        sectionPath: ['Roster'],
        selector: {
          pageId: active.chunks[0]?.pageId ?? '',
          scopeKind: 'page',
          sectionOccurrencePath: [1],
        },
        scopeChunkCount: 1,
        scopePageCount: 1,
      },
    ];

    for (const resolution of malformedResolutions) {
      const state = harness(active, {
        resolveSnapshotScope: async () => resolution,
      });
      await expect(retrieveAuthorized(state.dependencies, {
        query: 'read the page',
        retrievalScope: { pageTitle: 'Universe page 1' },
        retrievalMode: 'complete_scope',
      })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
      expect(state.loadSnapshotChunkPage).not.toHaveBeenCalled();
    }
  });

  it('fails closed when resolved subtree page counts exceed chunk counts', async () => {
    const active = activeSnapshot();
    active.snapshot.pageCount = 2;
    const state = harness(active, {
      resolveSnapshotScope: async () => ({
        status: 'resolved',
        pageTitle: 'Universe page 1',
        pagePath: ['WWE Universe Mode', 'Universe page 1'],
        sectionPath: null,
        selector: {
          pageId: active.chunks[0]?.pageId ?? '',
          scopeKind: 'subtree',
          sectionOccurrencePath: null,
        },
        scopeChunkCount: 1,
        scopePageCount: 2,
      }),
    });

    await expect(retrieveAuthorized(state.dependencies, {
      query: 'read the subtree',
      retrievalScope: {
        pageTitle: 'Universe page 1',
        scopeKind: 'subtree',
      },
      retrievalMode: 'complete_scope',
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(state.loadSnapshotChunkPage).not.toHaveBeenCalled();
  });

  it('fails closed when a complete subtree page emits more pages than resolved', async () => {
    const anchorPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const active = activeSnapshot([
      chunk({
        pageIndex: 1,
        pageTitle: 'Monday Night Raw',
        pagePath: anchorPath,
        content: 'Raw overview.',
      }),
      chunk({
        pageIndex: 2,
        pageTitle: 'Raw Roster',
        pagePath: [...anchorPath, 'Raw Roster'],
        content: 'Raw roster continuity.',
      }),
    ]);
    const state = harness(active, {
      resolveSnapshotScope: async () => ({
        status: 'resolved',
        pageTitle: 'Monday Night Raw',
        pagePath: anchorPath,
        sectionPath: null,
        selector: {
          pageId: active.chunks[0]?.pageId ?? '',
          scopeKind: 'subtree',
          sectionOccurrencePath: null,
        },
        scopeChunkCount: 2,
        scopePageCount: 1,
      }),
    });

    await expect(retrieveAuthorized(state.dependencies, {
      query: 'read the subtree',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: anchorPath,
        scopeKind: 'subtree',
      },
      retrievalMode: 'complete_scope',
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a complete subtree page contains a sibling path', async () => {
    const anchorPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const anchor = chunk({
      pageIndex: 1,
      pageTitle: 'Monday Night Raw',
      pagePath: anchorPath,
      content: 'Raw overview.',
    });
    const sibling = chunk({
      pageIndex: 2,
      pageTitle: 'SmackDown',
      pagePath: ['WWE Universe Mode', 'Brands', 'SmackDown'],
      content: 'SmackDown continuity.',
    });
    const { embedding: _embedding, ...storedSibling } = sibling;
    const active = activeSnapshot([anchor]);
    const state = harness(active, {
      resolveSnapshotScope: async () => ({
        status: 'resolved',
        pageTitle: anchor.pageTitle,
        pagePath: anchorPath,
        sectionPath: null,
        selector: {
          pageId: anchor.pageId,
          scopeKind: 'subtree',
          sectionOccurrencePath: null,
        },
        scopeChunkCount: 1,
        scopePageCount: 1,
      }),
      loadSnapshotChunkPage: async () => ({
        scopeChunkCount: 1,
        chunks: [storedSibling],
      }),
    });

    await expect(retrieveAuthorized(state.dependencies, {
      query: 'read the Raw subtree',
      retrievalScope: {
        pageTitle: anchor.pageTitle,
        pagePath: anchorPath,
        scopeKind: 'subtree',
      },
      retrievalMode: 'complete_scope',
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

    expect(state.loadSnapshotChunkPage).toHaveBeenCalledTimes(1);
    expect(state.embedQuery).not.toHaveBeenCalled();
  });

  it('paginates complete exact scopes with a snapshot-and-request-bound cursor', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const rawChunks = Array.from({ length: 15 }, (_unused, ordinal) => chunk({
      pageIndex: 1,
      ordinal,
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      headingPath: ordinal < 12 ? ['Roster'] : ['Roster', 'Active roster'],
      headingOccurrencePath: ordinal < 12 ? [1] : [1, 2],
      content: `Roster entry ${ordinal.toString().padStart(2, '0')}.`,
    }));
    const state = harness(activeSnapshot(rawChunks));
    const request = {
      query: 'read the complete roster',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        sectionPath: ['Roster'],
      },
      retrievalMode: 'complete_scope' as const,
    };

    const first = await retrieveAuthorized(state.dependencies, request);

    expect(first.citations.map(citation => citation.chunkId)).toEqual(
      rawChunks.slice(0, 12).map(item => item.id)
    );
    expect(first.coverage).toMatchObject({
      status: 'sampled',
      scopeChunks: 15,
      selectedChunks: 12,
      omittedChunks: 3,
      promptTruncated: false,
      exhaustive: false,
      hasMore: true,
    });
    expect(first.nextCursor).toBeTruthy();
    expect(first.coverage.nextCursor).toBe(first.nextCursor);
    const decodedCursor = JSON.parse(
      Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8')
    ) as Record<string, unknown>;
    expect(decodedCursor).toMatchObject({
      v: 3,
      snapshotId: SNAPSHOT_ID,
      scopeKind: 'page',
      scopeChunkCount: 15,
      scopePageCount: 1,
      offset: 12,
    });
    expect(decodedCursor).not.toHaveProperty('scopeSelector');
    expect(JSON.stringify(decodedCursor)).not.toContain(rawChunks[0]?.pageId);
    expect(JSON.stringify(decodedCursor)).not.toContain(rawChunks[0]?.id);
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledTimes(1);
    expect(state.resolveSnapshotScope).toHaveBeenCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageTitleKey: normalizeBackstageNotionScopeKey('Monday Night Raw'),
        pagePathKey: normalizeBackstageNotionScopePath(rawPath),
        sectionPathKey: normalizeBackstageNotionScopePath(['Roster']),
        scopeKind: 'page',
      }
    );
    expect(state.loadSnapshotChunkPage).toHaveBeenLastCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: rawChunks[0]?.pageId,
        scopeKind: 'page',
        sectionOccurrencePath: [1],
      },
      15,
      0,
      12
    );

    const tamperedCursor = Buffer.from(JSON.stringify({
      ...decodedCursor,
      offset: 1,
    }), 'utf8').toString('base64url');
    await expect(retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: tamperedCursor,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledTimes(2);
    expect(state.resolveSnapshotScope).toHaveBeenCalledTimes(1);
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledTimes(1);

    const kindTamperedCursor = Buffer.from(JSON.stringify({
      ...decodedCursor,
      scopeKind: 'subtree',
    }), 'utf8').toString('base64url');
    await expect(retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: kindTamperedCursor,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledTimes(1);

    const missingScopeState = harness(activeSnapshot([chunk({
      pageIndex: 2,
      pageTitle: 'SmackDown',
      pagePath: ['WWE Universe Mode', 'Brands', 'SmackDown'],
      content: 'SmackDown continuity.',
    })]));
    await expect(retrieveAuthorized(missingScopeState.dependencies, {
      ...request,
      cursor: tamperedCursor,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(missingScopeState.loadActiveSnapshotHeader).toHaveBeenCalledTimes(1);
    expect(missingScopeState.resolveSnapshotScope).not.toHaveBeenCalled();
    expect(missingScopeState.loadSnapshotChunkPage).not.toHaveBeenCalled();
    const ambiguousScopeState = harness(activeSnapshot([
      chunk({
        pageIndex: 1,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        headingPath: ['Roster'],
        content: 'First matching page.',
      }),
      chunk({
        pageIndex: 2,
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        headingPath: ['Roster'],
        content: 'Second matching page.',
      }),
    ]));
    await expect(retrieveAuthorized(ambiguousScopeState.dependencies, {
      ...request,
      cursor: tamperedCursor,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(ambiguousScopeState.loadActiveSnapshotHeader).toHaveBeenCalledTimes(1);
    expect(ambiguousScopeState.resolveSnapshotScope).not.toHaveBeenCalled();
    expect(ambiguousScopeState.loadSnapshotChunkPage).not.toHaveBeenCalled();

    const second = await retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.citations.map(citation => citation.chunkId)).toEqual(
      rawChunks.slice(12).map(item => item.id)
    );
    expect(second.citations.every(citation => citation.headingPath.length > 1)).toBe(true);
    expect(second.coverage).toMatchObject({
      status: 'sampled',
      scopeChunks: 15,
      selectedChunks: 3,
      omittedChunks: 12,
      promptTruncated: false,
      exhaustive: false,
      hasMore: false,
    });
    expect(second.nextCursor).toBeNull();
    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.resolveSnapshotScope).toHaveBeenCalledTimes(2);
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalled();
    expect(state.loadSnapshotChunkPage).toHaveBeenLastCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: rawChunks[0]?.pageId,
        scopeKind: 'page',
        sectionOccurrencePath: [1],
      },
      15,
      12,
      12
    );

    const boundedState = harness(activeSnapshot(rawChunks.slice(0, 3)));
    const bounded = await retrieveAuthorized(boundedState.dependencies, request);
    expect(bounded.coverage).toMatchObject({
      status: 'complete',
      scopeChunks: 3,
      selectedChunks: 3,
      omittedChunks: 0,
      promptTruncated: false,
      exhaustive: true,
      hasMore: false,
    });

    await expect(retrieveAuthorized(state.dependencies, {
      ...request,
      query: 'a different request',
      cursor: first.nextCursor ?? undefined,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    const changedSnapshot = activeSnapshot([chunk({
      pageIndex: 2,
      pageTitle: 'SmackDown',
      pagePath: ['WWE Universe Mode', 'Brands', 'SmackDown'],
      content: 'Replacement continuity.',
    })]);
    changedSnapshot.snapshot.id = '99999999-9999-4999-8999-999999999999';
    const changedState = harness(changedSnapshot);
    await expect(retrieveAuthorized(changedState.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    expect(changedState.loadActiveSnapshotHeader).toHaveBeenCalledTimes(1);
    expect(changedState.resolveSnapshotScope).not.toHaveBeenCalled();
    expect(changedState.loadSnapshotChunkPage).not.toHaveBeenCalled();
  });

  it('rejects malformed, scope-incompatible, and out-of-range signed cursors', async () => {
    const unscopedChunks = Array.from({ length: 13 }, (_unused, ordinal) => chunk({
      pageIndex: ordinal + 1,
      ordinal: 0,
      content: `Universe entry ${ordinal}.`,
    }));
    const unscopedActive = activeSnapshot(unscopedChunks);
    const unscopedState = harness(unscopedActive);
    const unscopedRequest = {
      query: 'read all universe continuity',
      retrievalMode: 'complete_scope' as const,
    };
    const unscopedFirst = await retrieveAuthorized(
      unscopedState.dependencies,
      unscopedRequest
    );
    const unscopedDecoded = decodeTestCursor(unscopedFirst.nextCursor ?? '');

    await expect(retrieveAuthorized(unscopedState.dependencies, {
      ...unscopedRequest,
      cursor: 'e',
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);

    for (const malformedPayload of [
      { ...unscopedDecoded, scopeKind: 'unsupported' },
      { ...unscopedDecoded, scopeKind: null },
      { ...unscopedDecoded, scopePageCount: 0 },
      { ...unscopedDecoded, scopePageCount: Number.MAX_SAFE_INTEGER },
      { ...unscopedDecoded, scopeSelector: null },
    ]) {
      const cursor = Buffer.from(
        JSON.stringify(malformedPayload),
        'utf8'
      ).toString('base64url');
      await expect(retrieveAuthorized(unscopedState.dependencies, {
        ...unscopedRequest,
        cursor,
      })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    }

    const unscopedKindMismatch = resignTestCursor({
      ...unscopedDecoded,
      scopeKind: 'page',
    }, unscopedActive);
    await expect(retrieveAuthorized(unscopedState.dependencies, {
      ...unscopedRequest,
      cursor: unscopedKindMismatch,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);

    const offsetAtEnd = resignTestCursor({
      ...unscopedDecoded,
      offset: unscopedDecoded.scopeChunkCount,
    }, unscopedActive);
    await expect(retrieveAuthorized(unscopedState.dependencies, {
      ...unscopedRequest,
      cursor: offsetAtEnd,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);

    const mismatchedScopeCount = resignTestCursor({
      ...unscopedDecoded,
      scopeChunkCount: 14,
    }, unscopedActive);
    await expect(retrieveAuthorized(unscopedState.dependencies, {
      ...unscopedRequest,
      cursor: mismatchedScopeCount,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);

    const mismatchedPageCount = resignTestCursor({
      ...unscopedDecoded,
      scopePageCount: 2,
    }, unscopedActive);
    await expect(retrieveAuthorized(unscopedState.dependencies, {
      ...unscopedRequest,
      cursor: mismatchedPageCount,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);

    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const scopedChunks = Array.from({ length: 13 }, (_unused, ordinal) => chunk({
      ordinal,
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      headingPath: ['Roster'],
      headingOccurrencePath: [1],
      content: `Raw roster entry ${ordinal}.`,
    }));
    const scopedActive = activeSnapshot(scopedChunks);
    const scopedState = harness(scopedActive);
    const pageRequest = {
      query: 'read the full Raw page',
      retrievalScope: { pageTitle: 'Monday Night Raw', pagePath: rawPath },
      retrievalMode: 'complete_scope' as const,
    };
    const pageFirst = await retrieveAuthorized(scopedState.dependencies, pageRequest);
    const pageDecoded = decodeTestCursor(pageFirst.nextCursor ?? '');
    const scopeKindMismatch = resignTestCursor({
      ...pageDecoded,
      scopeKind: 'subtree',
    }, scopedActive);
    await expect(retrieveAuthorized(scopedState.dependencies, {
      ...pageRequest,
      cursor: scopeKindMismatch,
    })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);

    const sectionRequest = {
      ...pageRequest,
      query: 'read the full Raw roster',
      retrievalScope: { ...pageRequest.retrievalScope, sectionPath: ['Roster'] },
    };
    const sectionFirst = await retrieveAuthorized(scopedState.dependencies, sectionRequest);
    expect(decodeTestCursor(sectionFirst.nextCursor ?? '')).not.toHaveProperty('scopeSelector');
  });

  it('binds complete-scope cursors to exact query and scope spelling', async () => {
    const rawPath = ['WWE Universe Mode', 'Brands', 'Monday Night Raw'];
    const rawChunks = Array.from({ length: 13 }, (_unused, ordinal) => chunk({
      pageIndex: 1,
      ordinal,
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      headingPath: ['Roster K'],
      content: `Roster entry ${ordinal}.`,
    }));
    const state = harness(activeSnapshot(rawChunks));
    const request = {
      query: 'read K the complete roster',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        sectionPath: ['Roster K'],
      },
      retrievalMode: 'complete_scope' as const,
    };
    const first = await retrieveAuthorized(state.dependencies, request);
    expect(first.nextCursor).toBeTruthy();

    const changedRequests: BackstageNotionRagQuery[] = [
      { ...request, query: 'Read K the complete roster' },
      { ...request, query: 'read  K the complete roster' },
      { ...request, query: 'read K the complete roster' },
      { ...request, query: ' read K the complete roster' },
      { ...request, query: 'read K the complete roster ' },
      {
        ...request,
        retrievalScope: { ...request.retrievalScope, pageTitle: 'monday night raw' },
      },
      {
        ...request,
        retrievalScope: { ...request.retrievalScope, pageTitle: ' Monday Night Raw' },
      },
      {
        ...request,
        retrievalScope: {
          ...request.retrievalScope,
          pagePath: ['WWE Universe Mode', 'Brands', 'Monday  Night Raw'],
        },
      },
      {
        ...request,
        retrievalScope: {
          ...request.retrievalScope,
          pagePath: ['WWE Universe Mode', 'Brands ', 'Monday Night Raw'],
        },
      },
      {
        ...request,
        retrievalScope: { ...request.retrievalScope, sectionPath: ['Roster K'] },
      },
      {
        ...request,
        retrievalScope: { ...request.retrievalScope, sectionPath: ['Roster K '] },
      },
    ];
    for (const changedRequest of changedRequests) {
      await expect(retrieveAuthorized(state.dependencies, {
        ...(changedRequest as Exclude<BackstageNotionRagQuery, string>),
        cursor: first.nextCursor ?? undefined,
      })).rejects.toBeInstanceOf(BackstageNotionCursorInvalidError);
    }
  });

  it('rejects malformed query envelopes, modes, scopes, and cursors before repository work', async () => {
    const invalidQueries: unknown[] = [
      null,
      [],
      { query: 42 },
      { query: 'continuity', retrievalMode: 'relevant', mode: 'complete_scope' },
      { query: 'continuity', retrievalMode: 'unsupported' },
      { query: 'continuity', retrievalScope: null },
      { query: 'continuity', retrievalScope: [] },
      { query: 'continuity', retrievalScope: { pageTitle: 42 } },
      {
        query: 'continuity',
        retrievalScope: { pageTitle: 'Raw', scopeKind: 'unsupported' },
      },
      {
        query: 'continuity',
        retrievalScope: {
          pageTitle: 'Raw',
          scopeKind: 'subtree',
          sectionPath: ['Roster'],
        },
      },
      {
        query: 'continuity',
        retrievalScope: { pageTitle: 'Raw', pagePath: 'not-an-array' },
      },
      {
        query: 'continuity',
        retrievalScope: { pageTitle: 'Raw', pagePath: [] },
      },
      {
        query: 'continuity',
        retrievalScope: { pageTitle: 'Raw', pagePath: [42] },
      },
      {
        query: 'continuity',
        retrievalScope: { pageTitle: 'Raw', sectionPath: ['x'.repeat(501)] },
      },
      { query: 'continuity', cursor: 'valid-looking-cursor' },
      { query: 'continuity', retrievalMode: 'complete_scope', cursor: '%' },
    ];

    for (const invalidQuery of invalidQueries) {
      const state = harness();
      await expect(retrieveAuthorized(
        state.dependencies,
        invalidQuery as BackstageNotionRagQuery
      )).rejects.toBeInstanceOf(Error);
      expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
      expect(state.loadActiveSnapshotHeader).not.toHaveBeenCalled();
    }
  });

  it('uses fixed-size lookup digests for compatibility-normalization expansion', async () => {
    const expandingSegment = '\uFDFA'.repeat(240);
    expect(Array.from(expandingSegment)).toHaveLength(240);
    expect(Array.from(expandingSegment.normalize('NFKC')).length).toBeGreaterThan(4_000);
    const expandingChunk = chunk({
      pageTitle: expandingSegment,
      pagePath: [expandingSegment],
      headingPath: [expandingSegment],
      headingOccurrencePath: [1],
      content: 'Compatibility-normalized continuity.',
    });
    const state = harness(activeSnapshot([expandingChunk]));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read the expanded scope',
      retrievalScope: {
        pageTitle: expandingSegment,
        pagePath: [expandingSegment],
        sectionPath: [expandingSegment],
      },
      retrievalMode: 'complete_scope',
    });

    expect(result.citations).toHaveLength(1);
    expect(result.resolvedScope).toEqual({
      pageTitle: expandingSegment,
      pagePath: [expandingSegment],
      sectionPath: [expandingSegment],
    });
    const lookup = state.resolveSnapshotScope.mock.calls[0]?.[2];
    expect(lookup?.pageTitleKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(lookup?.pagePathKey).toEqual([lookup?.pageTitleKey]);
    expect(lookup?.sectionPathKey).toEqual([lookup?.pageTitleKey]);
  });

  it('pages a maximum unscoped snapshot from its header without corpus projection', async () => {
    const visibleChunks = Array.from({ length: 12 }, (_unused, ordinal) => chunk({
      ordinal,
      content: `Visible maximum-snapshot entry ${ordinal}.`,
    }));
    const active = activeSnapshot(visibleChunks);
    active.snapshot.chunkCount = BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS;
    const state = harness(active, {
      loadSnapshotChunkPage: async () => ({
        scopeChunkCount: BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
        chunks: visibleChunks.map(({ embedding: _embedding, ...selected }) => selected),
      }),
    });

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read all continuity',
      retrievalMode: 'complete_scope',
    });

    expect(result.citations).toHaveLength(12);
    expect(result.nextCursor).toBeTruthy();
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledTimes(1);
    expect(state.resolveSnapshotScope).not.toHaveBeenCalled();
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      { pageId: null, scopeKind: 'all', sectionOccurrencePath: null },
      BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
      0,
      12
    );
  });

  it('paginates all 4,096 complete-scope chunks without duplication or omission', async () => {
    const active = activeSnapshot([chunk({ pageIndex: 1, ordinal: 0 })]);
    active.snapshot.chunkCount = BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS;
    const state = harness(active, {
      loadSnapshotChunkPage: async (
        _universeId,
        snapshotId,
        selector,
        knownScopeChunkCount,
        offset,
        limit
      ) => {
        expect(snapshotId).toBe(SNAPSHOT_ID);
        expect(selector).toEqual({
          pageId: null,
          scopeKind: 'all',
          sectionOccurrencePath: null,
        });
        expect(knownScopeChunkCount).toBe(BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS);
        const count = Math.min(
          limit,
          BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS - offset
        );
        return {
          scopeChunkCount: BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
          chunks: Array.from({ length: count }, (_unused, index) => {
            const generated = chunk({
              pageIndex: 1,
              ordinal: offset + index,
              content: `Maximum continuity entry ${offset + index}.`,
            });
            const { embedding: _embedding, ...selected } = generated;
            return selected;
          }),
        };
      },
    });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let calls = 0;

    do {
      const result = await retrieveAuthorized(state.dependencies, {
        query: 'read every continuity entry',
        retrievalMode: 'complete_scope',
        ...(cursor ? { cursor } : {}),
      });
      for (const citation of result.citations) {
        expect(seen.has(citation.chunkId)).toBe(false);
        seen.add(citation.chunkId);
      }
      calls += 1;
      cursor = result.nextCursor ?? undefined;
      expect(result.coverage.hasMore).toBe(Boolean(cursor));
    } while (cursor);

    expect(seen.size).toBe(BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS);
    expect(calls).toBe(Math.ceil(
      BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS / 12
    ));
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledTimes(calls);
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledTimes(calls);
  });

  it('keeps the maximum signed duplicate-heading cursor bounded without serializing its selector', async () => {
    const headingPath = Array.from(
      { length: 32 },
      (_unused, index) => `Heading ${index.toString().padStart(2, '0')}`
    );
    const headingOccurrencePath = Array.from({ length: 32 }, () => (
      BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS
    ));
    const rawPath = ['WWE Universe Mode', 'Maximum scope'];
    const rawChunks = Array.from(
      { length: BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS },
      (_unused, ordinal) => chunk({
        pageIndex: 1,
        ordinal,
        pageTitle: 'Maximum scope',
        pagePath: rawPath,
        headingPath,
        headingOccurrencePath,
        content: `Deep continuity entry ${ordinal}.`,
      })
    );
    const state = harness(activeSnapshot(rawChunks));
    const request = {
      query: 'read the maximum duplicate heading occurrence',
      retrievalScope: {
        pageTitle: 'Maximum scope',
        pagePath: rawPath,
        sectionPath: headingPath,
      },
      retrievalMode: 'complete_scope' as const,
    };

    const first = await retrieveAuthorized(state.dependencies, request);

    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{1,1024}$/u);
    expect(first.nextCursor?.length).toBeLessThanOrEqual(1024);
    const decoded = JSON.parse(Buffer.from(
      first.nextCursor ?? '',
      'base64url'
    ).toString('utf8')) as {
      scopeChunkCount: number;
      scopeKind: string;
      scopePageCount: number;
    };
    expect(decoded.scopeChunkCount).toBe(BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS);
    expect(decoded.scopeKind).toBe('page');
    expect(decoded.scopePageCount).toBe(1);
    expect(decoded).not.toHaveProperty('scopeSelector');

    const second = await retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.citations).toHaveLength(12);
    expect(state.resolveSnapshotScope).toHaveBeenCalledTimes(2);
    expect(state.loadActiveSnapshotHeader).toHaveBeenCalledTimes(2);
    expect(state.loadSnapshotChunkPage).toHaveBeenLastCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: rawChunks[0]?.pageId,
        scopeKind: 'page',
        sectionOccurrencePath: headingOccurrencePath,
      },
      BACKSTAGE_NOTION_RAG_MAX_ACTIVE_CHUNKS,
      12,
      12
    );
  });

  it('validates only selected complete-scope content and never requires embeddings', async () => {
    const rawChunks = Array.from({ length: 13 }, (_unused, ordinal) => chunk({
      ordinal,
      content: `Continuity entry ${ordinal}.`,
      embedding: [Number.NaN],
    }));
    const corruptUnselected = rawChunks[12];
    if (!corruptUnselected) {
      throw new Error('Expected the unselected test chunk.');
    }
    corruptUnselected.content = 'Content that does not match the persisted hash.';
    const state = harness(activeSnapshot(rawChunks));
    const request = {
      query: 'read all continuity',
      retrievalMode: 'complete_scope' as const,
    };

    const first = await retrieveAuthorized(state.dependencies, request);
    expect(first.citations).toHaveLength(12);
    expect(first.nextCursor).toBeTruthy();
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.embedQuery).not.toHaveBeenCalled();
    expect(state.loadSnapshotChunkPage).toHaveBeenCalledWith(
      UNIVERSE_ID,
      SNAPSHOT_ID,
      {
        pageId: null,
        scopeKind: 'all',
        sectionOccurrencePath: null,
      },
      13,
      0,
      12
    );
    expect(state.resolveSnapshotScope).not.toHaveBeenCalled();

    await expect(retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
  });

  it('rejects invalid counts, page lengths, duplicates, and ordering in paged projections', async () => {
    const first = chunk({
      pageIndex: 1,
      content: 'Alpha continuity.',
      pageTitle: 'Alpha',
      pagePath: ['WWE Universe Mode', 'Alpha'],
    });
    const second = chunk({
      pageIndex: 2,
      content: 'Bravo continuity.',
      pageTitle: 'Bravo',
      pagePath: ['WWE Universe Mode', 'Bravo'],
    });
    const active = activeSnapshot([first, second]);
    const { embedding: _firstEmbedding, ...storedFirst } = first;
    const { embedding: _secondEmbedding, ...storedSecond } = second;
    const invalidPages: BackstageNotionSnapshotChunkPage[] = [
      { scopeChunkCount: 0, chunks: [] },
      { scopeChunkCount: 2, chunks: [storedFirst] },
      { scopeChunkCount: 2, chunks: [storedFirst, storedFirst] },
      { scopeChunkCount: 2, chunks: [storedSecond, storedFirst] },
    ];

    for (const page of invalidPages) {
      const state = harness(active, {
        loadSnapshotChunkPage: async () => page,
      });
      await expect(retrieveAuthorized(state.dependencies, {
        query: 'read all continuity',
        retrievalMode: 'complete_scope',
      })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    }
  });

  it('rejects selected pages that disagree with their requested or resolved scope', async () => {
    const canonical = chunk({
      pageIndex: 1,
      pageTitle: 'Monday Night Raw',
      pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
      content: 'Raw continuity.',
    });
    const unrelated = chunk({
      pageIndex: 2,
      pageTitle: 'SmackDown',
      pagePath: ['WWE Universe Mode', 'SmackDown'],
      content: 'SmackDown continuity.',
    });
    const active = activeSnapshot([canonical]);
    const { embedding: _unrelatedEmbedding, ...storedUnrelated } = unrelated;
    const wrongPageState = harness(active, {
      loadSnapshotChunkPage: async () => ({
        scopeChunkCount: 1,
        chunks: [storedUnrelated],
      }),
    });
    const request = {
      query: 'read the Raw page',
      retrievalScope: { pageTitle: 'Monday Night Raw' },
      retrievalMode: 'complete_scope' as const,
    };
    await expect(retrieveAuthorized(
      wrongPageState.dependencies,
      request
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

    const variant = chunk({
      pageIndex: 1,
      pageTitle: 'monday night raw',
      pagePath: ['WWE Universe Mode', 'monday night raw'],
      content: 'Variant-cased Raw continuity.',
    });
    const variantActive = activeSnapshot([variant]);
    const mismatchState = harness(variantActive, {
      resolveSnapshotScope: async () => ({
        status: 'resolved',
        pageTitle: 'Monday Night Raw',
        pagePath: ['WWE Universe Mode', 'Monday Night Raw'],
        sectionPath: null,
        selector: {
          pageId: variant.pageId,
          scopeKind: 'page',
          sectionOccurrencePath: null,
        },
        scopeChunkCount: 1,
        scopePageCount: 1,
      }),
    });
    await expect(retrieveAuthorized(
      mismatchState.dependencies,
      request
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
  });

  it('uses chunk identity as the final deterministic ordering tie-breaker', async () => {
    const first = chunk({
      pageIndex: 1,
      ordinal: 0,
      content: 'Alpha fact.',
    });
    const second = chunk({
      pageIndex: 1,
      ordinal: 0,
      content: 'Bravo fact.',
    });
    const expected = [first.id, second.id].sort(compareText);

    const completeState = harness(activeSnapshot([second, first]));
    const complete = await retrieveAuthorized(completeState.dependencies, {
      query: 'read everything',
      retrievalMode: 'complete_scope',
    });
    expect(complete.citations.map(citation => citation.chunkId)).toEqual(expected);

    const relevantState = harness(activeSnapshot([second, first]));
    const relevant = await retrieveAuthorized(relevantState.dependencies, 'unmatched query');
    expect(relevant.citations.map(citation => citation.chunkId)).toEqual(expected);
  });

  it('supports deterministic complete-scope pagination across the whole universe', async () => {
    const chunks = Array.from({ length: 14 }, (_unused, ordinal) => chunk({
      pageIndex: ordinal < 7 ? 2 : 1,
      ordinal: ordinal % 7,
      pageTitle: ordinal < 7 ? 'SmackDown' : 'Monday Night Raw',
      pagePath: [
        'WWE Universe Mode',
        ordinal < 7 ? 'SmackDown' : 'Monday Night Raw',
      ],
      content: `Universe continuity ${ordinal}.`,
    }));
    const state = harness(activeSnapshot(chunks));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read all current continuity',
      retrievalMode: 'complete_scope',
    });

    expect(result.resolvedScope).toBeNull();
    expect(result.coverage).toMatchObject({
      scopeChunks: 14,
      selectedChunks: 12,
      omittedChunks: 2,
      hasMore: true,
    });
    expect(result.citations[0]?.pageTitle).toBe('Monday Night Raw');
    expect(state.embedQuery).not.toHaveBeenCalled();
  });

  it('orders complete scopes by Unicode code point instead of host locale', async () => {
    const accented = chunk({
      pageIndex: 1,
      pageTitle: 'Ärena',
      pagePath: ['WWE Universe Mode', 'Ärena'],
      content: 'Accented page continuity.',
    });
    const ascii = chunk({
      pageIndex: 2,
      pageTitle: 'Zulu',
      pagePath: ['WWE Universe Mode', 'Zulu'],
      content: 'ASCII page continuity.',
    });
    const state = harness(activeSnapshot([accented, ascii]));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read all continuity',
      retrievalMode: 'complete_scope',
    });

    expect(result.citations.map(citation => citation.pageTitle)).toEqual([
      'Zulu',
      'Ärena',
    ]);
  });

  it('orders a parent page path before its longer child prefix', async () => {
    const parent = chunk({
      pageIndex: 1,
      pageTitle: 'Zulu parent',
      pagePath: ['WWE Universe Mode', 'Shared'],
      content: 'Parent continuity.',
    });
    const child = chunk({
      pageIndex: 2,
      pageTitle: 'Alpha child',
      pagePath: ['WWE Universe Mode', 'Shared', 'Alpha child'],
      content: 'Child continuity.',
    });
    const state = harness(activeSnapshot([child, parent]));

    const result = await retrieveAuthorized(state.dependencies, {
      query: 'read all continuity',
      retrievalMode: 'complete_scope',
    });

    expect(result.citations.map(citation => citation.pageTitle)).toEqual([
      'Zulu parent',
      'Alpha child',
    ]);
  });

  it('repeats a partially packed chunk on the next complete-scope page', async () => {
    const rawPath = ['WWE Universe Mode', 'Monday Night Raw'];
    const chunks = Array.from({ length: 5 }, (_unused, ordinal) => chunk({
      pageIndex: 1,
      ordinal,
      pageTitle: 'Monday Night Raw',
      pagePath: rawPath,
      headingPath: ['Detailed results'],
      content: `Result ${ordinal}: ${'x'.repeat(3_800)}`,
    }));
    const state = harness(activeSnapshot(chunks));
    const request = {
      query: 'read every detailed result',
      retrievalScope: {
        pageTitle: 'Monday Night Raw',
        pagePath: rawPath,
        sectionPath: ['Detailed results'],
      },
      retrievalMode: 'complete_scope' as const,
    };

    const first = await retrieveAuthorized(state.dependencies, request);
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8')
    ) as { offset: number };
    expect(first.coverage.promptTruncated).toBe(true);
    expect(decoded.offset).toBe(first.chunkCount - 1);

    const second = await retrieveAuthorized(state.dependencies, {
      ...request,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.citations[0]?.chunkId).toBe(
      first.citations.at(-1)?.chunkId
    );
  });

  it('scopes booking retrieval to Raw hierarchy while leaving generic continuity retrieval unchanged', async () => {
    const privateMarker = 'PRIVATE-NOTION-CONTINUITY-MARKER';
    const chunks = [
      chunk({
        pageIndex: 1,
        pageTitle: 'World Heavyweight Championship',
        pagePath: ['WWE Universe Mode', 'Raw', 'Championships'],
        category: 'championships',
        content: `${privateMarker} Raw title continuity.`,
      }),
      chunk({
        pageIndex: 2,
        pageTitle: 'Shared roster',
        pagePath: ['WWE Universe Mode', 'Shared roster'],
        category: 'roster',
        content: 'Neutral roster continuity.',
      }),
      chunk({
        pageIndex: 3,
        pageTitle: 'SmackDown weekly show',
        pagePath: ['WWE Universe Mode', 'SmackDown'],
        content: 'SmackDown continuity.',
      }),
      chunk({
        pageIndex: 4,
        pageTitle: 'NXT weekly show',
        pagePath: ['WWE Universe Mode', 'NXT'],
        content: 'NXT continuity.',
      }),
    ];
    const state = harness(activeSnapshot(chunks));

    const booking = await retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw next week.'
    );
    const bookingTitles = booking.citations.map(citation => citation.pageTitle);

    expect(bookingTitles).toEqual([
      'World Heavyweight Championship',
      'Shared roster',
    ]);
    expect(booking.prompt).not.toContain('SmackDown continuity.');
    expect(booking.prompt).not.toContain('NXT continuity.');
    const bookingLog = latestRetrievedLog();
    expect(bookingLog).toMatchObject({
      candidateChunks: 4,
      scopedCandidateChunks: 2,
      scopeExcludedChunks: 2,
      retrievedChunks: 2,
      retrievalProfile: 'booking',
      scoped: true,
      scopeKind: 'brand',
      scopeStrategy: 'brand',
      detectedBrands: ['raw'],
      allowedBrands: ['raw'],
      corpusOmitted: true,
      scopeOmitted: true,
      promptTruncated: false,
    });
    expect(JSON.stringify(bookingLog)).not.toContain(privateMarker);
    expect(JSON.stringify(bookingLog)).not.toContain(chunks[0]?.pageTitle ?? '');
    expect(JSON.stringify(bookingLog)).not.toContain(chunks[0]?.contentHash ?? '');

    const continuity = await retrieveAuthorized(
      state.dependencies,
      'Book Raw next week.'
    );
    expect(continuity.citations.map(citation => citation.pageTitle)).toEqual(
      expect.arrayContaining([
        'World Heavyweight Championship',
        'Shared roster',
        'SmackDown weekly show',
        'NXT weekly show',
      ])
    );
  });

  it('fences booking scope before the bounded candidate limit', async () => {
    const unrelated = Array.from({ length: 160 }, (_unused, index) => chunk({
      pageIndex: index + 1,
      pageTitle: `SmackDown high scorer ${index}`,
      pagePath: ['WWE Universe Mode', 'SmackDown', `Week ${index}`],
      content: `SmackDown high relevance continuity ${index}.`,
      embedding: [1, 0],
    }));
    const raw = chunk({
      pageIndex: 201,
      pageTitle: 'Raw requested continuity',
      pagePath: ['WWE Universe Mode', 'Raw'],
      content: 'Lower-ranked Raw continuity.',
      embedding: [0.1, 0.9],
    });
    const shared = chunk({
      pageIndex: 202,
      pageTitle: 'Shared canon',
      pagePath: ['WWE Universe Mode', 'Shared'],
      content: 'Lower-ranked shared continuity.',
      embedding: [0.1, 0.9],
    });
    const state = harness(activeSnapshot([...unrelated, raw, shared]));

    const result = await retrieveBookingAuthorized(
      state.dependencies,
      'Book the Raw show next week.'
    );

    expect(result.citations.map(citation => citation.pageTitle)).toEqual([
      raw.pageTitle,
      shared.pageTitle,
    ]);
    expect(result.prompt).not.toContain('SmackDown high relevance continuity');
    expect(state.loadActiveSnapshot).not.toHaveBeenCalled();
    expect(state.rankSnapshotCandidates).toHaveBeenCalledWith(expect.objectContaining({
      allowedBookingBrands: ['raw'],
      limit: 128,
    }));
  });

  it('reserves named cross-brand coverage and excludes an unmentioned third brand', async () => {
    const rawChunks = Array.from({ length: 13 }, (_unused, index) => chunk({
      pageIndex: index + 1,
      pageTitle: `Raw continuity ${index}`,
      pagePath: ['WWE Universe Mode', 'Raw', `Week ${index}`],
      content: `Raw high relevance continuity ${index}.`,
      embedding: [1, 0],
    }));
    const state = harness(activeSnapshot([
      ...rawChunks,
      chunk({
        pageIndex: 20,
        pageTitle: 'SmackDown crossover continuity',
        pagePath: ['WWE Universe Mode', 'SmackDown'],
        content: 'Lower-scored SmackDown crossover fact.',
        embedding: [0.4, 0.6],
      }),
      chunk({
        pageIndex: 21,
        pageTitle: 'NXT crossover continuity',
        pagePath: ['WWE Universe Mode', 'NXT'],
        content: 'NXT fact that was not requested.',
        embedding: [1, 0],
      }),
    ]));

    const result = await retrieveBookingAuthorized(
      state.dependencies,
      'Book a Raw vs SmackDown cross-brand storyline.'
    );
    const titles = result.citations.map(citation => citation.pageTitle);

    expect(titles.some(title => title.startsWith('Raw continuity'))).toBe(true);
    expect(titles).toContain('SmackDown crossover continuity');
    expect(titles).not.toContain('NXT crossover continuity');
    expect(latestRetrievedLog()).toMatchObject({
      scopeStrategy: 'cross_brand',
      detectedBrands: ['raw', 'smackdown'],
      allowedBrands: ['raw', 'smackdown'],
      scopeExcludedChunks: 1,
    });
  });

  it('admits the closed brand union for an explicit generic cross-brand booking', async () => {
    const state = harness(activeSnapshot([
      ...Array.from({ length: 13 }, (_unused, index) => chunk({
        pageIndex: index + 1,
        pageTitle: `Raw show ${index}`,
        pagePath: ['Universe', 'Raw', `${index}`],
        content: `High-relevance Raw fact ${index}.`,
        embedding: [1, 0],
      })),
      chunk({
        pageIndex: 20,
        pageTitle: 'SmackDown show',
        pagePath: ['Universe', 'SmackDown'],
        content: 'Lower-relevance SmackDown fact.',
        embedding: [0.4, 0.6],
      }),
      chunk({
        pageIndex: 21,
        pageTitle: 'NXT show',
        pagePath: ['Universe', 'NXT'],
        content: 'Lower-relevance NXT fact.',
        embedding: [0.4, 0.6],
      }),
    ]));

    const result = await retrieveBookingAuthorized(
      state.dependencies,
      'Create a cross-brand supershow.'
    );

    const titles = result.citations.map(citation => citation.pageTitle);
    expect(result.citations).toHaveLength(12);
    expect(titles.some(title => title.startsWith('Raw show'))).toBe(true);
    expect(titles).toEqual(expect.arrayContaining(['SmackDown show', 'NXT show']));
    expect(latestRetrievedLog()).toMatchObject({
      scopeStrategy: 'cross_brand',
      explicitCrossBrand: true,
      allowedBrands: ['raw', 'smackdown', 'nxt'],
    });
  });

  it('bounds neutral booking continuity without crowding out the requested brand', async () => {
    const state = harness(activeSnapshot([
      chunk({
        pageIndex: 1,
        pageTitle: 'Raw weekly show',
        pagePath: ['Universe', 'Raw'],
        content: 'Requested Raw continuity.',
      }),
      ...Array.from({ length: 5 }, (_unused, index) => chunk({
        pageIndex: index + 2,
        pageTitle: `Shared continuity ${index}`,
        pagePath: ['Universe', 'Shared', `${index}`],
        content: `Neutral relationship continuity ${index}.`,
      })),
    ]));

    const result = await retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw next week.'
    );

    expect(result.citations[0]?.pageTitle).toBe('Raw weekly show');
    expect(result.citations).toHaveLength(3);
    expect(result.citations.filter(citation => (
      citation.pageTitle.startsWith('Shared continuity')
    ))).toHaveLength(2);
  });

  it('deduplicates equal booking content by hash and reports only safe counts', async () => {
    const duplicateContent = 'Identical Raw championship continuity.';
    const state = harness(activeSnapshot([
      chunk({
        pageIndex: 2,
        pageTitle: 'Raw next week primary continuity',
        pagePath: ['Universe', 'Raw'],
        content: duplicateContent,
      }),
      chunk({
        pageIndex: 1,
        pageTitle: 'Raw duplicate continuity',
        pagePath: ['Universe', 'Raw'],
        content: duplicateContent,
      }),
      chunk({
        pageIndex: 3,
        pageTitle: 'Raw unique continuity',
        pagePath: ['Universe', 'Raw'],
        content: 'Unique Raw continuity.',
      }),
    ]));

    const result = await retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw next week.'
    );

    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.pageTitle).toBe('Raw next week primary continuity');
    expect(latestRetrievedLog()).toMatchObject({
      candidateChunks: 3,
      uniqueCandidateChunks: 2,
      duplicatesRemoved: 1,
      retrievedChunks: 2,
    });
  });

  it('packs production-sized booking context as complete excerpts within deterministic budgets', async () => {
    const chunks = Array.from({ length: 12 }, (_unused, index) => chunk({
      pageIndex: index + 1,
      pageTitle: `Raw week ${index}`,
      pagePath: ['WWE Universe Mode', 'Raw', `Week ${index}`],
      content: `Raw continuity ${index}: ${'x'.repeat(1_400)}`,
    }));
    const state = harness(activeSnapshot(chunks));

    const result = await retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw next week.'
    );
    const starts = result.prompt.match(/\[Retrieved Notion excerpt /gu) ?? [];
    const ends = result.prompt.match(/\[End retrieved Notion excerpt\]/gu) ?? [];

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.chunkCount).toBeLessThan(12);
    expect(starts).toHaveLength(result.chunkCount);
    expect(ends).toHaveLength(result.chunkCount);
    expect(Array.from(result.prompt).length).toBeLessThanOrEqual(
      BACKSTAGE_NOTION_RAG_PROMPT_CODE_POINTS
    );
    expect(result.truncated).toBe(true);
    expect(result.coverage).toMatchObject({
      status: 'sampled',
      selectedChunks: result.chunkCount,
      omittedChunks: 12 - result.chunkCount,
      promptTruncated: false,
    });
    expect(latestRetrievedLog()).toMatchObject({
      candidateChunks: 12,
      corpusOmitted: true,
      promptTruncated: false,
    });
  });

  it('uses an all-context fallback only for underspecified booking scope', async () => {
    const allBrands = activeSnapshot([
      chunk({ pageIndex: 1, pageTitle: 'Raw show', pagePath: ['Universe', 'Raw'], content: 'Raw fallback fact.' }),
      chunk({ pageIndex: 2, pageTitle: 'SmackDown show', pagePath: ['Universe', 'SmackDown'], content: 'SmackDown fallback fact.' }),
      chunk({ pageIndex: 3, pageTitle: 'NXT show', pagePath: ['Universe', 'NXT'], content: 'NXT fallback fact.' }),
    ]);
    const underspecifiedState = harness(allBrands);

    const underspecified = await retrieveBookingAuthorized(
      underspecifiedState.dependencies,
      'Book next week using active storylines.'
    );

    expect(underspecified.citations).toHaveLength(3);
    expect(latestRetrievedLog()).toMatchObject({
      scoped: false,
      scopeKind: 'all',
      scopeStrategy: 'fallback_all',
      fallbackReason: 'underspecified_query',
      allowedBrands: ['raw', 'smackdown', 'nxt'],
    });

    jest.mocked(logger.info).mockClear();
    const unmatchedState = harness(activeSnapshot([
      chunk({ pageIndex: 4, pageTitle: 'SmackDown show', pagePath: ['Universe', 'SmackDown'], content: 'SmackDown unmatched fact.' }),
      chunk({ pageIndex: 5, pageTitle: 'NXT show', pagePath: ['Universe', 'NXT'], content: 'NXT unmatched fact.' }),
      chunk({ pageIndex: 6, pageTitle: 'Shared title history', pagePath: ['Universe', 'Shared'], content: 'Shared unmatched fact.' }),
    ]));
    const unmatched = await retrieveBookingAuthorized(
      unmatchedState.dependencies,
      'Book Raw next week.'
    );

    expect(unmatched.citations.map(citation => citation.pageTitle)).toEqual([
      'Shared title history',
    ]);
    expect(latestRetrievedLog()).toMatchObject({
      scoped: true,
      scopeKind: 'brand',
      scopeStrategy: 'brand',
      fallbackReason: 'no_matching_brand_context',
      allowedBrands: ['raw'],
      scopeExcludedChunks: 2,
    });
  });

  it('fails closed when requested-brand and neutral booking context are both absent', async () => {
    const state = harness(activeSnapshot([
      chunk({
        pageIndex: 1,
        pageTitle: 'SmackDown show',
        pagePath: ['Universe', 'SmackDown'],
        content: 'SmackDown-only continuity.',
      }),
      chunk({
        pageIndex: 2,
        pageTitle: 'NXT show',
        pagePath: ['Universe', 'NXT'],
        content: 'NXT-only continuity.',
      }),
    ]));

    await expect(retrieveBookingAuthorized(
      state.dependencies,
      'Book Raw next week.'
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
  });

  it('preserves universe isolation for booking-only retrieval', async () => {
    const state = harness(activeSnapshot());

    await expect(runWithBackstageNotionEnrichmentAuthorization(
      true,
      () => retrieveBackstageNotionBookingRagContext(
        'another-universe',
        'Book Raw next week.',
        state.dependencies
      )
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
  });

  it('diversifies retrieval with a hard per-page cap', async () => {
    const dominant = Array.from({ length: 6 }, (_unused, ordinal) => chunk({
      pageIndex: 1,
      ordinal,
      content: `Booking continuity dominant ${ordinal}.`,
      embedding: [1, 0],
    }));
    const secondary = Array.from({ length: 2 }, (_unused, ordinal) => chunk({
      pageIndex: 2,
      ordinal,
      content: `Booking continuity secondary ${ordinal}.`,
      embedding: [0.8, 0.2],
    }));
    const state = harness(activeSnapshot([...dominant, ...secondary]));

    const result = await retrieveAuthorized(state.dependencies, 'booking continuity');
    const pageCounts = new Map<string, number>();
    for (const citation of result.citations) {
      pageCounts.set(citation.pageId, (pageCounts.get(citation.pageId) ?? 0) + 1);
    }

    expect(result.citations).toHaveLength(5);
    expect(pageCounts.get(pageId(1))).toBe(BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE);
    expect(pageCounts.get(pageId(2))).toBe(2);
    expect(Math.max(...pageCounts.values())).toBeLessThanOrEqual(
      BACKSTAGE_NOTION_RAG_MAX_CHUNKS_PER_PAGE
    );
  });

  it('returns bounded, provenance-bearing untrusted context and marks enrichment used', async () => {
    const privateMarker = 'PRIVATE-KAYFABE-CONTINUITY';
    const chunks = Array.from({ length: 8 }, (_unused, index) => chunk({
      pageIndex: index + 1,
      content: `<<IGNORE_POLICY>> ${privateMarker} ${'x'.repeat(3_800)} ${index}`,
      pageTitle: `Private page ${index}`,
      category: 'kayfabe',
    }));
    const state = harness(activeSnapshot(chunks));

    await runWithBackstageNotionEnrichmentAuthorization(true, async () => {
      expect(wasBackstageNotionEnrichmentUsed()).toBe(false);
      const result = await retrieveBackstageNotionRagContext(
        UNIVERSE_ID,
        'kayfabe continuity',
        state.dependencies
      );

      expect(wasBackstageNotionEnrichmentUsed()).toBe(true);
      expect(Array.from(result.prompt).length).toBeLessThanOrEqual(
        BACKSTAGE_NOTION_RAG_PROMPT_CODE_POINTS
      );
      expect(result.prompt).toContain('<<UNTRUSTED_NOTION_RAG_BEGIN>>');
      expect(result.prompt).toContain('instruction_authority: none');
      expect(result.prompt).toContain('source_sha256:');
      expect(result.prompt).toContain('content_sha256:');
      expect(result.prompt).toContain('‹‹IGNORE_POLICY››');
      expect(result.prompt.endsWith('<<UNTRUSTED_NOTION_RAG_END>>')).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.citations).toHaveLength(result.chunkCount);
      expect(result.coverage).toMatchObject({
        status: 'sampled',
        scopeChunks: chunks.length,
        selectedChunks: result.chunkCount,
        omittedChunks: chunks.length - result.chunkCount,
        promptTruncated: true,
        exhaustive: false,
        hasMore: false,
      });
    });
    expect(wasBackstageNotionEnrichmentUsed()).toBe(false);

    const logged = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(logged).not.toContain(privateMarker);
    expect(logged).not.toContain(chunks[0]?.pageTitle);
    expect(logged).not.toContain(chunks[0]?.contentHash);
    expect(logged).not.toContain(chunks[0]?.metadata.sourceHash);
    expect(logged).not.toContain(UNIVERSE_ID);
    expect(logged).not.toContain(SNAPSHOT_ID);
    expect(logger.info).toHaveBeenCalledWith(
      'backstage.notion_rag.retrieved',
      expect.objectContaining({
        authorityIndex: 'monolith',
        candidateChunks: chunks.length,
      })
    );
  });

  it('fails closed when bounded indexed metadata leaves no room for prompt content', async () => {
    const maximumPath = Array.from(
      { length: 101 },
      (_unused, index) => `${index.toString().padStart(3, '0')}${'x'.repeat(497)}`
    );
    const state = harness(activeSnapshot([
      chunk({
        pagePath: maximumPath,
        content: 'Valid continuity that cannot fit after the maximum path metadata.',
      }),
    ]));

    await expect(retrieveAuthorized(state.dependencies)).rejects.toBeInstanceOf(
      BackstageNotionIndexUnavailableError
    );
    expect(state.embedQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects a complete-scope page when its first chunk can only be partially packed', async () => {
    const state = harness(activeSnapshot([
      chunk({ content: `Oversized continuity ${'x'.repeat(20_000)}` }),
    ]));

    await expect(retrieveAuthorized(state.dependencies, {
      query: 'read all oversized continuity',
      retrievalMode: 'complete_scope',
    })).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(state.embedQuery).not.toHaveBeenCalled();
  });
});
