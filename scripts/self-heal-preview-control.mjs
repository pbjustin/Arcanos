/** Fixed loopback client for execution through an independently attested Railway SSH instance. */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSelfHealPreviewProfile } from './railway-self-heal-preview-profile.mjs';
import { verifySelfHealPreviewArtifact } from './self-heal-preview-artifact.mjs';
import { SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH } from './railway-backstage-heavy-openai-fixture.mjs';

export const SELF_HEAL_PREVIEW_CONTROL_COMMANDS = Object.freeze([
  'inspect', 'duplicate_start', 'coordinator_stop', 'coordinator_start', 'tick',
  'observation_throw_once', 'hold_observation_once', 'release_observation', 'scheduler_failure_once', 'database_failure_once',
  'policy_disabled', 'policy_insufficient_autonomy', 'policy_freeze', 'policy_kill_switch',
  'policy_predictive_dry_run', 'policy_predictive_no_execute', 'policy_allowed', 'policy_restore',
  'prompt_worker_rejection', 'remote_mitigation_rejection',
  'trinity_activate', 'trinity_replace', 'trinity_stale_rollback', 'trinity_rollback',
  'trinity_consumer', 'trinity_fresh_success', 'trinity_run', 'predictive_evaluate', 'predictive_evaluate_live',
  'shutdown_prepare_a06', 'shutdown_prepare_e06', 'shutdown_cancel',
]);
const PROVIDER_COMMANDS = new Set(['inspect', 'set_healthy', 'timeout_next', 'hold_next', 'release']);
const MAX_BYTES = 65_536;
function fail() { throw new Error('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED'); }

async function boundedJson(response) {
  if (!response.ok || !response.body) fail();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) fail();
      chunks.push(Buffer.from(next.value));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value;
  } finally { await reader.cancel().catch(() => undefined); }
}

function assertNoPurposeSecrets(value, env) {
  const text = JSON.stringify(value);
  const secrets = ['ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN',
    'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY', 'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
    'ARCANOS_JOB_READ_CAPABILITY_SECRET'].map(name => env[name]);
  for (const name of ['DATABASE_URL', 'REDIS_URL']) {
    try { const url = new URL(env[name]); secrets.push(env[name], decodeURIComponent(url.password)); } catch { fail(); }
  }
  if (secrets.some(secret => typeof secret === 'string' && secret.length >= 8 && text.includes(secret))) fail();
}

