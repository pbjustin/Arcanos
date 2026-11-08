import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Client, Pool } from 'pg';
import type { PersistGamingSourceRevisionInput } from '../../src/core/db/repositories/gamingSourceRepository.js';
import { createGamingClearAssessment, GAMING_CLEAR_POLICY_VERSION } from '../../src/shared/gaming/gamingClearPolicy.js';
import { GAMING_FRESHNESS_POLICY_VERSION } from '../../src/shared/gaming/gamingFreshnessCore.js';
import { assertDisposablePostgresTestDatabaseUrl, POSTGRES_TEST_DATABASE_NAME, resolvePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const databaseEnvironment = 'JOB_CLAIM_FENCING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(databaseEnvironment);
if (connectionString) assertDisposablePostgresTestDatabaseUrl(connectionString, databaseEnvironment);
const describeWithDatabase = connectionString ? describe : describe.skip;
const schema = `gaming_authority_read_${randomUUID().replaceAll('-', '')}`;
let pool: Pool;
jest.unstable_mockModule('@core/db/client.js', () => ({ getPool: () => pool, isDatabaseConnected: () => Boolean(pool) }));
const { persistGamingSourceRevision, searchActiveGamingKnowledge } = await import('../../src/core/db/repositories/gamingSourceRepository.js');
const { retrieveStoredGamingKnowledge, selectStoredGamingEvidence } = await import('../../src/services/gamingStoredKnowledge.js');

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const text = 'In Platinum Lantern, rotate the silver telescope toward the eastern beacon before crossing the crystal bridge. Open the amber gate after aligning the telescope.';
const request = { game: 'Platinum Lantern', prompt: 'How do I cross the crystal bridge?', mode: 'guide' as const,
  hybridRetrieval: true, requireRequestCoverage: true, failOnUnavailable: true };

function inputFor(url: string, provenance: Record<string, unknown>, records = 1, body = text): PersistGamingSourceRevisionInput {
  return { gameKey: 'platinum-lantern', gameName: request.game, canonicalUrl: url, publicUrl: url,
    sourceType: 'supplied', trustScore: 0.8, contentHash: digest(body), cleanedContent: body,
    fetchedAt: '2026-11-07T00:00:00.000Z', extractor: 'synthetic-authority-read', extractorVersion: '1',
    normalizerSchemaVersion: '1', provenance, extractionMetrics: { coverageStatus: 'complete' },
    records: Array.from({ length: records }, (_, ordinal) => ({ recordType: 'guide', semanticKey: `bridge-${ordinal}`,
      payloadHash: digest(`${ordinal}:${body}`), searchText: body,
      normalized: { text: body, chunk: { ordinal, totalChunks: records, startChar: ordinal * body.length, endChar: (ordinal + 1) * body.length } } })) };
}

function approvedProvenance() {
  const approvedDocumentHash = digest(`document:${text}`);
  const dimension = { status: 'evaluated' as const, score: 4.5, reasonCodes: ['SYNTHETIC_ACQUIRED_SOURCE'], evidenceRefs: ['synthetic-source'], unresolvedFacts: [] };
  const assessment = createGamingClearAssessment({ profile: 'source', questionProfile: 'walkthrough', sourceRole: 'gameplay_guide',
    subjectId: 'synthetic-source', subjectHash: approvedDocumentHash, contextFingerprint: digest(JSON.stringify(request)), evidenceRefs: ['synthetic-source'],
    gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'not_applicable', provenance: 'verified', security: 'verified' },
    dimensions: { clarity: dimension, leverage: dimension, efficiency: dimension, alignment: dimension, resilience: dimension } });
  expect(assessment.qualityEligible).toBe(true);
  return { classification: 'verified', generationEligible: true, sourceIdentityPolicyVersion: GAMING_CLEAR_POLICY_VERSION,
    gamingClear: assessment, approvedContentHash: approvedDocumentHash, hybridPolicyVersion: 'gaming-hybrid-candidates/v1',
    acquiredApplicability: { extractorVersion: GAMING_FRESHNESS_POLICY_VERSION, contentHash: digest(text), game: request.game,
      metadataConflict: false, metadataUnverified: false } };
}

