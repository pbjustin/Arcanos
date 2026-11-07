import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool } from 'pg';
import { gamingAcquisitionAxios } from '../testUtils/gamingAcquisitionFixtures.js';
import { computeGptJobLifecycleDeadlines } from '../../src/shared/gpt/gptJobLifecycle.js';
import { assertDisposablePostgresTestDatabaseUrl, POSTGRES_TEST_DATABASE_NAME,
  resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

// Only this explicitly guarded URL is read; application DATABASE_URL is never used.
const DATABASE_ENV = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(DATABASE_ENV);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, DATABASE_ENV);
const withDatabase = connectionString ? describe : describe.skip;
const schemaName = `gaming_historical_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const actorScope = (actor: string) => hash(`${actor}\ngaming-source-ingestion`);
const retained = JSON.parse(readFileSync(new URL('../fixtures/gaming-historical-status/records.json', import.meta.url), 'utf8'));
// Authored wire-compatibility fixture for the immediately prior policy. Its
// envelope uses the unchanged source-approval shape, not a captured live job.
const priorPolicy: any = { provenance: { commit: 'synthetic-policy-v6-compatibility' },
  actorKey: `prior-policy-status-${randomUUID()}`, body: undefined };
const current: any = { actorKey: `current-status-${randomUUID()}`, body: undefined };
const fixtures: Array<[string, any]> = [...retained.map((fixture: any, index: number) => [`v${index + 1}`, fixture]),
  ['prior v6', priorPolicy], ['current', current]];
const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled', 'expired'];
let databasePool: Pool;
let administrator: Client;
let schemaCreated = false;
let administratorConnected = false;
const http = jest.fn();
const providerTrap = jest.fn(() => { throw new Error('No provider/network fetch is allowed in disposable status acceptance.'); });
const originalFetch = globalThis.fetch;
const methods = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const fixtureLogger = { ...methods, child: () => methods };

// Production repositories/query helper execute against the owned schema.
// No application database bootstrap or configured production pool can execute.
jest.unstable_mockModule('@core/db/client.js', () => ({
  getPool: () => databasePool, isDatabaseConnected: () => Boolean(databasePool),
  initializeDatabase: async () => { throw new Error('Application database bootstrap is forbidden.'); }
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  LogLevel: { DEBUG: 'debug' }, getConfiguredLogLevel: () => 'info',
  logger: fixtureLogger, dbLogger: fixtureLogger, aiLogger: fixtureLogger, default: fixtureLogger
}));
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: async () => ({ status: 'pending', maxRetries: 2, priority: 100 })
}));
const schema = await import('../../src/core/db/schema.js');
const jobs = await import('../../src/core/db/repositories/jobRepository.js');
const { persistGamingSourceRevision, searchActiveGamingKnowledge } = await import('../../src/core/db/repositories/gamingSourceRepository.js');
const service = await import('../../src/services/gamingSourceIngestion.js');
const { resolveGamingDocument } = await import('../../src/services/gamingDocumentResolution.js');
const { extractGamingFreshnessMetadata } = await import('../../src/shared/gaming/gamingFreshnessCore.js');
const { createGamingClearAssessment, GAMING_CLEAR_POLICY_VERSION } = await import('../../src/shared/gaming/gamingClearPolicy.js');
const { assessGamingRequestCoverage } = await import('../../src/shared/gaming/gamingClearEvidence.js');
const sourceUrl = `https://guides.example.org/copper-vale/real-pg18-${randomUUID()}`;
const page = '<html><title>Copper Vale guide</title><main><h1>Copper Vale guide</h1><p>In the game Copper Vale, '
  + 'players obtain the Amber Token at the marked market. The Amber Token costs 25 practice coins at that market. '
  + 'Collect the practice coins before buying the Amber Token and following the marked gate route. '
  + 'Keep the Amber Token until the training gate opens, then follow the marked route into the next practice area.</p></main></html>';
let currentSource: any;