/** Establish short process-local overlaps inside one attested SSH invocation. */
async function runLocalOverlap(operation, env, options) {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const evidence = { operation, status: 'incomplete', baseline: null, providerBaseline: null, held: null, replacement: null,
    finalState: null, providerFinal: null, requestId: null, reasonCode: null,
    cleanup: { provider: 'not_armed', observation: 'not_armed' } };
  let processInstanceId;
  let providerOwned = false; let observationOwned = false;
  const local = async argv => {
    const receipt = await runSelfHealPreviewControl(argv, env, options);
    const value = receipt.observation?.inspection ?? receipt.observation;
    if (receipt.observation?.rejected === true) fail();
    if (argv[0] !== 'provider' && processInstanceId && value?.processInstanceId !== processInstanceId) fail();
    if (argv[0] === 'provider' && (value?.issuedAt !== Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT)
      || value?.expiresAt !== Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT) || value.expired !== false)) fail();
    return value;
  };
  const boundedPoll = async (read, accept, timeoutMs, attempts) => {
    const deadline = now() + timeoutMs;
    for (let index = 0; index < attempts && now() < deadline; index += 1) {
      const value = await read(); if (accept(value)) return value;
      await wait(Math.min(100, Math.max(1, deadline - now())));
    }
    fail();
  };
  try {
    evidence.baseline = await local(['inspect']);
    processInstanceId = evidence.baseline.processInstanceId;
    if (!/^[a-f0-9-]{36}$/u.test(processInstanceId ?? '') || evidence.baseline.ready !== true
      || evidence.baseline.consumerRun?.status === 'running' || evidence.baseline.observation?.holding === true
      || evidence.baseline.observation?.holdArmed === true) fail();
    const providerBefore = await local(['provider', 'inspect']);
    evidence.providerBaseline = providerBefore;
    if (providerBefore.inFlight !== null || providerBefore.nextFault !== null) fail();
    if (operation === 'replacement-race') {
      const state = evidence.baseline.trinity?.snapshot?.final;
      if (state?.activeAction !== 'bypass_final_stage' || !Number.isSafeInteger(state.mitigationId)) fail();
    } else {
      observationOwned = true;
      await local(['command', 'hold_observation_once']); await local(['command', 'tick']);
      await boundedPoll(() => local(['inspect']), value => value.observation?.holding === true, 1_500, 15);
    }
    providerOwned = true; await local(['provider', 'hold_next']);
    const started = await local(['command', 'trinity_run']);
    evidence.requestId = started.consumerRun?.requestId;
    if (!evidence.requestId || started.consumerRun.status !== 'running' || started.rejected) fail();
    const providerHeld = await boundedPoll(() => local(['provider', 'inspect']), value => typeof value.inFlight === 'string', 1_500, 15);
    const consumerHeld = await local(['inspect']);
    if (consumerHeld.consumerRun?.requestId !== evidence.requestId || consumerHeld.consumerRun.status !== 'running'
      || (operation === 'dependency-overlap' && consumerHeld.observation?.holding !== true)) fail();
    evidence.held = { consumer: consumerHeld, provider: providerHeld };
    if (operation === 'replacement-race') {
      evidence.replacement = await local(['command', 'trinity_replace']);
      const previousId = consumerHeld.consumerRun.mitigationBefore?.mitigationId;
      const replacementId = evidence.replacement.trinity?.snapshot?.final?.mitigationId;
      if (evidence.replacement.rejected || !Number.isSafeInteger(previousId) || !Number.isSafeInteger(replacementId)
        || previousId === replacementId) fail();
    }
    await local(['provider', 'release']);
    if (observationOwned) await local(['command', 'release_observation']);
    evidence.finalState = await boundedPoll(() => local(['inspect']), value => value.consumerRun?.requestId === evidence.requestId
      && ['completed', 'failed'].includes(value.consumerRun.status)
      && (operation !== 'dependency-overlap' || (!value.observation?.holding && !value.tickPending)), 8_000, 80);
    evidence.status = 'completed';
  } catch { evidence.reasonCode = 'SELF_HEAL_PREVIEW_OVERLAP_NOT_ESTABLISHED'; }
  finally {
    if (providerOwned) {
      try {
        await local(['provider', 'release']); await local(['provider', 'set_healthy']);
        if (evidence.requestId && !evidence.finalState) evidence.finalState = await boundedPoll(() => local(['inspect']), value =>
          value.consumerRun?.requestId === evidence.requestId && ['completed', 'failed'].includes(value.consumerRun.status), 8_000, 80);
        evidence.providerFinal = await local(['provider', 'inspect']);
        if (evidence.providerFinal.inFlight !== null || evidence.providerFinal.nextFault !== null) fail();
        evidence.cleanup.provider = 'released';
      } catch { evidence.cleanup.provider = 'failed'; evidence.status = 'incomplete'; evidence.reasonCode ??= 'SELF_HEAL_PREVIEW_OVERLAP_CLEANUP_FAILED'; }
    }
    if (observationOwned) {
      try { await local(['command', 'release_observation']); evidence.cleanup.observation = 'released'; }
      catch { evidence.cleanup.observation = 'failed'; evidence.status = 'incomplete'; evidence.reasonCode ??= 'SELF_HEAL_PREVIEW_OVERLAP_CLEANUP_FAILED'; }
    }
  }
  return evidence;
}

