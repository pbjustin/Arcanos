import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertLiveValidationInventory, validateLiveValidationPublicOrigin, validateLiveValidationTarget,
  LiveValidationTargetError, LIVE_VALIDATION_TARGET_VERSION, LIVE_VALIDATION_HARD_LIMITS,
  LIVE_VALIDATION_HELPER_MODEL_IDS, LIVE_VALIDATION_PROJECT_ID,
  LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, LIVE_VALIDATION_PROTECTED_RESOURCE_IDS,
  LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES
} from './live-validation-target.mjs';

const environmentId = '11111111-1111-4111-8111-111111111111';
const runtimeServiceId = '22222222-2222-4222-8222-222222222222';
const unrelatedId = '33333333-3333-4333-8333-333333333333';
const publicOrigin = 'https://arcanos-v2-validation.up.railway.app';
function targetFixture() {
  return {
    version: LIVE_VALIDATION_TARGET_VERSION, repository: 'pbjustin/Arcanos',
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId, environmentName: 'live-validation',
    runtimeServiceId, publicOrigin, limits: { ...LIVE_VALIDATION_HARD_LIMITS },
    models: ['ft:gpt-4.1:arcanos:authority:fixture', ...LIVE_VALIDATION_HELPER_MODEL_IDS].map(id => ({
      id, inputMicroUsdPerToken: 1.25, outputMicroUsdPerToken: 5
    })), writes: false
  };
}
function inventoryFixture() {
  return {
    projectId: LIVE_VALIDATION_PROJECT_ID, environmentId, environmentName: 'live-validation',
    sharedVariableNames: [], privateNetworkEnabled: true, volumes: [],
    services: [{ id: runtimeServiceId, role: 'runtime',
      variableNames: [...LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES],
      publicDomains: [new URL(publicOrigin).hostname], tcpProxyDomains: [], volumeMounts: [],
      source: { repository: 'pbjustin/Arcanos', commitSha: 'b'.repeat(40), autoDeploy: false } }]
  };
}
function rejected(callback, code) {
  assert.throws(callback, error => error instanceof LiveValidationTargetError && error.code === code
    && error.message === code);
}

test('bound v2 target is an independent deeply frozen single-service JSON snapshot', () => {
  const source = targetFixture(); const target = validateLiveValidationTarget(source);
  assert.deepEqual(target, source);
  assert.ok(Object.isFrozen(target) && Object.isFrozen(target.models) && Object.isFrozen(target.models[0])
    && Object.isFrozen(target.limits));
  source.models[0].id = 'ft:changed';
  assert.equal(target.models[0].id, 'ft:gpt-4.1:arcanos:authority:fixture');
  assert.ok(!Object.isFrozen(source));
});

test('unbound example cannot authorize an environment', () => {
  const example = JSON.parse(readFileSync(new URL('../infra/live-validation/target.example.json', import.meta.url), 'utf8'));
  rejected(() => validateLiveValidationTarget(example), 'LIVE_VALIDATION_TARGET_PROTECTED');
});

test('production environment and every protected resource are denied in both target ID slots', () => {
  for (const id of [LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS]) {
    for (const field of ['environmentId', 'runtimeServiceId']) {
      const target = targetFixture(); target[field] = id;
      rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_PROTECTED');
    }
  }
  const duplicate = targetFixture(); duplicate.runtimeServiceId = duplicate.environmentId;
  rejected(() => validateLiveValidationTarget(duplicate), 'LIVE_VALIDATION_TARGET_PROTECTED');
});

test('authorization fixes repository, project, environment and transient mode and rejects old topology fields', () => {
  for (const [field, value] of [['version', 'arcanos-live-validation-target/v1'], ['repository', 'other/Arcanos'],
    ['projectId', environmentId], ['environmentName', 'production'], ['writes', true]]) {
    const target = targetFixture(); target[field] = value;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_INVALID');
  }
  for (const field of ['supervisorServiceId', 'privateOrigins', 'mtlsPeers', 'trustedSupervisorSha']) {
    const target = targetFixture(); target[field] = 'fixture';
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_INVALID');
  }
});

