// Run against the actual production Dockerfile image, offline and without credentials.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const [scope, expectedSha] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(scope, '--isolated-image');
assert.match(expectedSha, /^[0-9a-f]{40}$/u);
assert.equal(process.platform, 'linux');
assert.equal(process.versions.node, '24.18.1');
assert.equal(process.cwd(), '/app');
assert.notEqual(process.getuid(), 0);
assert.ok(existsSync('/.dockerenv'));
assert.ok(!existsSync('/app/.git'), 'source proof must not borrow checkout metadata');
assert.ok(!Object.entries(process.env).some(([name, value]) => value &&
  /TOKEN|SECRET|PASSWORD|OPENAI|DATABASE|REDIS|POSTGRES|^PG(?:HOST|PORT|USER|DATABASE|PASSWORD)$/u.test(name.toUpperCase())),
  'fixture refuses application/provider credentials');
const interfaces = readFileSync('/proc/net/dev', 'utf8').split('\n')
  .filter(line => line.includes(':')).map(line => line.split(':')[0].trim());
assert.deepEqual(interfaces, ['lo'], 'network-none container required');

const { readProductionBuildIdentity } = await import('/app/scripts/production-build-identity.mjs');
const identities = ['web', 'worker'].map(processKind => readProductionBuildIdentity({
  rootPath: '/app',
  env: { RAILWAY_GIT_COMMIT_SHA: expectedSha, ARCANOS_PROCESS_KIND: processKind },
}));
for (const identity of identities) {
  assert.equal(identity.status, 'verified_git_source', 'real build context must produce independently proven source');
  assert.equal(identity.gitSha, expectedSha);
  assert.equal(identity.buildConfiguredGitSha, expectedSha);
  assert.equal(identity.configuredGitSha, expectedSha);
  assert.equal(identity.referenceStatus, 'matches_verified_git_source');
  assert.equal(identity.artifactStatus, 'matches_build_receipt');
}
assert.deepEqual(identities[0], identities[1]);
console.log(JSON.stringify({
  boundary: 'production_dockerfile_real_source_context',
  ...identities[0],
  webWorkerParity: true, gitMetadataPresent: false,
  appStartupExecuted: false, providerDatabaseStartupExecuted: false,
}));
