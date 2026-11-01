import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import yaml from 'js-yaml';
import {
  containerArguments, parseOptions, retainProof, runFixtures, validateFixtureProof,
} from '../scripts/run-railway-inspection-e2e.mjs';
import { fixtureCaseWritesReceipt, requiredFixtureCases } from './fixtures/railway-production-inspection/cases.mjs';
import { startFixtureClock } from './fixtures/railway-production-inspection/timing.mjs';

const sourceSha = 'a'.repeat(40);
const sourceContextSha256 = 'b'.repeat(64);
const expected = { sourceSha, sourceContextSha256, postgresMajor: 17, relevantWorktreeDirty: false };
/** Build complete synthetic evidence for validator tests without executing the collector. */
const proof = (postgresMajor = 17) => ({
  schema: 'arcanos-production-inspection-e2e/v1', status: 'PASS',
  ...expected, postgresMajor, nodeVersion: 'v24.18.1', syntheticGithubAuthority: true,
  postgresVersion: `${postgresMajor}.9`,
  setupChecks: [{ name: 'database-server-key-mismatch', status: 'PASS',
    postgresStartupRejected: true, collectorExecuted: false }],
  teardown: { postgresStopped: true, fixtureDirectoryRemoved: true, pausedBackendsRemaining: 0 },
  cases: requiredFixtureCases(postgresMajor).map(name => ({
    name, status: 'PASS', databaseFingerprintUnchanged: true, collectorSessionsRemaining: 0,
    ...(fixtureCaseWritesReceipt(name) ? { receiptSha256: 'd'.repeat(64), receiptStatus: 'BLOCKED' } : {}),
  })),
});