describeWithDatabase('durable Gaming read authority on PostgreSQL 18', () => {
  let setup: Client;
  let created = false;
  beforeAll(async () => {
    setup = new Client({ connectionString, ssl: false });
    await setup.connect();
    const identity = await setup.query("SELECT current_database() AS name, current_setting('server_version_num') AS version");
    expect(identity.rows[0].name).toBe(POSTGRES_TEST_DATABASE_NAME);
    expect(Number(identity.rows[0].version)).toBeGreaterThanOrEqual(180000);
    expect(Number(identity.rows[0].version)).toBeLessThan(190000);
    await setup.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await setup.query(`SET search_path TO "${schema}", pg_catalog`);
    await setup.query(readFileSync(join(process.cwd(), 'migrations/20260808_gaming_knowledge_sources.sql'), 'utf8'));
    pool = new Pool({ connectionString, ssl: false, max: 2, options: `-c search_path=${schema},pg_catalog`,
      connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  }, 30000);
  afterAll(async () => {
    await pool?.end();
    if (created) await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
    await setup?.end();
  });

  test.each(['missing', 'invalid'])('requires durable proof for %s stamps without explicit restriction history', async stamp => {
    const item = inputFor(`https://guides.example.org/unstamped-${randomUUID()}`, approvedProvenance());
    const stored = await persistGamingSourceRevision(item);
    if (stamp === 'invalid') await pool.query("UPDATE gaming_source_revisions SET provenance = provenance || $2::jsonb WHERE id=$1",
      [stored.revisionId, JSON.stringify({ authorityAssessment: { version: 'caller-authored', restrictedRevisionCount: 0 } })]);
    const rows = await searchActiveGamingKnowledge({ gameKey: item.gameKey, query: 'crystal', sourceIds: [stored.sourceId] });
    expect(rows).toHaveLength(1);
    expect(rows[0].normalized.text).toBe(text);
    expect(rows[0].provenance.generationEligible).toBe(true);
    expect(rows[0].authorityReassessmentRequired).toBe(true);
    expect(selectStoredGamingEvidence(rows, request)).toEqual([]);
  });

  test('preserves a valid zero-restriction durable grant and ordinary independently acquired sources', async () => {
    const provenance = approvedProvenance();
    const item = inputFor(`https://guides.example.org/granted-${randomUUID()}`, provenance);
    const stored = await persistGamingSourceRevision({ ...item, authorityAuthorization: {
      revisionContentHash: item.contentHash, approvedDocumentHash: provenance.approvedContentHash,
      assessment: provenance.gamingClear, restrictedRevisionCount: 0 } });
    const rows = await searchActiveGamingKnowledge({ gameKey: item.gameKey, query: 'crystal', sourceIds: [stored.sourceId] });
    expect(rows).toHaveLength(1);
    expect(rows[0].authorityReassessmentRequired).toBeUndefined();
    expect(selectStoredGamingEvidence(rows, request)).toHaveLength(1);
    const { gamingClear: _assessment, approvedContentHash: _approvedHash, hybridPolicyVersion: _policy, ...independent } = provenance;
    const ordinary = await persistGamingSourceRevision(inputFor(`https://guides.example.org/independent-${randomUUID()}`, independent));
    const ordinaryRows = await searchActiveGamingKnowledge({ gameKey: item.gameKey, query: 'crystal', sourceIds: [ordinary.sourceId] });
    expect(ordinaryRows[0].authorityReassessmentRequired).toBeUndefined();
    expect(selectStoredGamingEvidence(ordinaryRows, request)).toHaveLength(1);
  });

  test('marker-bearing immutable history still requires proof when an alternate writer clears active markers', async () => {
    const url = `https://guides.example.org/historical-marker-${randomUUID()}`;
    const provenance = approvedProvenance();
    const original = await persistGamingSourceRevision(inputFor(url, provenance));
    const body = `${text} Preserve charge on the return crossing.`;
    const { gamingClear: _assessment, approvedContentHash: _approvedHash, hybridPolicyVersion: _policy, ...independent } = provenance;
    independent.acquiredApplicability = { ...independent.acquiredApplicability, contentHash: digest(body) };
    const alternate = await persistGamingSourceRevision(inputFor(url, independent, 1, body));
    expect(alternate.sourceId).toBe(original.sourceId);
    expect(alternate.revisionId).not.toBe(original.revisionId);
    // Model an alternate durable writer removing all active approval/hold fields.
    // The original immutable hybrid revision remains the authority boundary.
    await pool.query('UPDATE gaming_source_revisions SET provenance=$2::jsonb WHERE id=$1', [alternate.revisionId, JSON.stringify(independent)]);
    const rows = await searchActiveGamingKnowledge({ gameKey: 'platinum-lantern', query: 'crystal', sourceIds: [original.sourceId] });
    expect(rows).toHaveLength(1);
    expect(rows[0].provenance.gamingClear).toBeUndefined();
    expect(rows[0].provenance.generationEligible).toBe(true);
    expect(rows[0].normalized.text).toBe(body);
    expect(rows[0].authorityReassessmentRequired).toBe(true);
    expect(selectStoredGamingEvidence(rows, request)).toEqual([]);
  });

  test('refills beyond one hundred held lexical rows while preserving raw inspection and eligible evidence', async () => {
    const held = await persistGamingSourceRevision(inputFor(`https://guides.example.org/held-${randomUUID()}`,
      { ...approvedProvenance(), classification: 'stored_unverified', generationEligible: false }, 125));
    // Equal lexical rank is ordered by trust. All retained rows precede the guide.
    await pool.query('UPDATE gaming_sources SET trust_score=1 WHERE id=$1', [held.sourceId]);
    const provenance = approvedProvenance();
    const good = inputFor(`https://guides.example.org/lower-${randomUUID()}`, provenance);
    const eligible = await persistGamingSourceRevision({ ...good, trustScore: 0.1, authorityAuthorization: {
      revisionContentHash: good.contentHash, approvedDocumentHash: provenance.approvedContentHash,
      assessment: provenance.gamingClear, restrictedRevisionCount: 0 } });
    // Isolate this real SQL ranking fixture from other cases in the shared schema.
    await pool.query("UPDATE gaming_sources SET status='disabled' WHERE id <> ALL($1::uuid[])", [[held.sourceId, eligible.sourceId]]);
    const raw = await searchActiveGamingKnowledge({ gameKey: good.gameKey, query: 'crystal', limit: 20 });
    expect(raw).toHaveLength(20);
    expect(raw.every(row => row.sourceId === held.sourceId && row.authorityReassessmentRequired)).toBe(true);
    const found = await retrieveStoredGamingKnowledge(request, { resolveVerifiedPatch: () => undefined });
    expect(found.context).toContain('silver telescope');
    expect(found.evidence?.map(chunk => chunk.sourceId)).toEqual([eligible.sourceId]);
    expect(found.sources).toHaveLength(1);
    expect(found.clearEvidenceAssessment?.decision).toBe('accept');
    const retained = await searchActiveGamingKnowledge({ gameKey: good.gameKey, query: 'crystal', sourceIds: [held.sourceId], limit: 50 });
    expect(retained).toHaveLength(50);
    expect(retained.every(row => row.normalized.text === text)).toBe(true);
  });

  test('refills the source identity window after twenty higher-ranked held sources', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const stored = await persistGamingSourceRevision({ ...inputFor(`https://guides.example.org/held-identity-${randomUUID()}`,
        { ...approvedProvenance(), classification: 'reference_only', generationEligible: false }), trustScore: 1 });
      ids.push(stored.sourceId);
    }
    const provenance = approvedProvenance();
    const item = { ...inputFor(`https://guides.example.org/eligible-identity-${randomUUID()}`, provenance), trustScore: 0.1 };
    const good = await persistGamingSourceRevision({ ...item, authorityAuthorization: { revisionContentHash: item.contentHash,
      approvedDocumentHash: provenance.approvedContentHash, assessment: provenance.gamingClear, restrictedRevisionCount: 0 } });
    ids.push(good.sourceId);
    await pool.query("UPDATE gaming_sources SET status='disabled' WHERE id <> ALL($1::uuid[])", [ids]);
    const found = await retrieveStoredGamingKnowledge(request, { resolveVerifiedPatch: () => undefined });
    expect(found.evidence?.map(chunk => chunk.sourceId)).toEqual([good.sourceId]);
    expect(found.sources).toHaveLength(1);
    expect(found.clearEvidenceAssessment?.decision).toBe('accept');
    const held = await searchActiveGamingKnowledge({ gameKey: item.gameKey, query: 'crystal', sourceIds: ids.slice(0, 20), limit: 50 });
    expect(held).toHaveLength(20);
    expect(held.every(row => row.authorityReassessmentRequired)).toBe(true);
  });
});
