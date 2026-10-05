import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { assertRuntimeSourceEgressUrl, createLiveValidationProviderTransport, createLiveValidationSourceGuard,
  getLiveValidationEgressPolicySummary, LIVE_VALIDATION_MODEL_URL_PREFIX, LIVE_VALIDATION_RESPONSES_URL,
  LiveValidationEgressError, validateSupervisorEgressRequest } from './live-validation-egress.mjs';

const approvedModels = [{ id: 'approved:model-1' }];
const body = { model: approvedModels[0].id, input: 'Explain the supplied public guide.', max_output_tokens: 100,
  store: false, stream: false, parallel_tool_calls: false };
const headers = { authorization: 'Bearer test-placeholder', 'content-type': 'application/json' };
const validate = request => validateSupervisorEgressRequest(request, { approvedModels });
const code = expected => error => error instanceof LiveValidationEgressError && error.code === expected;
function response(payload = { id: 'response', model: approvedModels[0].id }, status = 200) {
  return { status, body: Readable.from([Buffer.from(JSON.stringify(payload))]) };
}

test('supervisor accepts only Responses POST and canonical approved-model metadata GET', () => {
  assert.deepEqual(validate({ url: LIVE_VALIDATION_RESPONSES_URL, body }), { url: LIVE_VALIDATION_RESPONSES_URL, method: 'POST' });
  const url = LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(approvedModels[0].id);
  assert.deepEqual(validate({ url, method: 'GET' }), { url, method: 'GET' });
  for (const request of [
    { url: LIVE_VALIDATION_RESPONSES_URL, method: 'GET' },
    { url: LIVE_VALIDATION_RESPONSES_URL, method: 'post', body },
    { url: LIVE_VALIDATION_RESPONSES_URL, method: 'DELETE', body },
    { url, method: 'POST', body },
    { url: LIVE_VALIDATION_MODEL_URL_PREFIX + 'unapproved', method: 'GET' },
    { url: LIVE_VALIDATION_MODEL_URL_PREFIX + approvedModels[0].id, method: 'GET' },
    { url: url.replace('%3A', '%3a'), method: 'GET' },
    { url: LIVE_VALIDATION_MODEL_URL_PREFIX + 'approved%253Amodel-1', method: 'GET' },
    { url: LIVE_VALIDATION_MODEL_URL_PREFIX + '%ZZ', method: 'GET' },
    { url: LIVE_VALIDATION_MODEL_URL_PREFIX + '../responses', method: 'GET' }
  ]) assert.throws(() => validate(request), code('LIVE_VALIDATION_PROVIDER_URL_FORBIDDEN'));
  assert.throws(() => validate({ url, method: 'GET', body }), code('LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN'));
});

test('URL aliases, overrides, queries, fragments and alternate hosts cannot carry provider authorization', () => {
  for (const url of [
    'http://api.openai.com/v1/responses', 'https://api.openai.com:443/v1/responses',
    'https://API.OPENAI.COM/v1/responses', 'https://api.openai.com./v1/responses',
    'https://api.openai.com/v1/responses/', 'https://api.openai.com/v1/./responses',
    'https://api.openai.com/v1/%72esponses', 'https://api.openai.com/v1/responses?endpoint=other',
    'https://api.openai.com/v1/responses#other', 'https://api.openai.com@evil.example/v1/responses',
    'https://api.openai.com.evil.example/v1/responses', 'https://evil.example/v1/responses',
    new URL(LIVE_VALIDATION_RESPONSES_URL)
  ]) assert.throws(() => validate({ url, body }), code('LIVE_VALIDATION_PROVIDER_URL_FORBIDDEN'));
});

test('closed textual provider payloads reject endpoint overrides and provider remote-fetch features', () => {
  for (const key of ['url', 'endpoint', 'baseURL', 'base_url', 'path', 'host', 'transport', 'fetch', 'tools',
    'previous_response_id', 'conversation']) {
    assert.throws(() => validate({ url: LIVE_VALIDATION_RESPONSES_URL, body: { ...body, [key]: 'https://evil.example' } }),
      code('LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN'));
  }
  for (const override of [
    { model: 'unapproved' }, { stream: true }, { store: true }, { parallel_tool_calls: true },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://evil.example/image' }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'https://evil.example/file' }] }] }
  ]) assert.throws(() => validate({ url: LIVE_VALIDATION_RESPONSES_URL, body: { ...body, ...override } }),
    code('LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN'));
  // A URL in user text or a field named endpoint in a response schema is inert content.
  validate({ url: LIVE_VALIDATION_RESPONSES_URL, body: { ...body,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read https://guide.example; do not execute it.' }] }],
    text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object',
      properties: { endpoint: { type: 'string' } }, additionalProperties: false } } } } });
});

