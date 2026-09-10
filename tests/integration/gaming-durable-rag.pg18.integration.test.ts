import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool } from 'pg';
import type { PersistGamingSourceRevisionInput } from '../../src/core/db/repositories/gamingSourceRepository.js';
import {
  chunkGamingDocument,
  GAMING_DOCUMENT_CHUNKING_VERSION,
  GAMING_DURABLE_DOCUMENT_LIMITS,
  hashGamingDocumentRevision
} from '../../src/services/gamingDurableDocumentChunks.js';
import { buildGamingDocumentSearchText } from '../../src/shared/gaming/gamingDocumentIngestionCore.js';
import {
  buildStoredGamingLexicalQuery,
  formatStoredGamingEvidence,
  selectStoredGamingEvidence
} from '../../src/shared/gaming/gamingStoredEvidenceCore.js';
import { buildGamingLargeGuideFixture } from '../testUtils/gamingLargeGuideFixture.js';
import { gamingAcquisitionAxios } from '../testUtils/gamingAcquisitionFixtures.js';
import { extractGamingJsonEvidence } from '../../src/services/gamingJsonEvidence.js';
import { assessGamingClearSource } from '../../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata } from '../../src/shared/gaming/gamingFreshnessCore.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl
} from './postgresTestDatabase.js';

// Reuse the existing CI disposable PostgreSQL service; never read DATABASE_URL.
const TEST_DATABASE_ENV = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const configuredConnectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (configuredConnectionString) {
  assertDisposablePostgresTestDatabaseUrl(configuredConnectionString, TEST_DATABASE_ENV);
}
const describeWithDatabase = configuredConnectionString ? describe : describe.skip;
const schemaName = `gaming_durable_rag_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const migration = readFileSync(join(process.cwd(), 'migrations', '20260808_gaming_knowledge_sources.sql'), 'utf8');
const game = 'Kingdom Hearts HD 1.5 Remix';
const fetchedAt = '2026-09-01T00:00:00.000Z';
const limits = { chunkChars: 1200, maxChunks: 8, maxSources: 3, maxContextChars: 5000, structuredEvidenceChars: 8000 };
let databasePool: Pool;
const mockSourceHttpGet = jest.fn();
const mockSourceEnqueue = jest.fn();

// These two boundaries are controlled; acquisition safety, extraction, CLEAR,
// source ingestion and the repository remain real implementations.
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockSourceHttpGet) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  findOrCreateGptJob: mockSourceEnqueue, getJobById: jest.fn(),
  IdempotencyKeyConflictError: class extends Error {}, JobRepositoryUnavailableError: class extends Error {}
}));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: async () => ({ status: 'pending', maxRetries: 2 })
}));

// Only the configured pool lookup is replaced. Repository transactions, rows,
// indexes, full-text matching and ranking all execute in actual PostgreSQL 18.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => databasePool,
  isDatabaseConnected: () => Boolean(databasePool)
}));
const { persistGamingSourceRevision, searchActiveGamingKnowledge, findActiveGamingSourceIdentities } =
  await import('../../src/core/db/repositories/gamingSourceRepository.js');

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function prepareDocument(text: string, gameKey: string): Promise<PersistGamingSourceRevisionInput> {
  const chunked = await chunkGamingDocument(text);
  expect(chunked.coverageStatus).toBe('complete');
  expect(chunked.indexedChars).toBe(chunked.text.length);
  expect(chunked.chunks.length).toBeGreaterThan(300);
  expect(chunked.chunks.length).toBeLessThanOrEqual(500);
  const title = 'Synthetic durable guide';
  const publicUrl = `https://example.com/${gameKey}`;
  return {
    gameKey, gameName: game, canonicalUrl: publicUrl, publicUrl, sourceType: 'supplied', trustScore: 0.8,
    contentHash: hashGamingDocumentRevision(chunked.text, JSON.stringify({ game, title })),
    cleanedContent: chunked.text.slice(0, GAMING_DURABLE_DOCUMENT_LIMITS.revisionPreviewChars),
    fetchedAt, extractor: 'archive-org', extractorVersion: 'archive-text-v1',
    normalizerSchemaVersion: GAMING_DOCUMENT_CHUNKING_VERSION,
    provenance: { resolverId: 'archive-org', resolverVersion: 'archive-text-v1', resolutionStrategy: 'archive_djvu_text' },
    extractionMetrics: { documentCharsIndexed: chunked.indexedChars, chunkCount: chunked.chunks.length, coverageStatus: chunked.coverageStatus },
    records: chunked.chunks.map(chunk => {
      const { text: chunkText, semanticKey, ...metadata } = chunk;
      const normalized = { schemaVersion: GAMING_DOCUMENT_CHUNKING_VERSION, game, title, text: chunkText, chunk: metadata };
      return {
        recordType: 'guide', semanticKey, payloadHash: hash(JSON.stringify(normalized)), title,
        searchText: buildGamingDocumentSearchText({ cleanedText: chunkText, title, game, normalizedEvidence: '', maxChars: 4600 }),
        normalized
      };
    })
  };
}

