import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSandboxCommand, runOfflineValidation } from './check-documentation-offline.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardUrl = pathToFileURL(path.join(repositoryRoot, 'scripts/documentation-offline-guard.mjs')).href;
const secret = 'synthetic-test-secret-must-not-appear-in-evidence';
const sensitiveKeys = [
  'OPENAI_API_KEY', 'ARCANOS_API_KEY', 'BACKEND_API_KEY', 'CI_API_KEY',
  'ARCANOS_GPT_ACCESS_TOKEN', 'ARCANOS_AUTOMATION_SECRET', 'GITHUB_TOKEN',
  'DATABASE_URL', 'DATABASE_PRIVATE_URL', 'PGHOST', 'PGPASSWORD', 'REDIS_URL',
  'SESSION_PERSISTENCE_URL', 'SESSION_PERSISTENCE_SQLITE_PATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'NODE_PATH',
];

function withEnvironment(values, operation) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runFixture(t, source, { dynamicGuard = false, allowFilesystemWrite = false } = {}) {
  // Keep fixtures outside the sandbox's private /tmp and out of generated indexes.
  const directory = mkdtempSync(path.join(repositoryRoot, '.documentation-offline-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'fixture.mjs');
  writeFileSync(fixture, source);
  const sandbox = createSandboxCommand();
  const args = [...sandbox.args];
  if (dynamicGuard) {
    assert.equal(args.at(-2), '--import');
    assert.equal(args.at(-1), guardUrl);
    args.splice(-2);
  }
  if (allowFilesystemWrite) args.push('--allow-fs-write=*');
  const result = spawnSync(sandbox.command, [...args, fixture], sandbox.options);
  // Child failure text is deliberately excluded from assertion diagnostics.
  assert.equal(result.error, undefined, 'sandbox must be available without a fallback');
  assert.equal(result.signal, null, 'sandbox fixture must finish within its bound');
  assert.equal(result.status, 0, 'sandbox fixture rejected its safety assertion');
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  return { directory, output: JSON.parse(result.stdout) };
}

test('sandbox command removes inherited credentials, proxies and Node preload injection', () => {
  withEnvironment(Object.fromEntries(sensitiveKeys.map((key) => [key, secret])), () => {
    const sandbox = createSandboxCommand();
    assert.equal(sandbox.command, '/usr/bin/bwrap');
    assert.equal(sandbox.options.shell, false);
    assert.equal(sandbox.options.cwd, repositoryRoot);
    assert.equal(JSON.stringify(sandbox).includes(secret), false);
    assert.equal(sensitiveKeys.some((key) => Object.hasOwn(sandbox.options.env, key)), false);
    for (const flag of ['--unshare-user', '--unshare-net', '--unshare-pid', '--clearenv', '--permission', '--allow-fs-read=*']) {
      assert.equal(sandbox.args.includes(flag), true, flag);
    }
    assert.equal(sandbox.args.includes('--allow-worker'), false);
    assert.equal(sandbox.args.includes('--allow-addons'), false);
    assert.equal(sandbox.args.some((arg) => arg.startsWith('--allow-fs-write')), false);
    assert.deepEqual(sandbox.args.slice(sandbox.args.indexOf('--ro-bind'), sandbox.args.indexOf('--ro-bind') + 3), ['--ro-bind', '/', '/']);
  });
});

test('guard blocks actual transport entry points before their original implementations run', (t) => {
  const { output } = runFixture(t, `
    import assert from 'node:assert/strict';
    import http, { request as namedHttpRequest } from 'node:http';
    import https from 'node:https';
    import http2 from 'node:http2';
    import net from 'node:net';
    import tls from 'node:tls';
    import dgram from 'node:dgram';
    import dns from 'node:dns';
    import dnsPromises, { lookup as namedLookup } from 'node:dns/promises';
    let originalCalls = 0;
    function originalTransport() { originalCalls++; throw new Error('ORIGINAL_TRANSPORT_REACHED'); }
    const methods = [
      [http, 'request'], [http, 'get'], [http.Agent.prototype, 'createConnection'],
      [https, 'request'], [https, 'get'], [https.Agent.prototype, 'createConnection'],
      [http2, 'connect'], [net, 'connect'], [net, 'createConnection'],
      [net.Socket.prototype, 'connect'], [net.Server.prototype, 'listen'], [tls, 'connect'],
      [dgram, 'createSocket'], [dgram.Socket.prototype, 'bind'],
      [dgram.Socket.prototype, 'connect'], [dgram.Socket.prototype, 'send'],
      [dns, 'lookup'], [dns, 'lookupService'], [dns, 'resolve'], [dns, 'resolve4'], [dns, 'reverse'],
      [dns.Resolver.prototype, 'resolve4'], [dnsPromises, 'lookup'], [dnsPromises, 'resolve'],
      [dnsPromises, 'reverse'], [dnsPromises.Resolver.prototype, 'resolve4'],
    ];
    for (const [target, method] of methods) target[method] = originalTransport;
    globalThis.fetch = originalTransport;
    globalThis.WebSocket = originalTransport;
    const guard = await import(${JSON.stringify(guardUrl)});
    guard.installDocumentationOfflineGuard();
    const target = 'https://user:${secret}@192.0.2.1/synthetic?token=${secret}';
    const operations = methods.map(([object, name]) => () => object[name](target, { authorization: '${secret}' }));
    operations.push(() => fetch(target), () => new WebSocket(target),
      () => namedHttpRequest(target), () => namedLookup('synthetic.invalid'),
      () => new dns.Resolver().resolve4('synthetic.invalid', () => {}),
      () => new dnsPromises.Resolver().resolve4('synthetic.invalid'),
      () => new net.Socket().connect(443, '192.0.2.1'),
      () => net.createServer().listen(0));
    for (const operation of operations) assert.throws(operation, (error) =>
      error.code === guard.DOCS_OFFLINE_NETWORK_BLOCKED && error.message === error.code);
    assert.equal(originalCalls, 0);
    console.log(JSON.stringify({ blocked: operations.length, originalCalls }));
  `, { dynamicGuard: true });
  assert.equal(output.blocked, 34);
  assert.equal(output.originalCalls, 0);
});

for (const mode of ['missing', 'mock', 'real-shaped']) {
  test(`provider client attempts fail with ${mode} credentials; child environment stays empty of credentials`, (t) => {
    const credential = mode === 'missing' ? undefined : mode === 'mock' ? 'sk-mock-for-ci-testing' : `sk-${secret}`;
    withEnvironment({ ...Object.fromEntries(sensitiveKeys.map((key) => [key, secret])), OPENAI_API_KEY: credential }, () => {
      const report = runOfflineValidation({ execute: () => ({ status: 0 }) });
      assert.equal(report.generation.status, 'skipped');
      assert.equal(report.providerAccess, 'blocked');
      assert.deepEqual(report.updates, []);
      assert.equal(JSON.stringify(report).includes(secret), false);
      const { output } = runFixture(t, `
        import assert from 'node:assert/strict';
        for (const key of ${JSON.stringify(sensitiveKeys)}) assert.equal(process.env[key], undefined);
        let originalCalls = 0;
        globalThis.fetch = () => { originalCalls++; throw new Error('ORIGINAL_PROVIDER_TRANSPORT_REACHED'); };
        const guard = await import(${JSON.stringify(guardUrl)});
        // A dependency-free SDK equivalent uses the same final fetch boundary,
        // including when callers supply mock credentials or enable mock mode.
        class ProviderClientFixture {
          constructor(apiKey) { this.apiKey = apiKey; this.mock = true; }
          async generate() {
            return fetch('https://192.0.2.1/synthetic', {
              method: 'POST', headers: { authorization: this.apiKey ?? '' },
            });
          }
        }
        const client = new ProviderClientFixture(${JSON.stringify(credential) ?? 'undefined'});
        await assert.rejects(client.generate(), (error) =>
          error.code === guard.DOCS_OFFLINE_NETWORK_BLOCKED && error.message === error.code);
        assert.equal(originalCalls, 0);
        console.log(JSON.stringify({ providerResult: 'blocked', originalCalls }));
      `, { dynamicGuard: true });
      assert.deepEqual(output, { providerResult: 'blocked', originalCalls: 0 });
    });
  });
}

test('only pinned read-only Git queries may spawn; workers and native addons stay denied', (t) => {
  const { output } = runFixture(t, `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { Worker } from 'node:worker_threads';
    const gitArgs = ['ls-files', '-z', '--', '*.md'];
    const options = { cwd: process.cwd(), encoding: 'utf8' };
    const files = childProcess.spawnSync('git', gitArgs, options);
    assert.equal(files.status, 0);
    assert.equal(files.stdout.split('\\0').includes('README.md'), true);
    const grep = childProcess.spawnSync('/usr/bin/git', [
      'grep', '-n', '-F', '--', ['SYNTHETIC_UNMATCHED', 'DOCUMENTATION_TOKEN', '91825'].join('_'), '--',
      ':!scripts/check-documentation.mjs', ':!docs/audits/**',
    ], options);
    // The fixture itself is untracked, so this sentinel must not match.
    assert.equal(grep.status, 1);
    const attempts = [
      () => childProcess.exec('synthetic-${secret}'),
      () => childProcess.execSync('synthetic-${secret}'),
      () => childProcess.execFile('/bin/true'),
      () => childProcess.execFileSync('/bin/true'),
      () => childProcess.spawn('/bin/true'),
      () => childProcess.fork('/synthetic-no-child.js'),
      () => childProcess.spawnSync('/bin/true', []),
      () => childProcess.spawnSync('git', ['status'], options),
      () => childProcess.spawnSync('git', ['-c', 'alias.ls-files=!synthetic', ...gitArgs], options),
      () => childProcess.spawnSync('git', gitArgs, { ...options, shell: true }),
      () => childProcess.spawnSync('git', gitArgs, { ...options, env: { OPENAI_API_KEY: '${secret}' } }),
      () => childProcess.spawnSync('git', gitArgs, { ...options, cwd: '/' }),
      () => childProcess.ChildProcess.prototype.spawn.call({}, {}),
    ];
    for (const attempt of attempts) assert.throws(attempt, (error) =>
      error.code === 'DOCS_OFFLINE_PROCESS_BLOCKED' && error.message === error.code);
    assert.throws(() => new Worker('', { eval: true }), { code: 'ERR_ACCESS_DENIED' });
    assert.throws(() => process.dlopen({}, '/synthetic-addon.node'), { code: 'ERR_DLOPEN_DISABLED' });
    console.log(JSON.stringify({ deniedProcesses: attempts.length, workerDenied: true, addonDenied: true }));
  `);
  assert.deepEqual(output, { deniedProcesses: 13, workerDenied: true, addonDenied: true });
});

test('the read-only mount independently blocks document, memory and database writes', (t) => {
  const { directory, output } = runFixture(t, `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const file of ['memory.json', 'database.sqlite', 'documentation-update.md']) {
      assert.throws(() => writeFileSync(join(directory, file), 'synthetic'), { code: 'EROFS' });
    }
    console.log(JSON.stringify({ writesDenied: 3 }));
  `, { allowFilesystemWrite: true });
  assert.equal(output.writesDenied, 3);
  for (const file of ['memory.json', 'database.sqlite', 'documentation-update.md']) {
    assert.equal(existsSync(path.join(directory, file)), false);
  }
});

test('actual offline validation passes without generation, updates or persistent output', () => {
  const indexes = ['backend-index.json', 'cli-agent-index.json', 'docs/BACKEND_INDEX.md', 'docs/CLI_AGENT_INDEX.md'];
  const before = indexes.map((file) => readFileSync(path.join(repositoryRoot, file)));
  const report = runOfflineValidation();
  assert.equal(report.validation.status, 'passed');
  assert.deepEqual(report.checks, [
    { name: 'documentation', status: 'passed', exitCode: 0 },
    { name: 'generated-indexes', status: 'passed', exitCode: 0 },
    { name: 'local-links', status: 'passed', exitCode: 0 },
  ]);
  assert.equal(report.generation.status, 'skipped');
  assert.equal(report.providerAccess, 'blocked');
  assert.deepEqual(report.updates, []);
  assert.equal(report.publication.requiresHumanReview, true);
  indexes.forEach((file, index) => assert.deepEqual(readFileSync(path.join(repositoryRoot, file)), before[index]));
});

for (const [name, response] of [
  ['validator exit', { status: 1, stdout: secret, stderr: secret }],
  ['sandbox unavailable', { status: null, error: { code: 'ENOENT', message: secret } }],
  ['timeout', { status: null, signal: 'SIGKILL', stderr: secret }],
  ['error despite zero exit', { status: 0, error: new Error(secret) }],
  ['missing result', undefined],
]) {
  test(`${name} fails closed with sanitized evidence and no unsandboxed fallback`, () => {
    const calls = [];
    const report = runOfflineValidation({ execute: (...args) => { calls.push(args); return response; } });
    assert.equal(report.validation.status, 'failed');
    assert.equal(report.generation.status, 'skipped');
    assert.equal(report.providerAccess, 'blocked');
    assert.deepEqual(report.updates, []);
    assert.equal(report.publication.requiresHumanReview, true);
    assert.equal(report.checks.every((check) => check.status === 'failed'), true);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(calls.length, 3);
    assert.equal(calls.every(([command]) => command === '/usr/bin/bwrap'), true);
    assert.deepEqual(calls.map(([, args]) => args.slice(args.indexOf(guardUrl) + 1)), [
      [path.join(repositoryRoot, 'scripts/check-documentation.mjs')],
      [path.join(repositoryRoot, 'scripts/reindex-codebase.js'), '--check'],
      [path.join(repositoryRoot, 'scripts/check-documentation-links.mjs'), '--local-only'],
    ]);
  });
}

test('thrown failures and successful child output cannot leak secrets or imply provider generation', () => {
  const failed = runOfflineValidation({ execute: () => { throw new Error(secret); } });
  const passed = runOfflineValidation({ execute: () => ({ status: 0, stdout: secret, stderr: secret }) });
  assert.equal(failed.validation.status, 'failed');
  assert.equal(passed.validation.status, 'passed');
  for (const report of [failed, passed]) {
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(report.generation.status, 'skipped');
    assert.equal(report.providerAccess, 'blocked');
    assert.deepEqual(report.updates, []);
    assert.equal(report.publication.requiresHumanReview, true);
  }
});
