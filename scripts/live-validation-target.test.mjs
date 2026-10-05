import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertLiveValidationInventory, validateLiveValidationTarget, LiveValidationTargetError,
  LIVE_VALIDATION_HARD_LIMITS, LIVE_VALIDATION_HELPER_MODEL_IDS, LIVE_VALIDATION_PROJECT_ID,
  LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, LIVE_VALIDATION_PROTECTED_RESOURCE_IDS,
  LIVE_VALIDATION_QUOTA_LEDGER_MOUNT, LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES,
  LIVE_VALIDATION_SUPERVISOR_VARIABLE_NAMES
} from './live-validation-target.mjs';

const environmentId = '11111111-1111-4111-8111-111111111111';
const runtimeServiceId = '22222222-2222-4222-8222-222222222222';
const supervisorServiceId = '33333333-3333-4333-8333-333333333333';
const ledgerId = '44444444-4444-4444-8444-444444444444';
const trustedSupervisorSha = 'a'.repeat(40);
function targetFixture() {
  return {
    version: 'arcanos-live-validation-target/v1', repository: 'pbjustin/Arcanos',
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId, environmentName: 'live-validation',
    runtimeServiceId, supervisorServiceId,
    privateOrigins: { runtime: 'https://live-validation-runtime.railway.internal:8443',
      supervisor: 'https://live-validation-supervisor.railway.internal:8443' },
    mtlsPeers: {
      runtime: { dns: 'live-validation-runtime.railway.internal', sha256: 'a'.repeat(64) },
      supervisor: { dns: 'live-validation-supervisor.railway.internal', sha256: 'b'.repeat(64) },
      verifier: { dns: 'live-validation-verifier.railway.internal', sha256: 'c'.repeat(64) }
    },
    trustedSupervisorSha, limits: { ...LIVE_VALIDATION_HARD_LIMITS },
    models: ['ft:gpt-4.1:arcanos:authority:fixture', ...LIVE_VALIDATION_HELPER_MODEL_IDS].map(id => ({
      id, inputMicroUsdPerToken: 1.25, outputMicroUsdPerToken: 5
    })), writes: false
  };
}
function inventoryFixture({ ledger = false } = {}) {
  return {
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId, environmentName: 'live-validation',
    sharedVariableNames: [], privateNetworkEnabled: true,
    volumes: ledger ? [{ id: ledgerId, serviceId: supervisorServiceId,
      mountPath: LIVE_VALIDATION_QUOTA_LEDGER_MOUNT, purpose: 'quota_ledger' }] : [],
    services: ['runtime', 'supervisor'].map(role => ({
      id: role === 'runtime' ? runtimeServiceId : supervisorServiceId, role,
      variableNames: role === 'runtime' ? [...LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES]
        : [...LIVE_VALIDATION_SUPERVISOR_VARIABLE_NAMES],
      publicDomains: [], tcpProxyDomains: [],
      volumeMounts: role === 'supervisor' && ledger ? [{ id: ledgerId,
        mountPath: LIVE_VALIDATION_QUOTA_LEDGER_MOUNT, purpose: 'quota_ledger' }] : [],
      source: { repository: 'pbjustin/Arcanos', commitSha: role === 'runtime' ? 'b'.repeat(40) : trustedSupervisorSha,
        autoDeploy: false }
    }))
  };
}
function rejected(callback, code) {
  assert.throws(callback, error => error instanceof LiveValidationTargetError && error.code === code
    && error.message === code);
}

test('bound target is an independent deeply frozen JSON snapshot', () => {
  const source = targetFixture();
  const target = validateLiveValidationTarget(source);
  assert.deepEqual(target, source);
  assert.ok(Object.isFrozen(target) && Object.isFrozen(target.models) && Object.isFrozen(target.models[0])
    && Object.isFrozen(target.mtlsPeers.verifier) && Object.isFrozen(target.limits));
  source.models[0].id = 'ft:changed';
  assert.equal(target.models[0].id, 'ft:gpt-4.1:arcanos:authority:fixture');
  assert.ok(!Object.isFrozen(source));
});

test('unbound example rejects before it can authorize an environment', () => {
  const example = JSON.parse(readFileSync(new URL('../infra/live-validation/target.example.json', import.meta.url), 'utf8'));
  rejected(() => validateLiveValidationTarget(example), 'LIVE_VALIDATION_TARGET_PROTECTED');
});

test('production environment and each production resource are denied in every target ID slot', () => {
  for (const id of [LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS]) {
    for (const field of ['environmentId', 'runtimeServiceId', 'supervisorServiceId']) {
      const target = targetFixture(); target[field] = id;
      rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_PROTECTED');
    }
  }
});

