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

// Only the configured pool lookup is replaced. Repository transactions, rows,
// indexes, full-text matching and ranking all execute in actual PostgreSQL 18.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => databasePool,
  isDatabaseConnected: () => Boolean(databasePool)
}));
const { persistGamingSourceRevision, searchActiveGamingKnowledge } =
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
});
