import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl,
} from './postgresTestDatabase.js';

// Real HTTP auth/dispatch, Notion parsing/synchronization, PostgreSQL repositories,
// authority retrieval, and Trinity. Only external providers and unrelated side
// effects are replaced; the production application startup is never imported.
const TEST_DATABASE_ENV = 'BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, TEST_DATABASE_ENV);
const describeWithDatabase = connectionString ? describe : describe.skip;
const ACCESS_TOKEN = `backstage-${'h'.repeat(48)}`;
const UNIVERSE_ID = `http-continuity-pg18-${randomUUID().slice(0, 8)}`;
const ROOT_PAGE_ID = randomUUID();
const SOURCE_ID = randomUUID();
const MEMBERS = [randomUUID(), randomUUID()].sort();
const EXTERNAL_REFERENCE_ID = randomUUID();
const QUERY = 'Who holds the synthetic championship?';
const PROVIDER_ANSWER = '- Synthetic champion one holds the championship.';
const CONTENT = [
  'PRIVATE_SYNTHETIC_RECORD_1: Synthetic champion one holds the championship.',
  'PRIVATE_SYNTHETIC_RECORD_2: Synthetic champion two is the next challenger.',
];
const EMBEDDING = Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0);
const root = {
  universeId: UNIVERSE_ID, rootPageId: ROOT_PAGE_ID,
  displayName: 'Synthetic HTTP authority', initialMinimumPageCount: 2,
};
let pool: Pool;
const responsesCreate = jest.fn();
const createEmbedding = jest.fn(async () => [...EMBEDDING]);
const queryDatabase = jest.fn();
const persistModuleConversation = jest.fn();
const storePattern = jest.fn();
const recordTrinityJudgedFeedback = jest.fn(async () => ({
  enabled: false, attempted: false, source: 'clear_audit', reason: 'fixture',
}));
const { AUDITED_TRANSIENT_READ_QUERIES } = await import('../../src/core/db/transientReadRegistry.js');