/** Persist source-derived historical JSON through the real repository and terminal writer. */
async function persistJob(fixture: any, status: string, body = fixture.body) {
  const input = { gptId: 'arcanos-gaming', requestPath: '/gpt-access/gaming/sources/ingestions',
    executionModeReason: 'gaming_source_ingestion', body: structuredClone(body) };
  const created = await jobs.createJob('gaming-historical-pg18', 'gpt', input,
    { status: 'pending', idempotencyScopeHash: actorScope(fixture.actorKey) });
  if (status === 'pending') return created;
  const failed = status === 'failed';
  const output = status === 'completed' || failed ? {
    ok: true, action: 'ingest', ingestionId: created.id, status: failed ? 'completed_with_errors' : 'completed',
    counts: { total: 1, queued: 0, succeeded: failed ? 0 : 1, rejected: 0, failed: failed ? 1 : 0,
      recordsCreated: failed ? 0 : 1, recordsUpdated: 0 },
    sources: [{ submittedIndex: 0, canonicalUrl: body.sources[0].canonicalUrl, status: failed ? 'failed' : 'stored',
      recordsCreated: failed ? 0 : 1, recordsUpdated: 0,
      ...(failed ? { error: { code: 'SOURCE_FETCH_FAILED', message: 'Synthetic retained fetch failure.', retryable: true } } : {}) }]
  } : null;
  return jobs.updateJob(created.id, status, output, null, undefined, computeGptJobLifecycleDeadlines(status));
}

async function sourceWrites() {
  const result = await databasePool.query(`SELECT (SELECT count(*)::int FROM gaming_sources) AS sources,
    (SELECT count(*)::int FROM gaming_source_revisions) AS revisions,
    (SELECT count(*)::int FROM gaming_knowledge_records) AS records`);
  return result.rows[0];
}

test('historical status SQL fixture rejects an unowned database target', () => {
  expect(() => assertDisposablePostgresTestDatabaseUrl('postgres://test:test@remote.invalid:5432/postgres', DATABASE_ENV)).toThrow();
});

