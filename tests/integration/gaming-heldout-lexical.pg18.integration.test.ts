import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool } from 'pg';
import { assertDisposablePostgresTestDatabaseUrl, POSTGRES_TEST_DATABASE_NAME, resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';
import { heldoutGamingPassages, heldoutGamingPersistence, heldoutGamingQuestions,
  HELDOUT_GAMING_HEAD, HELDOUT_GAMING_LEXICAL_VERSION, HELDOUT_GAMING_NOW } from '../testUtils/gamingHeldoutLexicalFixtures.js';
import { buildStoredGamingLexicalQuery } from '../../src/shared/gaming/gamingStoredEvidenceCore.js';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../../src/shared/gaming/gamingClearEvidence.js';
import { normalizeGamingGameIdentity } from '../../src/shared/gaming/gamingGameIdentity.js';

const environment = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(environment);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, environment);
const withDatabase = connectionString ? describe : describe.skip;
const schema = `gaming_heldout_lexical_${randomUUID().replaceAll('-', '')}`;
let pool: Pool;
jest.unstable_mockModule('@core/db/client.js', () => ({ getPool: () => pool, isDatabaseConnected: () => Boolean(pool) }));
const repository = await import('../../src/core/db/repositories/gamingSourceRepository.js');
const { retrieveStoredGamingKnowledge } = await import('../../src/services/gamingStoredKnowledge.js');
const observations: Array<Record<string, unknown>> = [];