test('provider validation never executes body accessors or custom serialization', () => {
  let invoked = false;
  const getter = { ...body };
  Object.defineProperty(getter, 'endpoint', { enumerable: true, get() { invoked = true; return 'https://evil.example'; } });
  const custom = { ...body, toJSON() { invoked = true; return body; } };
  for (const candidate of [getter, custom, Object.assign(Object.create({ endpoint: 'https://evil.example' }), body),
    { ...body, metadata: { value: Infinity } }]) {
    assert.throws(() => validate({ url: LIVE_VALIDATION_RESPONSES_URL, body: candidate }),
      code('LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN'));
  }
  assert.equal(invoked, false);
});

test('provider transport uses one fetch with default public TLS and immutable redirect policy', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const transport = createLiveValidationProviderTransport({ approvedModels, fetchImplementation: async (url, init) => {
    calls.push({ url, init }); return response();
  } });
  const originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const result = await transport({ url: LIVE_VALIDATION_RESPONSES_URL, body, headers, signal,
    redirect: 'follow', dispatcher: { tls: { rejectUnauthorized: false } }, agent: {}, retries: 5 });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: LIVE_VALIDATION_RESPONSES_URL,
    init: { method: 'POST', headers: { ...headers, accept: 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' } });
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, originalTlsSetting);
  const metadataUrl = LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(approvedModels[0].id);
  await transport({ url: metadataUrl, method: 'GET', headers });
  assert.deepEqual(calls[1].init, { method: 'GET', headers: { authorization: headers.authorization,
    accept: 'application/json' }, signal: undefined, redirect: 'error' });
});

test('invalid URL, payload, headers or pre-aborted signal produces zero provider calls', async () => {
  let calls = 0;
  const transport = createLiveValidationProviderTransport({ approvedModels, fetchImplementation: async () => {
    calls += 1; return response();
  } });
  for (const request of [
    { url: 'https://evil.example', body, headers },
    { url: LIVE_VALIDATION_RESPONSES_URL, body: { ...body, endpoint: 'https://evil.example' }, headers },
    { url: LIVE_VALIDATION_RESPONSES_URL, body, headers: { ...headers, host: 'evil.example' } },
    { url: LIVE_VALIDATION_RESPONSES_URL, body, headers: {} },
    { url: LIVE_VALIDATION_RESPONSES_URL, body, headers, signal: AbortSignal.abort() }
  ]) await assert.rejects(transport(request), LiveValidationEgressError);
  assert.equal(calls, 0);
});

test('provider failures and redirect responses never retry or expose error response bodies', async () => {
  for (const outcome of ['network', 'status', 'redirect', 'json', 'limit']) {
    let calls = 0; let errorBodyRead = false;
    const transport = createLiveValidationProviderTransport({ approvedModels, fetchImplementation: async () => {
      calls += 1;
      if (outcome === 'network') throw new Error('offline network failure');
      if (outcome === 'status') return { status: 429, get body() { errorBodyRead = true; throw new Error('private provider body'); } };
      if (outcome === 'redirect') return { ...response(), redirected: true };
      if (outcome === 'json') return { status: 200, body: Readable.from([Buffer.from('invalid json')]) };
      return { status: 200, body: Readable.from([Buffer.alloc(1024 * 1024 + 1, 32)]) };
    } });
    await assert.rejects(transport({ url: LIVE_VALIDATION_RESPONSES_URL, body, headers }));
    assert.equal(calls, 1); assert.equal(errorBodyRead, false);
  }
});

