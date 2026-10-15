/** Two closed shutdown probes. No caller-selected PID, SQL, URL or timeout. */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { createClient } from 'redis';
import { bindSelfHealPreviewArtifact, buildSelfHealPreviewDatabaseClientOptions,
  resolveSelfHealPreviewProfile } from './railway-self-heal-preview-profile.mjs';
import { verifySelfHealPreviewArtifact } from './self-heal-preview-artifact.mjs';

function fail() { throw new Error('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED'); }
async function readinessBody(response) {
  if (!response.body) fail();
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 4096) fail(); chunks.push(Buffer.from(next.value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); }
}
export function parsePreviewShutdownProcess(pid, stat, rawCommand, entry) {
  if (!Number.isSafeInteger(pid) || pid < 2 || !['dist/workers/jobRunner.js', 'scripts/start-railway-service.mjs',
    'scripts/start-railway-service-with-integrity.mjs'].includes(entry) || !stat.startsWith(`${pid} (`)) fail();
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  if (fields[0] === 'Z') return null;
  const command = rawCommand.split('\0').filter(Boolean);
  if (command.at(-1) !== entry || !/(?:^|\/)node$/u.test(command[0] ?? '')
    || !/^\d+$/u.test(fields[19]) || !/^\d+$/u.test(fields[1])) fail();
  return { pid, startTime: fields[19], parentPid: Number(fields[1]) };
}
function readProcess(pid, entry) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) fail();
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return parsePreviewShutdownProcess(pid, stat, readFileSync(`/proc/${pid}/cmdline`, 'utf8'), entry);
  } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null; throw error; }
}
function processIdentity(pid) { return readProcess(pid, 'dist/workers/jobRunner.js')?.startTime ?? null; }
function signalTarget(workerPid) {
  const worker = readProcess(workerPid, 'dist/workers/jobRunner.js');
  if (!worker) fail();
  const launcher = readProcess(worker.parentPid, 'scripts/start-railway-service.mjs');
  if (!launcher) fail();
  const wrapper = readProcess(launcher.parentPid, 'scripts/start-railway-service-with-integrity.mjs');
  if (!wrapper) fail();
  return wrapper;
}