withDatabase('held-out Gaming SQL lexical ranking and durable authority on PostgreSQL 18', () => {
  let setup: Client;
  let schemaCreated = false;
  let serverVersion = 0;
  beforeAll(async () => {
    setup = new Client({ connectionString, ssl: false, application_name: 'arcanos-heldout-gaming-lexical-setup' });
    await setup.connect();
    const identity = await setup.query("SELECT current_database() AS name, current_setting('server_version_num') AS version");
    expect(identity.rows[0].name).toBe(POSTGRES_TEST_DATABASE_NAME);
    serverVersion = Number(identity.rows[0].version);
    expect(serverVersion).toBeGreaterThanOrEqual(180000); expect(serverVersion).toBeLessThan(190000);
    await setup.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await setup.query(`SET search_path TO "${schema}", pg_catalog`);
    await setup.query(readFileSync(join(process.cwd(), 'migrations/20260808_gaming_knowledge_sources.sql'), 'utf8'));
    pool = new Pool({ connectionString, ssl: false, max: 2, options: `-c search_path=${schema},pg_catalog`,
      connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'arcanos-heldout-gaming-lexical' });
  }, 30000);
  beforeEach(async () => {
    // Only this suite's newly created schema contains these synthetic fixtures.
    await pool.query('TRUNCATE gaming_sources CASCADE');
  });
  afterAll(async () => {
    try {
      await pool?.end();
      if (schemaCreated) {
        await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
        expect((await setup.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toEqual([]);
      }
    } finally { await setup?.end(); }
  });

  test.each(heldoutGamingQuestions)('runs real source identity, SQL ranks and service authority for $id', async question => {
    const passageBySource = new Map<string, string>();
    for (const id of question.pool) {
      const passage = heldoutGamingPassages.find(row => row.id === id)!;
      const input = heldoutGamingPersistence(passage);
      const stored = await repository.persistGamingSourceRevision(input);
      passageBySource.set(stored.sourceId, id);
      if (passage.restriction === 'revoked') await repository.recordGamingSourceAuthorityHold({
        sourceId: stored.sourceId, gameKey: input.gameKey, canonicalUrl: input.canonicalUrl,
        reason: 'SOURCE_USE_RESTRICTED', observedAt: new Date(HELDOUT_GAMING_NOW) });
    }
    const query = buildStoredGamingLexicalQuery(question.input.prompt, question.input.game, question.input);
    const sqlStart = performance.now();
    const identities = await repository.findActiveGamingSourceIdentities({ game: question.input.game,
      edition: question.input.edition, mode: 'guide' });
    const rows = identities.length ? await repository.searchActiveGamingKnowledge({
      gameKey: normalizeGamingGameIdentity(question.input.game), sourceIds: identities.map(source => source.sourceId),
      mode: 'guide', query: query.query, limit: 20 }, { queryTimeoutMs: 1000 }) : [];
    const rawSqlMs = performance.now() - sqlStart;
    const rawTop3 = rows.slice(0, 3).map(row => passageBySource.get(row.sourceId)!);
    expect(rows.every(row => Number.isFinite(row.relevance) && row.relevance > 0)).toBe(true);
    const serviceStart = performance.now();
    const knowledge = await retrieveStoredGamingKnowledge({ ...question.input, hybridRetrieval: true, failOnUnavailable: true },
      { resolveVerifiedPatch: () => undefined });
    const serviceMs = performance.now() - serviceStart;
    const selected = (knowledge.evidence ?? []).map(row => passageBySource.get(row.sourceId)!);
    const clear = assessGamingClearEvidence(question.input, knowledge,
      { identityVerified: true, now: new Date(HELDOUT_GAMING_NOW), requireRequestCoverage: true });
    const originalProvenance = (knowledge.evidence ?? []).every(chunk => rows.some(row => row.recordId === chunk.recordId
      && row.sourceId === chunk.sourceId && row.revisionId === chunk.revisionId && row.publicUrl === chunk.publicUrl
      && row.fetchedAt.toISOString() === chunk.provenance.fetchedAt));
    expect(originalProvenance).toBe(true);
    if (question.kind === 'restriction') expect(clear.decision).not.toBe('accept');
    if (question.kind === 'exact' || question.kind === 'complementary') {
      expect([...selected].sort()).toEqual([...question.relevant].sort());
      expect(assessGamingRequestCoverage(question.input, knowledge).coverageSatisfied).toBe(true);
      expect(clear.decision).toBe('accept');
    }
    if (question.id === 'heldout-spoiler-scope') expect(JSON.stringify(knowledge)).not.toContain('destroys the observatory');
    if (['unverified', 'reference', 'revoked', 'missing-grant'].some(id => question.pool.includes(id))) {
      expect(rows).toHaveLength(1);
      expect(knowledge.evidence ?? []).toEqual([]);
    }
    const hit = (values: string[]) => values.filter(id => question.relevant.includes(id)).length;
    observations.push({ id: question.id, kind: question.kind, relevant: question.relevant, rawTop3, selected,
      rawRecallAt3: question.relevant.length ? hit(rawTop3) / question.relevant.length : null,
      rawPrecisionAt3: question.relevant.length ? hit(rawTop3) / 3 : null,
      selectedRecallAt3: question.relevant.length ? hit(selected) / question.relevant.length : null,
      selectedPrecisionAt3: question.relevant.length ? hit(selected) / 3 : null,
      clearDecision: clear.decision, originalProvenance, rawSqlMs, serviceMs,
      rawAuthorityReassessment: rows.map(row => row.authorityReassessmentRequired === true) });
  });

  test.each(heldoutGamingQuestions.filter(question => question.kind === 'complementary'))(
    'keeps partial durable support without granting full answer coverage for $id', async question => {
      await repository.persistGamingSourceRevision(heldoutGamingPersistence(
        heldoutGamingPassages.find(passage => passage.id === question.relevant[0])!));
      const knowledge = await retrieveStoredGamingKnowledge({ ...question.input, hybridRetrieval: true, failOnUnavailable: true },
        { resolveVerifiedPatch: () => undefined });
      expect(knowledge.evidence).toHaveLength(1);
      expect(assessGamingRequestCoverage(question.input, knowledge).coverageSatisfied).toBe(false);
      expect(assessGamingClearEvidence(question.input, knowledge, { identityVerified: true,
        now: new Date(HELDOUT_GAMING_NOW), requireRequestCoverage: true }).decision).not.toBe('accept');
    });

  test('reports SQL candidate quality separately from selected evidence and generated-answer quality', () => {
    expect(observations).toHaveLength(heldoutGamingQuestions.length);
    const positives = observations.filter(row => row.kind !== 'restriction');
    const mean = (key: string) => positives.reduce((sum, row) => sum + Number(row[key]), 0) / positives.length;
    console.info('GAMING_HELDOUT_SQL_REPORT', JSON.stringify({ version: HELDOUT_GAMING_LEXICAL_VERSION,
      studyHead: HELDOUT_GAMING_HEAD, serverVersion, scope: 'real disposable PostgreSQL identity/search/ranking plus production stored service selection and deterministic CLEAR; synthetic authority grants; no generated answer or provider',
      positiveQuestions: positives.length, restrictionControls: observations.length - positives.length,
      macroRawRecallAt3: mean('rawRecallAt3'), macroRawPrecisionAt3: mean('rawPrecisionAt3'),
      macroSelectedRecallAt3: mean('selectedRecallAt3'), macroSelectedPrecisionAt3: mean('selectedPrecisionAt3'),
      clearAcceptCount: positives.filter(row => row.clearDecision === 'accept').length,
      falseAuthorityAccepted: observations.filter(row => row.kind === 'restriction' && row.clearDecision === 'accept').length,
      heapUsedBytes: process.memoryUsage().heapUsed, maxRssKiB: process.resourceUsage().maxRSS, observations }));
  });
});
