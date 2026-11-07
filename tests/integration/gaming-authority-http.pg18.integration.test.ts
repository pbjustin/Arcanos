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
  expect(receipt.checks).toEqual(expect.arrayContaining(['refresh cannot grant authority', 'real compiled grounded response', 'no unauthorized network attempted']));
  expect(receipt.freshProcess.freshProcess).toBe(true);
  expect(receipt.freshProcess.checks).toContain('fresh no external network');
  expect(receipt.checks).toContain('real structured reasoning reached provider transport');
  expect(receipt.provider).toBe('synthetic loopback HTTP; real SDK/adapter/Trinity');
}, 100_000);
