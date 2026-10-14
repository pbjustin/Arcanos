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
  'trinity_consumer', 'trinity_fresh_success', 'trinity_run', 'predictive_evaluate',
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

/** No URL, token, script, SQL or arbitrary payload can be supplied as an argument. */
export async function runSelfHealPreviewControl(argv, env = process.env, options = {}) {
  const role = env.ARCANOS_PROCESS_KIND;
  const profile = resolveSelfHealPreviewProfile(role, env, { now: options.now });
  const target = { role, runId: profile.proofTarget.runId, sourceSha: profile.proofTarget.sourceCommit,
    projectId: profile.proofTarget.projectId, environmentId: profile.proofTarget.environmentId,
    serviceId: profile.proofTarget.serviceId };
  if (argv.length === 1 && argv[0] === 'artifact') {
    return { target, artifact: (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: target.sourceSha }) };
  }
  if (argv.length === 2 && argv[0] === 'fenced-job' && ['create', 'inspect'].includes(argv[1])) {
    const { runSelfHealPreviewFencedJob } = await import('./self-heal-preview-job.mjs');
    return { target, fencedJob: await runSelfHealPreviewFencedJob(argv[1], env, options) };
  }
  let command;
  let provider = false;
  if (argv.length === 1 && argv[0] === 'inspect') command = 'inspect';
  else if (argv.length === 2 && argv[0] === 'command' && SELF_HEAL_PREVIEW_CONTROL_COMMANDS.includes(argv[1])) command = argv[1];
  else if (argv.length === 2 && argv[0] === 'provider' && PROVIDER_COMMANDS.has(argv[1]) && role === 'worker') {
    provider = true; command = argv[1];
  } else fail();
  const body = { command, ...(provider && command === 'timeout_next' ? { count: 1, delayMs: 2_000 }
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
      || inspection.environmentId !== target.environmentId))) fail();
  const receipt = { target, command, provider, observation };
  assertNoPurposeSecrets(receipt, env);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSelfHealPreviewControl(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt))).catch(() => {
    console.error('SELF_HEAL_PREVIEW_CONTROL_CLIENT_FAILED'); process.exitCode = 1;
  });
}
