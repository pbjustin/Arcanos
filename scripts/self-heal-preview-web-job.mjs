/** Ordinary protected web admission and PostgreSQL Worker proof; two closed slots. */
import { createHash } from 'node:crypto';
import { resolveSelfHealPreviewProfile } from './railway-self-heal-preview-profile.mjs';
import { buildBackstageHeavyProbePrompt } from './railway-backstage-heavy-e2e-probe.mjs';
import { BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT } from './railway-backstage-heavy-openai-fixture.mjs';
import { inspectSelfHealPreviewWebJob } from './self-heal-preview-job.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_BYTES = 65_536;
function fail() { throw new Error('SELF_HEAL_PREVIEW_WEB_JOB_FAILED'); }
const digest = value => createHash('sha256').update(value).digest('hex');

async function readJson(response) {
  if (!response.body || !/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) fail();
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength; if (size > MAX_BYTES) fail(); chunks.push(Buffer.from(item.value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
    return body;
  } finally { await reader.cancel().catch(() => undefined); }
}

/** No caller URL, bearer, prompt, SQL, job ID or arbitrary HTTP request is accepted. */
export async function runSelfHealPreviewWebJob(env, options = {}) {
  try {
    if (env.ARCANOS_PROCESS_KIND !== 'web' || ![1, 2].includes(options.attempt)) fail();
    const profile = resolveSelfHealPreviewProfile('web', env, { now: options.now });
    const now = options.now ?? Date.now;
    const deadline = Math.min(now() + 120_000, profile.expiresAtMs);
    const assertLease = () => { if (now() >= deadline) fail(); };
    const baseUrl = `http://127.0.0.1:${env.PORT ?? '8080'}`;
    const traceId = `self-heal-preview:${profile.proofTarget.runId}:web:${options.attempt}`;
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const fetchJson = async (path, request) => {
      assertLease();
      const response = await fetchImpl(`${baseUrl}${path}`, { ...request, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(6_000, deadline - now()))) });
      const body = await readJson(response); assertLease(); return { response, body };
    };
    // Actual read-only ownership/artifact/TLS admission precedes any HTTP write.
    await inspectSelfHealPreviewWebJob(null, env, options); assertLease();
    const body = JSON.stringify({ action: 'generateBooking', executionMode: 'sync', payload: {
      universeId: `fixture-${profile.proofTarget.runId}-web-${options.attempt}`,
      prompt: buildBackstageHeavyProbePrompt(`${profile.proofTarget.runId}-web-${options.attempt}`),
    } });
    const submit = async suffix => {
      const requestId = `${traceId}:${suffix}`;
      const result = await fetchJson('/gpt/backstage-booker', { method: 'POST', body, headers: {
        authorization: `Bearer ${env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN}`,
        'content-type': 'application/json', 'x-request-id': requestId, 'x-trace-id': traceId,
      } });
      if (result.response.status !== 202 || result.response.headers.get('x-gpt-queue-bypassed') !== 'false'
        || result.response.headers.get('x-gpt-route-decision-reason') !== 'backstage_prompt_size'
        || result.response.headers.get('x-request-id') !== requestId || result.response.headers.get('x-trace-id') !== traceId
        || !(result.response.headers.get('cache-control') ?? '').split(',').some(value => value.trim().toLowerCase() === 'no-store')) fail();
      return { ...result, requestId };
    };
    const submissions = await Promise.all([submit('a'), submit('b')]);
    const first = submissions[0].body; const jobId = first.jobId; const token = first.jobReadToken;
    if (!UUID.test(jobId ?? '') || !/^v1\.[A-Za-z0-9_-]{43}$/u.test(token ?? '')
      || !/^derived:[A-Za-z0-9_-]{16,256}$/u.test(first.idempotencyKey ?? '')
      || submissions.some(item => item.body.jobId !== jobId || item.body.jobReadToken !== token
        || item.body.jobReadTokenHeader !== 'x-arcanos-job-read-token' || item.body.poll !== `/jobs/${jobId}/result`
        || item.body.idempotencyKey !== first.idempotencyKey || item.body.idempotencySource !== 'derived'
        || (Object.hasOwn(item.body, 'deduped') && item.body.deduped !== true))
      || submissions.filter(item => item.body.deduped !== true).length > 1) fail();
    const unauthorized = await fetchJson(`/jobs/${jobId}/result`, { method: 'GET' });
    if (unauthorized.response.status !== 200 || unauthorized.body.status !== 'not_found' || unauthorized.body.result !== null) fail();
    let database = null; let terminalObserved = false; let pollCount = 0;
    for (; pollCount < 240; pollCount += 1) {
      const result = await fetchJson(`/jobs/${jobId}/result`, { method: 'GET', headers: { 'x-arcanos-job-read-token': token } });
      if (result.response.status !== 200) fail();
      const terminal = result.body;
      if (terminal.status === 'completed') {
        if (terminal.jobStatus !== 'completed' || terminal.lifecycleStatus !== 'completed' || terminal.error !== null
          || terminal.result?.ok !== true || terminal.result?.result !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT
          || terminal.result?._route?.gptId !== 'backstage-booker' || terminal.result?._route?.action !== 'generateBooking'
          || terminal.result?._route?.traceId !== traceId
          || !submissions.some(item => item.requestId === terminal.result?._route?.requestId)) fail();
        terminalObserved = true;
        database = await inspectSelfHealPreviewWebJob(jobId, env, options);
        if (database.job?.completionVerified === true) break;
      } else if (terminal.status !== 'pending') fail();
      assertLease(); await sleep(Math.min(500, deadline - now()));
    }
    if (!terminalObserved || database?.job?.completionVerified !== true) fail();
    return { sourceSha: profile.proofTarget.sourceCommit, runId: profile.proofTarget.runId,
      webServiceId: profile.proofTarget.serviceId, attempt: options.attempt, correlationId: traceId,
      jobId, pollCount: pollCount + 1, duplicatePrevented: true, unauthorizedResultConcealed: true,
      resultSha256: digest(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT), database,
      consumerPath: 'ordinary-protected-gpt-web-queue-worker-sdk', providerResponses: 'injected-loopback-adapter',
      externalProviderRecoveryProven: false };
  } catch { fail(); }
}