export async function runSelfHealPreviewShutdown(operation, scenario, env, options = {}) {
  if (!['held', 'receipt'].includes(operation) || !['A06', 'E06'].includes(scenario)
    || (operation === 'held' && env.ARCANOS_PROCESS_KIND !== 'worker')) fail();
  const unbound = resolveSelfHealPreviewProfile(env.ARCANOS_PROCESS_KIND, env, { now: options.now });
  const artifact = await (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: unbound.proofTarget.sourceCommit });
  const profile = bindSelfHealPreviewArtifact(unbound, artifact);
  const { PreviewShutdownJournal } = options.shutdownModule
    ?? await import('../dist/services/selfImprove/selfHealingPreviewShutdown.js');
  const journal = await PreviewShutdownJournal.open(buildSelfHealPreviewDatabaseClientOptions(profile), profile.ownership, options.createJournalClient);
  const wait = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const identity = options.processIdentity ?? processIdentity;
  const signal = options.signalProcess ?? ((pid, name) => process.kill(pid, name));
  const signalParent = options.signalTarget ?? signalTarget;
  const evidenceKind = options.createJournalClient || options.createRedisClient || options.processIdentity
    || options.signalProcess || options.signalTarget || options.shutdownModule || options.fetchImpl || options.verifyArtifact
    || options.now || options.sleep ? 'synthetic_injected_dependencies' : 'independent_pg_redis_process_probe';
  let redis;
  let sentSignal = false;
  let prepared = false;
  let result;
  const local = async args => {
    const receipt = await options.local(args);
    if (receipt.observation?.rejected) fail();
    return receipt.observation?.inspection ?? receipt.observation;
  };
  const poll = async (read, accept, timeoutMs) => {
    const deadline = now() + timeoutMs;
    for (let attempt = 0; attempt < 500 && now() < deadline; attempt += 1) {
      const value = await read(); if (accept(value)) return value;
      await wait(Math.min(25, Math.max(1, deadline - now())));
    }
    fail();
  };
  const has = (receipt, phase) => receipt.events.some(event => event.phase === phase);
  const connectRedis = async () => {
    redis = (options.createRedisClient ?? createClient)({ url: profile.proofTarget.redisUrl,
      disableOfflineQueue: true, socket: { connectTimeout: 500, reconnectStrategy: false } });
    redis.on('error', () => undefined); await redis.connect();
  };
  const redisPresent = async id => {
    const reply = await redis.sendCommand(['CLIENT', 'LIST', 'ID', id], { timeout: 500 });
    return String(reply).split('\n').some(line => line.split(' ').includes(`id=${id}`));
  };
  const redisServerRunId = async () => {
    const info = await redis.sendCommand(['INFO', 'server'], { timeout: 500 });
    const match = /^run_id:([a-f0-9]{40})\r?$/mu.exec(String(info)); if (!match) fail(); return match[1];
  };
  try {
    if (operation === 'receipt') {
      let receipt = await journal.read(scenario);
      if (has(receipt, 'redis_stopped') && !has(receipt, 'independent_redis_closed')) {
        const held = receipt.events.find(event => event.phase === 'independent_held_probe');
        if (!held?.data.redisServerRunId) fail();
        await connectRedis();
        const serverRunId = await redisServerRunId();
        if (serverRunId !== held.data.redisServerRunId) fail();
        if (!await redisPresent(receipt.redisClientId)) {
          await journal.append('independent_redis_closed', { redisClientPresent: false, redisServerRunId: serverRunId });
          receipt = await journal.read(scenario);
        }
      }
      return { evidence: evidenceKind === 'synthetic_injected_dependencies' ? evidenceKind : 'independent_postgres_redis_readback', receipt };
    }
    if (typeof options.local !== 'function') fail();
    const baseline = await local(['inspect']);
    if (!baseline.ready || !Number.isSafeInteger(baseline.pid) || baseline.consumerRun?.status === 'running'
      || baseline.predictiveRun?.status === 'running' || baseline.observation?.holding || baseline.observation?.holdArmed) fail();
    const initialIdentity = identity(baseline.pid); if (!initialIdentity) fail();
    await journal.holdBarrier();
    await local(['command', 'coordinator_stop']);
    await poll(() => local(['inspect']), value => !value.coordinator.inFlight && !value.coordinator.loopRunning, 1_000);
    const armed = await local(['command', scenario === 'A06' ? 'shutdown_prepare_a06' : 'shutdown_prepare_e06']);
    prepared = true;
    if (armed.processInstanceId !== baseline.processInstanceId || !armed.shutdownProbe?.armed
      || armed.shutdownProbe.scenario !== scenario) fail();
    const initial = await journal.read(scenario);
    if (initial.processInstanceId !== baseline.processInstanceId || initial.pid !== baseline.pid
      || initial.deploymentId !== env.RAILWAY_DEPLOYMENT_ID || initial.redisClientId !== armed.shutdownProbe.redisClientId) fail();
    await connectRedis();
    const serverRunId = await redisServerRunId();
    const providerHealthy = async () => {
      const value = await local(['provider', 'inspect']);
      return value.expired === false && value.inFlight === null && value.nextFault === null;
    };
    if (!await redisPresent(initial.redisClientId) || !await providerHealthy()) fail();
    await local(['command', 'coordinator_start']);
    const held = await poll(() => local(['inspect']), value => value.processInstanceId === baseline.processInstanceId
      && value.shutdownProbe?.holding && value.coordinator.inFlight, 1_000);
    if (identity(held.pid) !== initialIdentity || held.pid !== baseline.pid) fail();
    const wrapper = signalParent(held.pid);
    const rechecked = signalParent(held.pid);
    if (wrapper.pid !== rechecked.pid || wrapper.startTime !== rechecked.startTime) fail();
    signal(wrapper.pid, 'SIGTERM'); sentSignal = true;
    const shutdown = await poll(() => journal.read(scenario), value => has(value, 'shutdown_seen'), 1_000);
    const readiness = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${env.PORT ?? '8080'}/readyz`,
      { redirect: 'error', signal: AbortSignal.timeout(500) });
    const readinessState = await readinessBody(readiness);
    const heldEvidence = { processAlive: identity(held.pid) === initialIdentity, redisClientPresent: await redisPresent(initial.redisClientId),
      providerHealthy: await providerHealthy(), drainAbsent: !has(shutdown, 'coordinator_drained') && !has(shutdown, 'redis_stop_begin') };
    if (Object.values(heldEvidence).some(value => value !== true) || has(shutdown, 'barrier_expired')
      || readiness.status !== 503 || readinessState.ready !== false || readinessState.child !== 'draining') fail();
    await journal.append('independent_held_probe', { ...heldEvidence, redisServerRunId: serverRunId, readinessWithheld: true });
    await journal.append('independent_barrier_releasing');
    await journal.releaseBarrier();
    const closed = await poll(async () => {
      const receipt = await journal.read(scenario);
      return { receipt, redisPresent: await redisPresent(initial.redisClientId) };
    }, value => has(value.receipt, 'redis_stopped') && !value.redisPresent, 5_000);
    if (has(closed.receipt, 'barrier_expired')) fail();
    const phases = closed.receipt.events.map(event => event.phase);
    if (phases.indexOf('coordinator_drained') < 0 || phases.indexOf('coordinator_drained') >= phases.indexOf('redis_stop_begin')
      || phases.indexOf('redis_stop_begin') >= phases.indexOf('redis_stopped')) fail();
    if (await redisServerRunId() !== serverRunId) fail();
    await journal.append('independent_redis_closed', { redisClientPresent: false, providerHealthy: await providerHealthy(), redisServerRunId: serverRunId });
    // The supervisor may terminate this SSH process with its pod. The durable
    // journal can then be read through the surviving Web service; the controller
    // must additionally prove disappearance of the exact old deployment instance.
    await poll(async () => identity(held.pid), value => value !== initialIdentity, 15_000);
    await journal.append('independent_process_exited', { processAlive: false });
    result = { evidence: evidenceKind, receipt: await journal.read(scenario) };
    return result;
  } finally {
    await journal.releaseBarrier().catch(() => undefined);
    if (prepared && !sentSignal) await local(['command', 'shutdown_cancel']).catch(() => undefined);
    if (redis?.isOpen) redis.destroy();
    await journal.close();
  }
}