test('persistent authorization is restricted to the repository, project, environment name and read-only mode', () => {
  for (const [field, value] of [['version', 'arcanos-live-pr-preview/v1'], ['repository', 'other/Arcanos'],
    ['projectId', environmentId], ['environmentName', 'production'], ['writes', true]]) {
    const target = targetFixture(); target[field] = value;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_INVALID');
  }
  const target = targetFixture(); target.runtimeServiceId = target.supervisorServiceId;
  rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_PROTECTED');
});

test('every budget cap can tighten but cannot be omitted, widened, fractional or zero', () => {
  const tighter = targetFixture(); tighter.limits = Object.fromEntries(Object.keys(LIVE_VALIDATION_HARD_LIMITS).map(key => [key, 1]));
  assert.deepEqual(validateLiveValidationTarget(tighter).limits, tighter.limits);
  for (const [key, cap] of Object.entries(LIVE_VALIDATION_HARD_LIMITS)) {
    for (const value of [0, cap + 1, 1.5, null]) {
      const target = targetFixture(); target.limits[key] = value;
      rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_LIMITS_INVALID');
    }
    const target = targetFixture(); delete target.limits[key];
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_LIMITS_INVALID');
  }
});

test('trusted supervisor revision requires an exact nonzero lowercase Git SHA', () => {
  for (const value of [null, 'main', 'a'.repeat(39), 'A'.repeat(40), '0'.repeat(40)]) {
    const target = targetFixture(); target.trustedSupervisorSha = value;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_SUPERVISOR_SHA_INVALID');
  }
});

test('private origins exclude public, plain HTTP, alternate ports, credentials, paths and normalization', () => {
  for (const value of ['https://example.com:8443', 'http://live-validation-runtime.railway.internal:8443',
    'https://live-validation-runtime.railway.internal', 'https://live-validation-runtime.railway.internal:443',
    'https://live-validation-runtime.railway.internal:8443/', 'https://LIVE-validation-runtime.railway.internal:8443',
    'https://user@live-validation-runtime.railway.internal:8443', 'https://live-validation-runtime.railway.internal:8443/path',
    'https://live-validation-runtime.railway.internal:8443?secret=x', 'https://live-validation-runtime.railway.internal:8443#x']) {
    const target = targetFixture(); target.privateOrigins.runtime = value;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_PRIVATE_TARGET_INVALID');
  }
});

