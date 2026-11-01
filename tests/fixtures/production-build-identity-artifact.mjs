// Run only in a disposable, network-none container built from the tracked
// Dockerfile. Mutations target a private /tmp copy; /app is observation-only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.deepEqual(process.argv.slice(2), ['--isolated-image'], 'explicit isolated-image scope required');
assert.equal(process.platform, 'linux');
assert.equal(process.versions.node, '24.18.1');
assert.equal(process.cwd(), '/app');
assert.ok(existsSync('/.dockerenv'), 'container marker required');
assert.ok(!Object.entries(process.env).some(([name, value]) => value &&
  /TOKEN|SECRET|PASSWORD|OPENAI|DATABASE|REDIS|POSTGRES|^PG(?:HOST|PORT|USER|DATABASE|PASSWORD)$/u.test(name.toUpperCase())),
  'fixture refuses application/provider credentials');
const interfaces = readFileSync('/proc/net/dev', 'utf8').split('\n')
  .filter(line => line.includes(':')).map(line => line.split(':')[0].trim());
assert.deepEqual(interfaces, ['lo'], 'network-none container required');
assert.ok(!existsSync('/app/.git'), 'Docker artifact must not borrow Git metadata');

const imageModule = await import('/app/scripts/production-build-identity.mjs');
const receiptPath = '/app/dist/build-identity.json';
const imageReceiptBytes = readFileSync(receiptPath);
const imageReceipt = JSON.parse(imageReceiptBytes);
const original = imageModule.readProductionBuildIdentity({ rootPath: '/app', env: {} });
assert.equal(original.artifactStatus, 'matches_build_receipt', 'actual image receipt must match before fixture copying');
assert.equal(original.gitSha, null);
assert.equal(original.status, 'unverified');