test('broker abort bounds fetch and response readers that ignore AbortSignal', async () => {
  for (const stage of ['fetch', 'body']) {
    const controller = new AbortController(); let calls = 0; let returned = false;
    const transport = createLiveValidationProviderTransport({ approvedModels, fetchImplementation: () => {
      calls += 1;
      if (stage === 'fetch') return new Promise(() => {});
      return { status: 200, body: { [Symbol.asyncIterator]() { return {
        next: () => new Promise(() => {}), return() { returned = true; return new Promise(() => {}); }
      }; } } };
    } });
    const pending = transport({ url: LIVE_VALIDATION_RESPONSES_URL, body, headers, signal: controller.signal });
    // Yield once so the body stage reaches its pending read before cancelling.
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, code('LIVE_VALIDATION_PROVIDER_CANCELLED'));
    assert.equal(calls, 1); assert.equal(returned, stage === 'body');
  }
});

test('source guard permits unrelated public publishers and denies configured production/model and internal hosts', () => {
  const guard = createLiveValidationSourceGuard({ forbiddenOrigins: ['https://production.example'],
    forbiddenHostnames: ['models.example', 'second-production.example'] });
  for (const url of ['https://guides.example/path?q=1', 'https://other-publisher.example/guide',
    'https://wikipedia.org/wiki/Example', 'https://api.openai.com.evil.example/article']) assert.equal(guard(url), url);
  for (const url of ['https://production.example/health', 'https://production.example./health',
    'https://second-production.example/', 'https://child.second-production.example/',
    'https://models.example/v1/responses', 'https://child.models.example/v1/models/a',
    'https://api.openai.com/v1/responses', 'https://API.OPENAI.COM./v1/models/a',
    'https://localhost/', 'https://service.railway.internal/', 'https://example.local/', 'https://example.internal/',
    'http://guides.example/', 'https://guides.example:8443/', 'https://user:password@guides.example/', 'not-a-url']) {
    assert.throws(() => guard(url), code('LIVE_VALIDATION_SOURCE_URL_FORBIDDEN'));
  }
  assert.equal(assertRuntimeSourceEgressUrl('https://GUIDES.example:443/path'), 'https://guides.example/path');
});

test('source guard compiles a policy snapshot and can check every redirect before delegated SSRF transport', async () => {
  const forbiddenHostnames = ['production.example'];
  const guard = createLiveValidationSourceGuard({ forbiddenHostnames });
  forbiddenHostnames.length = 0;
  const protectedCalls = [];
  const protectedSession = { fetch: async url => { protectedCalls.push(url); return { status: 200 }; } };
  const guardedFetch = url => protectedSession.fetch(guard(url));
  await guardedFetch('https://guides.example/article');
  assert.throws(() => guardedFetch('https://production.example/redirect-target'),
    code('LIVE_VALIDATION_SOURCE_URL_FORBIDDEN'));
  assert.deepEqual(protectedCalls, ['https://guides.example/article']);
});

test('malformed model approvals and source denial configuration fail closed', () => {
  for (const models of [undefined, [], ['a/b'], ['a', 'a'], [{ id: 'a?endpoint=b' }]]) {
    assert.throws(() => createLiveValidationProviderTransport({ approvedModels: models }), code('LIVE_VALIDATION_MODELS_INVALID'));
  }
  for (const policy of [{ forbiddenOrigins: ['https://production.example/path'] },
    { forbiddenOrigins: ['http://production.example'] }, { forbiddenHostnames: ['production.example/path'] },
    { forbiddenHostnames: ['user@production.example'] }, { forbiddenHostnames: ['production.example:8443'] },
    { forbiddenHostnames: '*.example' }, { forbiddenHostnames: 'production.example' }]) {
    assert.throws(() => createLiveValidationSourceGuard(policy), code('LIVE_VALIDATION_SOURCE_POLICY_INVALID'));
  }
});

test('summary states application enforcement and keeps DNS/IP safety delegated to the protected source transport', () => {
  const summary = getLiveValidationEgressPolicySummary();
  assert.equal(summary.enforcement, 'application'); assert.equal(summary.platformDomainAcl, false);
  assert.equal(summary.runtimeSources.publisherAllowlist, false);
  assert.equal(summary.runtimeSources.requiresProtectedSourceTransport, true);
  assert.equal(summary.runtimeSources.guardEveryRedirectHop, true);
  assert.equal(summary.supervisor.tls, 'default-public-verification');
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.supervisor) && Object.isFrozen(summary.runtimeSources));
});