test('each mTLS role requires its own exact DNS and certificate SHA256 identity', () => {
  for (const role of ['runtime', 'supervisor', 'verifier']) {
    for (const value of [null, '0'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) {
      const target = targetFixture(); target.mtlsPeers[role].sha256 = value;
      rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_MTLS_PEER_INVALID');
    }
  }
  const target = targetFixture(); target.mtlsPeers.verifier = { ...target.mtlsPeers.runtime };
  rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_MTLS_PEER_INVALID');
  const mismatch = targetFixture(); mismatch.mtlsPeers.runtime.dns = 'another.railway.internal';
  rejected(() => validateLiveValidationTarget(mismatch), 'LIVE_VALIDATION_PRIVATE_TARGET_INVALID');
});

test('model contract preserves one fine-tune authority and both existing helper roles with positive prices', () => {
  for (const id of ['gpt-4.1', 'ft:', 'ft:with spaces', 'gpt-6-luna']) {
    const target = targetFixture(); target.models[0].id = id;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  }
  for (const value of [0, -1, null, 100_001]) {
    const target = targetFixture(); target.models[0].inputMicroUsdPerToken = value;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  }
  const extra = targetFixture(); extra.models.push({ id: 'gpt-4.1', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 });
  rejected(() => validateLiveValidationTarget(extra), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  const constants = readFileSync(new URL('../src/shared/constants.ts', import.meta.url), 'utf8');
  assert.match(constants, /MODEL_GPT_6_LUNA:\s*'gpt-6-luna'/u);
  assert.match(constants, /MODEL_GPT_6_1_SOL:\s*'gpt-6\.1-sol'/u);
});

test('JSON boundary rejects unknown fields, inherited records, accessors, sparse arrays and cycles without executing code', () => {
  const unknown = targetFixture(); unknown.providerKey = 'fixture';
  rejected(() => validateLiveValidationTarget(unknown), 'LIVE_VALIDATION_TARGET_INVALID');
  const inherited = Object.create(targetFixture());
  rejected(() => validateLiveValidationTarget(inherited), 'LIVE_VALIDATION_TARGET_INVALID');
  const getter = targetFixture(); let called = false;
  Object.defineProperty(getter, 'repository', { enumerable: true, get() { called = true; return 'pbjustin/Arcanos'; } });
  rejected(() => validateLiveValidationTarget(getter), 'LIVE_VALIDATION_TARGET_INVALID');
  assert.equal(called, false);
  const sparse = targetFixture(); delete sparse.models[1];
  rejected(() => validateLiveValidationTarget(sparse), 'LIVE_VALIDATION_TARGET_INVALID');
  const cyclic = targetFixture(); cyclic.models.push(cyclic);
  rejected(() => validateLiveValidationTarget(cyclic), 'LIVE_VALIDATION_TARGET_INVALID');
});

test('inventory accepts only the two private roles and an optional single isolated quota ledger', () => {
  for (const ledger of [false, true]) {
    const source = inventoryFixture({ ledger });
    const inventory = assertLiveValidationInventory(targetFixture(), source);
    assert.deepEqual(inventory, source);
    assert.ok(Object.isFrozen(inventory) && Object.isFrozen(inventory.services[0].source));
    assert.ok(!Object.isFrozen(source));
  }
});

test('inventory must prove exact environment ownership and private networking with no shared variables', () => {
  for (const [field, value] of [['projectId', environmentId], ['environmentId', LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID],
    ['environmentName', 'production']]) {
    const inventory = inventoryFixture(); inventory[field] = value;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_TARGET_MISMATCH');
  }
  for (const [field, value] of [['privateNetworkEnabled', false], ['privateNetworkEnabled', null],
    ['sharedVariableNames', ['DATABASE_URL']]]) {
    const inventory = inventoryFixture(); inventory[field] = value;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_ISOLATION_INVALID');
  }
});

test('production or additional services cannot be hidden in the environment inventory', () => {
  for (const id of LIVE_VALIDATION_PROTECTED_RESOURCE_IDS) {
    const inventory = inventoryFixture(); inventory.services[0].id = id;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  }
  const extra = inventoryFixture(); extra.services.push({ ...extra.services[0], id: ledgerId });
  rejected(() => assertLiveValidationInventory(targetFixture(), extra), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  const missing = inventoryFixture(); missing.services.pop();
  rejected(() => assertLiveValidationInventory(targetFixture(), missing), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
});

test('provider credentials and controller public keys belong only to supervisor, with no management or data credentials', () => {
  for (const name of ['ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY', 'ARCANOS_LIVE_VALIDATION_CONTROLLER_PUBLIC_KEY_PEM']) {
    const inventory = inventoryFixture(); inventory.services[0].variableNames.push(name);
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_VARIABLE_FORBIDDEN');
  }
  for (const name of ['OPENAI_API_KEY', 'DATABASE_URL', 'REDIS_URL', 'PGPASSWORD', 'RAILWAY_TOKEN',
    'RAILWAY_API_TOKEN', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'ARCANOS_LIVE_VALIDATION_CONTROLLER_PRIVATE_KEY_PEM']) {
    for (const role of [0, 1]) {
      const inventory = inventoryFixture(); inventory.services[role].variableNames.push(name);
      rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_VARIABLE_FORBIDDEN');
    }
  }
  const duplicate = inventoryFixture(); duplicate.services[0].variableNames.push('PORT');
  rejected(() => assertLiveValidationInventory(targetFixture(), duplicate), 'LIVE_VALIDATION_INVENTORY_VARIABLE_FORBIDDEN');
  const values = inventoryFixture(); values.services[0].variables = { fixture: 'never accepted' };
  rejected(() => assertLiveValidationInventory(targetFixture(), values), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
});

test('neither private service admits public HTTPS domains or TCP proxies', () => {
  for (const role of [0, 1]) {
    for (const field of ['publicDomains', 'tcpProxyDomains']) {
      const inventory = inventoryFixture(); inventory.services[role][field] = ['unexpected.example'];
      rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_PUBLIC_ROUTE_FORBIDDEN');
    }
  }
});

test('source requires pinned repository revisions, disabled auto deployment and exact trusted supervisor revision', () => {
  for (const role of [0, 1]) {
    for (const [field, value] of [['autoDeploy', true], ['autoDeploy', null], ['repository', 'other/Arcanos'],
      ['commitSha', 'main'], ['commitSha', '0'.repeat(40)]]) {
      const inventory = inventoryFixture(); inventory.services[role].source[field] = value;
      rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
    }
  }
  const untrusted = inventoryFixture(); untrusted.services[1].source.commitSha = 'c'.repeat(40);
  rejected(() => assertLiveValidationInventory(targetFixture(), untrusted), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
});

test('only explicit trusted predeploy phase permits fresh services with no observed deployed revision', () => {
  const fresh = inventoryFixture(); fresh.services.forEach(service => { service.source.commitSha = null; });
  assert.deepEqual(assertLiveValidationInventory(targetFixture(), fresh, { phase: 'predeploy' }), fresh);
  rejected(() => assertLiveValidationInventory(targetFixture(), fresh), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  rejected(() => assertLiveValidationInventory(targetFixture(), fresh, { phase: 'paid' }), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  const existing = inventoryFixture(); existing.services[1].source.commitSha = 'c'.repeat(40);
  assert.deepEqual(assertLiveValidationInventory(targetFixture(), existing, { phase: 'predeploy' }), existing);
  rejected(() => assertLiveValidationInventory(targetFixture(), existing), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  for (const role of [0, 1]) {
    for (const value of [undefined, '', 'main', '0'.repeat(40)]) {
      const invalid = inventoryFixture(); invalid.services[role].source.commitSha = value;
      assert.throws(() => assertLiveValidationInventory(targetFixture(), invalid, { phase: 'predeploy' }));
    }
    for (const [field, value] of [['autoDeploy', true], ['repository', 'other/Arcanos']]) {
      const invalid = structuredClone(fresh); invalid.services[role].source[field] = value;
      rejected(() => assertLiveValidationInventory(targetFixture(), invalid, { phase: 'predeploy' }),
        'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
    }
  }
  const counterfeit = structuredClone(fresh); counterfeit.phase = 'predeploy';
  rejected(() => assertLiveValidationInventory(targetFixture(), counterfeit), 'LIVE_VALIDATION_INVENTORY_TARGET_MISMATCH');
  for (const options of [{ phase: 'unknown' }, { phase: false }, { phase: null }, { phase: 'predeploy', extra: true }]) {
    rejected(() => assertLiveValidationInventory(targetFixture(), fresh, options), 'LIVE_VALIDATION_INVENTORY_PHASE_INVALID');
  }
});

test('runtime volumes, production resource volumes, data volumes and unmounted volumes reject', () => {
  const runtimeMount = inventoryFixture({ ledger: true }); runtimeMount.services[0].volumeMounts = runtimeMount.services[1].volumeMounts;
  rejected(() => assertLiveValidationInventory(targetFixture(), runtimeMount), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  for (const id of LIVE_VALIDATION_PROTECTED_RESOURCE_IDS) {
    const production = inventoryFixture({ ledger: true });
    production.volumes[0].id = id; production.services[1].volumeMounts[0].id = id;
    rejected(() => assertLiveValidationInventory(targetFixture(), production), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  }
  for (const [field, value] of [['purpose', 'database'], ['mountPath', '/var/lib/postgresql'], ['serviceId', runtimeServiceId]]) {
    const inventory = inventoryFixture({ ledger: true }); inventory.volumes[0][field] = value;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  }
  const unmounted = inventoryFixture({ ledger: true }); unmounted.services[1].volumeMounts = [];
  rejected(() => assertLiveValidationInventory(targetFixture(), unmounted), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  const omitted = inventoryFixture({ ledger: true }); omitted.volumes = [];
  rejected(() => assertLiveValidationInventory(targetFixture(), omitted), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
  const second = inventoryFixture({ ledger: true }); second.volumes.push({ ...second.volumes[0], id: environmentId });
  rejected(() => assertLiveValidationInventory(targetFixture(), second), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
});

test('persistent Railway profiles use dedicated launchers, health checks, one replica and no restart/migrations', () => {
  for (const role of ['runtime', 'supervisor']) {
    const config = JSON.parse(readFileSync(new URL(`../infra/live-validation/${role}.railway.json`, import.meta.url), 'utf8'));
    assert.equal(config.build.builder, 'DOCKERFILE');
    assert.equal(config.build.dockerfilePath, `infra/live-validation/${role}.Dockerfile`);
    assert.equal(config.deploy.startCommand, `node /app/scripts/start-live-validation-${role}.mjs`);
    assert.equal(config.deploy.healthcheckPath, '/healthz');
    assert.equal(config.deploy.restartPolicyType, 'NEVER');
    assert.equal(config.deploy.numReplicas, 1);
    assert.equal(config.deploy.preDeployCommand, undefined);
    assert.equal(config.deploy.cronSchedule, undefined);
  }
});
