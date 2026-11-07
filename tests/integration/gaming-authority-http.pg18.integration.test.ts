import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolvePostgresTestDatabaseUrl, assertDisposablePostgresTestDatabaseUrl } from './postgresTestDatabase.js';

const target = resolvePostgresTestDatabaseUrl('JOB_CLAIM_FENCING_TEST_DATABASE_URL');
if (target) assertDisposablePostgresTestDatabaseUrl(target, 'JOB_CLAIM_FENCING_TEST_DATABASE_URL');
const databaseTest = target ? test : test.skip;

databaseTest('compiled authenticated MCP, real SQL queue/worker, protected loopback acquisition, CLEAR and fresh-process authority', () => {
  const output = execFileSync(process.execPath, [resolve('tests/fixtures/gaming-authority-compiled-http.mjs')], {
    cwd: process.cwd(), env: { ...process.env, JOB_CLAIM_FENCING_TEST_DATABASE_URL: target! },
    encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024
  });
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
  expect(receipt.freshProcess.freshProcess).toBe(true);
  expect(receipt.freshProcess.checks).toContain('fresh no external network');
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