/** No URL, token, script, SQL or arbitrary payload can be supplied as an argument. */
export async function runSelfHealPreviewControl(argv, env = process.env, options = {}) {
  const role = env.ARCANOS_PROCESS_KIND;
  const profile = resolveSelfHealPreviewProfile(role, env, { now: options.now });
  const target = { role, runId: profile.proofTarget.runId, sourceSha: profile.proofTarget.sourceCommit,
    projectId: profile.proofTarget.projectId, environmentId: profile.proofTarget.environmentId,
    serviceId: profile.proofTarget.serviceId, deploymentId: env.RAILWAY_DEPLOYMENT_ID };
  const finish = receipt => { assertNoPurposeSecrets(receipt, env); return receipt; };
  if (argv.length === 1 && argv[0] === 'startup-failure-receipt' && role === 'web') {
    const { runSelfHealPreviewStartupReceipt } = await import('./self-heal-preview-startup.mjs');
    return finish({ target, startup: await runSelfHealPreviewStartupReceipt(env, options) });
  }
  if (argv.length === 2 && ['shutdown-held', 'shutdown-receipt'].includes(argv[0]) && ['A06', 'E06'].includes(argv[1])
    && (argv[0] === 'shutdown-receipt' || role === 'worker')) {
    const { runSelfHealPreviewShutdown } = await import('./self-heal-preview-shutdown.mjs');
    return finish({ target, shutdown: await runSelfHealPreviewShutdown(argv[0] === 'shutdown-held' ? 'held' : 'receipt', argv[1], env,
      { ...options, local: args => runSelfHealPreviewControl(args, env, options) }) });
  }
  if (argv.length === 1 && ['replacement-race', 'dependency-overlap'].includes(argv[0]) && role === 'worker') {
    return finish({ target, overlap: await runLocalOverlap(argv[0], env, options) });
  }
  if (argv.length === 1 && argv[0] === 'artifact') {
    return finish({ target, artifact: (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: target.sourceSha }) });
  }
  if (argv.length === 4 && argv[0] === 'fenced-job' && ['create', 'inspect'].includes(argv[1])
      && ['1', '2'].includes(argv[3]) && role === 'worker') {
    const { runSelfHealPreviewFencedJob, SELF_HEAL_PREVIEW_JOB_SCENARIOS } = await import('./self-heal-preview-job.mjs');
    if (!SELF_HEAL_PREVIEW_JOB_SCENARIOS.includes(argv[2])) fail();
    return finish({ target, fencedJob: await runSelfHealPreviewFencedJob(argv[1], env,
      { ...options, scenario: argv[2], attempt: Number(argv[3]) }) });
  }
  if (argv.length === 3 && argv[0] === 'web-job' && argv[1] === 'run'
      && ['1', '2'].includes(argv[2]) && role === 'web') {
    const { runSelfHealPreviewWebJob } = await import('./self-heal-preview-web-job.mjs');
    return finish({ target, webJob: await runSelfHealPreviewWebJob(env, { ...options, attempt: Number(argv[2]) }) });
  }
  let command;
  let provider = false;
  if (argv.length === 1 && argv[0] === 'inspect') command = 'inspect';
  else if (argv.length === 2 && argv[0] === 'command' && SELF_HEAL_PREVIEW_CONTROL_COMMANDS.includes(argv[1])) command = argv[1];
  else if (argv.length === 2 && argv[0] === 'provider' && PROVIDER_COMMANDS.has(argv[1]) && role === 'worker') {
    provider = true; command = argv[1];
  } else fail();
  const body = { command, ...(provider && command === 'timeout_next' ? { count: 1, delayMs: 5_000 }
    : provider && command === 'hold_next' ? { delayMs: 5_000 } : {}) };
  const url = provider ? `http://127.0.0.1:8766${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH}`
    : `http://127.0.0.1:8791/${argv[0] === 'inspect' ? 'inspect' : 'command'}`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: argv[0] === 'inspect' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(6_000),
    headers: { authorization: `Bearer ${profile.controlToken}`, 'content-type': 'application/json' },
    ...(argv[0] === 'inspect' ? {} : { body: JSON.stringify(body) }),
  });
  const observation = await boundedJson(response);
  const inspection = observation.inspection ?? observation;
  if (inspection.runId !== target.runId
    || (provider ? inspection.sourceSha : inspection.sourceCommit) !== target.sourceSha
    || (!provider && (inspection.serviceId !== target.serviceId || inspection.projectId !== target.projectId
      || inspection.environmentId !== target.environmentId || inspection.deploymentId !== target.deploymentId
      || inspection.processKind !== role))) fail();
  const receipt = { target, command, provider, observation };
  return finish(receipt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSelfHealPreviewControl(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(() => {
    console.error('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED'); process.exitCode = 1;
  });
}