const ownedRoot = mkdtempSync('/tmp/arcanos-image-identity-');
const sourceRoots = [
  'src', 'scripts', 'config', 'contracts', 'schemas', 'openapi', 'workers/src',
  'daemon-python/arcanos', 'packages', 'vendor', 'arcanos-ai-runtime/src'
];
const sourceFiles = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'railway.json',
  'workers/package.json', 'workers/tsconfig.json', 'daemon-python/pyproject.toml',
  'prisma/schema.prisma', 'arcanos-ai-runtime/package.json',
  'arcanos-ai-runtime/package-lock.json', 'arcanos-ai-runtime/tsconfig.json'
];
const results = [];
const pass = name => results.push({ name, passed: true });
try {
  const copyInput = (path, emitted = false) => {
    const from = join('/app', path);
    if (!existsSync(from)) return;
    const to = join(ownedRoot, path);
    assert.ok(resolve(to).startsWith(`${ownedRoot}/`));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, filter: file => {
      const relative = file.slice('/app/'.length);
      const segments = relative.split('/');
      if (segments.some(name => ['node_modules', '.git', '__pycache__'].includes(name) || /^\.env(?:\.|$)/u.test(name))) return false;
      if (!emitted && segments.includes('dist') && !relative.startsWith('vendor/')) return false;
      assert.ok(!lstatSync(file).isSymbolicLink(), 'image inventory inputs must not escape through links');
      return true;
    } });
  };
  for (const path of sourceRoots) copyInput(path);
  for (const path of sourceFiles) copyInput(path);
  for (const path of ['dist', 'workers/dist']) copyInput(path, true);
  for (const name of readdirSync('/app/packages')) {
    if (lstatSync(join('/app/packages', name)).isDirectory()) copyInput(`packages/${name}/dist`, true);
  }
  const options = { rootPath: ownedRoot, env: {} };
  const copiedModule = await import(pathToFileURL(join(ownedRoot, 'scripts/production-build-identity.mjs')).href);
  const copiedReceiptPath = join(ownedRoot, 'dist/build-identity.json');
  const read = () => copiedModule.readProductionBuildIdentity(options);
  assert.deepEqual(read(), original, 'copied measured image inputs must retain the original artifact identity');
  assert.deepEqual(copiedModule.writeProductionBuildIdentity(options), imageReceipt);
  assert.deepEqual(copiedModule.writeProductionBuildIdentity(options), imageReceipt);
  pass('actual_image_receipt_and_reproducible_generation');

  const reportInNativeChild = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
      'const module = await import(process.argv[1]); module.reportProductionBuildIdentity({rootPath:process.argv[2],env:{}});',
      pathToFileURL(join(ownedRoot, 'scripts/production-build-identity.mjs')).href, ownedRoot],
    { env: {}, encoding: 'utf8', timeout: 15_000, maxBuffer: 8192 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const line = `${result.stdout}${result.stderr}`.trim();
    assert.ok(line.startsWith('[railway-launcher] build.identity '));
    assert.ok(!line.includes('test-fixture-private-sentinel'));
    return JSON.parse(line.slice('[railway-launcher] build.identity '.length));
  };
  assert.deepEqual(reportInNativeChild(), original);
  pass('native_reporter_process_reads_actual_artifact_copy');

  for (const path of [
    'prisma/schema.prisma', 'vendor/minimatch-9.0.7/package.json',
    'vendor/minimatch-9.0.7/dist/commonjs/index.js', 'arcanos-ai-runtime/src/worker.ts',
    'arcanos-ai-runtime/package.json', 'arcanos-ai-runtime/package-lock.json', 'arcanos-ai-runtime/tsconfig.json',
    'dist/start-server.js'
  ]) {
    const target = join(ownedRoot, path);
    const before = readFileSync(target);
    try {
      writeFileSync(target, Buffer.concat([before, Buffer.from('\nfixture mutation\n')]));
      assert.equal(read().artifactStatus, 'mismatch');
      assert.equal(read().gitSha, null);
      pass(`mutation_detected:${path}`);
    } finally { writeFileSync(target, before); }
    assert.equal(read().artifactStatus, 'matches_build_receipt');
  }

  unlinkSync(copiedReceiptPath);
  assert.equal(reportInNativeChild().artifactStatus, 'unknown');
  pass('missing_receipt_warns_unverified_without_failing_reporter');
  writeFileSync(copiedReceiptPath, '{test-fixture-private-sentinel');
  assert.equal(reportInNativeChild().artifactStatus, 'unknown');
  pass('corrupt_receipt_warns_unverified_without_reflecting_content');
  writeFileSync(copiedReceiptPath, imageReceiptBytes);

  const configured = { rootPath: ownedRoot, env: { RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40) } };
  assert.equal(copiedModule.writeProductionBuildIdentity(configured).gitSha, null);
  assert.equal(copiedModule.readProductionBuildIdentity(configured).status, 'unverified');
  pass('platform_reference_cannot_establish_git_commit_without_metadata');
  writeFileSync(copiedReceiptPath, imageReceiptBytes);

  const sourceLink = join(ownedRoot, 'src/fixture-outside.ts');
  symlinkSync('/app/src/start-server.ts', sourceLink);
  assert.throws(() => copiedModule.writeProductionBuildIdentity(options), /BUILD_IDENTITY_LINK/u);
  assert.equal(read().artifactStatus, 'unknown');
  assert.equal(read().gitSha, null);
  unlinkSync(sourceLink);
  unlinkSync(copiedReceiptPath);
  symlinkSync(receiptPath, copiedReceiptPath);
  assert.equal(read().artifactStatus, 'unknown');
  unlinkSync(copiedReceiptPath);
  writeFileSync(copiedReceiptPath, imageReceiptBytes);
  pass('source_and_receipt_links_fail_closed');

  for (const path of [
    'src/.env.json', 'dist/.env.production', 'vendor/minimatch-9.0.7/.env',
    'node_modules/private/index.js', 'packages/protocol/node_modules/private/index.js',
    'memory/credentials.json', 'logs/private.json', 'arcanos-ai-runtime/data/credentials.json'
  ]) {
    const target = join(ownedRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'test-fixture-private-sentinel', { mode: path.includes('/.env') ? 0o000 : 0o600 });
  }
  assert.deepEqual(copiedModule.writeProductionBuildIdentity({
    rootPath: ownedRoot, env: { OPENAI_API_KEY: 'test-fixture-private-sentinel', DATABASE_URL: 'test-fixture-private-sentinel' }
  }), imageReceipt);
  assert.deepEqual(reportInNativeChild(), original);
  pass('dotenv_dependencies_and_runtime_data_excluded');

  assert.deepEqual(readFileSync(receiptPath), imageReceiptBytes);
  assert.deepEqual(imageModule.readProductionBuildIdentity({ rootPath: '/app', env: {} }), original);
  pass('app_source_and_emitted_inventory_unchanged');
  console.log(JSON.stringify({ boundary: 'actual_docker_image_inventory_and_native_reporter',
    appStartupExecuted: false, providerDatabaseStartupExecuted: false,
    networkInterfaces: interfaces, gitSha: null,
    sourceDigest: original.sourceDigest, artifactDigest: original.artifactDigest,
    buildId: original.buildId, passed: results.length, cases: results }));
} finally {
  assert.equal(dirname(resolve(ownedRoot)), '/tmp');
  assert.ok(ownedRoot.startsWith('/tmp/arcanos-image-identity-'));
  rmSync(ownedRoot, { recursive: true, force: true });
}
