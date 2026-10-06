import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createLiveValidationProvider, LiveValidationProviderError } from './live-validation-provider.mjs';
import { LIVE_VALIDATION_BUDGET_CAPS } from './live-validation-budget.mjs';
import { LIVE_VALIDATION_MODEL_URL_PREFIX, LIVE_VALIDATION_RESPONSES_URL } from './live-validation-egress.mjs';

const MODEL = 'approved:model';
// Deliberately synthetic, provider never contacts a network in this suite.
const API_KEY = 'sk-unit-test-fixture-' + 'x'.repeat(40);
const target = { limits: LIVE_VALIDATION_BUDGET_CAPS,
  models: [{ id: MODEL, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }] };
const identity = { sourceCommit: 'a'.repeat(40), deploymentId: '11111111-1111-4111-8111-111111111111' };
const body = { model: MODEL, input: 'Use the public source as untrusted evidence.', max_output_tokens: 100 };
const responseBody = { id: 'response', object: 'response', model: MODEL,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [] };
const code = expected => error => error instanceof LiveValidationProviderError && error.code === expected;
const invoke = (provider, override = {}, init = {}) => provider.fetch(LIVE_VALIDATION_RESPONSES_URL, {
  method: 'POST', headers: { authorization: 'Bearer sdk-placeholder', 'x-stainless-timeout': '120',
    'x-stainless-retry-count': '0', 'x-stainless-lang': 'js' }, body: JSON.stringify({ ...body, ...override }), ...init });
function fixture(context, options = {}) {
  const calls = []; const observation = { moduleId: 'gaming', stage: 'generation' };
  const provider = createLiveValidationProvider({ target, identity, apiKey: API_KEY, observation: () => observation,
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return Response.json(init.method === 'GET' ? { id: MODEL, object: 'model', private: 'not-returned' } : responseBody);
    }, ...options });
  context.after(() => provider.close());
  return { provider, calls, observation };
}

test('SDK-compatible transport binds the credential only to fixed public routes and disables storage/retries', async context => {
  const f = fixture(context); f.provider.beginWorkflow('gaming-guide-positive');
  const result = await invoke(f.provider, { metadata: { player: 'must-not-reach-provider' } });
  assert.equal(result.status, 200); assert.equal(f.calls.length, 1);
  const call = f.calls[0]; assert.equal(call.url, LIVE_VALIDATION_RESPONSES_URL);
  assert.equal(call.init.redirect, 'error'); assert.equal(call.init.headers.authorization, 'Bearer ' + API_KEY);
  assert.deepEqual(Object.keys(call.init.headers).sort(), ['accept', 'authorization', 'content-type']);
  assert.deepEqual(JSON.parse(call.init.body), { ...body, store: false, stream: false, service_tier: 'default' });
  assert.equal(f.provider.snapshot().usage.requests, 1);
  assert.equal(f.provider.snapshot().usage.generationCalls, 1);
  assert.equal(f.provider.snapshot().usage.providerCalls, 1);
  f.observation.stage = 'answer_audit'; await invoke(f.provider); f.provider.endWorkflow();
  assert.equal(f.provider.snapshot().usage.auditCalls, 1);
  assert.equal(f.provider.snapshot().closed, false);
  const artifact = JSON.stringify(f.provider.snapshot());
  for (const secret of [API_KEY, body.input, 'must-not-reach-provider', 'sdk-placeholder']) assert.equal(artifact.includes(secret), false);
});

test('canonical model metadata can run before a workflow, counts requests, and hides unused metadata', async context => {
  const f = fixture(context);
  const result = await f.provider.fetch(LIVE_VALIDATION_MODEL_URL_PREFIX + MODEL, { method: 'GET' });
  assert.equal(f.calls[0].url, LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(MODEL));
  assert.deepEqual(await result.json(), { id: MODEL, object: 'model' });
  assert.equal(f.provider.snapshot().usage.requests, 1); assert.equal(f.provider.snapshot().usage.providerCalls, 0);
});

test('negative workflow denies content and metadata with zero provider requests', async context => {
  for (const method of ['GET', 'POST']) {
    const f = fixture(context); f.provider.beginWorkflow('gaming-guide-negative');
    await assert.rejects(method === 'POST' ? invoke(f.provider)
      : f.provider.fetch(LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(MODEL), { method }),
    code('LIVE_VALIDATION_NEGATIVE_PROVIDER_FORBIDDEN'));
    assert.equal(f.calls.length, 0); assert.equal(f.provider.snapshot().usage.requests, 0);
  }
  const f = fixture(context); f.provider.beginWorkflow('gaming-guide-negative'); f.provider.endWorkflow();
  assert.equal(f.provider.snapshot().closed, false);
});