async function query(gameKey: string, prompt: string) {
  const { query: lexicalQuery } = buildStoredGamingLexicalQuery(prompt, game);
  return searchActiveGamingKnowledge({ gameKey, query: lexicalQuery, mode: 'guide', limit: 20 }, { queryTimeoutMs: 1000 });
}

describeWithDatabase('durable Gaming chunk storage and retrieval on PostgreSQL 18', () => {
  let setupClient: Client;
  let schemaCreated = false;
  let setupConnected = false;

  beforeAll(async () => {
    if (!configuredConnectionString) throw new Error(`${TEST_DATABASE_ENV} is required for this test suite.`);
    setupClient = new Client({ connectionString: configuredConnectionString, ssl: false, application_name: 'arcanos-gaming-durable-rag-pg18-test' });
    await setupClient.connect();
    setupConnected = true;
    const identity = await setupClient.query<{ database_name: string; server_version_num: string }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num"
    );
    expect(identity.rows[0].database_name).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(identity.rows[0].server_version_num)).toBeGreaterThanOrEqual(180_000);
    expect(Number(identity.rows[0].server_version_num)).toBeLessThan(190_000);
    await setupClient.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await setupClient.query(`SET search_path TO ${quotedSchema}, pg_catalog`);
    await setupClient.query(migration);
    databasePool = new Pool({
      connectionString: configuredConnectionString, ssl: false, max: 2,
      application_name: 'arcanos-gaming-durable-rag-pg18-repository',
      options: `-c search_path=${schemaName},pg_catalog`,
      connectionTimeoutMillis: 5000, statement_timeout: 10000
    });
  }, 30000);

  afterAll(async () => {
    await databasePool?.end();
    if (setupConnected) {
      try {
        if (schemaCreated) await setupClient.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      } finally {
        await setupClient.end();
      }
    }
  });

  test('acquires a short structured source, passes real source CLEAR, ingests, and retrieves without its URL', async () => {
    const { resolveGamingDocument } = await import('../../src/services/gamingDocumentResolution.js');
    const {
      createGamingSourceIngestion, executeQueuedGamingSourceIngestion, buildStoredGamingKnowledgeContext,
      refreshGamingSources, hashGamingApprovedDocument
    } = await import('../../src/services/gamingSourceIngestion.js');
    const structuredGame = 'Void Frontier';
    const publicUrl = `https://guides.example.org/void-frontier/${randomUUID()}`;
    const prompt = 'Which system, body and site reports Platinum in TEST-ORION-01?';
    let site = 'PML 7';
    const page = () => `<html><head><title>Void Frontier guide</title></head><body><main><h1>Void Frontier</h1><table><tr><th>System</th><th>Body</th><th>Site</th><th>Resource</th></tr><tr><td>TEST-ORION-01</td><td>B 2</td><td>${site}</td><td>Platinum</td></tr></table></main></body></html>`;
    mockSourceHttpGet.mockImplementation(async (url: string, options: any) => {
      expect(new URL(url).hostname).toBe('93.184.216.34');
      expect(options).toMatchObject({ maxRedirects: 0, proxy: false, headers: { Host: 'guides.example.org' } });
      return { data: page(), headers: { 'content-type': 'text/html' } };
    });
    mockSourceEnqueue.mockImplementation(async (input: any) => ({
      job: { id: randomUUID(), status: 'pending', created_at: new Date(), input: input.input }, created: true, deduped: false
    }));
    const input = { game: structuredGame, prompt, mode: 'guide' as const };
    const document = await resolveGamingDocument(publicUrl);
    expect(document.evidenceUnits).toHaveLength(1);
    expect(document.evidenceUnits![0].text.length).toBeLessThan(120);
    const now = new Date('2026-09-10T12:00:00Z');
    const assessment = assessGamingClearSource(input, document, {
      subjectId: publicUrl, subjectHash: hashGamingApprovedDocument(document), actorScopeHash: hash('disposable-reader'),
      sourcePolicy: assessGamingSourcePolicy(publicUrl, structuredGame),
      freshness: extractGamingFreshnessMetadata(document, input, now), now
    });
    expect(assessment).toMatchObject({ qualityEligible: true, decision: 'accept', gates: { claimSupport: 'verified' } });
    expect(assessment.dimensionScores.clarity.reasonCodes).toContain('INTELLIGIBLE_HEADER_VALUE_RELATIONSHIPS');
    const gateway = { actorKey: 'disposable-structured-reader', requestId: 'disposable-request', traceId: 'disposable-trace' };
    const admitted = await createGamingSourceIngestion({ action: 'ingest', payload: {
      game: structuredGame, sourceUrls: [publicUrl], idempotencyKey: `structured-${randomUUID()}`
    } }, gateway);
    expect(admitted.statusCode).toBe(202);
    const queuedBody = () => (mockSourceEnqueue.mock.calls.at(-1)![0] as any).input.body;
    const stored = await executeQueuedGamingSourceIngestion(randomUUID(), queuedBody());
    expect(stored.output.sources[0]).toMatchObject({ status: 'stored' });
    const firstRecordCount = stored.output.sources[0].recordsCreated;
    expect(firstRecordCount).toBeGreaterThanOrEqual(1);
    const sourceId = stored.output.sources[0].sourceId!;
    const records = await searchActiveGamingKnowledge({ gameKey: 'void-frontier', query: 'platinum', mode: 'guide', sourceIds: [sourceId] });
    expect(records).toHaveLength(1);
    const firstRevision = records[0].revisionId;
    const retrieved = await buildStoredGamingKnowledgeContext({ ...input, failOnUnavailable: true });
    expect(retrieved.context).toContain('TEST-ORION-01');
    expect(retrieved.context).toContain('B 2');
    expect(retrieved.context).toContain('PML 7');
    expect(retrieved.sources.some(source => source.url === publicUrl)).toBe(true);
    expect(retrieved.evidence?.some(evidence => evidence.sourceId === sourceId && evidence.revisionId === firstRevision
      && evidence.evidenceUnits?.some(unit => unit.provenance.sourceUrl === publicUrl && unit.provenance.strategy === 'html_table'))).toBe(true);
    const refresh = async () => {
      const admittedRefresh = await refreshGamingSources({ action: 'refresh', payload: { sourceIds: [sourceId], idempotencyKey: `refresh-${randomUUID()}` } }, gateway);
      expect(admittedRefresh.statusCode).toBe(202);
      return executeQueuedGamingSourceIngestion(randomUUID(), queuedBody());
    };
    expect((await refresh()).output.sources[0]).toMatchObject({ status: 'unchanged', recordsCreated: 0, recordsUpdated: 0 });
    site = 'PML 8';
    expect((await refresh()).output.sources[0]).toMatchObject({ status: 'updated', recordsCreated: firstRecordCount, recordsUpdated: firstRecordCount });
    const changed = await buildStoredGamingKnowledgeContext({ ...input, failOnUnavailable: true });
    expect(changed.context).toContain('PML 8');
    expect(changed.context).not.toContain('PML 7');
    expect(changed.evidence?.some(evidence => evidence.sourceId === sourceId && evidence.revisionId !== firstRevision)).toBe(true);
    const statuses = await databasePool.query<{ status: string }>(
      'SELECT status FROM gaming_knowledge_records WHERE source_id = $1 ORDER BY status', [sourceId]);
    expect(statuses.rows.filter(row => row.status === 'active')).toHaveLength(firstRecordCount);
    expect(statuses.rows.filter(row => row.status === 'superseded')).toHaveLength(firstRecordCount);
    mockSourceHttpGet.mockReset(); mockSourceEnqueue.mockReset();
  }, 30000);

  test('retains JSON record provenance beyond 100K and revisions a late change through actual SQL', async () => {
    const { GAMING_DOCUMENT_RESOLVER_VERSION } = await import('../../src/services/gamingDocumentResolution.js');
    const gameKey = `structured-late-${randomUUID()}`;
    const publicUrl = `https://guides.example.org/${gameKey}`;
    const prepare = async (site: string): Promise<PersistGamingSourceRevisionInput> => {
      const parsed = extractGamingJsonEvidence({ sourceUrl: publicUrl, contentType: 'application/json',
        body: JSON.stringify({ system: 'TEST-ORION-01', body: 'B 2', site, resource: 'Platinum' }) });
      expect(parsed.units).toHaveLength(1);
      const text = `${'An ordinary synthetic guide explains equipment and safe travel. '.repeat(2_000)}\n\n${parsed.units[0].text}`;
      expect(text.indexOf(parsed.units[0].text)).toBeGreaterThan(100_000);
      const chunked = await chunkGamingDocument(text, { evidenceUnits: parsed.units });
      expect(chunked.coverageStatus).toBe('complete');
      expect(chunked.chunks.filter(chunk => chunk.evidenceUnits?.length)).toHaveLength(1);
      return {
        gameKey, gameName: 'Void Frontier', canonicalUrl: publicUrl, publicUrl, sourceType: 'supplied', trustScore: 0.25,
        contentHash: hashGamingDocumentRevision(chunked.text, JSON.stringify(parsed.units)),
        cleanedContent: chunked.text.slice(0, GAMING_DURABLE_DOCUMENT_LIMITS.revisionPreviewChars), fetchedAt,
        extractor: 'generic-web', extractorVersion: GAMING_DOCUMENT_RESOLVER_VERSION, normalizerSchemaVersion: GAMING_DOCUMENT_CHUNKING_VERSION,
        provenance: { resolverId: 'generic-web', evidenceUnitPolicyVersion: parsed.units[0].provenance.policyVersion },
        records: chunked.chunks.map(chunk => {
          const { text: chunkText, semanticKey, evidenceUnits, ...chunkMetadata } = chunk;
          const normalized = { game: 'Void Frontier', text: chunkText, chunk: chunkMetadata, ...(evidenceUnits?.length ? { evidenceUnits } : {}) };
          return { recordType: 'guide', semanticKey, payloadHash: hash(JSON.stringify(normalized)), searchText: chunkText, normalized };
        })
      };
    };
    const original = await prepare('PML 7');
    const first = await persistGamingSourceRevision(original);
    expect(await persistGamingSourceRevision(original)).toMatchObject({ state: 'unchanged', revisionId: first.revisionId });
    const input = { game: 'Void Frontier', prompt: 'Which system body site reports Platinum in TEST-ORION-01?', mode: 'guide' as const };
    const rows = await searchActiveGamingKnowledge({ gameKey, query: 'platinum', mode: 'guide' });
    const selected = selectStoredGamingEvidence(rows, input, limits);
    const formatted = formatStoredGamingEvidence(selected, { maxContextChars: 2000 }, limits);
    expect(formatted.context).toContain('PML 7');
    expect(formatted.evidence?.[0].startChar).toBeGreaterThan(100_000);
    expect(formatted.evidence?.[0].evidenceUnits?.[0].provenance).toMatchObject({ strategy: 'application_json', jsonOnly: true, sourceUrl: publicUrl });
    const revised = await prepare('PML 8');
    expect(revised.cleanedContent).toBe(original.cleanedContent);
    expect(revised.contentHash).not.toBe(original.contentHash);
    const second = await persistGamingSourceRevision(revised);
    expect(second).toMatchObject({ state: 'updated', sourceId: first.sourceId });
    expect(second.revisionId).not.toBe(first.revisionId);
    const active = await searchActiveGamingKnowledge({ gameKey, query: 'platinum', mode: 'guide' });
    expect(active.every(row => row.revisionId === second.revisionId)).toBe(true);
    const after = formatStoredGamingEvidence(selectStoredGamingEvidence(active, input, limits), { maxContextChars: 2000 }, limits);
    expect(after.context).toContain('PML 8');
    expect(after.context).not.toContain('PML 7');
  }, 30000);

  test('matches stored title formatting across three games without collapsing editions or reindexing historical keys', async () => {
    for (const [storedName, requestedName, otherEdition] of [
      ['Lantern™ Voyage®: Remastered – 1.5', 'Lantern Voyage Remastered 1.5', 'Lantern Voyage'],
      ['Pilot’s Oath - PC Edition', "Pilot's Oath: PC Edition", "Pilot's Oath Console Edition"],
      ['Ａｓｈｂｏｕｎｄ Arena — II', 'Ashbound Arena II', 'Ashbound Arena I'],
      ['AETHER CAFÉ™: II', 'Aether Café II', 'Aether Cafe II'],
      ['ΝΗΣΟΣ™: II', 'Νησος II', 'Νησος I'],
      ['İris™: II', 'İris II', 'Iris II']
    ]) {
      const text = 'At Copper Quay, activate the blue beacon to unlock the ferry.';
      const gameKey = `historical-${randomUUID()}`;
      const source = await persistGamingSourceRevision({
        gameKey, gameName: storedName, canonicalUrl: `https://example.com/${gameKey}`, sourceType: 'supplied',
        contentHash: hash(text), cleanedContent: text, fetchedAt, extractor: 'synthetic', extractorVersion: '1', normalizerSchemaVersion: '1',
        records: [{ recordType: 'guide', semanticKey: 'copper-quay', payloadHash: hash(text), searchText: text, normalized: { text } }]
      });
      const identities = await findActiveGamingSourceIdentities({ game: requestedName, mode: 'guide' }, { queryTimeoutMs: 1000 });
      expect(identities).toEqual([{ sourceId: source.sourceId, gameKey, gameName: storedName }]);
      expect(await findActiveGamingSourceIdentities({ game: requestedName, edition: 'Incompatible Remake', mode: 'guide' })).toEqual([]);
      expect(await findActiveGamingSourceIdentities({ game: otherEdition, mode: 'guide' })).toEqual([]);
      expect(await findActiveGamingSourceIdentities({ game: requestedName, mode: 'build' })).toEqual([]);
      // The precise title cannot reach the historical key through the old exact-key path.
      expect(await searchActiveGamingKnowledge({ gameKey: requestedName, query: 'copper', mode: 'guide' })).toEqual([]);
      const scope = { gameKey: requestedName, sourceIds: identities.map(identity => identity.sourceId), mode: 'guide' as const };
      expect(await searchActiveGamingKnowledge({ ...scope, query: '' })).toEqual([]);
      const query = buildStoredGamingLexicalQuery('What next?', requestedName, { currentArea: 'Copper Quay' });
      const records = await searchActiveGamingKnowledge({ ...scope, query: query.query });
      expect(records).toHaveLength(1);
      expect(records[0].relevance).toBeGreaterThan(0);
      expect(selectStoredGamingEvidence(records, { game: requestedName, prompt: 'What next?', currentArea: 'Copper Quay', mode: 'guide' }, limits)).toHaveLength(1);
      await databasePool.query("UPDATE gaming_sources SET status = 'disabled' WHERE id = $1", [source.sourceId]);
      expect(await findActiveGamingSourceIdentities({ game: requestedName, mode: 'guide' })).toEqual([]);
    }
  });

  test('a separate edition field selects the complete trusted identity and rejects a base-only catalog', async () => {
    const text = 'The Glass Warden raises its shield before the strike.';
    const gameKey = `edition-${randomUUID()}`;
    const persist = (edition: string) => persistGamingSourceRevision({
      gameKey: `${gameKey}-${edition}`, gameName: `Lantern Vale${edition ? ` ${edition}` : ''}`,
      canonicalUrl: `https://example.com/${gameKey}-${edition}`, sourceType: 'supplied',
      contentHash: hash(text), cleanedContent: text, fetchedAt, extractor: 'synthetic', extractorVersion: '1', normalizerSchemaVersion: '1',
      records: [{ recordType: 'guide', semanticKey: 'warden', payloadHash: hash(text), searchText: text, normalized: { text } }]
    });
    await persist('');
    expect(await findActiveGamingSourceIdentities({ game: 'Lantern Vale', edition: 'Remake', mode: 'guide' })).toEqual([]);
    const remake = await persist('Remake');
    expect(await findActiveGamingSourceIdentities({ game: 'Lantern Vale', edition: 'Remake', mode: 'guide' }))
      .toEqual([{ sourceId: remake.sourceId, gameKey: `${gameKey}-Remake`.toLowerCase(), gameName: 'Lantern Vale Remake' }]);
    expect(await findActiveGamingSourceIdentities({ game: 'Lantern Vale Remake', edition: 'Remake', mode: 'guide' }))
      .toHaveLength(1);
  });

  test('retrieves late and near-end facts through real indexed SQL and bounded evidence projection', async () => {
    const fixture = buildGamingLargeGuideFixture();
    expect(fixture.text.length).toBeGreaterThan(590_000);
    const document = await prepareDocument(fixture.text, 'durable-large-guide');
    const persisted = await persistGamingSourceRevision(document);
    expect(persisted).toMatchObject({ state: 'created', recordsCreated: document.records.length, recordsUpdated: 0 });
    const preview = await databasePool.query<{ cleaned_content: string }>('SELECT cleaned_content FROM gaming_source_revisions WHERE id = $1', [persisted.revisionId]);
    expect(preview.rows[0].cleaned_content.length).toBe(16000);
    expect(preview.rows[0].cleaned_content).not.toContain(fixture.markers.nearEnd);

    for (const [prompt, fact, minimumOffset] of [
      ['Where is the Clockwork Observatory?', fixture.markers.late, 400_000],
      ['Where is the Zephyrglass Compass?', fixture.markers.nearEnd, 580_000]
    ] as const) {
      const rows = await query(document.gameKey, prompt);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(20);
      expect(rows.every(row => row.relevance > 0 && row.revisionId === persisted.revisionId)).toBe(true);
      const selected = selectStoredGamingEvidence(rows, { game, prompt, mode: 'guide' }, limits);
      const formatted = formatStoredGamingEvidence(selected, { sourceIndexOffset: 2, maxContextChars: 3000 }, limits);
      expect(formatted.context.length).toBeLessThanOrEqual(3000);
      expect(formatted.context).toContain(fact);
      expect(formatted.sources).toHaveLength(1);
      expect(formatted.context).toContain('[Source 3]');
      expect(formatted.context).not.toContain('[Source 4]');
      const evidence = formatted.evidence!.find(chunk => chunk.text.includes(fact))!;
      expect(evidence).toMatchObject({ sourceId: persisted.sourceId, revisionId: persisted.revisionId,
        provenance: { fetchedAt, resolverId: 'archive-org', resolverVersion: 'archive-text-v1', resolutionStrategy: 'archive_djvu_text' } });
      expect(evidence.startChar).toBeGreaterThan(minimumOffset);
      expect(rows.some(row => row.recordId === evidence.recordId)).toBe(true);
      expect(JSON.stringify(formatted.sources)).not.toContain(persisted.revisionId);
      expect(JSON.stringify(formatted.sources)).not.toContain(evidence.recordId);
    }
    expect(await query(document.gameKey, 'Where is Unindexedmarigold?')).toEqual([]);
    expect(await query('different-game-scope', 'Where is Zephyrglass?')).toEqual([]);
    await databasePool.query("UPDATE gaming_sources SET status = 'disabled' WHERE id = $1", [persisted.sourceId]);
    expect(await query(document.gameKey, 'Where is Zephyrglass?')).toEqual([]);
  }, 30000);

  test('keeps unchanged revisions and supersedes or reactivates complete chunk generations after a deep edit', async () => {
    const fixture = buildGamingLargeGuideFixture();
    const original = await prepareDocument(fixture.text, 'durable-refresh-guide');
    const first = await persistGamingSourceRevision(original);
    const firstRows = await query(original.gameKey, 'Where is Zephyrglass?');
    expect(firstRows.length).toBeGreaterThan(0);
    expect(await persistGamingSourceRevision(original)).toMatchObject({
      state: 'unchanged', sourceId: first.sourceId, revisionId: first.revisionId, recordsCreated: 0, recordsUpdated: 0
    });
    const changed = await prepareDocument(fixture.text.replace('Zephyrglass', 'Amberglass'), original.gameKey);
    expect(changed.cleanedContent).toBe(original.cleanedContent);
    expect(changed.contentHash).not.toBe(original.contentHash);
    const second = await persistGamingSourceRevision(changed);
    expect(second).toMatchObject({ state: 'updated', sourceId: first.sourceId, recordsCreated: changed.records.length, recordsUpdated: original.records.length });
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(await query(original.gameKey, 'Where is Zephyrglass?')).toEqual([]);
    const changedRows = await query(original.gameKey, 'Where is Amberglass?');
    expect(changedRows.length).toBeGreaterThan(0);
    expect(changedRows.every(row => row.revisionId === second.revisionId)).toBe(true);

    const restored = await persistGamingSourceRevision(original);
    expect(restored).toMatchObject({ state: 'updated', sourceId: first.sourceId, revisionId: first.revisionId,
      recordsCreated: 0, recordsUpdated: changed.records.length });
    expect(await query(original.gameKey, 'Where is Amberglass?')).toEqual([]);
    expect((await query(original.gameKey, 'Where is Zephyrglass?')).map(row => row.recordId)).toEqual(firstRows.map(row => row.recordId));
    const generations = await databasePool.query<{ source_revision_id: string; status: string; count: number }>(
      `SELECT source_revision_id, status, COUNT(*)::integer AS count FROM gaming_knowledge_records
       WHERE game_key = $1 GROUP BY source_revision_id, status`, [original.gameKey]
    );
    expect(generations.rows).toEqual(expect.arrayContaining([
      { source_revision_id: first.revisionId, status: 'active', count: original.records.length },
      { source_revision_id: second.revisionId, status: 'superseded', count: changed.records.length }
    ]));
    expect(generations.rows).toHaveLength(2);
    expect((await databasePool.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM gaming_source_revisions WHERE source_id = $1', [first.sourceId])).rows[0].count).toBe(2);
  }, 30000);

  test('advances unchanged hybrid resource verification monotonically without changing revision or active chunks', async () => {
    const gameKey = `hybrid-freshness-${randomUUID()}`;
    const text = 'The Glass Warden opens its shield after the blue beacon pulses.';
    const original: PersistGamingSourceRevisionInput = {
      gameKey, gameName: 'Lantern Vale', canonicalUrl: `https://example.com/${gameKey}`,
      sourceType: 'supplied', contentHash: hash(text), cleanedContent: text,
      fetchedAt: '2026-09-01T00:00:00.000Z', extractor: 'synthetic', extractorVersion: '1',
      normalizerSchemaVersion: 'gaming-hybrid-fixture-v1',
      provenance: {
        retainedResolverField: 'synthetic-only',
        hybridFreshness: { verifiedAt: '2026-09-01T00:00:00.000Z', fetchedAt: '2026-09-01T00:00:00.000Z', patch: 'opaque-blue' },
      },
      records: [{ recordType: 'guide', semanticKey: 'glass-warden', payloadHash: hash(text), searchText: text, normalized: { text } }],
    };
    const first = await persistGamingSourceRevision(original);
    const before = await databasePool.query<{ id: string; status: string }>(
      'SELECT id, status FROM gaming_knowledge_records WHERE source_revision_id = $1', [first.revisionId]
    );
    const reverify = (verifiedAt: string) => persistGamingSourceRevision({
      ...original, fetchedAt: verifiedAt,
      provenance: {
        ignoredAttemptToReplaceResolver: 'must-not-overwrite',
        hybridFreshness: { verifiedAt, fetchedAt: verifiedAt, patch: 'opaque-blue' },
      },
    });
    // Competing completed fetches may reach the source lock in either order.
    const [newer, older] = await Promise.all([
      reverify('2026-09-03T00:00:00.000Z'), reverify('2026-09-02T00:00:00.000Z'),
    ]);
    for (const result of [newer, older]) expect(result).toMatchObject({
      state: 'unchanged', sourceId: first.sourceId, revisionId: first.revisionId, recordsCreated: 0, recordsUpdated: 0,
    });
    await reverify('2026-09-01T12:00:00.000Z');
    // A legacy revalidation lacking hybrid metadata cannot remove it.
    await persistGamingSourceRevision({ ...original, provenance: { resolverId: 'legacy-refresh' } });
    const revisions = await databasePool.query<{ id: string; provenance: Record<string, unknown> }>(
      'SELECT id, provenance FROM gaming_source_revisions WHERE source_id = $1', [first.sourceId]
    );
    expect(revisions.rows).toEqual([{
      id: first.revisionId,
      provenance: {
        retainedResolverField: 'synthetic-only',
        hybridFreshness: { verifiedAt: '2026-09-03T00:00:00.000Z', fetchedAt: '2026-09-03T00:00:00.000Z', patch: 'opaque-blue' },
      },
    }]);
    const after = await databasePool.query<{ id: string; status: string }>(
      'SELECT id, status FROM gaming_knowledge_records WHERE source_revision_id = $1', [first.revisionId]
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].status).toBe('active');
    const retrieved = await searchActiveGamingKnowledge({ gameKey, query: 'glass & warden', mode: 'guide' });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].revisionId).toBe(first.revisionId);
    expect(retrieved[0].provenance).toMatchObject({
      hybridFreshness: { verifiedAt: '2026-09-03T00:00:00.000Z' },
    });
  });

  test('rolls back a failed new revision after supersession and retains the prior usable evidence', async () => {
    const gameKey = `hybrid-failed-refresh-${randomUUID()}`;
    const text = 'The Lantern Guardian weakens after the bronze bell rings.';
    const original: PersistGamingSourceRevisionInput = {
      gameKey, gameName: 'Lantern Vale', canonicalUrl: `https://example.com/${gameKey}`,
      sourceType: 'supplied', contentHash: hash(text), cleanedContent: text, fetchedAt,
      extractor: 'synthetic', extractorVersion: '1', normalizerSchemaVersion: 'gaming-hybrid-fixture-v1',
      records: [{ recordType: 'guide', semanticKey: 'lantern-guardian', payloadHash: hash(text), searchText: text, normalized: { text } }],
    };
    const first = await persistGamingSourceRevision(original);
    const nextText = 'The Lantern Guardian weakens after the silver bell rings.';
    // A disposable-schema-only constraint fails the final record insert, after
    // the production transaction has inserted a revision and superseded rows.
    await databasePool.query(`ALTER TABLE gaming_knowledge_records ADD CONSTRAINT hybrid_fixture_insert_failure
      CHECK (normalized->>'simulateFailure' IS DISTINCT FROM 'true')`);
    try {
      await expect(persistGamingSourceRevision({
        ...original, contentHash: hash(nextText), cleanedContent: nextText,
        records: [{ recordType: 'guide', semanticKey: 'lantern-guardian', payloadHash: hash(nextText),
          searchText: nextText, normalized: { text: nextText, simulateFailure: true } }],
      })).rejects.toMatchObject({ code: '23514' });
    } finally {
      await databasePool.query('ALTER TABLE gaming_knowledge_records DROP CONSTRAINT hybrid_fixture_insert_failure');
    }
    const revisions = await databasePool.query<{ id: string }>(
      'SELECT id FROM gaming_source_revisions WHERE source_id = $1', [first.sourceId]
    );
    expect(revisions.rows).toEqual([{ id: first.revisionId }]);
    const prior = await searchActiveGamingKnowledge({ gameKey, query: 'bronze & bell', mode: 'guide' });
    expect(prior).toHaveLength(1);
    expect(prior[0].revisionId).toBe(first.revisionId);
    expect(await searchActiveGamingKnowledge({ gameKey, query: 'silver & bell', mode: 'guide' })).toEqual([]);
    const records = await databasePool.query<{ status: string; superseded_at: Date | null }>(
      'SELECT status, superseded_at FROM gaming_knowledge_records WHERE source_revision_id = $1', [first.revisionId]
    );
    expect(records.rows).toEqual([{ status: 'active', superseded_at: null }]);
  });
});