// Repository factories import client.js directly, rather than db/index.js.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => pool,
  isDatabaseConnected: () => false,
  getStatus: () => ({ connected: false, hasPool: !!pool, error: null }),
  initializeDatabase: jest.fn(async () => false),
  close: jest.fn(), closePoolIfCurrent: jest.fn(),
}));
jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  applyBackstageRosterMutation: jest.fn(), applyBackstageStorylineMutation: jest.fn(),
  close: jest.fn(), createJob: jest.fn(), deleteMemory: jest.fn(), getLatestJob: jest.fn(),
  getMemoryRecordByKey: jest.fn(), getMemoryRecordByLegacyRowId: jest.fn(),
  getMemoryRecordByRecordId: jest.fn(), getPool: () => pool,
  getStatus: () => ({ connected: false, hasPool: !!pool, error: null }),
  initializeDatabase: jest.fn(async () => false), initializeDatabaseWithSchema: jest.fn(async () => false),
  isDatabaseConnected: () => false, isDatabaseSchemaReady: () => false,
  isTransactionCommitAmbiguousError: () => false,
  loadAllRagDocs: jest.fn(async () => []), loadMemory: jest.fn(), loadMemoryRecordById: jest.fn(),
  loadRagDocsByIds: jest.fn(async () => []), logExecution: jest.fn(), logExecutionBatch: jest.fn(),
  query: queryDatabase, saveMemory: jest.fn(), saveRagDoc: jest.fn(),
  transaction: jest.fn(), updateJob: jest.fn(),
}));
jest.unstable_mockModule('@services/openai/embeddings.js', () => ({
  DEFAULT_OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
  createEmbedding, createEmbeddings: jest.fn(),
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ adapter: null, client: { responses: { create: responsesCreate } } }),
  requireOpenAIClientOrAdapter: () => ({ adapter: null, client: { responses: { create: responsesCreate } } }),
}));
jest.unstable_mockModule('@services/moduleConversationPersistence.js', () => ({ persistModuleConversation }));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: 'No memory context available.', accessLog: [] }),
  storePattern,
}));
jest.unstable_mockModule('../../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false,
    forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(), recordTrinityStageFailure: () => 'retry_once',
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: () => 'fixture-integrity-hash',
}));
jest.unstable_mockModule('@transport/http/middleware/publicProviderAdmission.js', () => ({
  publicProviderGptAdmission: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const environment = {
  ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: ACCESS_TOKEN,
  ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON: JSON.stringify({
    [UNIVERSE_ID]: { rootPageId: ROOT_PAGE_ID, displayName: root.displayName },
  }),
  ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'monolith',
  GPT5_MODEL: 'gpt-5', GPT_ASYNC_HEAVY_PROMPT_CHARS: '1',
  OPENAI_STORE: 'true', PRIORITY_QUEUE_ENABLED: 'false',
  GPTID_BACKSTAGE_BOOKER: undefined, GPT_MODULE_MAP: undefined,
  SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG: undefined,
};
const originalEnvironment = new Map(Object.keys(environment).map(name => [name, process.env[name]]));
for (const [name, value] of Object.entries(environment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const { PostgresBackstageNotionRagRepository } = await import('../../src/core/db/repositories/backstageNotionRagRepository.js');
const { PostgresBackstageNotionSyncStatusRepository } = await import('../../src/core/db/repositories/backstageNotionSyncStatusRepository.js');
const { syncBackstageNotionAuthorityRoot } = await import('../../src/services/backstageNotionSync.js');
const { retrieveBackstageNotionAuthorityBookingRagContext } = await import('../../src/services/backstageNotionPartitionCutover.js');
const { runWithBackstageProtectedGenerationRequest, isBackstageNotionEnrichmentAuthorized } = await import('../../src/services/backstageNotionEnrichmentAuthorization.js');
const { BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME } = await import('../../src/shared/backstage/backstageNotionContextCore.js');
const { default: requestContext } = await import('../../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../../src/routes/gptRouter.js');
const { canonicalGptIdentifierBoundary } = await import('../../src/transport/http/middleware/canonicalGptIdentifierBoundary.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.post('/gpt/:gptId', canonicalGptIdentifierBoundary);
  app.use('/gpt', gptRouter);
  return app;
}

function migration(name: string): string {
  return readFileSync(join(process.cwd(), 'migrations', name), 'utf8');
}

afterAll(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describeWithDatabase('Backstage Notion authority through authenticated HTTP and PostgreSQL 18', () => {
  let observer: Client;
  let observerConnected = false;
  let initialized = false;
  let databaseVersion = 0;
  const ownedRollbacks: string[] = [];
  const candidateMigration = '20260902_backstage_notion_rag_candidate_search_v1.sql';
  const installationTables = [
    'backstage_events', 'backstage_wrestlers', 'backstage_storylines', 'backstage_story_beats',
    'backstage_canon_heads', 'backstage_canon_revisions', 'backstage_storyline_threads',
    'backstage_storyline_participants', 'backstage_storyline_canon_beats',
    'backstage_notion_authority_epoch', 'backstage_notion_universe_heads', 'backstage_notion_snapshots',
    'backstage_notion_snapshot_pages', 'backstage_notion_snapshot_chunks',
    'backstage_notion_sync_leases', 'backstage_notion_snapshot_chunk_search',
  ];

  async function installOwnedMigration(name: string): Promise<void> {
    const rollback = migration(name.replace(/\.sql$/u, '.rollback.sql'));
    await observer.query(migration(name));
    // These migrations commit atomically. Register only completed stages so a
    // later setup failure can remove them without assuming absent tables exist.
    ownedRollbacks.push(rollback);
  }

  beforeAll(async () => {
    observer = new Client({ connectionString, ssl: false, application_name: 'backstage-authority-http-observer' });
    await observer.connect();
    observerConnected = true;
    await observer.query('SET search_path TO public, pg_catalog');
    const target = await observer.query<{ current_database: string; server_version_num: string }>(
      `SELECT current_database(), current_setting('server_version_num') AS server_version_num`
    );
    expect(target.rows[0]?.current_database).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(target.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);
    databaseVersion = Number(target.rows[0]!.server_version_num);
    await observer.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    const installation = await observer.query<{ table_count: string }>(
      `SELECT COUNT(*) AS table_count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::TEXT[])`,
      [installationTables]
    );
    const count = Number(installation.rows[0]?.table_count ?? 0);
    if (count === 0) {
      await observer.query(migration('20260814_backstage_universe_scope_v1.sql'));
      // All four base tables were confirmed absent. Dropping these owned tables
      // also removes any incomplete concurrent index from the next stage.
      ownedRollbacks.push(`DROP TABLE public.backstage_story_beats,
        public.backstage_storylines, public.backstage_events, public.backstage_wrestlers`);
      const canon = migration('20260814_backstage_canon_storyline_v1.sql');
      const canonRollback = migration('20260814_backstage_canon_storyline_v1.rollback.sql');
      const transactionStart = canon.indexOf('\nBEGIN;');
      if (transactionStart < 0) throw new Error('Canon migration transaction phase is missing.');
      await observer.query(canon.slice(0, transactionStart).trim());
      await observer.query(canon.slice(transactionStart).trim());
      ownedRollbacks.push(canonRollback);
      for (const name of [
        '20260819_backstage_notion_rag_v1.sql',
        '20260819_backstage_notion_rag_v2_index_version_fence.sql',
        '20260829_backstage_notion_rag_v3_snapshot_capacity.sql', candidateMigration,
      ]) await installOwnedMigration(name);
    } else if (count !== installationTables.length) {
      throw new Error('HTTP PG18 database contains a partial Backstage installation.');
    }
    const status = await observer.query<{ relation: string | null }>(
      `SELECT to_regclass('public.backstage_notion_latest_sync_attempts')::TEXT AS relation`
    );
    if (status.rows[0]?.relation === null) {
      await installOwnedMigration('20260829_backstage_notion_rag_v4_sync_status.sql');
    }
    pool = new Pool({
      connectionString, ssl: false, max: 4, options: '-c search_path=public,pg_catalog',
      application_name: 'backstage-authority-http-repository',
    });
    initialized = true;
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => pool?.end());
    if (observerConnected) {
      // A failed transactional migration leaves this connection aborted; clear
      // it before either fixture-row cleanup or completed-stage rollbacks.
      await cleanup(() => observer.query('ROLLBACK'));
      if (initialized) {
        await cleanup(() => observer.query(`TRUNCATE TABLE public.backstage_notion_universe_heads,
          public.backstage_notion_snapshot_chunk_search, public.backstage_notion_snapshot_chunks,
          public.backstage_notion_snapshot_pages, public.backstage_notion_sync_leases,
          public.backstage_notion_snapshots RESTART IDENTITY CASCADE`));
        await cleanup(() => observer.query(`UPDATE public.backstage_notion_authority_epoch
          SET epoch = 0, updated_at = clock_timestamp() WHERE singleton = TRUE`));
      }
      for (const rollback of ownedRollbacks.reverse()) {
        await cleanup(() => observer.query('ROLLBACK'));
        await cleanup(() => observer.query(rollback));
      }
    }
    await cleanup(async () => observer?.end());
    if (failures.length > 0) throw new AggregateError(failures, 'PostgreSQL HTTP fixture cleanup failed.');
  }, 120_000);

  test('serves nested database inventory snapshots, contains failed refreshes, and recovers through the canonical route', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unexpectedFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('External fetch is forbidden in the PostgreSQL HTTP fixture.')
    );
    responsesCreate.mockResolvedValue({
      id: 'resp_backstage_pg18_http_fixture', model: 'gpt-5.1', status: 'completed',
      output_text: PROVIDER_ANSWER, output: [],
      usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
    });
    const timestamp = new Date().toISOString();
    const titleParts = [...Array.from({ length: 25 }, () => 'a'), ' complete HTTP title'];
    const annotations = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
    const textItem = (content: string) => ({
      type: 'text', text: { content, link: null }, annotations, plain_text: content, href: null,
    });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json' },
    });
    let failTitleRefresh = false;
    let failTopologyRefresh = false;
    let titleReads = 0;
    const notionRequests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.notion.com');
      notionRequests.push(url.pathname);
      if (url.pathname === `/v1/pages/${ROOT_PAGE_ID}`) return json({
        object: 'error', status: 400, code: 'validation_error', message: 'Synthetic database root.',
      }, 400);
      if (url.pathname === `/v1/databases/${ROOT_PAGE_ID}`) return json({
        object: 'database', id: ROOT_PAGE_ID, parent: { type: 'workspace', workspace: true },
        title: [textItem('Synthetic database')], last_edited_time: timestamp, in_trash: false,
        data_sources: [{ id: SOURCE_ID, name: 'Synthetic source' }],
      });
      if (url.pathname === `/v1/data_sources/${SOURCE_ID}/query`) {
        expect(init?.method).toBe('POST');
        return json({
          object: 'list', type: 'page_or_data_source', page_or_data_source: {},
          results: MEMBERS.map(id => ({ object: 'page', id })),
          has_more: false, next_cursor: null, request_status: { type: 'complete' },
        });
      }
      const member = MEMBERS.find(id => url.pathname.startsWith(`/v1/pages/${id}`));
      if (!member) throw new Error('Unexpected synthetic Notion request.');
      if (url.pathname.endsWith('/properties/title')) {
        expect(member).toBe(MEMBERS[0]);
        titleReads += 1;
        const continuation = url.searchParams.has('start_cursor');
        const parts = continuation ? titleParts.slice(25) : titleParts.slice(0, 25);
        const cursor = !failTitleRefresh && !continuation ? 'synthetic-title-page-2' : null;
        const nextUrl = cursor ? new URL(url.pathname, url.origin) : null;
        nextUrl?.searchParams.set('page_size', '100');
        if (cursor) nextUrl?.searchParams.set('start_cursor', cursor);
        return json({
          object: 'list', type: 'property_item',
          results: parts.map(part => ({ object: 'property_item', id: 'title', type: 'title', title: textItem(part) })),
          has_more: failTitleRefresh || !continuation, next_cursor: cursor,
          property_item: { id: 'title', type: 'title', title: {}, next_url: nextUrl?.toString() ?? null },
        });
      }
      if (url.pathname.endsWith('/markdown')) return json({
        object: 'page_markdown', id: member,
        markdown: [
          '# Synthetic championship',
          CONTENT[MEMBERS.indexOf(member)],
          member === MEMBERS[0]
            ? `<page url="notion://${MEMBERS[1]}">Navigation label is not the provider title</page>`
            : `<mention-page url="notion://${MEMBERS[0]}">Parent reference</mention-page>`,
          `<mention-page url="notion://${EXTERNAL_REFERENCE_ID}">External reference</mention-page>`,
        ].join('\n\n'),
        truncated: false, unknown_block_ids: [],
      });
      expect(url.pathname).toBe(`/v1/pages/${member}`);
      return json({
        object: 'page', id: member,
        parent: member === MEMBERS[0]
          ? { type: 'database_id', database_id: ROOT_PAGE_ID }
          : { type: 'page_id', page_id: failTopologyRefresh ? EXTERNAL_REFERENCE_ID : MEMBERS[0] },
        properties: { 'Synthetic label': { id: 'title', type: 'title',
          title: member === MEMBERS[0] ? titleParts.slice(0, 25).map(part => ({
            type: 'mention', mention: { type: 'page', page: { id: MEMBERS[1] } },
            annotations, plain_text: part, href: `https://www.notion.so/${MEMBERS[1]!.replaceAll('-', '')}`,
          })) : [textItem('Second synthetic member')],
        } },
        last_edited_time: timestamp, in_trash: false,
      });
    };
    const repository = new PostgresBackstageNotionRagRepository(pool);
    const syncStatusRepository = new PostgresBackstageNotionSyncStatusRepository(pool);
    const sync = () => syncBackstageNotionAuthorityRoot(root, {
      repository, syncStatusRepository, fetchImpl,
      embedBatch: async (inputs: readonly string[]) => inputs.map(() => [...EMBEDDING]),
      readEnvironment: name => name === BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME ? `ntn_${'s'.repeat(48)}` : undefined,
      holderId: 'synthetic-http-pg18', requestSpacingMs: 0, retryBaseDelayMs: 0,
      fetchTimeoutMs: 1_000, cycleTimeoutMs: 15_000,
    });
    const app = buildApp();
    const readContinuity = (retrievalMode = 'complete_scope', bearer: string | null = ACCESS_TOKEN) => {
      const post = request(app).post('/gpt/backstage-booker');
      if (bearer !== null) post.set('Authorization', `Bearer ${bearer}`);
      return post.send({ action: 'queryContinuity', executionMode: 'async',
        payload: { universeId: UNIVERSE_ID, query: QUERY, retrievalMode },
      });
    };

    expect((await readContinuity('complete_scope', 'invalid-fixture-bearer')).status).toBe(401);
    const absent = await readContinuity();
    expect(absent.status).toBe(503);
    expect(absent.body.error.code).toBe('BACKSTAGE_NOTION_INDEX_UNAVAILABLE');
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(notionRequests).toHaveLength(0);

    const activated = await sync();
    expect(activated).toMatchObject({ status: 'activated', pageCount: 3, chunkCount: 2 });
    expect(titleReads).toBe(4);
    const inventory = await repository.loadActiveInventory(UNIVERSE_ID);
    expect(inventory?.pages.find(page => page.pageId === MEMBERS[0])).toMatchObject({
      title: titleParts.join(''), parentPageId: ROOT_PAGE_ID,
      depth: 1, path: [root.displayName, titleParts.join('')],
    });
    expect(inventory?.pages.find(page => page.pageId === MEMBERS[1])).toMatchObject({
      title: 'Second synthetic member', parentPageId: MEMBERS[0],
      depth: 2, path: [root.displayName, titleParts.join(''), 'Second synthetic member'],
    });
    expect(inventory?.pages.map(page => page.pageId).sort()).toEqual([ROOT_PAGE_ID, ...MEMBERS].sort());
    for (const member of MEMBERS) {
      expect(notionRequests.filter(path => path === `/v1/pages/${member}/markdown`)).toHaveLength(1);
    }
    expect(notionRequests.some(path => path.includes(EXTERNAL_REFERENCE_ID))).toBe(false);
    expect(await syncStatusRepository.loadLatestSyncAttempt(UNIVERSE_ID)).toMatchObject({
      outcome: 'activated', activatedSnapshotId: activated.snapshotId,
      pagesDiscovered: 3, pagesFetched: 2, blocksFetched: 2,
      candidateSnapshotCreated: true, candidateSnapshotValidated: true, candidateSnapshotActivated: true,
    });
    const denied = await readContinuity('complete_scope', null);
    expect(denied.status).toBe(503);
    expect(denied.body.error.code).toBe('BACKSTAGE_NOTION_INDEX_UNAVAILABLE');
    expect(responsesCreate).not.toHaveBeenCalled();

    for (const mode of ['complete_scope', 'relevant']) {
      const response = await readContinuity(mode);
      expect(response.status).toBe(200);
      expect(response.headers['x-gpt-queue-bypassed']).toBe('true');
      expect(response.body).toMatchObject({ ok: true, result: {
        universeId: UNIVERSE_ID, authority: 'notion', answer: PROVIDER_ANSWER,
        coverage: { status: mode === 'relevant' ? 'sampled' : 'complete', scopeChunks: 2, selectedChunks: 2, hasMore: false },
      }, _route: { gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', action: 'queryContinuity', route: 'backstage-booker' } });
      const stored = await observer.query<{ chunk_id: string; content_hash: string }>(
        'SELECT id AS chunk_id, content_hash FROM public.backstage_notion_snapshot_chunks WHERE universe_id = $1 AND snapshot_id = $2',
        [UNIVERSE_ID, activated.snapshotId]
      );
      expect(response.body.result.sources.map((source: { sourceId: string }) => source.sourceId).sort())
        .toEqual(stored.rows.map(row => row.chunk_id).sort());
      expect(response.body.result.sources.map((source: { contentHash: string }) => source.contentHash).sort())
        .toEqual(stored.rows.map(row => row.content_hash).sort());
      const publicBody = JSON.stringify(response.body);
      for (const privateValue of [ROOT_PAGE_ID, SOURCE_ID, EXTERNAL_REFERENCE_ID, ...MEMBERS, ...CONTENT]) expect(publicBody).not.toContain(privateValue);
    }
    expect(createEmbedding).toHaveBeenCalledWith(QUERY);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    for (const [providerRequest, providerOptions] of responsesCreate.mock.calls as unknown as [
      { input: unknown; store: boolean; max_output_tokens: number }, { signal: AbortSignal },
    ][]) {
      const prompt = JSON.stringify(providerRequest.input);
      expect(prompt).toContain(QUERY);
      for (const content of CONTENT) expect(prompt).toContain(content);
      expect(prompt).toContain('instruction_authority: none');
      expect(providerRequest).toMatchObject({ store: false, max_output_tokens: 900 });
      expect(providerOptions.signal).toBeInstanceOf(AbortSignal);
    }

    failTitleRefresh = true;
    await expect(sync()).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_SYNC_ROOT_FAILED', diagnostics: { candidateSnapshotActivated: false },
    });
    expect(await repository.loadActiveInventory(UNIVERSE_ID)).toEqual(inventory);
    expect(await syncStatusRepository.loadLatestSyncAttempt(UNIVERSE_ID)).toMatchObject({
      outcome: 'failed', candidateSnapshotActivated: false, activatedSnapshotId: null,
    });
    const stale = await readContinuity();
    expect(stale.status).toBe(200);
    expect(stale.body.result.answer).toContain('Snapshot status: last_known_good');
    expect(stale.body.result.answer).toContain('latest sync outcome: failed');
    expect(stale.body.result.answer).toContain('This is older verified continuity, not current workspace state.');
    expect(stale.body.result.answer).toContain(PROVIDER_ANSWER.slice(2));
    const providerCount = responsesCreate.mock.calls.length;
    await expect(runWithBackstageProtectedGenerationRequest(() =>
      retrieveBackstageNotionAuthorityBookingRagContext(UNIVERSE_ID, 'Synthetic booking')
    )).rejects.toMatchObject({ code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' });
    expect(responsesCreate).toHaveBeenCalledTimes(providerCount);

    failTitleRefresh = false;
    failTopologyRefresh = true;
    await expect(sync()).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_SYNC_INCOMPLETE',
      diagnostics: {
        topologyRejectionCode: 'provider_parent_mismatch',
        candidateSnapshotCreated: false, candidateSnapshotValidated: false, candidateSnapshotActivated: false,
      },
    });
    expect(await repository.loadActiveInventory(UNIVERSE_ID)).toEqual(inventory);
    expect(await syncStatusRepository.loadLatestSyncAttempt(UNIVERSE_ID)).toMatchObject({
      outcome: 'failed', candidateSnapshotCreated: false,
      candidateSnapshotValidated: false, candidateSnapshotActivated: false, activatedSnapshotId: null,
    });
    const topologyStale = await readContinuity();
    expect(topologyStale.status).toBe(200);
    expect(topologyStale.body.result.answer).toContain('Snapshot status: last_known_good');
    expect(topologyStale.body.result.answer).toContain(PROVIDER_ANSWER.slice(2));

    failTopologyRefresh = false;
    expect(await sync()).toMatchObject({ status: 'unchanged', snapshotId: activated.snapshotId });
    const recovered = await readContinuity();
    expect(recovered.status).toBe(200);
    expect(recovered.body.result.answer).toBe(PROVIDER_ANSWER);
    expect((await observer.query<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM public.backstage_notion_snapshots WHERE universe_id = $1', [UNIVERSE_ID]
    )).rows).toEqual([{ count: '1' }]);
    expect(queryDatabase).not.toHaveBeenCalled();
    expect(persistModuleConversation).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
    expect(notionRequests.some(path => path.includes(EXTERNAL_REFERENCE_ID))).toBe(false);
    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
    process.stdout.write(`NOTION_AUTHORITY_HTTP_E2E ${JSON.stringify({
      schema: 'backstage-notion-authority-http-e2e/v1',
      postgresVersion: databaseVersion,
      phases: [
        'invalid_bearer_denied', 'missing_head_denied', 'database_parent_title_pagination_activated',
        'nested_inventory_member_structural_parent', 'page_mentions_do_not_expand_scope',
        'missing_bearer_denied', 'complete_scope_http_sql_citations', 'relevant_http_sql_citations',
        'failed_refresh_retains_head', 'last_known_good_http_warning',
        'protected_booking_retrieval_denied', 'provider_parent_mismatch_retains_head',
        'topology_failed_refresh_last_known_good_http', 'unchanged_refresh_restores_current',
      ],
      pageCount: 3, chunkCount: 2, retainedSnapshotCount: 1,
      providerCalls: responsesCreate.mock.calls.length,
      unexpectedNetworkCalls: unexpectedFetch.mock.calls.length,
      provider: 'deterministic_fixture', notion: 'deterministic_transport_fixture',
    })}\n`);
  }, 60_000);
});