describe('inspection E2E fixture safety', () => {
  const directories = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it.each([14990, 30000])('keeps the timeout duration monotonic when wall time changes to %s', wallEnd => {
    const wall = jest.spyOn(Date, 'now').mockReturnValueOnce(10000).mockReturnValueOnce(wallEnd);
    const monotonic = jest.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(5600);
    try {
      const elapsed = startFixtureClock();
      expect(elapsed()).toBe(5500);
    } finally {
      wall.mockRestore();
      monotonic.mockRestore();
    }
  });

  it('pauses the observed lock-waiting backend before any TLS-inspection await', async () => {
    const source = readFileSync('tests/fixtures/railway-production-inspection/run-fixtures.mjs', 'utf8');
    const timeoutCase = source.slice(source.indexOf("await runCase('database-query-timeout'"),
      source.indexOf("await runCase('database-connection-loss'"));
    const body = /duringCollector: async \(\) => \{([\s\S]*?)\n    \}, errorCode:/u.exec(timeoutCase)?.[1];
    expect(body).toBeDefined();
    const events = [];
    const backend = { pid: 12345, wait_event_type: 'Lock', query: 'SELECT fixture_constraints' };
    // Execute the actual fixture callback with inert effects; never signal a real process or run SQL.
    const inject = runInNewContext(`(async () => {${body}})`, {
      collectorBackend: async predicate => { expect(predicate(backend)).toBe(true); return backend; },
      normalizeSql: value => value.trim(), CATALOG_QUERIES: { constraints: backend.query },
      captureTlsSession: async () => { events.push('tls'); },
      suspendBackend: (observed, durationMs) => {
        expect(observed).toBe(backend); expect(durationMs).toBe(5500);
        events.push('pause'); return Promise.resolve();
      },
      lockClient: { query: async sql => { expect(sql).toBe('ROLLBACK'); events.push('rollback'); },
        end: async () => { events.push('end'); } },
    });
    await inject();
    expect(events).toEqual(['pause', 'tls', 'rollback', 'end']);
  });

  /** Build synthetic artifact files to test independent validation, without executing any collector. */
  function receiptBundle() {
    const directory = mkdtempSync(join(tmpdir(), 'inspection-e2e-receipt-test-'));
    directories.push(directory);
    const source = join(directory, 'source');
    const destination = join(directory, 'retained');
    mkdirSync(source);
    const value = proof();
    for (const item of value.cases.filter(entry => fixtureCaseWritesReceipt(entry.name))) {
      const serialized = `${JSON.stringify({ status: item.receiptStatus, syntheticCase: item.name })}\n`;
      item.receiptSha256 = createHash('sha256').update(serialized).digest('hex');
      writeFileSync(join(source, `${item.name}.json`), serialized, { mode: 0o600 });
    }
    writeFileSync(join(source, 'proof.json'), JSON.stringify(value), { mode: 0o600 });
    return { source, destination };
  }

  it('independently hashes and retains an untampered receipt bundle', () => {
    const { source, destination } = receiptBundle();
    expect(retainProof(source, destination, expected).status).toBe('PASS');
    expect(readFileSync(join(destination, 'complete-catalog.json'), 'utf8'))
      .toBe(readFileSync(join(source, 'complete-catalog.json'), 'utf8'));
  });

  it('rejects changed receipt bytes even when JSON is valid and the claimed hash is unchanged', () => {
    const { source, destination } = receiptBundle();
    const receipt = join(source, 'complete-catalog.json');
    writeFileSync(receipt, `${readFileSync(receipt, 'utf8')} `);
    expect(() => retainProof(source, destination, expected)).toThrow('FIXTURE_PROOF_RECEIPT_HASH_MISMATCH');
  });

  it.each([
    ['--postgres-major', '19'], ['--postgres-major', 'production'],
    ['--output-directory', 'relative'], ['--output-directory', '/tmp/fixture,src=/existing'],
    ['--postgres-major'], ['--production', 'true'],
    ['--postgres-major', '17', '--postgres-major', '18'],
  ])('rejects unsafe or ambiguous arguments %j', (...args) => {
    expect(() => parseOptions(args)).toThrow();
  });

  it('refuses an existing output directory without touching its files or starting Docker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inspection-e2e-existing-test-'));
    directories.push(directory);
    const sentinel = join(directory, 'preserve'); writeFileSync(sentinel, 'preserve existing work');
    await expect(runFixtures({ postgresMajors: [17], outputDirectory: directory }))
      .rejects.toThrow('FIXTURE_OUTPUT_DIRECTORY_EXISTS');
    expect(readFileSync(sentinel, 'utf8')).toBe('preserve existing work');
  });

  it('requires a network-disabled read-only runtime with loopback aliases and no published ports', () => {
    const args = containerArguments({ name: `arcanos-inspection-e2e-${'a'.repeat(24)}-pg17`,
      imageId: `sha256:${'c'.repeat(64)}`, proofDirectory: '/tmp/test-only-proof',
      sourceSha, postgresMajor: 17, relevantWorktreeDirty: false });
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'none']);
    expect(args).toContain('--read-only');
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('--privileged');
    expect(args).toContain('backboard.railway.com:127.0.0.1');
    expect(args).toContain('shortline.proxy.rlwy.net:127.0.0.1');
    expect(args).toContain('-i');
    expect(args).not.toContain('HOME=/tmp');
    expect(args.some(arg => /(?:RAILWAY_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|DATABASE_URL)=/u.test(arg))).toBe(false);
  });

  it.each([
    value => { value.sourceSha = 'c'.repeat(40); },
    value => { value.postgresMajor = 18; },
    value => { value.relevantWorktreeDirty = true; },
    value => { value.nodeVersion = 'v24.19.0'; },
    value => { value.syntheticGithubAuthority = false; },
    value => { delete value.postgresVersion; },
    value => { value.postgresVersion = '18.1'; },
    value => { delete value.setupChecks; },
    value => { value.setupChecks[0].collectorExecuted = true; },
    value => { value.setupChecks[0].postgresStartupRejected = false; },
    value => { delete value.teardown; },
    value => { value.teardown.pausedBackendsRemaining = 1; },
    value => { value.teardown.postgresStopped = false; },
    value => { value.teardown.fixtureDirectoryRemoved = false; },
    value => { value.sourceContextSha256 = 'c'.repeat(64); },
    value => { value.cases = []; },
    value => { value.cases.pop(); },
    value => { value.cases.reverse(); },
    value => { value.cases[1].name = value.cases[0].name; },
    value => { value.cases[0].name = 'unknown-case'; },
    value => { value.cases[0].status = 'FAIL'; },
    value => { value.cases[0].databaseFingerprintUnchanged = false; },
    value => { value.cases[0].collectorSessionsRemaining = 1; },
    value => { delete value.cases[0].receiptSha256; },
    value => { value.cases[0].receiptStatus = 'SUCCESS'; },
  ])('rejects misbound or incomplete fixture evidence', change => {
    const value = proof(); change(value);
    expect(() => validateFixtureProof(value, expected)).toThrow();
  });

  it.each([17, 18])('accepts the complete PostgreSQL %i inventory', postgresMajor => {
    const value = proof(postgresMajor);
    expect(validateFixtureProof(value, { ...expected, postgresMajor })).toBe(value);
    expect(value.cases.some(item => item.name === 'not-enforced-constraint')).toBe(postgresMajor === 18);
  });

  it('retains bound setup and partial failures without accepting incomplete success', () => {
    const value = proof(); value.status = 'FAIL'; value.cases = [];
    value.failureCode = 'FIXTURE_DATABASE_START_FAILED';
    expect(validateFixtureProof(value, expected)).toBe(value);
    value.cases = proof().cases.slice(0, 2); value.cases[1].status = 'FAIL';
    expect(validateFixtureProof(value, expected).status).toBe('FAIL');
    value.cases[1].name = 'unknown-case';
    expect(() => validateFixtureProof(value, expected)).toThrow('FIXTURE_PROOF_CASE_ORDER_INVALID');
  });

  it('keeps the preview-linked PostgreSQL matrix credential-free and retains failure receipts', () => {
    const text = readFileSync('.github/workflows/railway-inspection-fixture-e2e.yml', 'utf8');
    const workflow = yaml.load(text);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\.|pull_request_target|workflow_dispatch|railway (?:up|redeploy|restart)/u);
    const job = workflow.jobs['inspection-fixtures'];
    expect(job.if).toContain("'railway-preview'");
    expect(job.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(job.strategy.matrix['postgres-major']).toEqual(['17', '18']);
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with).toEqual({ ref: '${{ github.event.pull_request.head.sha }}', 'persist-credentials': false });
    expect(job.steps.find(step => step.run?.startsWith('npm ci')).run).toContain('--ignore-scripts');
    const artifact = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(artifact.if).toBe('always()');
    expect(artifact.with.path).toContain('/**/*.json');
    expect(artifact.with['if-no-files-found']).toBe('error');
  });
});
