#!/usr/bin/env node
/** Bounded acceptance driver for the existing worker-coordinator-v1 profile. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { validateSelfHealPreviewCleanupReceipt } from './self-heal-preview-cleanup.mjs';
import { buildBackstageHeavyRailwayCliEnvironment, railwayInvocationForBackstageHeavyProbe } from './railway-backstage-heavy-e2e-probe.mjs';

export const SELF_HEAL_ACCEPTANCE_CASES = Object.freeze([
  'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'B01', 'B02', 'B03', 'B04', 'B05',
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06',
]);
const COMMANDS = new Set(['inspect', 'duplicate_start', 'coordinator_stop', 'coordinator_start', 'tick',
  'observation_throw_once', 'hold_observation_once', 'release_observation', 'scheduler_failure_once', 'database_failure_once',
  'policy_disabled', 'policy_insufficient_autonomy', 'policy_freeze', 'policy_kill_switch', 'policy_predictive_dry_run',
  'policy_predictive_no_execute', 'policy_allowed', 'policy_restore', 'prompt_worker_rejection', 'remote_mitigation_rejection',
  'trinity_activate', 'trinity_replace', 'trinity_stale_rollback', 'trinity_rollback', 'trinity_consumer', 'trinity_run', 'predictive_evaluate_live']);
const PROVIDER = new Set(['inspect', 'set_healthy', 'timeout_next', 'hold_next', 'release']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REAL_TRANSPORTS = new WeakSet();
const MAX_BYTES = 2 * 1024 * 1024;
const CLEANUP_RESERVE_MS = 10 * 60_000;
const NAMES = { web: 'arcanos-web-pr1544-heavy', worker: 'arcanos-worker-pr1544-heavy', postgres: 'Postgres', redis: 'Redis' };
const CAPS = { web: { cpu: 1, memoryBytes: 1024 ** 3 }, worker: { cpu: 1, memoryBytes: 2 * 1024 ** 3 },
  postgres: { cpu: 0.5, memoryBytes: 0.5 * 1024 ** 3 }, redis: { cpu: 0.25, memoryBytes: 0.25 * 1024 ** 3 } };
const INVENTORY_QUERY = `query SelfHealAcceptanceInventory($projectId: String!, $environmentId: String!, $workerId: String!, $postgresId: String!, $redisId: String!) {
  project(id: $projectId) { id name workspaceId deletedAt
    services(first: 10) { edges { node { id name } } pageInfo { hasNextPage } }
    environments(first: 10) { edges { node { id name deletedAt
      volumeInstances(first: 10) { edges { node { volumeId serviceId mountPath } } pageInfo { hasNextPage } }
      serviceInstances(first: 10) { edges { node { serviceId serviceName
        domains { serviceDomains { domain } customDomains { domain } }
        latestDeployment { id status deploymentStopped meta instances { id status } }
        activeDeployments { id status deploymentStopped meta instances { id status } }
      } } pageInfo { hasNextPage } }
    } } pageInfo { hasNextPage } }
  }
  workerTcpProxies: tcpProxies(environmentId: $environmentId, serviceId: $workerId) { id }
  postgresTcpProxies: tcpProxies(environmentId: $environmentId, serviceId: $postgresId) { id }
  redisTcpProxies: tcpProxies(environmentId: $environmentId, serviceId: $redisId) { id }
}`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serializeReceipt = value => `${JSON.stringify({ ...value, receiptSha256: hash(value) })}\n`;
export class SelfHealAcceptanceError extends Error {
  constructor(code, classification = 'BLOCKED') { super(`SELF_HEAL_ACCEPTANCE_${code}`); this.classification = classification; }
}
function block(code) { throw new SelfHealAcceptanceError(code); }
function requireProof(value, code) { if (!value) throw new SelfHealAcceptanceError(code, 'FAILED'); }
function exactKeys(value, keys) { return record(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }
function rows(connection) {
  if (!record(connection) || !Array.isArray(connection.edges) || connection.pageInfo?.hasNextPage !== false) block('INCOMPLETE_INVENTORY');
  return connection.edges.map(edge => { if (!record(edge?.node)) block('INCOMPLETE_INVENTORY'); return edge.node; });
}

/** No tokens, URLs, arbitrary scripts or production targets are admitted. */
export function validateSelfHealAcceptanceManifest(value, options = {}) {
  const now = options.now?.() ?? Date.now();
  if (!exactKeys(value, ['version', 'receipt', 'controllerSha', 'budgetUsd', 'cleanupArmedUntil', 'services'])
    || value.version !== 1 || value.budgetUsd !== 3 || !SHA.test(value.controllerSha ?? '')) block('MANIFEST_INVALID');
  const receipt = validateSelfHealPreviewCleanupReceipt(value.receipt, { now: () => now, allowExpired: false });
  if (!receipt.resources || receipt.resources.services.length !== 4 || receipt.resources.volumes.length !== 2
    || value.cleanupArmedUntil !== receipt.expiresAt || !Array.isArray(value.services) || value.services.length !== 4) block('OWNERSHIP_INVALID');
  const ids = new Set(); const roles = new Set();
  for (const service of value.services) {
    if (!exactKeys(service, ['role', 'serviceId', 'deploymentId', 'imageDigest', 'compiledSha256'])
      || !Object.hasOwn(NAMES, service.role) || roles.has(service.role) || !UUID.test(service.serviceId ?? '')
      || !UUID.test(service.deploymentId ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(service.imageDigest ?? '')
      || !receipt.resources.services.some(bound => bound.id === service.serviceId && bound.name === NAMES[service.role])
      || (['web', 'worker'].includes(service.role) ? !DIGEST.test(service.compiledSha256 ?? '') : service.compiledSha256 !== null)) block('SERVICE_INVALID');
    roles.add(service.role); ids.add(service.serviceId); ids.add(service.deploymentId);
  }
  if (roles.size !== 4 || ids.size !== 8) block('SERVICE_INVALID');
  return Object.freeze({ ...value, receipt, services: Object.freeze(value.services.map(service => Object.freeze({ ...service }))) });
}

/** Complete control-plane inventory, sole running instance, pinned artifact and no public data endpoints. */
export function attestSelfHealAcceptanceStatus(status, manifest, options = {}) {
  validateSelfHealAcceptanceManifest(manifest, options);
  const receipt = manifest.receipt;
  if (status?.id !== receipt.projectId || status.name !== receipt.projectName || status.workspaceId !== receipt.workspaceId
    || status.deletedAt !== null) block('PROJECT_DRIFT');
  const services = rows(status.services);
  if (services.length !== 4 || services.some(service => !manifest.services.some(pin => pin.serviceId === service.id && NAMES[pin.role] === service.name))) block('TOPOLOGY_DRIFT');
  const environments = rows(status.environments);
  if (environments.length !== 1 || environments[0].id !== receipt.environmentId || environments[0].name !== receipt.environmentName
    || environments[0].deletedAt !== null) block('ENVIRONMENT_DRIFT');
  const environment = environments[0];
  const instances = rows(environment.serviceInstances);
  const volumes = rows(environment.volumeInstances);
  if (instances.length !== 4 || volumes.length !== 2 || volumes.some(volume => !receipt.resources.volumes.some(bound =>
    bound.id === volume.volumeId && bound.serviceId === volume.serviceId && bound.mountPath === volume.mountPath))) block('TOPOLOGY_DRIFT');
  const targets = {};
  for (const pin of manifest.services) {
    const instance = instances.find(item => item.serviceId === pin.serviceId);
    const deployment = instance?.latestDeployment;
    const active = instance?.activeDeployments?.filter(item => item.deploymentStopped !== true);
    const running = deployment?.instances?.filter(item => item.status === 'RUNNING');
    const transient = options.transientRole === pin.role;
    if (instance?.serviceName !== NAMES[pin.role] || deployment?.id !== pin.deploymentId
      || (!transient && (deployment.status !== 'SUCCESS' || deployment.deploymentStopped !== false))
      || !Array.isArray(active) || (transient ? active.length > 1 : active.length !== 1)
      || active.some(item => item.id !== pin.deploymentId)
      || !Array.isArray(running) || (transient ? running.length > 1 : running.length !== 1)
      || running.some(item => !UUID.test(item.id ?? ''))
      || deployment.meta?.serviceManifest?.deploy?.numReplicas !== 1) block('DEPLOYMENT_DRIFT');
    if (deployment.meta?.imageDigest !== pin.imageDigest
      || active.some(item => item.meta?.imageDigest !== pin.imageDigest)) block('IMAGE_DRIFT');
    if (['web', 'worker'].includes(pin.role)) {
      if (deployment.meta?.commitHash !== receipt.sourceSha
        || deployment.meta?.serviceManifest?.deploy?.startCommand !== 'node scripts/railway-backstage-heavy-proof-supervisor.mjs --self-heal-preview-v1'
        || deployment.meta?.serviceManifest?.deploy?.healthcheckPath !== '/readyz'
        || deployment.meta?.serviceManifest?.deploy?.restartPolicyType !== 'NEVER') block('SOURCE_OR_LAUNCH_DRIFT');
    }
    const deployConfig = deployment.meta?.serviceManifest?.deploy;
    if (deployConfig?.limitOverride?.containers?.cpu !== CAPS[pin.role].cpu
      || deployConfig?.limitOverride?.containers?.memoryBytes !== CAPS[pin.role].memoryBytes
      || deployConfig?.cronSchedule) block('RESOURCE_CAP_DRIFT');
    if (pin.role !== 'web' && ((instance.domains?.serviceDomains?.length ?? 0) !== 0
      || (instance.domains?.customDomains?.length ?? 0) !== 0 || (instance.tcpProxies?.length ?? 0) !== 0)) block('PUBLIC_DEPENDENCY');
    targets[pin.role] = { serviceId: pin.serviceId, deploymentId: pin.deploymentId, instanceId: running[0]?.id ?? null };
  }
  return targets;
}

/** Publish a complete immutable receipt before continuing with a later operation. */
export function publishSelfHealAcceptanceReceipt(directory, sequence, receipt) {
  const stat = lstatSync(directory);
  if (!isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink()
    || !Number.isSafeInteger(sequence) || sequence < 1) block('EVIDENCE_PATH_INVALID');
  const path = join(directory, `${String(sequence).padStart(5, '0')}-${receipt.scenario ?? 'run'}.json`);
  const serialized = serializeReceipt(receipt);
  if (Buffer.byteLength(serialized) > MAX_BYTES) block('EVIDENCE_TOO_LARGE');
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
  return path;
}

function safeProjection(value) {
  const text = JSON.stringify(value);
  const projection = JSON.parse(text);
  if (Buffer.byteLength(serializeReceipt(projection)) > MAX_BYTES || /(?:Bearer\s|postgres(?:ql)?:\/\/|rediss?:\/\/|(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/"@?#]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-proj-)/iu.test(text)) block('UNSAFE_DIAGNOSTIC');
  return projection;
}

/** Transport has a closed vocabulary; SSH executes only the reviewed fixed helper. */
export function createSelfHealAcceptanceTransport(manifest, options = {}) {
  validateSelfHealAcceptanceManifest(manifest, options);
  const execute = options.execute === true; const allowNetwork = options.allowNetwork === true;
  if (execute !== allowNetwork) block('NETWORK_GATES_REQUIRED');
  const now = options.now ?? Date.now;
  let expectedRestart = null;
  let workerRestarted = false;
  let redisRestarted = false;
  let shutdownRequested = false;
  const cli = async (args, operationTimeoutMs) => {
    if (!execute) block('DRY_RUN_TRANSPORT');
    const env = options.env ?? process.env;
    const invocation = options.invocation ?? railwayInvocationForBackstageHeavyProbe(process.platform, env.APPDATA, process.execPath);
    try {
      const result = await (options.command ?? promisify(execFile))(invocation.executable, [...invocation.argsPrefix, ...args], {
        env: buildBackstageHeavyRailwayCliEnvironment(env), timeout: operationTimeoutMs ?? (args[0] === 'ssh' ? 150_000 : 30_000),
        maxBuffer: MAX_BYTES, windowsHide: true, encoding: 'utf8',
      });
      if (typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_BYTES) block('TRANSPORT_OUTPUT_INVALID');
      return result.stdout;
    } catch (error) { if (error instanceof SelfHealAcceptanceError) throw error; block('TRANSPORT_UNAVAILABLE'); }
  };
  const targets = async (restoring = false) => {
    if (Date.parse(manifest.receipt.expiresAt) <= now()) block('LEASE_EXPIRED');
    if (!restoring && Date.parse(manifest.receipt.expiresAt) - now() <= CLEANUP_RESERVE_MS) block('CLEANUP_RESERVE_REACHED');
    const head = restoring ? manifest.receipt.sourceSha : await (options.readHead ?? (async () => {
      const result = await promisify(execFile)('gh', ['pr', 'view', '1544', '--repo', 'pbjustin/Arcanos', '--json', 'headRefOid', '--jq', '.headRefOid'],
        { timeout: 15_000, maxBuffer: 4096, windowsHide: true, encoding: 'utf8' }); return result.stdout.trim();
    }))();
    if (head !== manifest.receipt.sourceSha) block('PR_HEAD_CHANGED');
    const variables = { projectId: manifest.receipt.projectId, environmentId: manifest.receipt.environmentId,
      workerId: manifest.services.find(pin => pin.role === 'worker').serviceId,
      postgresId: manifest.services.find(pin => pin.role === 'postgres').serviceId,
      redisId: manifest.services.find(pin => pin.role === 'redis').serviceId };
    const response = JSON.parse(await cli(['api', INVENTORY_QUERY, '--variables', JSON.stringify(variables), '--compact']));
    if (response.errors !== undefined || !record(response.data?.project)
      || ['worker', 'postgres', 'redis'].some(role => !Array.isArray(response.data[`${role}TcpProxies`])
        || response.data[`${role}TcpProxies`].length !== 0)) block('INVENTORY_UNAVAILABLE');
    const status = response.data.project;
    const transientRole = expectedRestart && now() < expectedRestart.expiresAt ? expectedRestart.role : undefined;
    return attestSelfHealAcceptanceStatus(status, manifest, { now, transientRole });
  };
  const remote = async (role, argv, restoring = false) => {
      if (!['web', 'worker'].includes(role) || !Array.isArray(argv)) block('OPERATION_INVALID');
      const valid = (argv.length === 1 && ['inspect', 'artifact'].includes(argv[0]))
        || (role === 'worker' && argv.length === 1 && ['replacement-race', 'dependency-overlap'].includes(argv[0]))
        || (role === 'web' && argv.length === 2 && argv[0] === 'shutdown-receipt' && ['A06', 'E06'].includes(argv[1]))
        || (argv.length === 2 && argv[0] === 'command' && COMMANDS.has(argv[1]))
        || (role === 'worker' && argv.length === 2 && argv[0] === 'provider' && PROVIDER.has(argv[1]))
        || (role === 'worker' && argv.length === 4 && argv[0] === 'fenced-job' && ['create', 'inspect'].includes(argv[1])
          && SELF_HEAL_ACCEPTANCE_CASES.includes(argv[2]) && ['1', '2'].includes(argv[3]))
        || (role === 'web' && argv.length === 3 && argv[0] === 'web-job' && argv[1] === 'run' && ['1', '2'].includes(argv[2]));
      if (!valid) block('OPERATION_INVALID');
      if (restoring && !(role === 'worker' && ((argv[0] === 'provider' && ['release', 'set_healthy'].includes(argv[1]))
        || (argv[0] === 'command' && ['release_observation', 'trinity_rollback', 'policy_restore', 'coordinator_start'].includes(argv[1]))))) block('RESTORATION_INVALID');
      const target = (await targets(restoring))[role];
      if (!target.instanceId) block('TARGET_NOT_RUNNING');
      // Railway SSH adds session-only authority and context absent from the application parent.
      const stdout = await cli(['ssh', '--project', manifest.receipt.projectId, '--environment', manifest.receipt.environmentId,
        '--service', target.serviceId, '--deployment-instance', target.instanceId, '--',
        'env', '-u', 'RAILWAY_API_TOKEN', '-u', 'RAILWAY_ENV', '-u', 'GH_TOKEN', 'node', 'scripts/self-heal-preview-control.mjs', ...argv]);
      let value; try { value = JSON.parse(stdout.trim()); } catch { block('REMOTE_RECEIPT_INVALID'); }
      if (value?.target?.role !== role || value.target.sourceSha !== manifest.receipt.sourceSha || value.target.runId !== manifest.receipt.runId
        || value.target.projectId !== manifest.receipt.projectId || value.target.environmentId !== manifest.receipt.environmentId
        || value.target.serviceId !== target.serviceId || value.target.deploymentId !== target.deploymentId) block('REMOTE_IDENTITY_DRIFT');
      if (argv[0] === 'artifact' && value.artifact?.compiledSha256 !== manifest.services.find(pin => pin.role === role).compiledSha256) block('ARTIFACT_DRIFT');
      return safeProjection({ ...value, platformTarget: target });
  };
  const transport = Object.freeze({
    remote: (role, argv) => remote(role, argv),
    restore: argv => remote('worker', argv, true),
    async shutdownHeld(scenario) {
      if (!['A06', 'E06'].includes(scenario)) block('SHUTDOWN_SCENARIO_INVALID');
      if (shutdownRequested) block('SHUTDOWN_BUDGET_EXHAUSTED');
      const target = (await targets()).worker;
      if (!target.instanceId) block('TARGET_NOT_RUNNING');
      shutdownRequested = true;
      // A successful signal can terminate the initiating SSH connection. Only
      // the independent Web-side database receipt may prove this operation.
      expectedRestart = { role: 'worker', expiresAt: now() + 120_000 };
      let transportClosed = false;
      try {
        await cli(['ssh', '--project', manifest.receipt.projectId, '--environment', manifest.receipt.environmentId,
          '--service', target.serviceId, '--deployment-instance', target.instanceId, '--',
          'env', '-u', 'RAILWAY_API_TOKEN', '-u', 'RAILWAY_ENV', '-u', 'GH_TOKEN', 'node', 'scripts/self-heal-preview-control.mjs', 'shutdown-held', scenario], 30_000);
      } catch (error) {
        if (!(error instanceof SelfHealAcceptanceError) || error.message !== 'SELF_HEAL_ACCEPTANCE_TRANSPORT_UNAVAILABLE') throw error;
        transportClosed = true;
      }
      return { role: 'worker', target, scenario, requested: true, transportClosed, effectEvidence: 'independent_shutdown_receipt_required' };
    },
    async restart(role) {
      if (!['worker', 'redis'].includes(role)) block('RESTART_TARGET_INVALID');
      if ((role === 'worker' && workerRestarted) || (role === 'redis' && redisRestarted)) block('RESTART_BUDGET_EXHAUSTED');
      const target = (await targets())[role];
      if (role === 'worker') workerRestarted = true; else redisRestarted = true;
      expectedRestart = { role, expiresAt: now() + 120_000 };
      // Railway owns the stop/start operation: a crashed controller cannot leave a deliberate stopped Redis.
      const result = await cli(['restart', '--project', manifest.receipt.projectId, '--environment', manifest.receipt.environmentId,
        '--service', target.serviceId, '--yes', '--json']);
      let acknowledgement; try { acknowledgement = JSON.parse(result); } catch { block('RESTART_ACK_INVALID'); }
      if (!record(acknowledgement)) block('RESTART_ACK_INVALID');
      return { role, target, restartRequested: true, acknowledgementSha256: hash(acknowledgement) };
    },
    targets,
  });
  if (!options.command && !options.readHead && !options.invocation && !options.now && !options.env) REAL_TRANSPORTS.add(transport);
  return transport;
}

function inspection(receipt) { return receipt?.observation?.inspection ?? receipt?.observation; }
function finalStage(value) { return value?.trinity?.snapshot?.final; }

/** An OS signal or a drain log alone cannot satisfy shutdown acceptance. */
export function attestSelfHealShutdownReceipt(value, scenario, baseline, recovered, manifest, before, after) {
  const receipt = value?.receipt;
  requireProof(value?.evidence === 'independent_postgres_redis_readback' && receipt?.scenario === scenario
    && receipt.sourceSha === manifest.receipt.sourceSha && receipt.processInstanceId === baseline.processInstanceId
    && receipt.deploymentId === manifest.services.find(pin => pin.role === 'worker').deploymentId
    && receipt.pid === baseline.pid && /^[1-9]\d{0,18}$/u.test(receipt.redisClientId ?? ''), 'SHUTDOWN_IDENTITY_DRIFT');
  const events = receipt.events;
  requireProof(Array.isArray(events) && events.length <= 12
    && new Set(events.map(event => event.phase)).size === events.length
    && !events.some(event => event.phase === 'barrier_expired'), 'SHUTDOWN_BARRIER_NOT_PROVEN');
  const ordered = ['prepared', 'evaluation_held', 'shutdown_seen', 'independent_held_probe',
    'independent_barrier_releasing', 'barrier_released', 'coordinator_drained',
    'redis_stop_begin', 'redis_stopped', 'independent_redis_closed'];
  let previous = -1; let previousAt = Date.parse(manifest.receipt.issuedAt);
  for (const phase of ordered) {
    const index = events.findIndex(event => event.phase === phase);
    const at = Date.parse(events[index]?.at);
    requireProof(index > previous && Number.isFinite(at) && at >= previousAt
      && at < Date.parse(manifest.receipt.expiresAt), 'SHUTDOWN_ORDER_NOT_PROVEN');
    previous = index; previousAt = at;
  }
  const data = phase => events.find(event => event.phase === phase).data;
  requireProof(data('prepared')?.redisClientId === receipt.redisClientId
    && data('evaluation_held')?.inFlight === true && data('shutdown_seen')?.signalSeen === true
    && ['processAlive', 'redisClientPresent', 'providerHealthy', 'drainAbsent', 'readinessWithheld'].every(key => data('independent_held_probe')?.[key] === true)
    && data('barrier_released')?.signalSeen === true && data('barrier_released').elapsedMs >= 0
    && data('barrier_released').elapsedMs < 5000, 'SHUTDOWN_ACTIVE_EVALUATION_NOT_PROVEN');
  requireProof(data('coordinator_drained')?.inFlight === false && data('coordinator_drained').redisConnected === true
    && data('redis_stopped')?.inFlight === false && data('redis_stopped').redisConnected === false
    && data('independent_redis_closed')?.redisClientPresent === false
    && /^[a-f0-9]{40}$/u.test(data('independent_held_probe')?.redisServerRunId ?? '')
    && data('independent_redis_closed').redisServerRunId === data('independent_held_probe').redisServerRunId, 'SHUTDOWN_DEPENDENCY_ORDER_NOT_PROVEN');
  requireProof(UUID.test(before?.worker?.instanceId ?? '') && UUID.test(after?.worker?.instanceId ?? '')
    && before.worker.instanceId !== after.worker.instanceId
    && recovered.ready === true && recovered.processInstanceId !== baseline.processInstanceId
    && recovered.scheduler.installations === 1 && recovered.policy.selfImproveEnabled === false, 'SHUTDOWN_RESTART_NOT_PROVEN');
  return { oldInstanceId: before.worker.instanceId, newInstanceId: after.worker.instanceId,
    oldProcessInstanceId: baseline.processInstanceId, newProcessInstanceId: recovered.processInstanceId,
    activeEvaluationDrained: true, redisClosureIndependentlyObserved: true, postgresAvailableThroughDrain: true };
}

/** Supplement A04 with a real failed bootstrap generation and recovered owned topology. */
export function attestSelfHealStartupFailureReceipt(value, failed, recovered, manifest, inventory, fenced, options = {}) {
  const targets = attestSelfHealAcceptanceStatus(inventory, manifest, options);
  const bind = (role, envelope) => {
    const pin = manifest.services.find(service => service.role === role); const target = envelope?.target;
    requireProof(target?.role === role && target.projectId === manifest.receipt.projectId
      && target.environmentId === manifest.receipt.environmentId && target.runId === manifest.receipt.runId
      && target.sourceSha === manifest.receipt.sourceSha && target.serviceId === pin.serviceId && target.deploymentId === pin.deploymentId
      && envelope.platformTarget?.serviceId === pin.serviceId && envelope.platformTarget.deploymentId === pin.deploymentId
      && envelope.platformTarget.instanceId === targets[role].instanceId, 'STARTUP_FAILURE_ENVELOPE_DRIFT');
  };
  bind('web', value); bind('worker', recovered?.before); bind('worker', recovered?.after);
  for (const step of ['absent', 'created', 'completed']) bind('worker', fenced?.[step]);
  const sequence = [value, recovered.before, fenced.absent, fenced.created, fenced.completed, recovered.after];
  let lastAt = Date.parse(manifest.receipt.issuedAt);
  for (const envelope of sequence) {
    const at = Date.parse(envelope.observedAt);
    requireProof(Number.isFinite(at) && at >= lastAt && at <= (options.now?.() ?? Date.now())
      && at < Date.parse(manifest.receipt.expiresAt), 'STARTUP_FAILURE_EVIDENCE_ORDER');
    lastAt = at;
  }
  const startup = value.startup; const receipt = startup?.receipt; const worker = manifest.services.find(pin => pin.role === 'worker');
  if (startup?.evidence !== 'independent_postgres_startup_readback') block('STARTUP_FAILURE_INSPECTION_UNAVAILABLE');
  requireProof(receipt?.scenario === 'A04'
    && receipt.sourceSha === manifest.receipt.sourceSha && receipt.compiledSha256 === worker.compiledSha256
    && UUID.test(receipt.processInstanceId ?? '') && Number.isSafeInteger(receipt.pid) && receipt.pid >= 2,
  'STARTUP_FAILURE_IDENTITY_DRIFT');
  requireProof(failed?.id === receipt.deploymentId && failed.id !== worker.deploymentId
    && failed.projectId === manifest.receipt.projectId && failed.environmentId === manifest.receipt.environmentId
    && failed.serviceId === worker.serviceId && ['FAILED', 'CRASHED'].includes(failed.status)
    && failed.deploymentStopped === true && Array.isArray(failed.instances)
    && failed.instances.every(instance => instance.status !== 'RUNNING')
    && failed.meta?.commitHash === manifest.receipt.sourceSha && failed.meta?.imageDigest === worker.imageDigest,
  'STARTUP_FAILURE_GENERATION_NOT_PROVEN');
  const initial = receipt.initialReadiness; const outcome = receipt.outcome;
  requireProof(initial?.statusCode === 503 && initial.ready === false && initial.child === 'starting'
    && Date.parse(initial.observedAt) >= Date.parse(manifest.receipt.issuedAt)
    && Date.parse(receipt.finishedAt) >= Date.parse(initial.observedAt)
    && Date.parse(receipt.finishedAt) <= Date.parse(value.observedAt)
    && Date.parse(receipt.finishedAt) < Date.parse(manifest.receipt.expiresAt)
    && outcome?.readinessCommitted === false && outcome.scheduler?.installationAttempts === 1
    && outcome.scheduler.installations === 0 && outcome.scheduler.installationFailures === 1 && outcome.scheduler.callbacks === 0
    && ['FAILED', 'BLOCKED'].includes(outcome.coordinator?.state) && outcome.coordinator.inFlight === false,
  'STARTUP_READINESS_WITHHOLDING_NOT_PROVEN');
  const restoredBefore = inspection(recovered.before); const restoredAfter = inspection(recovered.after);
  for (const state of [restoredBefore, restoredAfter]) requireProof(state?.ready === true && UUID.test(state.processInstanceId ?? '')
    && state.processInstanceId !== receipt.processInstanceId && state.coordinator?.loopRunning === true
    && state.scheduler?.installations === 1 && state.scheduler.installationAttempts === 1
    && state.policy?.selfImproveEnabled === false, 'STARTUP_FAILURE_RECOVERY_NOT_PROVEN');
  requireProof(restoredBefore.processInstanceId === restoredAfter.processInstanceId, 'STARTUP_FAILURE_PROCESS_CHANGED');
  for (const step of ['absent', 'created', 'completed']) {
    const probe = fenced[step].fencedJob;
    requireProof(probe?.scenario === 'A04' && probe.attempt === 2
      && probe.correlationId === `self-heal-preview:${manifest.receipt.runId}:fenced:A04:2`, 'STARTUP_FAILURE_JOB_IDENTITY');
  }
  const created = fenced.created.fencedJob.job; const job = fenced.completed.fencedJob.job;
  requireProof(fenced.absent.fencedJob.job === null && UUID.test(created?.id ?? '') && created.status === 'pending'
    && created.completionVerified === false && created.claimEvents === 0 && created.completionEvents === 0
    && job?.id === created.id
    && job?.completionVerified === true && job.literalObserved === true
    && job.matchingClaimEvents === 1 && job.matchingCompletionEvents === 1, 'STARTUP_FAILURE_RECOVERY_NOT_PROVEN');
  return { failedDeploymentId: failed.id, recoveredDeploymentId: worker.deploymentId,
    recoveredInstanceId: targets.worker.instanceId, readinessWithheldBeforeInitialization: true,
    initialSchedulerFailureObserved: true, ordinaryJobContinuityVerified: true };
}

/** Each case retains baseline, every operation, effects and restoration; incomplete evidence cannot pass. */
export async function runSelfHealAcceptanceCase(scenario, manifest, options = {}) {
  if (!SELF_HEAL_ACCEPTANCE_CASES.includes(scenario)) block('SCENARIO_INVALID');
  validateSelfHealAcceptanceManifest(manifest, options);
  if (options.execute !== true && options.allowNetwork !== true) return { scenario, classification: 'NOT_RUN', executed: false, sourceSha: manifest.receipt.sourceSha };
  if (options.execute !== true || options.allowNetwork !== true) block('NETWORK_GATES_REQUIRED');
  const now = options.now ?? Date.now; const wait = options.sleep ?? sleep;
  const transport = options.transport ?? createSelfHealAcceptanceTransport(manifest, options);
  const events = []; let sequence = 0; let baseline; let finalState; let errorCode = null;
  let classification = 'BLOCKED'; let cleanupResult = 'NOT_RUN';
  const emit = async (kind, value) => {
    const event = safeProjection({ scenario, sequence: ++sequence, observedAt: new Date(now()).toISOString(), kind, value });
    await options.onReceipt?.(event);
    events.push({ sequence: event.sequence, kind: event.kind, observedAt: event.observedAt, receiptSha256: hash(event) });
    return value;
  };
  const remote = async (role, args) => emit('operation', { role, args, receipt: await transport.remote(role, args) }).then(value => value.receipt);
  const inspect = async (role = 'worker') => inspection(await remote(role, ['inspect']));
  const command = async name => remote('worker', ['command', name]);
  const poll = async (read, predicate, timeoutMs = 30_000, transient = false) => {
    const deadline = Math.min(now() + timeoutMs, Date.parse(manifest.receipt.expiresAt) - CLEANUP_RESERVE_MS);
    for (let attempt = 0; attempt < 200 && now() < deadline; attempt += 1) {
      try { const value = await read(); if (predicate(value)) return value; }
      catch (error) {
        if (!transient || !(error instanceof SelfHealAcceptanceError)
          || !['SELF_HEAL_ACCEPTANCE_TARGET_NOT_RUNNING', 'SELF_HEAL_ACCEPTANCE_TRANSPORT_UNAVAILABLE'].includes(error.message)) throw error;
      }
      await wait(Math.min(2000, Math.max(1, deadline - now())));
    }
    block('OBSERVATION_NOT_ESTABLISHED');
  };
  const tick = async () => { await command('tick'); return poll(inspect, value => value.tickPending === false && !value.coordinator.inFlight); };
  const consumer = async () => {
    const before = await inspect();
    const admitted = await command('trinity_run');
    if (admitted.observation?.rejected === true) block('CONSUMER_NOT_ADMITTED');
    return poll(inspect, value => value.consumerRun?.requestId !== before.consumerRun?.requestId
      && ['completed', 'failed'].includes(value.consumerRun?.status), 15_000);
  };
  const fenced = async attempt => {
    await remote('worker', ['fenced-job', 'create', scenario, String(attempt)]);
    const result = await poll(() => remote('worker', ['fenced-job', 'inspect', scenario, String(attempt)]), value => value.fencedJob?.job?.completionVerified === true, 120_000);
    requireProof(result.fencedJob.job.literalObserved && result.fencedJob.job.matchingClaimEvents === 1 && result.fencedJob.job.matchingCompletionEvents === 1, 'JOB_EFFECT_NOT_VERIFIED');
    return result;
  };
  const restart = async role => {
    await emit('lifecycle', await transport.restart(role));
    return poll(inspect, value => value.ready === true && (role !== 'worker' || value.processInstanceId !== baseline.processInstanceId), 120_000, true);
  };
  const canonicalAction = async () => {
    await command('coordinator_stop'); await command('policy_disabled');
    for (let count = 0; count < 3; count += 1) await consumer();
    let observedFaults = 0;
    for (let count = 0; count < 6; count += 1) {
      await remote('worker', ['provider', 'timeout_next']);
      const observed = await consumer();
      if (observed.consumerRun?.recoveryPath?.reasoningTimeoutDirectAnswerFallback === true
        || observed.consumerRun?.status === 'failed' || observed.consumerRun?.diagnostics?.statusCode >= 400) observedFaults += 1;
    }
    requireProof(observedFaults >= 3, 'FAULT_CLUSTER_NOT_OBSERVED');
    await remote('worker', ['provider', 'set_healthy']); await command('policy_allowed'); await command('coordinator_start');
    return poll(inspect, value => value.coordinator.lastActionAt !== null
      && value.coordinator.lastActionAt !== baseline.coordinator.lastActionAt && value.coordinator.lastDecision === 'heal', 45_000);
  };
  try {
    baseline = await inspect(); await emit('baseline', baseline);
    await remote('worker', ['artifact']); await remote('web', ['artifact']);
    if (['B04', 'C01', 'C04', 'C05', 'C06', 'C07', 'C08', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07'].includes(scenario)) {
      baseline = await restart('worker'); await emit('fresh_process_baseline', baseline);
    }
    if (scenario === 'A01') {
      requireProof(baseline.ready && baseline.coordinator.loopRunning && baseline.coordinator.processKind === 'worker'
        && baseline.scheduler.installations === 1 && baseline.scheduler.installationAttempts === 1
        && baseline.runtime.nodeVersion === '24.18.1', 'BOOTSTRAP_NOT_PROVEN');
      await fenced(1);
    } else if (scenario === 'A02') {
      const web = await inspect('web');
      requireProof(web.ready && web.coordinator.coordinatorState === 'DISABLED' && !web.coordinator.loopRunning && web.scheduler.installations === 0, 'WEB_SUPPRESSION_FAILED');
    } else if (scenario === 'A03') {
      const after = inspection(await command('duplicate_start'));
      requireProof(after.processInstanceId === baseline.processInstanceId && after.scheduler.installations === baseline.scheduler.installations
        && after.coordinator.loopRunning, 'DUPLICATE_SCHEDULER'); await fenced(1);
    } else if (scenario === 'A04') {
      await command('coordinator_stop'); await command('scheduler_failure_once'); await command('coordinator_start');
      const failed = await inspect();
      requireProof(failed.scheduler.installationFailures > baseline.scheduler.installationFailures && !failed.coordinator.loopRunning, 'SCHEDULER_FAILURE_NOT_OBSERVED');
      await fenced(1); await command('coordinator_start');
      await poll(inspect, value => value.coordinator.loopRunning);
      // Startup-mode failed readiness requires a separately attested deployment; never infer it from a live reinstallation.
      block('STARTUP_FAILURE_DEPLOYMENT_RECEIPT_REQUIRED');
    } else if (['A05', 'E05'].includes(scenario)) {
      const after = await restart('worker');
      requireProof(after.processInstanceId !== baseline.processInstanceId && after.scheduler.installations === 1
        && !finalStage(after)?.activeAction && after.policy.selfImproveEnabled === false, 'STALE_PROCESS_AUTHORITY'); await fenced(1);
    } else if (['A06', 'E06'].includes(scenario)) {
      if (typeof transport.shutdownHeld !== 'function' || typeof transport.targets !== 'function') block('SHUTDOWN_CAPABILITY_REQUIRED');
      const before = await transport.targets();
      await emit('lifecycle', await transport.shutdownHeld(scenario));
      const journal = await poll(() => remote('web', ['shutdown-receipt', scenario]), value =>
        value.shutdown?.receipt?.events?.some(event => event.phase === 'independent_redis_closed'), 30_000, true);
      const recovered = await restart('worker'); const after = await transport.targets();
      await emit('shutdown_effect', attestSelfHealShutdownReceipt(journal.shutdown, scenario, baseline, recovered, manifest, before, after));
      await fenced(1);
    } else if (scenario === 'B01') {
      await restart('redis'); const after = await poll(inspect, value => value.redis.state === 'READY' && value.redis.connected
        && value.redis.readyGeneration > baseline.redis.readyGeneration && value.redis.recoveryCount > baseline.redis.recoveryCount, 120_000);
      await fenced(1);
      requireProof(Date.parse(after.redis.lastReadyAt) > Date.parse(baseline.redis.lastReadyAt), 'REDIS_DISCONNECTION_NOT_OBSERVED');
    } else if (scenario === 'B02') {
      await command('database_failure_once'); await fenced(1);
      const after = await inspect(); requireProof(after.claimBoundary.injectedFailures > baseline.claimBoundary.injectedFailures && !after.claimFailurePending, 'DATABASE_FAILURE_NOT_CONSUMED');
    } else if (scenario === 'B03') {
      await remote('worker', ['provider', 'timeout_next']);
      const after = await consumer();
      requireProof(after.consumerRun.requestId !== baseline.consumerRun?.requestId && (after.consumerRun.status === 'failed'
        || after.consumerRun.diagnostics.statusCode >= 400 || after.consumerRun.recoveryPath?.reasoningTimeoutDirectAnswerFallback === true), 'PROVIDER_TIMEOUT_NOT_OBSERVED');
      await remote('worker', ['provider', 'inspect']); await tick(); await fenced(1);
    } else if (scenario === 'B04') {
      await command('policy_allowed'); const active = (await command('trinity_activate')).observation;
      requireProof(active.result?.applied === true, 'RETRY_BASELINE_NOT_ACTIVE'); await consumer();
      await command('trinity_rollback'); const cooling = await inspect();
      const deadline = finalStage(cooling).cooldownUntilMs;
      requireProof(deadline > now() && deadline - now() <= 120_000, 'COOLDOWN_NOT_INSTALLED');
      const denied = (await command('trinity_activate')).observation;
      requireProof(denied.result?.applied === false && denied.result?.reason === 'cooldown_active'
        && finalStage(denied.inspection).attempts === 1, 'COOLDOWN_NOT_ENFORCED');
      while (now() <= deadline) { await wait(Math.min(30_000, deadline - now() + 1)); await inspect(); }
      requireProof((await command('trinity_activate')).observation.result?.applied === true, 'COOLDOWN_NEVER_RECOVERED');
      requireProof((await command('trinity_replace')).observation.result?.applied === true, 'RETRY_REPLACEMENT_NOT_APPLIED');
      const exhausted = (await command('trinity_activate')).observation;
      requireProof(exhausted.result?.applied === false && exhausted.result?.reason === 'attempt_budget_exhausted'
        && finalStage(exhausted.inspection).attempts === 3, 'RETRY_BUDGET_NOT_ENFORCED'); await consumer();
    } else if (scenario === 'B05') {
      await remote('worker', ['provider', 'set_healthy']); const after = await consumer();
      requireProof(after.consumerRun.status === 'completed' && after.consumerRun.diagnostics.statusCode === 200 && !after.consumerRun.dryRun, 'RECOVERY_CONSUMER_FAILED');
      await fenced(1);
    } else if (['C01', 'D07'].includes(scenario)) {
      const after = await canonicalAction();
      requireProof(after.coordinator.lastActionAt && after.coordinator.lastActionAt !== baseline.coordinator.lastActionAt
        && after.coordinator.lastDecision === 'heal', 'CANONICAL_MITIGATION_NOT_OBSERVED');
      const observed = await consumer();
      requireProof(observed.consumerRun.canonicalActionAtStart.at === after.coordinator.lastActionAt
        && observed.consumerRun.status === 'completed', 'CONSUMER_ACTION_NOT_CORRELATED');
      if (after.coordinator.lastAction === 'reinitializeOpenAIProvider:reloaded=true:ok=true:healthy') {
        requireProof(after.provider.reloadCount > baseline.provider.reloadCount
          && observed.consumerRun.consumerClientId !== baseline.provider.lastConsumerClientId, 'PROVIDER_CONSUMER_CLIENT_NOT_REPLACED');
      } else if (after.coordinator.lastAction.startsWith('activateTrinity')) {
        requireProof(observed.consumerRun.mitigationBefore?.mitigationId !== null
          && observed.consumerRun.mitigationBefore?.mitigationId === finalStage(after)?.mitigationId
          && !observed.consumerRun.routingStages.includes('ARCANOS-FINAL'), 'TRINITY_CONSUMER_EFFECT_NOT_OBSERVED');
      } else block('ACTION_EFFECT_INSPECTION_UNSUPPORTED');
    } else if (scenario === 'C02') {
      const beforeWeb = await inspect('web');
      const result = (await command('remote_mitigation_rejection')).observation;
      const afterWeb = await inspect('web');
      requireProof(result.rejected === true && result.dispatchAttempts === 0 && result.actuatorMode === 'unavailable'
        && beforeWeb.processInstanceId === afterWeb.processInstanceId && hash(beforeWeb.promptRoute) === hash(afterWeb.promptRoute)
        && hash(beforeWeb.trinity) === hash(afterWeb.trinity), 'UNAUTHORIZED_REMOTE_EFFECT');
      await emit('proof_boundary', { remoteActuation: 'unsupported_in_dedicated_worker_role', operatorApprovedRemoteTransportTested: false });
    } else if (scenario === 'C03') {
      const beforeWeb = await inspect('web'); const result = (await command('prompt_worker_rejection')).observation;
      const afterWeb = await inspect('web');
      requireProof(result.result?.applied === false && hash(beforeWeb.promptRoute) === hash(afterWeb.promptRoute), 'CROSS_PROCESS_EFFECT');
    } else if (scenario === 'C04') {
      await command('policy_allowed'); const activated = (await command('trinity_activate')).observation;
      if (activated?.rejected === true || activated?.result?.applied !== true) block('LOCAL_MITIGATION_PREREQUISITE');
      const original = activated.inspection; const replaced = (await command('trinity_replace')).observation;
      if (replaced?.rejected === true || replaced?.result?.applied !== true) block('LOCAL_MITIGATION_PREREQUISITE');
      const replacement = replaced.inspection; const stale = (await command('trinity_stale_rollback')).observation;
      requireProof(finalStage(original).mitigationId !== finalStage(replacement).mitigationId && stale.result?.rolledBack === false
        && finalStage(stale.inspection).mitigationId === finalStage(replacement).mitigationId, 'STALE_IDENTITY_CHANGED_STATE');
      const observed = await consumer(); requireProof(observed.consumerRun.mitigationBefore?.mitigationId === finalStage(replacement).mitigationId, 'CONSUMER_IDENTITY_MISMATCH');
    } else if (scenario === 'C05') {
      await command('policy_allowed'); await command('trinity_activate');
      const result = await remote('worker', ['replacement-race']); const overlap = result.overlap;
      const held = overlap?.held?.consumer; const replacement = finalStage(overlap?.replacement);
      const final = finalStage(overlap?.finalState); const completed = overlap?.finalState?.consumerRun;
      requireProof(overlap?.status === 'completed' && held?.consumerRun?.status === 'running'
        && typeof overlap.requestId === 'string' && overlap.requestId.length > 0
        && held.consumerRun.requestId === overlap.requestId && completed?.requestId === overlap.requestId
        && [overlap.baseline, held, overlap.replacement, overlap.finalState, held.consumerRun, completed]
          .every(value => value?.processInstanceId === baseline.processInstanceId)
        && Number.isSafeInteger(held.consumerRun.mitigationBefore?.mitigationId)
        && completed.mitigationBefore?.mitigationId === held.consumerRun.mitigationBefore.mitigationId
        && Number.isSafeInteger(replacement?.mitigationId) && replacement.activeAction === 'enable_degraded_mode'
        && completed.mitigationBefore.mitigationId !== replacement.mitigationId
        && final?.mitigationId === replacement.mitigationId && final.activeAction === replacement.activeAction
        && ['verificationSuccesses', 'verificationFailures'].every(key => Number.isSafeInteger(replacement[key])
          && final[key] === replacement[key])
        && completed.status === 'completed' && completed.dryRun === false && completed.diagnostics?.statusCode === 200
        && completed.mitigationAfter?.mitigationId === replacement.mitigationId
        && overlap.cleanup?.provider === 'released', 'REPLACEMENT_RACE_CONTAMINATED_EVIDENCE');
    } else if (scenario === 'C06') {
      await command('policy_allowed'); const active = inspection(await command('trinity_activate'));
      const expires = finalStage(active).expiresAtMs; requireProof(expires > now() && expires - now() <= 600_000, 'TTL_INVALID');
      while (now() <= expires) { await wait(Math.min(30_000, expires - now() + 1)); await inspect(); }
      await command('trinity_consumer'); const after = await consumer();
      requireProof(finalStage(after).activeAction === null && after.consumerRun.mitigationBefore?.mitigationId === null, 'TTL_EFFECT_RETAINED');
    } else if (['C07', 'C08'].includes(scenario)) {
      const after = await canonicalAction();
      if (!after.coordinator.lastActionAt || after.coordinator.lastActionAt === baseline.coordinator.lastActionAt) block('CANONICAL_ACTION_PREREQUISITE');
      if (scenario === 'C08') for (let count = 0; count < 3; count += 1) await consumer();
      const observed = await poll(async () => { await wait(30_000); return tick(); }, value => scenario === 'C07'
        ? value.coordinatorEvents?.some(event => event.reasonCode === 'awaiting_consumer_request_samples'
          && event.observedSamples === 0 && event.requiredSamples === 3 && Date.parse(event.timestamp) > Date.parse(after.coordinator.lastActionAt))
        : value.coordinator.lastVerificationResult?.outcome === 'improved', 150_000);
      requireProof(scenario === 'C07' ? observed.consumerMetrics.postAction?.requestCount === 0
        : observed.consumerMetrics.postAction?.requestCount >= 3
          && Date.parse(observed.coordinator.lastVerificationResult.verifiedAt) > Date.parse(after.coordinator.lastActionAt)
          && (after.coordinator.lastAction !== 'reinitializeOpenAIProvider:reloaded=true:ok=true:healthy' || observed.provider.successesSinceCanonicalAction >= 3), 'RECOVERY_FRESHNESS_FAILED');
    } else if (/^D0[1-4]$/u.test(scenario)) {
      const policy = { D01: 'policy_disabled', D02: 'policy_insufficient_autonomy', D03: 'policy_freeze', D04: 'policy_kill_switch' }[scenario];
      const expectedReason = { D01: 'self_improve_execution_disabled', D02: 'insufficient_autonomy',
        D03: 'self_improve_frozen', D04: 'self_improve_frozen' }[scenario];
      await command('coordinator_stop'); await command(policy);
      const providerBefore = inspection(await remote('worker', ['provider', 'inspect']));
      const providerReceiptIds = new Set((providerBefore?.receipts ?? []).map(value => value.requestId));
      const priorEventIds = new Set((baseline.coordinatorEvents ?? []).map(value => value.id));
      let observedFaults = 0;
      // These faults run only under the restrictive case policy. They provide
      // real diagnostics for a canonical decision, never a fabricated candidate.
      for (let count = 0; count < 3; count += 1) {
        await remote('worker', ['provider', 'timeout_next']);
        const observed = await consumer();
        requireProof(observed.processInstanceId === baseline.processInstanceId, 'AUTHORIZATION_PROCESS_CHANGED');
        if (observed.consumerRun?.recoveryPath?.reasoningTimeoutDirectAnswerFallback === true
          || observed.consumerRun?.status === 'failed' || observed.consumerRun?.diagnostics?.statusCode >= 400) observedFaults += 1;
      }
      const providerAfter = inspection(await remote('worker', ['provider', 'inspect']));
      const injectedFaults = (providerAfter?.receipts ?? []).filter(value => !providerReceiptIds.has(value.requestId)
        && value.fault === 'timeout' && ['timeout', 'client_closed'].includes(value.outcome));
      await remote('worker', ['provider', 'set_healthy']);
      const beforeTick = await inspect(); const tickStartedAt = Date.parse(beforeTick.policy?.observedAt); const after = await tick();
      requireProof(after.processInstanceId === baseline.processInstanceId
        && after.coordinator.lastActionAt === baseline.coordinator.lastActionAt
        && Number.isSafeInteger(after.provider.reloadCount) && after.provider.reloadCount === baseline.provider.reloadCount
        && ['intake', 'reasoning', 'final'].every(stage =>
          record(after.trinity?.snapshot?.[stage]) && record(baseline.trinity?.snapshot?.[stage])
          && after.trinity.snapshot[stage].activeAction === baseline.trinity.snapshot[stage].activeAction
          && after.trinity?.snapshot?.[stage]?.mitigationId === baseline.trinity?.snapshot?.[stage]?.mitigationId), 'AUTHORIZATION_SIDE_EFFECT');
      if (observedFaults !== 3 || injectedFaults.length !== 3) block('AUTHORIZATION_FAULT_PREREQUISITE');
      const policyObserved = scenario === 'D01' ? after.policy.selfImproveEnabled === false
        : scenario === 'D02' ? after.policy.autonomyLevel === 2
          : scenario === 'D03' ? after.policy.frozen === true : after.policy.killSwitch?.frozen === true;
      if (!policyObserved || after.coordinator.lastDecision !== 'heal'
        || !(after.coordinatorEvents ?? []).some(event => !priorEventIds.has(event.id) && event.id !== null
          && event.trigger === 'action' && event.kind === 'noop' && event.reasonCode === expectedReason
          && typeof event.action === 'string' && event.action.length > 0
          && Date.parse(event.timestamp) >= tickStartedAt)) block('CANONICAL_POLICY_DENIAL_REQUIRED');
    } else if (['D05', 'D06'].includes(scenario)) {
      const dryRun = scenario === 'D05';
      await command('coordinator_stop');
      await command(dryRun ? 'policy_predictive_dry_run' : 'policy_predictive_no_execute');
      const providerBefore = inspection(await remote('worker', ['provider', 'inspect']));
      const providerReceiptIds = new Set((providerBefore?.receipts ?? []).map(value => value.requestId));
      let observedFaults = 0;
      // Two real stage failures reach the predictive pre-heal threshold while
      // staying below the ordinary three-failure reactive request threshold.
      for (let count = 0; count < 2; count += 1) {
        await remote('worker', ['provider', 'timeout_next']);
        const observed = await consumer();
        requireProof(observed.processInstanceId === baseline.processInstanceId, 'PREDICTIVE_PROCESS_CHANGED');
        if (observed.consumerRun?.recoveryPath?.reasoningTimeoutDirectAnswerFallback === true
          || observed.consumerRun?.status === 'failed' || observed.consumerRun?.diagnostics?.statusCode >= 400) observedFaults += 1;
      }
      const providerAfter = inspection(await remote('worker', ['provider', 'inspect']));
      const injectedFaults = (providerAfter?.receipts ?? []).filter(value => !providerReceiptIds.has(value.requestId)
        && value.fault === 'timeout' && ['timeout', 'client_closed'].includes(value.outcome));
      await remote('worker', ['provider', 'set_healthy']);
      if (observedFaults !== 2 || injectedFaults.length !== 2) block('PREDICTIVE_FAULT_PREREQUISITE');
      const before = await inspect(); const requestedAt = Date.parse(before.policy?.observedAt);
      const admitted = await command('predictive_evaluate_live'); const started = inspection(admitted)?.predictiveRun;
      if (admitted.observation?.rejected === true || !started || started.processInstanceId !== baseline.processInstanceId
        || !Number.isFinite(requestedAt) || !Number.isFinite(Date.parse(started.startedAt))
        || Date.parse(started.startedAt) < requestedAt) block('PREDICTIVE_NEW_AUDIT_REQUIRED');
      const after = await poll(inspect, value => value.predictiveRun?.status === 'completed'
        && value.predictiveRun.startedAt === started.startedAt && value.predictiveRun.processInstanceId === baseline.processInstanceId, 15_000);
      const audit = after.predictiveRun.audit;
      if (!record(audit) || typeof audit.attempted !== 'boolean') block('PREDICTIVE_NEW_AUDIT_REQUIRED');
      requireProof(after.processInstanceId === baseline.processInstanceId
        && after.coordinator.lastActionAt === baseline.coordinator.lastActionAt
        && Number.isSafeInteger(after.provider.reloadCount) && after.provider.reloadCount === baseline.provider.reloadCount
        && ['intake', 'reasoning', 'final'].every(stage =>
          record(after.trinity?.snapshot?.[stage]) && record(baseline.trinity?.snapshot?.[stage])
          && after.trinity.snapshot[stage].activeAction === baseline.trinity.snapshot[stage].activeAction
          && after.trinity?.snapshot?.[stage]?.mitigationId === baseline.trinity?.snapshot?.[stage]?.mitigationId)
        && audit?.attempted === false, 'PREDICTIVE_EXECUTION_ESCAPE');
      if (after.predictiveRun.evidence !== 'measured_runtime_observation'
        || !/^predictive_heal_audit_\d+$/u.test(audit?.auditId ?? '') || audit.auditId === before.predictiveRun?.audit?.auditId
        || audit.source !== 'self-heal.preview.measured-runtime' || Date.parse(audit.timestamp) < Date.parse(started.startedAt)
        || !Number.isFinite(Date.parse(audit.timestamp)) || audit.selectedAction === 'none'
        || typeof audit.selectedAction !== 'string' || audit.selectedAction.length === 0 || audit.safeToExecute !== true) block('PREDICTIVE_EXECUTABLE_CANDIDATE_REQUIRED');
      if (audit.mode !== (dryRun ? 'dry_run' : 'recommend_only') || audit.status !== (dryRun ? 'dry_run' : 'skipped')
        || audit.featureFlags?.enabled !== true || audit.featureFlags?.dryRun !== dryRun
        || audit.featureFlags?.autoExecute !== dryRun) block('PREDICTIVE_POLICY_MODE_REQUIRED');
    } else if (['E01', 'E02', 'E03'].includes(scenario)) {
      await command('observation_throw_once'); const failed = await tick(); await fenced(1); const recovered = await tick(); await fenced(2);
      requireProof(failed.observation.injectedFailures > baseline.observation.injectedFailures && recovered.coordinator.loopRunning
        && recovered.coordinator.tickCount > failed.coordinator.tickCount, 'COORDINATOR_RECOVERY_FAILED');
    } else if (scenario === 'E04') {
      const result = await remote('worker', ['dependency-overlap']); const overlap = result.overlap;
      requireProof(overlap?.status === 'completed' && overlap.held?.consumer?.observation?.holding === true
        && overlap.held?.consumer?.consumerRun?.status === 'running', 'CONCURRENT_FAULTS_NOT_ESTABLISHED');
      await tick(); await fenced(1);
      const after = await inspect(); requireProof(!after.tickPending && !after.observation.holding && after.scheduler.installations === baseline.scheduler.installations, 'CONCURRENT_FAULTS_UNBOUNDED');
    }
    classification = REAL_TRANSPORTS.has(transport) ? 'VERIFIED' : 'SYNTHETIC_ONLY';
  } catch (error) {
    classification = error instanceof SelfHealAcceptanceError ? error.classification : 'BLOCKED';
    errorCode = error instanceof SelfHealAcceptanceError ? error.message : 'SELF_HEAL_ACCEPTANCE_UNAVAILABLE';
    await emit('failure', { classification, errorCode });
  } finally {
    const restoreFailures = [];
    for (const args of [['provider', 'release'], ['provider', 'set_healthy'], ['command', 'release_observation'],
      ['command', 'trinity_rollback'], ['command', 'policy_restore'], ['command', 'coordinator_start']]) {
      try {
        const receipt = transport.restore ? await transport.restore(args) : await transport.remote('worker', args);
        finalState = inspection(receipt); await emit('restoration', { args, receipt });
      } catch { restoreFailures.push(args.join(':')); }
    }
    try {
      requireProof(!finalState.observation.holding && !finalState.claimFailurePending && finalState.consumerRun?.status !== 'running'
        && finalState.policy.selfImproveEnabled === false && restoreFailures.length === 0, 'FAULT_CLEANUP_INCOMPLETE');
      cleanupResult = REAL_TRANSPORTS.has(transport) ? 'VERIFIED' : 'SYNTHETIC_ONLY';
    } catch { cleanupResult = 'FAILED'; classification = 'BLOCKED'; errorCode ??= 'SELF_HEAL_ACCEPTANCE_FAULT_CLEANUP_FAILED'; }
  }
  const result = { version: 1, scenario, classification, executed: true, sourceSha: manifest.receipt.sourceSha,
    controllerSha: manifest.controllerSha, runId: manifest.receipt.runId, projectId: manifest.receipt.projectId,
    environmentId: manifest.receipt.environmentId, baseline, finalState, cleanupResult, errorCode,
    providerBoundary: 'synthetic_loopback_adapter', realExternalProviderRecoveryProven: false,
    eventCount: events.length, eventReceipts: events };
  await options.onResult?.(safeProjection(result)); return result;
}

async function main() {
  const argv = process.argv.slice(2); const allowed = new Set(['--manifest', '--evidence-directory', '--case', '--execute', '--allow-network']);
  const parsed = {}; for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]; if (!allowed.has(name) || Object.hasOwn(parsed, name)) block('ARGUMENT_INVALID');
    parsed[name] = ['--execute', '--allow-network'].includes(name) ? true : argv[++index];
  }
  if (!isAbsolute(parsed['--manifest'] ?? '') || !isAbsolute(parsed['--evidence-directory'] ?? '')
    || !SELF_HEAL_ACCEPTANCE_CASES.includes(parsed['--case'])) block('ARGUMENT_INVALID');
  const stat = lstatSync(parsed['--manifest']); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) block('MANIFEST_INVALID');
  const manifest = validateSelfHealAcceptanceManifest(JSON.parse(readFileSync(parsed['--manifest'], 'utf8')));
  // A unique per-case directory is supplied by the caller; publication never overwrites an earlier failure.
  let sequence = 0;
  const result = await runSelfHealAcceptanceCase(parsed['--case'], manifest, {
    execute: parsed['--execute'] === true, allowNetwork: parsed['--allow-network'] === true,
    onReceipt: receipt => publishSelfHealAcceptanceReceipt(parsed['--evidence-directory'], ++sequence, receipt),
    onResult: receipt => publishSelfHealAcceptanceReceipt(parsed['--evidence-directory'], ++sequence, receipt),
  });
  console.log(JSON.stringify({ scenario: result.scenario, classification: result.classification, errorCode: result.errorCode ?? null }));
  if (!['VERIFIED', 'NOT_RUN'].includes(result.classification)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => {
  console.error('SELF_HEAL_ACCEPTANCE_FAILED'); process.exitCode = 1;
});
