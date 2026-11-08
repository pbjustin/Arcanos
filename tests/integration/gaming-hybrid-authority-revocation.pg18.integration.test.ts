import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool } from 'pg';
import { gamingAcquisitionAxios } from '../testUtils/gamingAcquisitionFixtures.js';
import { assertDisposablePostgresTestDatabaseUrl, POSTGRES_TEST_DATABASE_NAME, resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const databaseEnvironment = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(databaseEnvironment);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, databaseEnvironment);
const withDatabase = connectionString ? describe : describe.skip;
const schema = `gaming_hybrid_revocation_${randomUUID().replaceAll('-', '')}`;
let pool: Pool;
let unavailableAuthorityUrl: string | undefined;
let unavailableAuthorityReads = 0;
const http = jest.fn();
const enqueue = jest.fn();

jest.unstable_mockModule('@core/db/client.js', () => ({ getPool: () => pool, isDatabaseConnected: () => Boolean(pool) }));
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ findOrCreateGptJob: enqueue, getJobById: jest.fn(),
  IdempotencyKeyConflictError: class extends Error {}, JobRepositoryUnavailableError: class extends Error {} }));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({ planAutonomousWorkerJob: async () => ({ status: 'pending', maxRetries: 2 }) }));

const repository = await import('../../src/core/db/repositories/gamingSourceRepository.js');
const service = await import('../../src/services/gamingSourceIngestion.js');
const { createGamingHybridWorkflow } = await import('../../src/services/gamingHybridKnowledge.js');
const { logger } = await import('../../src/platform/logging/structuredLogging.js');
for (const level of ['info', 'warn', 'error'] as const) jest.spyOn(logger, level).mockImplementation(() => undefined);

const game = 'EVE Online';
const firstText = 'In EVE Online, align the platinum prism with the eastern notch before rotating the relay. '
  + 'Rotate the platinum prism until the amber latch opens. Inspect the platinum prism before each relay rotation.';
const secondText = 'In EVE Online, preserve charge for the return crossing. Charge drains while the relay glows. '
  + 'Close the bronze switch to preserve charge after opening the crossing. Wait by the relay before using the remaining charge.';
const context = { actorKey: 'synthetic-hybrid-revocation-owner', canStore: true, canAutoStore: false };