withDatabase('retained Gaming status and current execution on real PostgreSQL 18', () => {
  beforeAll(async () => {
    globalThis.fetch = providerTrap as typeof fetch;
    administrator = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000,
      application_name: 'arcanos-gaming-historical-pg18-setup' });
    await administrator.connect(); administratorConnected = true;
    const identity = await administrator.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version");
    expect(identity.rows[0].database).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(identity.rows[0].version).toBeGreaterThanOrEqual(180_000);
    expect(identity.rows[0].version).toBeLessThan(190_000);
    await administrator.query(`CREATE SCHEMA ${quotedSchema}`); schemaCreated = true;
    await administrator.query(`SET search_path TO ${quotedSchema}, pg_catalog`);
    for (const table of ['job_data', 'job_events']) {
      const definition = schema.TABLE_DEFINITIONS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
      expect(definition).toBeDefined(); await administrator.query(definition!);
    }
    await administrator.query(readFileSync(join(process.cwd(), 'migrations/20260808_gaming_knowledge_sources.sql'), 'utf8'));
    databasePool = new Pool({ connectionString, ssl: false, max: 4, connectionTimeoutMillis: 5_000,
      application_name: 'arcanos-gaming-historical-pg18-repositories',
      options: `-c search_path=${schemaName},pg_catalog -c statement_timeout=10000 -c lock_timeout=5000` });
    http.mockImplementation(async (url: string, options: any) => {
      expect(new URL(url).hostname).toBe('93.184.216.34');
      expect(options).toMatchObject({ maxRedirects: 0, proxy: false, headers: { Host: 'guides.example.org' } });
      return { data: page, headers: { 'content-type': 'text/html' } };
    });
    const document = await resolveGamingDocument(sourceUrl);
    const old = retained[4].body.sources[0].hybridApproval.gamingClear;
    const contentHash = service.hashGamingApprovedDocument(document);
    const assessment = createGamingClearAssessment({ ...old, questionProfile: 'walkthrough', subjectHash: contentHash,
      dimensions: old.dimensionScores, evidenceRefs: ['history-fixture-source'], evaluatedAt: '2026-11-06T12:00:00.000Z' });
    currentSource = { url: sourceUrl, game: 'Copper Vale', contentHash, sourceAssessment: assessment,
      actorScopeHash: hash(current.actorKey), policyVersion: 'gaming-hybrid-candidates/v1', sourceTrustType: 'supplied',
      freshness: extractGamingFreshnessMetadata(document, { game: 'Copper Vale' }, new Date()) };
    const admitted = await service.createApprovedGamingSourceIngestion([currentSource], `current-body-${randomUUID()}`,
      { actorKey: current.actorKey, canStore: true });
    expect(admitted.statusCode).toBe(202);
    const row = await jobs.getJobById((admitted.payload as any).ingestionId);
    current.body = (row!.input as any).body;
    expect(current.body.sources[0].hybridApproval.gamingClear.policyProfile).toBe(`${GAMING_CLEAR_POLICY_VERSION}:walkthrough:source`);
    priorPolicy.body = structuredClone(current.body);
    priorPolicy.body.sources[0].hybridApproval.actorScopeHash = hash(priorPolicy.actorKey);
    priorPolicy.body.sources[0].hybridApproval.gamingClear.policyProfile = 'gaming-clear-policy/v6:walkthrough:source';
    // The producer-body seed is not part of the later explicit-key concurrency lineage.
    await databasePool.query('DELETE FROM job_data WHERE id = $1', [row!.id]);
  }, 30_000);

  beforeEach(() => { http.mockClear(); providerTrap.mockClear(); });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    // Job events are asynchronous production writes; drain them before dropping this owned schema.
    let drainFailure: unknown;
    try {
      if (databasePool) {
        const deadline = Date.now() + 5_000;
        while (databasePool.idleCount !== databasePool.totalCount || databasePool.waitingCount) {
          if (Date.now() >= deadline) throw new Error('Owned repository event writes did not drain.');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    } catch (error) { drainFailure = error; }
    finally {
      try { await databasePool?.end(); }
      finally {
        if (administratorConnected) {
          try { if (schemaCreated) await administrator.query(`DROP SCHEMA ${quotedSchema} CASCADE`); }
          finally { await administrator.end(); }
        }
      }
    }
    if (drainFailure) throw drainFailure;
  }, 30_000);

  test.each(fixtures.flatMap(([version, fixture]) => statuses.map(status => [version, status, fixture])))
  ('round-trips %s %s through real job writes and owner-only read status', async (_version, status, fixture) => {
    const row = await persistJob(fixture, status);
    const before = await jobs.getJobById(row.id);
    expect((before!.input as any).body).toEqual(fixture.body);
    const writes = await sourceWrites();
    const read = await service.getGamingSourceIngestionStatus(row.id, { actorKey: fixture.actorKey });
    expect(read).toMatchObject({ statusCode: 200, payload: { action: 'status', status: status === 'pending' ? 'queued' : status } });
    expect(JSON.stringify(read.payload)).not.toMatch(/hybridApproval|gamingClear|actorScopeHash|contentHash|applicabilityBinding/u);
    expect((await service.getGamingSourceIngestionStatus(row.id, { actorKey: 'another-disposable-actor' })).statusCode).toBe(404);
    const after = await jobs.getJobById(row.id);
    expect(after!.input).toEqual(before!.input); expect(after!.updated_at).toEqual(before!.updated_at);
    expect(await sourceWrites()).toEqual(writes);
    expect(http).not.toHaveBeenCalled(); expect(providerTrap).not.toHaveBeenCalled();
  });

  test.each(fixtures)('projects %s failed-without-output using the retained body only', async (_version, fixture) => {
    const row = await persistJob(fixture, 'failed');
    await databasePool.query('UPDATE job_data SET output = NULL WHERE id = $1', [row.id]);
    expect(await service.getGamingSourceIngestionStatus(row.id, { actorKey: fixture.actorKey }))
      .toMatchObject({ statusCode: 200, payload: { status: 'failed', counts: { failed: 1 },
        sources: [{ status: 'failed', error: { code: 'INTERNAL_ERROR', retryable: false } }] } });
  });

  const malformed: Array<[string, (body: any) => void]> = [
    ['future CLEAR policy', body => { body.sources[0].hybridApproval.gamingClear.policyProfile =
      `${GAMING_CLEAR_POLICY_VERSION.replace(/\d+$/u, version => String(Number(version) + 1))}:walkthrough:source`; }],
    ['future rubric', body => { body.sources[0].hybridApproval.gamingClear.rubricVersion = 'gaming-clear/v2'; }],
    ['profile mismatch', body => { body.sources[0].hybridApproval.gamingClear.policyProfile = 'gaming-clear-policy/v1:walkthrough:answer'; }],
    ['extra version tuple', body => { body.sources[0].hybridApproval.gamingClear.policyProfile += ':extra'; }],
    ['unknown inherited profile', body => { body.sources[0].hybridApproval.gamingClear.policyProfile = 'gaming-clear-policy/v1:constructor:source'; }],
    ['future source policy', body => { body.sources[0].hybridApproval.sourcePolicyVersion = 'gaming-hybrid-source-policy-v3'; }],
    ['future freshness policy', body => { body.sources[0].hybridApproval.freshnessPolicyVersion = 'gaming-hybrid-freshness-v2'; }],
    ['invalid source actor hash', body => { body.sources[0].hybridApproval.actorScopeHash = 'not-a-digest'; }],
    ['unknown approval authority', body => { body.sources[0].hybridApproval.authorizeReplay = true; }],
    ['unknown body authority', body => { body.executeAutomatically = true; }],
    ['out-of-range dimension', body => { body.sources[0].hybridApproval.gamingClear.dimensionScores.clarity.score = 6; }],
    ['ineligible historical approval', body => { body.sources[0].hybridApproval.gamingClear.qualityEligible = false; }],
    ['oversized freshness', body => { body.sources[0].hybridApproval.freshness = { value: 'x'.repeat(8_001) }; }],
    ['oversized valid-shaped assessment', body => { body.sources[0].hybridApproval.gamingClear.dimensionScores.clarity.evidenceRefs = Array.from({ length: 50 }, (_, i) => `${i}${'x'.repeat(240)}`); }]
  ];
  test.each(malformed)('does not expose a SQL-retained malformed body: %s', async (_name, mutate) => {
    const body = structuredClone(retained[0].body); mutate(body);
    const row = await persistJob(retained[0], 'completed', body);
    expect((await service.getGamingSourceIngestionStatus(row.id, { actorKey: retained[0].actorKey })).statusCode).toBe(404);
    await expect(service.executeQueuedGamingSourceIngestion(row.id, (await jobs.getJobById(row.id))!.input.body))
      .rejects.toMatchObject({ code: 'GAMING_SOURCE_JOB_INVALID' });
    expect(http).not.toHaveBeenCalled(); expect(providerTrap).not.toHaveBeenCalled();
  });

  test.each([...retained, priorPolicy])('refuses execution and reapproval of SQL-retained producer $provenance.commit', async fixture => {
    const row = await persistJob(fixture, 'completed');
    const body = (await jobs.getJobById(row.id))!.input.body as any;
    const writes = await sourceWrites();
    await expect(service.executeQueuedGamingSourceIngestion(row.id, body)).rejects.toMatchObject({ code: 'GAMING_SOURCE_JOB_INVALID' });
    const source = body.sources[0];
    expect((await service.createApprovedGamingSourceIngestion([{ url: source.canonicalUrl, game: source.game,
      ...source.hybridApproval, sourceTrustType: source.sourceTrustType, sourceAssessment: source.hybridApproval.gamingClear }],
    `old-replay-${randomUUID()}`, { actorKey: fixture.actorKey, canStore: true })).statusCode).toBe(400);
    expect(await sourceWrites()).toEqual(writes);
    expect(http).not.toHaveBeenCalled(); expect(providerTrap).not.toHaveBeenCalled();
  });

  test('reading a tampered v6 audit record cannot turn it into current execution authority', async () => {
    const body = structuredClone(current.body); body.sources[0].hybridApproval.gamingClear.overall = 4.9;
    const row = await persistJob(current, 'completed', body);
    // Retained status validates bounded wire shape; it does not recertify saved quality aggregates.
    expect((await service.getGamingSourceIngestionStatus(row.id, { actorKey: current.actorKey })).statusCode).toBe(200);
    const writes = await sourceWrites();
    await expect(service.executeQueuedGamingSourceIngestion(row.id, (await jobs.getJobById(row.id))!.input.body))
      .rejects.toMatchObject({ code: 'GAMING_SOURCE_JOB_INVALID' });
    expect(await sourceWrites()).toEqual(writes); expect(http).not.toHaveBeenCalled();
  });

  test('executes a current v6 job into actual Gaming SQL and retains idempotency/actor isolation', async () => {
    const context = { actorKey: current.actorKey, canStore: true };
    const key = `concurrent-current-${randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 3 }, () => service.createApprovedGamingSourceIngestion([currentSource], key, context)));
    expect(responses.every(response => response.statusCode === 202)).toBe(true);
    expect(responses.filter(response => !(response.payload as any).deduplicated)).toHaveLength(1);
    const ids = new Set(responses.map(response => (response.payload as any).ingestionId)); expect(ids.size).toBe(1);
    const id = [...ids][0];
    const row = await jobs.getJobById(id);
    const completed = await service.executeQueuedGamingSourceIngestion(id, row!.input.body);
    expect(completed.output.sources[0].error).toBeUndefined();
    expect(completed).toMatchObject({ retryable: false, output: { status: 'completed', sources: [{ status: 'stored' }] } });
    await jobs.updateJob(id, 'completed', completed.output, null, undefined, computeGptJobLifecycleDeadlines('completed'));
    expect(await service.getGamingSourceIngestionStatus(id, context)).toMatchObject({ statusCode: 200, payload: { status: 'completed', sources: [{ status: 'stored' }] } });
    const sql = await databasePool.query('SELECT provenance FROM gaming_source_revisions WHERE source_id = $1', [completed.output.sources[0].sourceId]);
    expect(sql.rows).toHaveLength(1);
    expect(sql.rows[0].provenance.gamingClear.policyProfile).toBe(`${GAMING_CLEAR_POLICY_VERSION}:walkthrough:source`);
    expect(await service.createApprovedGamingSourceIngestion([currentSource], key, context)).toMatchObject({ statusCode: 202, payload: { ingestionId: id, deduplicated: true } });
    expect((await service.createApprovedGamingSourceIngestion([{ ...currentSource, recordType: 'build' }], key, context)).statusCode).toBe(409);
    const other = { actorKey: `other-${randomUUID()}`, canStore: true };
    const isolated = await service.createApprovedGamingSourceIngestion([{ ...currentSource, actorScopeHash: hash(other.actorKey) }], key, other);
    expect(isolated.statusCode).toBe(202); expect((isolated.payload as any).ingestionId).not.toBe(id);
    expect((await service.getGamingSourceIngestionStatus(id, other)).statusCode).toBe(404);
    const rows = await databasePool.query('SELECT count(*)::int AS count FROM job_data WHERE idempotency_key_hash = $1', [hash(key)]);
    expect(rows.rows[0].count).toBe(2); expect(http).toHaveBeenCalledTimes(1); expect(providerTrap).not.toHaveBeenCalled();
  });

  test('expires retained results through real cleanup before allowing a new explicit-key job', async () => {
    const context = { actorKey: `expiry-${randomUUID()}`, canStore: true };
    const source = { ...currentSource, actorScopeHash: hash(context.actorKey) };
    const key = `expiry-key-${randomUUID()}`;
    const first = await service.createApprovedGamingSourceIngestion([source], key, context);
    const id = (first.payload as any).ingestionId;
    await jobs.updateJob(id, 'completed', { ok: true, action: 'ingest', ingestionId: id, status: 'completed', sources: [],
      counts: { total: 1, queued: 0, succeeded: 1, rejected: 0, failed: 0, recordsCreated: 1, recordsUpdated: 0 } },
    null, undefined, computeGptJobLifecycleDeadlines('completed'));
    await databasePool.query("UPDATE job_data SET retention_until = NOW() - INTERVAL '1 second' WHERE id = $1", [id]);
    expect((await service.getGamingSourceIngestionStatus(id, context)).statusCode).toBe(200);
    const cleaned = await jobs.cleanupExpiredGptJobs(); expect(cleaned.expiredTerminal).toBeGreaterThanOrEqual(1);
    expect(await service.getGamingSourceIngestionStatus(id, context)).toMatchObject({ statusCode: 200, payload: { status: 'expired' } });
    const replacement = await service.createApprovedGamingSourceIngestion([source], key, context);
    expect(replacement.statusCode).toBe(202); expect((replacement.payload as any).ingestionId).not.toBe(id);
    const pending = await persistJob(retained[0], 'pending');
    await databasePool.query("UPDATE job_data SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1", [pending.id]);
    expect((await jobs.cleanupExpiredGptJobs()).expiredPending).toBeGreaterThanOrEqual(1);
    expect(await service.getGamingSourceIngestionStatus(pending.id, { actorKey: retained[0].actorKey }))
      .toMatchObject({ statusCode: 200, payload: { status: 'expired' } });
    await databasePool.query("UPDATE job_data SET expires_at = NOW() - INTERVAL '8 days' WHERE id = ANY($1::uuid[])", [[id, pending.id]]);
    expect((await jobs.cleanupExpiredGptJobs()).deletedExpired).toBeGreaterThanOrEqual(2);
    expect((await service.getGamingSourceIngestionStatus(id, context)).statusCode).toBe(404);
    expect(http).not.toHaveBeenCalled(); expect(providerTrap).not.toHaveBeenCalled();
  });

  test('stored SQL topic descriptions cannot replace independently sufficient acquired gameplay facts', async () => {
    const game = 'Silver Harbor';
    const heading = `${game} gameplay guide`;
    const description = `In the game ${game}, this page lists a tutorial shield record.`;
    const input = { game, mode: 'guide' as const, prompt: `How do I get the shield from the tutorial area in ${game}?`,
      requireRequestCoverage: true, failOnUnavailable: true };
    const seed = async (text: string, title: string | null) => {
      const url = `https://guides.example.org/silver-harbor/retained-${randomUUID()}`;
      const contentHash = hash(text);
      const old = retained[4].body.sources[0].hybridApproval.gamingClear;
      const assessment = createGamingClearAssessment({ ...old, subjectHash: contentHash,
        contextFingerprint: hash(`synthetic retained corpus ${game}`), questionProfile: 'walkthrough',
        dimensions: old.dimensionScores, evidenceRefs: ['history-fixture-source'], evaluatedAt: '2026-11-06T12:00:00.000Z' });
      const normalized = { text, game, chunk: { ordinal: 0, totalChunks: 1, startChar: 0, endChar: text.length } };
      // This models an already retained row; it does not claim fresh-source approval.
      // Backend identity/applicability provenance is explicit; request coverage must still inspect its actual text.
      const stored = await persistGamingSourceRevision({ gameKey: 'silver-harbor', gameName: game,
        canonicalUrl: url, publicUrl: url, sourceType: 'supplied', trustScore: 0.5, contentHash,
        cleanedContent: text, fetchedAt: new Date().toISOString(), extractor: 'synthetic-retained-corpus',
        extractorVersion: 'pg18-retained-fixture-v1', normalizerSchemaVersion: '1',
        provenance: { gameName: game, sourceIdentityPolicyVersion: GAMING_CLEAR_POLICY_VERSION,
          gamingClear: assessment, approvedContentHash: contentHash,
          acquiredApplicability: { extractorVersion: 'gaming-hybrid-freshness-v1', contentHash, game },
          resolverId: 'synthetic-retained-corpus', resolverVersion: 'pg18-retained-fixture-v1', resolutionStrategy: 'retained_text' },
        extractionMetrics: { coverageStatus: 'complete', documentCharsIndexed: text.length, chunkCount: 1 },
        records: [{ recordType: 'guide', semanticKey: hash(url), payloadHash: hash(JSON.stringify(normalized)),
          title: title ?? undefined, searchText: text, normalized }] });
      const raw = await searchActiveGamingKnowledge({ gameKey: 'silver-harbor', query: 'shield', mode: 'guide', sourceIds: [stored.sourceId] });
      expect(raw).toHaveLength(1); expect(raw[0].normalized.text).toBe(text);
      return url;
    };
    for (const [text, title] of [[description, null], [`${heading} ${description}`, heading], [`${heading} ${description}`, null]] as const) {
      await seed(text, title);
      const knowledge = await service.buildStoredGamingKnowledgeContext(input);
      expect(knowledge.sourceKnown).toBe(true);
      expect(assessGamingRequestCoverage(input, knowledge).coverageSatisfied).toBe(false);
      // A retained passage may remain readable as context; it cannot authorize generation.
      expect(knowledge.clearEvidenceAssessment?.gates.claimSupport).toBe('unknown');
      expect(knowledge.clearEvidenceAssessment?.decision).not.toBe('accept');
    }
    const fact = `In the game ${game}, the tutorial-area shield is the Practice Shield. `
      + 'The Practice Shield is sold at the Lantern Shop in the training village for 25 practice coins. '
      + 'Collect the coins before returning to the Lantern Shop to buy the tutorial-area shield.';
    const factUrl = await seed(fact, heading);
    const knowledge = await service.buildStoredGamingKnowledgeContext(input);
    expect(knowledge.sourceKnown).toBe(true);
    expect(assessGamingRequestCoverage(input, knowledge).coverageSatisfied).toBe(true);
    expect(knowledge.clearEvidenceAssessment?.gates.claimSupport).toBe('verified');
    expect(knowledge.clearEvidenceAssessment?.decision).toBe('accept');
    expect(knowledge.sources.some(source => source.url === factUrl)).toBe(true);
    expect(knowledge.context).toContain('Lantern Shop');
    expect(http).not.toHaveBeenCalled(); expect(providerTrap).not.toHaveBeenCalled();
  });
});
