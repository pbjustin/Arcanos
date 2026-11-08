import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { resolvePostgresTestDatabaseUrl, assertDisposablePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const target = resolvePostgresTestDatabaseUrl('JOB_CLAIM_FENCING_TEST_DATABASE_URL');
if (target) assertDisposablePostgresTestDatabaseUrl(target, 'JOB_CLAIM_FENCING_TEST_DATABASE_URL');
const databaseTest = target ? test : test.skip;

async function compiledFixture(args: string[] = []): Promise<string> {
  // The parent owns the exact cleanup target; child logs never choose a schema.
  const schema = `gaming_http_${randomUUID().replaceAll('-', '')}`;
  try {
    return execFileSync(process.execPath, [resolve('tests/fixtures/gaming-authority-compiled-http.mjs'), '--schema', schema, ...args], {
      cwd: process.cwd(), env: { ...process.env, JOB_CLAIM_FENCING_TEST_DATABASE_URL: target! },
      encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    // Node child-process errors can be circular; retain bounded phase evidence
    // without preventing Jest from writing its machine-readable failure receipt.
    const failure = error as { code?: string; status?: number; signal?: string; stderr?: Buffer | string };
    const stderr = failure.stderr?.toString() ?? '';
    const phases = stderr.split(/\r?\n/u).filter(line => line.startsWith('GAMING_HTTP_PHASE ')).slice(-8);
    const diagnostic = stderr.split(/\r?\n/u).filter(line => !line.startsWith('GAMING_HTTP_PHASE ')).join('\n').slice(-2500)
      .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/giu, '$1<redacted>@')
      .replace(/\bBearer\s+[^\s"']+/giu, 'Bearer <redacted>')
      .replace(/\b(?:sk-proj-|sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/gu, '<redacted-token>')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '<redacted-jwt>');
    const cleanup = { schema, verifiedAbsent: false };
    const client = new Client({ connectionString: target!, ssl: false, connectionTimeoutMillis: 1000,
      statement_timeout: 1000, query_timeout: 2000 });
    try {
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const remaining = await client.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present', [schema]);
      cleanup.verifiedAbsent = remaining.rows[0].present === false;
    } catch { /* The primary child failure remains primary; cleanup status stays false. */ }
    finally { await client.end(); }
    throw Object.assign(new Error(`Compiled HTTP fixture failed (${failure.code ?? 'child exit'}, status=${failure.status}, signal=${failure.signal}).\n${phases.join('\n')}\n${diagnostic}`), { cleanup });
  }
}

databaseTest('compiled authenticated MCP, real SQL queue/worker, protected loopback acquisition, CLEAR and fresh-process authority', async () => {
  const output = await compiledFixture();
  const marker = output.split('GAMING_HTTP_RECEIPT ').at(-1);
  expect(marker).not.toBe(output);
  const receipt = JSON.parse(marker!.split(/\r?\n/u)[0]);
  expect(receipt.compiled).toBe(true);
  expect(receipt.sourceIdentity.commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  expect(receipt.sourceIdentity.buildIdentity.artifactStatus).toBe('matches_build_receipt');
  expect(receipt.freshProcess.sourceIdentity).toEqual(receipt.sourceIdentity);
  expect(receipt.checks).toEqual(expect.arrayContaining(['refresh cannot grant authority', 'real compiled grounded response', 'no unauthorized network attempted',
    'owner-confirmed verified hybrid selects grounded evidence', 'owner-confirmed verified hybrid persists through queued worker',
    'owner-confirmed verified hybrid uses real provider stages']));
  expect(receipt.checks).toEqual(expect.arrayContaining([
    'authenticated hybrid revocation begins with partial accepted evidence',
    'authenticated hybrid revocation source persists through real queued worker',
    'authenticated hybrid revocation binds the exact approved game and URL',
    'authenticated hybrid revocation worker commits source-use rejection',
    'authenticated hybrid revocation observes exact SQL restriction epoch one',
    'authenticated hybrid revocation withholds recovery evidence and answer',
    'authenticated hybrid revocation invokes no provider'
  ]));
  expect(receipt.hybridRevocation).toMatchObject({ game: 'EVE Online', edition: 'base-game', storageGameKey: 'eve-online-base-game',
    storedClassification: 'verified', restrictedRevisionCount: 1, providerRequestsAdded: 0,
    heldOutcome: { status: 'rejected', error: { code: 'SOURCE_USE_RESTRICTED' } },
    recovery: { reason: 'EVIDENCE_REVALIDATION_REQUIRED', evidenceSelected: false, selectedCandidateIds: [], selectedEvidenceIds: [] } });
  expect(receipt.hybridRevocation.retainedSqlRows).toBeGreaterThan(0);
  expect(receipt.hybridRevocation.recovery.answer).toBeUndefined();
  expect(receipt.freshProcess.freshProcess).toBe(true);
  expect(receipt.freshProcess.checks).toContain('fresh no external network');
  expect(receipt.freshProcess.checks).toEqual(expect.arrayContaining([
    'fresh held hybrid source exact SQL identity', 'fresh held hybrid source requires reassessment',
    'fresh held hybrid source exact restriction epoch', 'fresh held hybrid source excluded'
  ]));
  expect(receipt.freshProcess.checks).toContain("fresh normal retrieval CLEAR Baldur's Gate 3");
  expect(receipt.states).toEqual(expect.arrayContaining([expect.objectContaining({ game: "Baldur's Gate 3",
    classification: 'verified', generationEligible: true, eligible: true, revisionId: expect.any(String) })]));
  expect(receipt.checks).toContain('real structured reasoning reached provider transport');
  expect(receipt.checks).toContain('every grounded generation request received selected evidence');
  const groundedRequests = receipt.providerRequests.filter((request: { lane: string; model: string }) =>
    request.lane === 'structured-reasoning' || request.model === 'ft:gpt-4.1:synthetic:gaming-http-authority');
  expect(groundedRequests).toHaveLength(4);
  expect(groundedRequests.every((request: { selectedEvidenceReceived?: boolean }) => request.selectedEvidenceReceived === true)).toBe(true);
  expect(receipt.provider).toBe('synthetic loopback HTTP; real SDK/adapter/Trinity');
  expect(receipt.providerRequests).toHaveLength(receipt.generated + receipt.audited);
  expect(receipt.audited).toBe(2);
  console.info('GAMING_HTTP_TEST_RECEIPT ' + JSON.stringify({ sourceIdentity: receipt.sourceIdentity,
    checks: receipt.checks.length, freshChecks: receipt.freshProcess.checks.length,
    generated: receipt.generated, audited: receipt.audited, providerRequests: receipt.providerRequests }));
}, 100_000);

databaseTest('compiled fixture preserves a child failure receipt and cleans only its parent-owned disposable schema', async () => {
  await expect(compiledFixture(['--exit-after-schema'])).rejects.toMatchObject({
    message: expect.stringContaining('synthetic abrupt child failure'),
    cleanup: { schema: expect.stringMatching(/^gaming_http_[a-f0-9]{32}$/u), verifiedAbsent: true }
  });
}, 100_000);