test('every budget cap can tighten but cannot be omitted, widened, fractional or zero', () => {
  assert.deepEqual(LIVE_VALIDATION_HARD_LIMITS, {
    maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000
  });
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

test('origin is exact normal Railway HTTPS without ports, paths, credentials or normalization', () => {
  assert.equal(validateLiveValidationPublicOrigin(publicOrigin), true);
  for (const value of [null, 'https://example.com', 'http://arcanos-v2-validation.up.railway.app',
    'https://arcanos-v2-validation.railway.internal:8443', publicOrigin + ':443', publicOrigin + ':8443',
    publicOrigin + '/', 'https://ARCANOS-v2-validation.up.railway.app',
    'https://user@arcanos-v2-validation.up.railway.app', publicOrigin + '/path', publicOrigin + '?secret=x',
    publicOrigin + '#x', 'https://nested.arcanos-v2-validation.up.railway.app']) {
    assert.equal(validateLiveValidationPublicOrigin(value), false, String(value));
    const target = targetFixture(); target.publicOrigin = value;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_PUBLIC_TARGET_INVALID');
  }
});

test('model contract fixes one fine-tune and both helper roles with bounded positive prices', () => {
  for (const id of ['gpt-4.1', 'ft:', 'ft:with spaces', 'gpt-6-luna']) {
    const target = targetFixture(); target.models[0].id = id;
    rejected(() => validateLiveValidationTarget(target), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  }
  for (const field of ['inputMicroUsdPerToken', 'outputMicroUsdPerToken']) {
    for (const value of [0, -1, null, 100_001, Infinity, NaN]) {
      const target = targetFixture(); target.models[0][field] = value;
      rejected(() => validateLiveValidationTarget(target), Number.isFinite(value) || value === null
        ? 'LIVE_VALIDATION_TARGET_MODELS_INVALID' : 'LIVE_VALIDATION_TARGET_INVALID');
    }
    const maximum = targetFixture(); maximum.models[0][field] = 100_000;
    assert.doesNotThrow(() => validateLiveValidationTarget(maximum));
  }
  const extra = targetFixture(); extra.models.push({ id: 'gpt-4.1', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 });
  rejected(() => validateLiveValidationTarget(extra), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  for (const helper of [1, 2]) {
    const replaced = targetFixture(); replaced.models[helper].id = 'gpt-4.1';
    rejected(() => validateLiveValidationTarget(replaced), 'LIVE_VALIDATION_TARGET_MODELS_INVALID');
  }
  const constants = readFileSync(new URL('../src/shared/constants.ts', import.meta.url), 'utf8');
  assert.match(constants, /MODEL_GPT_6_LUNA:\s*'gpt-6-luna'/u);
  assert.match(constants, /MODEL_GPT_6_1_SOL:\s*'gpt-6\.1-sol'/u);
});

test('target JSON rejects unknown fields, prototypes, getters, serialization hooks, sparse arrays and cycles', () => {
  const unknown = targetFixture(); unknown.providerKey = 'fixture';
  rejected(() => validateLiveValidationTarget(unknown), 'LIVE_VALIDATION_TARGET_INVALID');
  rejected(() => validateLiveValidationTarget(Object.create(targetFixture())), 'LIVE_VALIDATION_TARGET_INVALID');
  const getter = targetFixture(); let called = false;
  Object.defineProperty(getter, 'repository', { enumerable: true, get() { called = true; return 'pbjustin/Arcanos'; } });
  rejected(() => validateLiveValidationTarget(getter), 'LIVE_VALIDATION_TARGET_INVALID');
  assert.equal(called, false);
  const serializer = targetFixture(); serializer.toJSON = () => { called = true; return targetFixture(); };
  rejected(() => validateLiveValidationTarget(serializer), 'LIVE_VALIDATION_TARGET_INVALID');
  assert.equal(called, false);
  const sparse = targetFixture(); delete sparse.models[1];
  rejected(() => validateLiveValidationTarget(sparse), 'LIVE_VALIDATION_TARGET_INVALID');
  const cyclic = targetFixture(); cyclic.models.push(cyclic);
  rejected(() => validateLiveValidationTarget(cyclic), 'LIVE_VALIDATION_TARGET_INVALID');
  const poisoned = targetFixture(); Object.defineProperty(poisoned, '__proto__', { enumerable: true, value: {} });
  rejected(() => validateLiveValidationTarget(poisoned), 'LIVE_VALIDATION_TARGET_INVALID');
  const symbol = targetFixture(); symbol[Symbol('hidden')] = 'fixture';
  rejected(() => validateLiveValidationTarget(symbol), 'LIVE_VALIDATION_TARGET_INVALID');
});

test('inventory accepts exactly one service with its public origin and no storage', () => {
  const source = inventoryFixture(); const inventory = assertLiveValidationInventory(targetFixture(), source);
  assert.deepEqual(inventory, source);
  assert.ok(Object.isFrozen(inventory) && Object.isFrozen(inventory.services[0].source));
  assert.ok(!Object.isFrozen(source));
});

test('inventory proves environment ownership and isolated networking without shared variables', () => {
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

test('production IDs, wrong roles, missing services and any extra service are denied', () => {
  for (const id of [LIVE_VALIDATION_PRODUCTION_ENVIRONMENT_ID, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS, unrelatedId]) {
    const inventory = inventoryFixture(); inventory.services[0].id = id;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  }
  for (const role of ['supervisor', 'postgres', 'redis']) {
    const inventory = inventoryFixture(); inventory.services[0].role = role;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  }
  const extra = inventoryFixture(); extra.services.push({ ...extra.services[0], id: unrelatedId });
  rejected(() => assertLiveValidationInventory(targetFixture(), extra), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
  const missing = inventoryFixture(); missing.services = [];
  rejected(() => assertLiveValidationInventory(targetFixture(), missing), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
});

test('all volumes and service mounts are forbidden including production volumes and quota ledgers', () => {
  for (const id of [unrelatedId, ...LIVE_VALIDATION_PROTECTED_RESOURCE_IDS]) {
    for (const field of ['volumes', 'volumeMounts']) {
      const inventory = inventoryFixture(); const owner = field === 'volumes' ? inventory : inventory.services[0];
      owner[field] = [{ id, serviceId: runtimeServiceId, mountPath: '/var/lib/validation', purpose: 'quota_ledger' }];
      rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_VOLUME_FORBIDDEN');
    }
  }
});

test('validation key and test token are the only credential exceptions; values and ambient overrides are denied', () => {
  assert.ok(LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES.includes('ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY'));
  assert.ok(LIVE_VALIDATION_RUNTIME_VARIABLE_NAMES.includes('ARCANOS_LIVE_VALIDATION_TEST_TOKEN'));
  for (const name of ['OPENAI_API_KEY', 'DATABASE_URL', 'REDIS_URL', 'PGPASSWORD', 'RAILWAY_TOKEN',
    'RAILWAY_API_TOKEN', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'OPENAI_BASE_URL',
    'ARCANOS_LIVE_VALIDATION_CONTROLLER_PRIVATE_KEY_PEM', 'ARCANOS_LIVE_VALIDATION_CONTROLLER_PUBLIC_KEY_PEM',
    'ARCANOS_LIVE_VALIDATION_TLS_CERT_PEM']) {
    const inventory = inventoryFixture(); inventory.services[0].variableNames.push(name);
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_VARIABLE_FORBIDDEN');
  }
  const duplicate = inventoryFixture(); duplicate.services[0].variableNames.push('PORT');
  rejected(() => assertLiveValidationInventory(targetFixture(), duplicate), 'LIVE_VALIDATION_INVENTORY_VARIABLE_FORBIDDEN');
  const values = inventoryFixture(); values.services[0].variables = { fixture: 'never accepted' };
  rejected(() => assertLiveValidationInventory(targetFixture(), values), 'LIVE_VALIDATION_INVENTORY_SERVICES_INVALID');
});

test('inventory admits only target hostname and no TCP proxies or second public routes', () => {
  for (const domains of [[], ['unexpected.up.railway.app'], [new URL(publicOrigin).hostname, 'other.example'], [publicOrigin]]) {
    const inventory = inventoryFixture(); inventory.services[0].publicDomains = domains;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_PUBLIC_ROUTE_FORBIDDEN');
  }
  const tcp = inventoryFixture(); tcp.services[0].tcpProxyDomains = ['unexpected.example'];
  rejected(() => assertLiveValidationInventory(targetFixture(), tcp), 'LIVE_VALIDATION_INVENTORY_PUBLIC_ROUTE_FORBIDDEN');
});

test('source requires exact lowercase nonzero repository revision and disabled automatic deployment', () => {
  for (const [field, value] of [['autoDeploy', true], ['autoDeploy', null], ['repository', 'other/Arcanos'],
    ['commitSha', 'main'], ['commitSha', '0'.repeat(40)], ['commitSha', 'A'.repeat(40)], ['commitSha', 'b'.repeat(39)]]) {
    const inventory = inventoryFixture(); inventory.services[0].source[field] = value;
    rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  }
});

test('only explicit predeploy permits missing deployed revision without relaxing isolation or source configuration', () => {
  const fresh = inventoryFixture(); fresh.services[0].source.commitSha = null;
  assert.deepEqual(assertLiveValidationInventory(targetFixture(), fresh, { phase: 'predeploy' }), fresh);
  rejected(() => assertLiveValidationInventory(targetFixture(), fresh), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  rejected(() => assertLiveValidationInventory(targetFixture(), fresh, { phase: 'paid' }), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  for (const value of [undefined, '', 'main', '0'.repeat(40)]) {
    const invalid = inventoryFixture(); invalid.services[0].source.commitSha = value;
    assert.throws(() => assertLiveValidationInventory(targetFixture(), invalid, { phase: 'predeploy' }));
  }
  for (const [field, value] of [['autoDeploy', true], ['repository', 'other/Arcanos']]) {
    const invalid = structuredClone(fresh); invalid.services[0].source[field] = value;
    rejected(() => assertLiveValidationInventory(targetFixture(), invalid, { phase: 'predeploy' }), 'LIVE_VALIDATION_INVENTORY_SOURCE_INVALID');
  }
  const shared = structuredClone(fresh); shared.sharedVariableNames = ['DATABASE_URL'];
  rejected(() => assertLiveValidationInventory(targetFixture(), shared, { phase: 'predeploy' }), 'LIVE_VALIDATION_INVENTORY_ISOLATION_INVALID');
  const counterfeit = structuredClone(fresh); counterfeit.phase = 'predeploy';
  rejected(() => assertLiveValidationInventory(targetFixture(), counterfeit), 'LIVE_VALIDATION_INVENTORY_TARGET_MISMATCH');
  for (const options of [{ phase: 'unknown' }, { phase: false }, { phase: null }, { phase: 'predeploy', extra: true }]) {
    rejected(() => assertLiveValidationInventory(targetFixture(), fresh, options), 'LIVE_VALIDATION_INVENTORY_PHASE_INVALID');
  }
});

test('inventory and phase JSON reject getters and inherited records without evaluating them', () => {
  let called = false; const inventory = inventoryFixture();
  Object.defineProperty(inventory.services[0], 'variableNames', { enumerable: true,
    get() { called = true; return ['PORT']; } });
  rejected(() => assertLiveValidationInventory(targetFixture(), inventory), 'LIVE_VALIDATION_INVENTORY_INVALID');
  assert.equal(called, false);
  rejected(() => assertLiveValidationInventory(targetFixture(), Object.create(inventoryFixture())), 'LIVE_VALIDATION_INVENTORY_INVALID');
  const options = {}; Object.defineProperty(options, 'phase', { enumerable: true,
    get() { called = true; return 'predeploy'; } });
  rejected(() => assertLiveValidationInventory(targetFixture(), inventoryFixture(), options), 'LIVE_VALIDATION_INVENTORY_PHASE_INVALID');
  assert.equal(called, false);
});

test('Railway profile uses one dedicated launcher and replica with health checks and no restart or migrations', () => {
  const config = JSON.parse(readFileSync(new URL('../infra/live-validation/runtime.railway.json', import.meta.url), 'utf8'));
  assert.equal(config.build.builder, 'DOCKERFILE');
  assert.equal(config.build.dockerfilePath, 'infra/live-validation/runtime.Dockerfile');
  assert.equal(config.deploy.startCommand, 'node /app/scripts/start-live-validation-runtime.mjs');
  assert.equal(config.deploy.healthcheckPath, '/healthz');
  assert.equal(config.deploy.restartPolicyType, 'NEVER');
  assert.equal(config.deploy.numReplicas, 1);
  assert.equal(config.deploy.preDeployCommand, undefined);
  assert.equal(config.deploy.cronSchedule, undefined);
});