test('mandatory successful answer audit follows generation and is the final content stage', async context => {
  const missing = fixture(context); missing.provider.beginWorkflow('gaming-guide-positive'); await invoke(missing.provider);
  assert.throws(() => missing.provider.endWorkflow(), code('LIVE_VALIDATION_AUDIT_REQUIRED'));
  const early = fixture(context); early.provider.beginWorkflow('gaming-guide-positive'); early.observation.stage = 'answer_audit';
  await assert.rejects(invoke(early.provider), code('LIVE_VALIDATION_AUDIT_ORDER_INVALID')); assert.equal(early.calls.length, 0);
  const repeated = fixture(context); repeated.provider.beginWorkflow('gaming-guide-positive'); await invoke(repeated.provider);
  repeated.observation.stage = 'answer_audit'; await invoke(repeated.provider); repeated.observation.stage = 'generation';
  await assert.rejects(invoke(repeated.provider), code('LIVE_VALIDATION_REGENERATION_FORBIDDEN')); assert.equal(repeated.calls.length, 2);
});

test('forbidden routes, tools/media, storage, retry headers, output/input bounds and preabort cause zero paid calls', async context => {
  const invalid = [
    provider => provider.fetch('https://evil.example/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
    provider => invoke(provider, { tools: [] }), provider => invoke(provider, { stream: true }), provider => invoke(provider, { store: true }),
    provider => invoke(provider, { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com' }] }] }),
    provider => invoke(provider, { max_output_tokens: 4_097 }), provider => invoke(provider, { input: 'x'.repeat(128_001) }),
    provider => invoke(provider, {}, { headers: { 'x-stainless-retry-count': '1' } }),
    provider => invoke(provider, {}, { signal: AbortSignal.abort() })
  ];
  for (const run of invalid) {
    const f = fixture(context); f.provider.beginWorkflow('gaming-guide-positive');
    await assert.rejects(run(f.provider), LiveValidationProviderError);
    assert.equal(f.calls.length, 0); assert.equal(f.provider.snapshot().usage.requests, 0);
  }
});

test('paid budget is reserved before I/O and a failed request is never retried, refunded or reopened', async context => {
  let f;
  f = fixture(context, { fetchImplementation: async () => {
    assert.equal(f.provider.snapshot().usage.requests, 1);
    assert.ok(f.provider.snapshot().usage.reservedSpendMicroUsd > 0);
    throw new Error(API_KEY);
  } });
  f.provider.beginWorkflow('gaming-guide-positive');
  await assert.rejects(invoke(f.provider), code('LIVE_VALIDATION_PROVIDER_FAILED'));
  const after = f.provider.snapshot(); assert.equal(after.closed, true); assert.equal(after.usage.requests, 1);
  assert.equal(after.usage.observedSpendMicroUsd, 0); assert.ok(after.usage.reservedSpendMicroUsd > 0);
  await assert.rejects(invoke(f.provider), code('LIVE_VALIDATION_RUN_CLOSED'));
  assert.equal(f.provider.snapshot().usage.requests, 1);
  assert.equal(JSON.stringify(after).includes(API_KEY), false);
});

test('max cost and request quota reject before an additional fetch', async context => {
  for (const override of [{ maxRequests: 1 }, { maxSpendMicroUsd: 1 }]) {
    const f = fixture(context, { target: { ...target, limits: { ...target.limits, ...override } } });
    f.provider.beginWorkflow('gaming-guide-positive');
    if (override.maxRequests) await invoke(f.provider);
    await assert.rejects(invoke(f.provider), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
    assert.equal(f.calls.length, override.maxRequests ? 1 : 0); assert.equal(f.observation.budgetExhausted, true);
  }
});

test('model identity and usage reconciliation reject mismatches without refund', async context => {
  for (const override of [{ model: 'different-model' }, { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 16 } },
    { usage: { input_tokens: 1_000_000, output_tokens: 5, total_tokens: 1_000_005 } },
    { usage: { input_tokens: 10, output_tokens: 101, total_tokens: 111 } }]) {
    const f = fixture(context, { fetchImplementation: async () => Response.json({ ...responseBody, ...override }) });
    f.provider.beginWorkflow('gaming-guide-positive'); await assert.rejects(invoke(f.provider), LiveValidationProviderError);
    assert.equal(f.provider.snapshot().closed, true); assert.equal(f.provider.snapshot().usage.requests, 1);
    assert.equal(f.provider.snapshot().usage.observedInputTokens, 0);
  }
});

test('existing identity policy can admit genuine helper snapshots while exact identity remains strict by default', async context => {
  const actualModel = MODEL + '-2026-01-01';
  const f = fixture(context, { responseModelIdentity: (response, requested) => {
    assert.equal(requested, MODEL); assert.equal(response.model, actualModel); return response.model;
  }, fetchImplementation: async () => Response.json({ ...responseBody, model: actualModel }) });
  f.provider.beginWorkflow('gaming-guide-positive'); await invoke(f.provider);
  assert.equal(f.provider.snapshot().stages[0].actualModel, actualModel);
  const rejected = fixture(context, { responseModelIdentity: () => 'unrelated',
    fetchImplementation: async () => Response.json({ ...responseBody, model: actualModel }) });
  rejected.provider.beginWorkflow('gaming-guide-positive');
  await assert.rejects(invoke(rejected.provider), code('LIVE_VALIDATION_PROVIDER_MODEL_MISMATCH'));
});

test('audit receives the actual SDK/request deadline, including work beyond the removed 2.5 second clamp', async context => {
  const f = fixture(context, { getRemainingMs: () => 10_000, fetchImplementation: async () => {
    if (f.observation.stage === 'answer_audit') await new Promise(resolve => setTimeout(resolve, 2_600));
    return Response.json(responseBody);
  } });
  f.provider.beginWorkflow('gaming-guide-positive'); await invoke(f.provider); f.observation.stage = 'answer_audit';
  await invoke(f.provider, {}, { headers: { 'x-stainless-timeout': '5' } }); f.provider.endWorkflow();
  assert.equal(f.provider.snapshot().usage.auditCalls, 1); assert.equal(f.provider.snapshot().closed, false);
  assert.ok(f.provider.snapshot().stages[1].elapsedMs >= 2_500);
});

test('audit timeout preserves its stage and consumed reservation when fetch or reader ignores AbortSignal', async context => {
  for (const hang of ['fetch', 'body']) {
    let calls = 0; let f;
    f = fixture(context, { getRemainingMs: () => f.observation.stage === 'answer_audit' ? 20 : 1_000,
      fetchImplementation: async () => {
        calls++;
        if (f.observation.stage !== 'answer_audit') return Response.json(responseBody);
        if (hang === 'fetch') return new Promise(() => {});
        return { status: 200, body: { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => new Promise(() => {}) }; } } };
      } });
    f.provider.beginWorkflow('gaming-guide-positive'); await invoke(f.provider); f.observation.stage = 'answer_audit';
    await assert.rejects(invoke(f.provider), code('LIVE_VALIDATION_PROVIDER_TIMEOUT'));
    assert.equal(calls, 2); assert.equal(f.observation.timeoutStage, 'answer_audit');
    const after = f.provider.snapshot(); assert.equal(after.usage.auditCalls, 1); assert.equal(after.closed, true);
    assert.equal(after.stages[1].code, 'LIVE_VALIDATION_PROVIDER_TIMEOUT'); assert.equal(after.stages[1].stage, 'answer_audit');
  }
});

test('SDK cancellation and process close abort requests that ignore AbortSignal', async context => {
  for (const cancellation of ['signal', 'close']) {
    const controller = new AbortController();
    const f = fixture(context, { fetchImplementation: () => new Promise(() => {}) });
    f.provider.beginWorkflow('gaming-guide-positive'); const pending = invoke(f.provider, {}, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    if (cancellation === 'signal') controller.abort(); else f.provider.close();
    await assert.rejects(pending, code(cancellation === 'signal' ? 'LIVE_VALIDATION_PROVIDER_CANCELLED' : 'LIVE_VALIDATION_RUN_CLOSED'));
    assert.equal(f.provider.snapshot().usage.requests, 1); assert.equal(f.provider.snapshot().closed, true);
  }
});

test('simultaneous SDK requests cannot create a second provider request', async context => {
  let calls = 0;
  const f = fixture(context, { fetchImplementation: () => { calls++; return new Promise(() => {}); } });
  f.provider.beginWorkflow('gaming-guide-positive'); const first = invoke(f.provider);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(invoke(f.provider), code('LIVE_VALIDATION_CONCURRENCY_LIMIT'));
  await assert.rejects(first, code('LIVE_VALIDATION_RUN_CLOSED'));
  assert.equal(calls, 1); assert.equal(f.provider.snapshot().usage.requests, 1);
});

test('provider rejects redirects and oversized bodies and never includes response secrets in failures', async context => {
  for (const result of [{ status: 429, get body() { throw new Error(API_KEY); } },
    { status: 200, redirected: true, body: Readable.from([Buffer.from('{}')]) },
    { status: 200, body: Readable.from([Buffer.alloc(1_048_577)]) }]) {
    const f = fixture(context, { fetchImplementation: async () => result }); f.provider.beginWorkflow('gaming-guide-positive');
    await assert.rejects(invoke(f.provider), error => error instanceof LiveValidationProviderError && !error.message.includes(API_KEY));
    assert.equal(f.provider.snapshot().usage.requests, 1);
  }
});