async function fixture(input: { sourceUrl?: string } = {}) {
  const sourceUrl = input.sourceUrl ?? `https://guides.example.org/hybrid-revocation-prism-${randomUUID()}`;
  const complementUrl = `https://guides.example.org/hybrid-revocation-charge-${randomUUID()}`;
  let restricted = false;
  http.mockImplementation(async (target: string, options: any) => {
    const url = new URL(target);
    expect(url.hostname).toBe('93.184.216.34');
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, headers: { Host: 'guides.example.org' } });
    const first = url.pathname === new URL(sourceUrl).pathname;
    expect([new URL(sourceUrl).pathname, new URL(complementUrl).pathname]).toContain(url.pathname);
    return { status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>${game} guide</title><article><p>${first ? firstText : secondText}</p><p>Edition: base game.</p>`
        + `${first && restricted ? '<p>No automated use.</p>' : ''}</article></html>` };
  });
  enqueue.mockImplementation(async (job: any) => ({ created: true, deduped: false,
    job: { id: randomUUID(), status: 'pending', created_at: new Date(), input: job.input } }));
  const latestBody = () => structuredClone((enqueue.mock.calls.at(-1)![0] as any).input.body);
  const generationInputs: any[] = [];
  const workflow = createGamingHybridWorkflow({ generate: (async (pipeline: any, prepared: any) => {
    generationInputs.push({ pipeline, prepared });
    // Observe the actual generation admission boundary without invoking a provider
    // or manufacturing an answer-ready result.
    return { data: { response: '', fallbackReason: 'INTAKE_UPSTREAM_TIMEOUT', sources: [],
      grounding: { groundingStatus: 'insufficient' } } };
  }) as any });
  const query = { contractVersion: 'gaming-hybrid-v2' as const, game, mode: 'guide' as const, edition: 'base-game',
    question: 'Explain how to align the platinum prism and preserve charge.', storagePolicy: 'ask_before_store' as const,
    idempotencyKey: randomUUID() };
  const missing = await workflow.query(query, context);
  expect(missing.body.nextAction).toBe('search');
  const partial = await workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: missing.body.workflowId,
    expectedRevision: missing.body.revision, idempotencyKey: randomUUID(), candidates: [{ url: sourceUrl }] }, context);
  expect(partial.body).toMatchObject({ nextAction: 'search', coverageSatisfied: false, evidenceSelected: true });
  expect(partial.body.selectedCandidateIds).toHaveLength(1);
  expect(generationInputs).toHaveLength(0);
  const candidateId = partial.body.selectedCandidateIds![0];
  const commitHold = async (sourceId: string) => {
    restricted = true;
    const refresh = await service.refreshGamingSources({ action: 'refresh', payload: { sourceIds: [sourceId],
      idempotencyKey: randomUUID() } }, context);
    expect(refresh.statusCode).toBe(202);
    const held = await service.executeQueuedGamingSourceIngestion((refresh.payload as any).ingestionId, latestBody());
    expect(held.output.sources[0]).toMatchObject({ status: 'rejected', error: { code: 'SOURCE_USE_RESTRICTED' } });
  };

  return { sourceUrl, complementUrl, candidateId, generationInputs, commitHold,
    async complete() {
      return workflow.candidates({ contractVersion: 'gaming-hybrid-v2', workflowId: missing.body.workflowId,
        expectedRevision: partial.body.revision, idempotencyKey: randomUUID(), candidates: [{ url: complementUrl }] }, context);
    },
    async hold() {
      // Use the workflow's genuine content-bound approval, then the actual
      // ingestion worker transaction. The mocked seam only owns queue admission.
      const admitted = await workflow.ingest({ contractVersion: 'gaming-hybrid-v2', workflowId: missing.body.workflowId,
        idempotencyKey: randomUUID(), candidateIds: [candidateId], storagePolicy: 'ask_before_store', confirmStore: true }, context);
      expect(admitted.status).toBe(202);
      const stored = await service.executeQueuedGamingSourceIngestion(admitted.body.ingestion!.ingestionId, latestBody());
      expect(stored.output.sources[0]).toMatchObject({ status: 'stored', classification: 'verified', generationEligible: true });
      const sourceId = stored.output.sources[0].sourceId!;
      expect(sourceId).toBeTruthy();
      const storedSource = await repository.getGamingSourceById(sourceId);
      expect(storedSource).toMatchObject({ game: `${game} base-game`, gameKey: 'eve-online-base-game', canonicalUrl: sourceUrl });
      const before = await repository.searchActiveGamingKnowledge({ gameKey: storedSource!.gameKey, query: 'platinum', sourceIds: [sourceId] });
      expect(before.length).toBeGreaterThan(0);
      expect(before.every(row => !row.authorityReassessmentRequired)).toBe(true);
      await commitHold(sourceId);
      expect(await service.captureGamingSourceAuthorityRestrictionCount(storedSource!.game, sourceUrl)).toBe(1);
      const raw = await repository.searchActiveGamingKnowledge({ gameKey: storedSource!.gameKey, query: 'platinum', sourceIds: [sourceId] });
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.every(row => row.authorityReassessmentRequired)).toBe(true);
      const after = await service.buildStoredGamingKnowledgeContext({ game, mode: 'guide', prompt: query.question,
        edition: 'base-game', failOnUnavailable: true });
      expect(after.evidence ?? []).toEqual([]);
      return { sourceId, storedSource: storedSource!, raw };
    }
  };
}

withDatabase('hybrid accepted-evidence authority revocation on PostgreSQL 18', () => {
  let setup: Client;
  let created = false;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  beforeAll(async () => {
    setup = new Client({ connectionString, ssl: false });
    await setup.connect();
    const identity = await setup.query("SELECT current_database() AS name, current_setting('server_version_num')::int AS version");
    expect(identity.rows[0].name).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(identity.rows[0].version).toBeGreaterThanOrEqual(180000);
    expect(identity.rows[0].version).toBeLessThan(190000);
    await setup.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await setup.query(`SET search_path TO "${schema}", pg_catalog`);
    await setup.query(readFileSync(join(process.cwd(), 'migrations/20260808_gaming_knowledge_sources.sql'), 'utf8'));
    process.env.DATABASE_URL = connectionString;
    pool = new Pool({ connectionString, ssl: false, max: 4, application_name: 'gaming-hybrid-authority-revocation',
      options: `-c search_path=${schema},pg_catalog`, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    pool.on('connect', client => {
      const query = client.query.bind(client) as (...args: any[]) => unknown;
      client.query = ((...args: any[]) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        const values = Array.isArray(args[1]) ? args[1] : args[0]?.values;
        if (unavailableAuthorityUrl && typeof text === 'string' && text.includes('restricted_revision_count')
          && text.includes('gaming_source_revisions') && values?.[2] === unavailableAuthorityUrl) {
          unavailableAuthorityReads += 1;
          return Promise.reject(new Error('Synthetic exact-source authority read unavailable.'));
        }
        return query(...args);
      }) as typeof client.query;
    });
  }, 30000);
  beforeEach(async () => {
    unavailableAuthorityUrl = undefined;
    unavailableAuthorityReads = 0;
    http.mockReset();
    enqueue.mockReset();
    // The suite owns this unique schema; prior source rows must not satisfy the
    // next workflow's initial retrieval before the fixture is admitted.
    await pool.query('DELETE FROM gaming_sources');
  });
  afterAll(async () => {
    try {
      await pool?.end();
      if (created) await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await setup?.end();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  test('preserves generation admission for current exact-source artifacts with no durable restriction', async () => {
    const source = await fixture();
    const completed = await source.complete();
    expect(source.generationInputs).toHaveLength(1);
    expect(source.generationInputs[0].prepared.knowledge.sources.map((item: any) => item.url))
      .toEqual(expect.arrayContaining([source.sourceUrl, source.complementUrl]));
    expect(source.generationInputs[0].prepared.knowledge.evidence.some((item: any) =>
      item.publicUrl === source.sourceUrl && item.text.includes('platinum prism'))).toBe(true);
    expect(completed.body.coverageSatisfied).toBe(true);
    expect(completed.body.answer).toBeUndefined();
  }, 30000);

  test('excludes an accepted artifact before recovery generation after a real worker commits its durable hold', async () => {
    const source = await fixture();
    await source.hold();
    const completed = await source.complete();
    expect(source.generationInputs).toHaveLength(0);
    expect(completed.body.selectedCandidateIds ?? []).not.toContain(source.candidateId);
    expect((completed.body.selectedEvidenceIds ?? []).some(id => id.startsWith(`${source.candidateId}:`))).toBe(false);
    expect(completed.body.coverageSatisfied).not.toBe(true);
    expect(completed.body.answer).toBeUndefined();
  }, 30000);

  test('fails closed when only a previously accepted source authority recheck becomes unavailable', async () => {
    const source = await fixture();
    unavailableAuthorityUrl = source.sourceUrl;
    const completed = await source.complete();
    expect(unavailableAuthorityReads).toBeGreaterThan(0);
    expect(source.generationInputs).toHaveLength(0);
    expect(completed.body.selectedCandidateIds ?? []).not.toContain(source.candidateId);
    expect(completed.body.answer).toBeUndefined();
  }, 30000);

  test('revokes a freshly reacquired artifact when a repeated hold changes durable source state without incrementing its count', async () => {
    const original = await fixture();
    const { sourceId, storedSource } = await original.hold();
    // A clean protected reacquisition at the held epoch can qualify transiently.
    // A later observation of that same restriction must still revoke this grant.
    const reacquired = await fixture({ sourceUrl: original.sourceUrl });
    const authority = repository.createGamingSourceRepository(pool);
    const input = { gameKey: storedSource.gameKey, canonicalUrl: original.sourceUrl };
    const before = await authority.readGamingSourceAuthoritySnapshot(input);
    expect(before.restrictedRevisionCount).toBe(1);
    expect(before.stateFingerprint).toEqual(expect.any(String));
    await reacquired.commitHold(sourceId);
    const after = await authority.readGamingSourceAuthoritySnapshot(input);
    expect(after.restrictedRevisionCount).toBe(1);
    expect(after.stateFingerprint).not.toBe(before.stateFingerprint);
    const completed = await reacquired.complete();
    expect(reacquired.generationInputs).toHaveLength(0);
    expect(completed.body.selectedCandidateIds ?? []).not.toContain(reacquired.candidateId);
    expect(completed.body.coverageSatisfied).not.toBe(true);
    expect(completed.body.answer).toBeUndefined();
  }, 30000);
});
