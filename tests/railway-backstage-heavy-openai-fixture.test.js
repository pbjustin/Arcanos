import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
  startBackstageHeavyOpenAIFixture,
  startSelfHealPreviewOpenAIFixture,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_READY_SENTINEL,
} from '../scripts/railway-backstage-heavy-openai-fixture.mjs';
import { createOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { normalizeResponsesDraft } from '../src/services/openai/requestBuilders/normalize.js';
import { resolveGenerativeModel } from '../src/services/openai/credentialProvider.js';
import { createSingleChatCompletion, ensureModelMatchesExpectation } from '../src/services/openai/chatFallbacks.js';
import { TRINITY_STRUCTURED_REASONING_SCHEMA } from '../src/core/logic/trinitySchema.js';

describe('credential-free Backstage heavy OpenAI fixture', () => {
  const runId = 'proof-run-1460';
  let runtime;
  let previousAuthority;

  beforeEach(() => {
    previousAuthority = process.env.FINETUNED_MODEL_ID;
    process.env.FINETUNED_MODEL_ID = BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID;
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    if (previousAuthority === undefined) delete process.env.FINETUNED_MODEL_ID;
    else process.env.FINETUNED_MODEL_ID = previousAuthority;
  });

  function buildRequest(systemText, options = {}) {
    const directive = options.omitDirective
      ? 'Generate five rewritten booking notes'
      : BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE;
    const userPrompt = [
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
      `Run ${runId}.`,
      `${directive} for a complete fictional event.`,
      'Keep every detail invented. '.repeat(60),
    ].join(' ');
    const normalized = normalizeResponsesDraft({
      model: resolveGenerativeModel('final'),
      prompt: userPrompt,
      preparedMessages: [
        { role: 'system', content: systemText },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      includeRoutingMessage: false,
      maxTokens: BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
      temperature: 0,
      top_p: 1,
      store: false,
    });
    return {
      model: normalized.model,
      input: normalized.input,
      max_output_tokens: normalized.maxOutputTokens,
      store: false,
    };
  }

  it('accepts the production Responses wire shape and enforces one fresh compact retry', async () => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0,
      firstResponseDelayMs: 0,
      expectedRunId: runId,
    });
    const address = runtime.server.address();
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const client = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL,
      maxRetries: 0,
    }).getClient();

    const models = await client.models.list({ page: 1 });
    expect(models.data.map(candidate => candidate.id)).toEqual([
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
    ]);
    const first = await client.responses.create(
      buildRequest('Fictional policy without a recovery directive.')
    );
    expect(first.status).toBe('incomplete');
    expect(ensureModelMatchesExpectation(first, resolveGenerativeModel('final')))
      .toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID);
    expect(first.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(first.output_text).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT);

    const second = await client.responses.create(buildRequest(
      `Fictional policy. ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER}`
    ));
    expect(second.status).toBe('completed');
    expect(ensureModelMatchesExpectation(second, resolveGenerativeModel('final-escalation')))
      .toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID);
    expect(second.output_text).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);

    const attestationResponse = await fetch(
      `http://127.0.0.1:${address.port}${BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH}`,
      {
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
        },
      }
    );
    await expect(attestationResponse.json()).resolves.toMatchObject({
      responsePhase: 'second_complete',
      modelsListCalls: 1,
      responsesCalls: 2,
      firstResponseIncomplete: true,
      secondResponseCompleted: true,
      firstRecoveryMarkerAbsent: true,
      secondRecoveryMarkerObserved: true,
      secondRequestExcludedPartialOutput: true,
      promptSentinelObserved: true,
      bookingDirectiveObserved: true,
      runMarkerObserved: true,
      thirdResponseRejected: 0,
      unknownRequests: 0,
      authorizationFailures: 0,
      invalidRequests: 0,
    });

    await expect(client.responses.create(buildRequest(
      `Fictional policy. ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER}`
    ))).rejects.toMatchObject({ status: 422 });
    expect(runtime.state.thirdResponseRejected).toBe(1);
  });

  it('rejects concurrent phase advancement, partial-output continuation, and unapproved model queries', async () => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0,
      firstResponseDelayMs: 40,
      expectedRunId: runId,
    });
    const address = runtime.server.address();
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const client = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL,
      maxRetries: 0,
    }).getClient();
    await client.models.list({ page: 1 });
    await expect(client.responses.create(buildRequest(
      'Fictional invalid directive policy.',
      { omitDirective: true }
    ))).rejects.toMatchObject({ status: 422 });
    const firstPromise = client.responses.create(
      buildRequest('Fictional first-call policy.')
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(client.responses.create(buildRequest(
      `Fictional policy. ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER}`
    ))).rejects.toMatchObject({ status: 422 });
    await firstPromise;

    await expect(client.responses.create(buildRequest(
      `${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER} ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT}`
    ))).rejects.toMatchObject({ status: 422 });

    const invalidModels = await fetch(
      `http://127.0.0.1:${address.port}/v1/models?page=2`,
      {
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
        },
      }
    );
    expect(invalidModels.status).toBe(404);
    await expect(client.models.retrieve(
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID
    )).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    'gpt-5.1', 'gpt-6-luna', 'gpt-6.1-sol', 'ft:synthetic:other-authority',
    BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID.toUpperCase(),
    `${BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID}-other`, undefined,
  ])('rejects provider request model %s without advancing the guarded response phase', async model => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0, firstResponseDelayMs: 0, expectedRunId: runId,
    });
    const address = runtime.server.address();
    const client = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0,
    }).getClient();
    await client.models.list({ page: 1 });
    const request = { ...buildRequest('Fictional model boundary policy.'), model };
    if (model === undefined) {
      // The adapter rejects missing models before transport; the fixture rejects raw wire omissions too.
      await expect(client.responses.create(request)).rejects.toThrow(/non-empty model/);
      expect(runtime.state.invalidRequests).toBe(0);
      const rejected = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      expect(rejected.status).toBe(422);
    } else {
      await expect(client.responses.create(request)).rejects.toMatchObject({ status: 422 });
    }
    expect(runtime.state.responsesCalls).toBe(0);
    expect(runtime.state.responsePhase).toBe('idle');
    expect(runtime.state.invalidRequests).toBe(1);
    expect(() => ensureModelMatchesExpectation({ model }, resolveGenerativeModel('final')))
      .toThrow(/model/);
  });

  it('keeps the exact finite output cap when the model is the configured synthetic authority', async () => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0, firstResponseDelayMs: 0, expectedRunId: runId,
    });
    const address = runtime.server.address();
    const client = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0,
    }).getClient();
    await client.models.list({ page: 1 });
    for (const max_output_tokens of [2400, 6001, 8000, Number.MAX_SAFE_INTEGER]) {
      await expect(client.responses.create({
        ...buildRequest('Fictional bounded output policy.'), max_output_tokens,
      })).rejects.toMatchObject({ status: 422 });
    }
    expect(runtime.state.responsesCalls).toBe(0);
    expect(runtime.state.responsePhase).toBe('idle');
    expect(runtime.state.invalidRequests).toBe(4);
  });

  it.each([
    'gpt-6-luna', 'gpt-6.1-sol', 'ft:synthetic:other-authority',
    BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID.toUpperCase(),
  ])('rejects provider-reported identity %s through the real central final call', async model => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0, firstResponseDelayMs: 0, expectedRunId: runId,
    });
    const address = runtime.server.address();
    const sentPayloads = [];
    const adapter = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0,
      fetch: async (input, init) => {
        const upstream = await fetch(input, init);
        if (String(input).endsWith('/responses')) {
          sentPayloads.push(JSON.parse(String(init.body)));
          const wireResponse = await upstream.json();
          return new Response(JSON.stringify({ ...wireResponse, model }), {
            status: upstream.status, headers: upstream.headers,
          });
        }
        return upstream;
      },
    });
    await adapter.getClient().models.list({ page: 1 });
    const request = buildRequest('Fictional final authority policy.');
    await expect(createSingleChatCompletion(adapter, {
      messages: request.input.map(item => ({
        role: item.role, content: item.content.map(part => part.text).join('\n'),
      })),
      max_tokens: BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
      maxRetries: 0,
    })).rejects.toThrow(/unexpected model/);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].model).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID);
    expect(sentPayloads[0].max_output_tokens).toBe(6000);
    expect(runtime.state.responsesCalls).toBe(1);
    expect(runtime.state.invalidRequests).toBe(0);
  });
});

describe('bounded self-healing preview provider profile', () => {
  const token = 'a'.repeat(64);
  const promptSentinel = 'PRIVATE_REQUEST_MUST_NEVER_BE_REFLECTED';
  let runtime;
  const childEnv = (changes = {}) => ({
    NODE_ENV: 'production', TZ: 'UTC',
    ARCANOS_BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD: 'v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'self-heal-run-1544',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'b'.repeat(40),
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1',
    ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'self-heal-run-1544',
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(Date.now() - 1000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: token,
    ...changes,
  });
  const endpoint = () => `http://127.0.0.1:${runtime.server.address().port}`;
  async function control(body, credential = token) {
    const response = await fetch(`${endpoint()}${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${credential}`,
        'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    return { status: response.status, json: async () => result };
  }
  const client = (extra = {}) => createOpenAIAdapter({
    apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
    baseURL: `${endpoint()}/v1`, maxRetries: 0, ...extra,
  }).getClient();
  const responseBody = (extra = {}) => ({
    model: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
    input: promptSentinel, ...extra,
  });
  const waitForActive = async () => {
    const deadline = Date.now() + 1000;
    while (!runtime.state.inFlight && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(runtime.state.inFlight).not.toBeNull();
  };

  afterEach(async () => { await runtime?.close(); runtime = undefined; });

  it.each([
    { OPENAI_API_KEY: 'forbidden' }, { RAILWAY_TOKEN: 'forbidden' },
    { DATABASE_URL: 'forbidden' }, { NODE_OPTIONS: '--import forbidden' },
    { ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'other' },
    { ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: 'A'.repeat(64) },
    { ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'different-run-1544' },
    { ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'invalid' },
    { ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(Date.now() + 600_000).toISOString() },
    { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(0).toISOString() },
    { ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(Date.now() + 7_200_001).toISOString() },
  ])('rejects an invalid or credential-bearing literal child environment %p', async changes => {
    await expect(startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv(changes) }))
      .rejects.toThrow('SELF_HEAL_PREVIEW_OPENAI_CHILD_CONTRACT_INVALID');
  });

  it('rejects non-loopback listeners before starting', async () => {
    await expect(startSelfHealPreviewOpenAIFixture({ host: '0.0.0.0', env: childEnv() }))
      .rejects.toThrow('SELF_HEAL_PREVIEW_OPENAI_LISTEN_TARGET_INVALID');
  });

  it('accepts actual SDK model, Responses, chat, and Trinity structured response decoding', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const sdk = client();
    expect((await sdk.models.list()).data[0].id).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID);
    const response = await sdk.responses.create(responseBody());
    expect(response.status).toBe('completed');
    expect(response.output_text).toContain('Synthetic preview provider');
    expect(response._request_id).toBe('self-heal-fixture-2');
    const completion = await sdk.chat.completions.create({
      model: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
      messages: [{ role: 'user', content: promptSentinel }],
    });
    expect(completion.choices[0].finish_reason).toBe('stop');
    const structured = await sdk.responses.parse(responseBody({ text: { format: {
      type: 'json_schema', ...TRINITY_STRUCTURED_REASONING_SCHEMA,
    } } }));
    expect(structured.output_parsed).toMatchObject({ response_mode: 'answer',
      reasoning_steps: [], final_answer: expect.stringContaining('Synthetic') });
    const receipt = await (await control({ command: 'inspect' })).json();
    expect(receipt).toMatchObject({ providerRequests: 4, completed: 4, inFlight: null });
    expect(receipt.receipts).toHaveLength(4);
    expect(receipt.receipts.every(item => item.outcome === 'completed'
      && item.endedAt >= item.startedAt)).toBe(true);
    expect(JSON.stringify([response, completion, structured, receipt]))
      .not.toContain(promptSentinel);
    expect(JSON.stringify(receipt)).not.toContain(token);
  });

  it('authenticates controls before reading a body and separates provider authority', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const early = await new Promise((resolve, reject) => {
      const request = httpRequest(`${endpoint()}${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH}`, {
        method: 'POST', headers: { 'content-length': 1_000_000,
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}` },
      }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.flushHeaders();
    });
    expect(early).toBe(401);
    expect(runtime.state.controlRequests).toBe(0);
    const provider = await fetch(`${endpoint()}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(provider.status).toBe(401);
    expect(runtime.state.providerRequests).toBe(0);
    expect((await control({ command: 'timeout_next', count: 1, delayMs: 10 }, 'wrong')).status)
      .toBe(401);
    expect(runtime.state.nextFault).toBeNull();
  });

  it('observes bounded timeout effects, then independently observes provider recovery', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    expect((await control({ command: 'timeout_next', count: 2, delayMs: 5 })).status).toBe(200);
    const sdk = client();
    for (let count = 0; count < 2; count += 1) {
      await expect(sdk.responses.create(responseBody())).rejects.toMatchObject({ status: 504 });
    }
    expect((await control({ command: 'set_healthy' })).status).toBe(200);
    await expect(sdk.responses.create(responseBody())).resolves.toMatchObject({ status: 'completed' });
    const receipt = await (await control({ command: 'inspect' })).json();
    expect(receipt).toMatchObject({ timedOut: 2, completed: 1, nextFault: null });
    expect(receipt.receipts.map(item => item.outcome)).toEqual(['timeout', 'timeout', 'completed']);
    expect(receipt.receipts.map(item => item.requestId)).toEqual([
      'self-heal-fixture-1', 'self-heal-fixture-2', 'self-heal-fixture-3',
    ]);
  });

  it('bounds concurrent faults, releases a held request, and rejects replacement while active', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    await control({ command: 'hold_next', delayMs: 1000 });
    const held = client().responses.create(responseBody()).then(value => value);
    await waitForActive();
    await expect(client().responses.create(responseBody())).rejects.toMatchObject({ status: 429 });
    expect((await control({ command: 'timeout_next', count: 1, delayMs: 5 })).status).toBe(409);
    expect((await control({ command: 'release' })).status).toBe(200);
    await expect(held).resolves.toMatchObject({ status: 'completed' });
    expect(runtime.inspect()).toMatchObject({ providerRequests: 1, completed: 1,
      inFlight: null, timedOut: 0, rejected: 1 });
  });

  it('records client timeout independently and clears its hold for subsequent consumers', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    await control({ command: 'hold_next', delayMs: 1000 });
    await expect(client({ timeout: 30 }).responses.create(responseBody())).rejects.toThrow();
    const deadline = Date.now() + 1000;
    while (runtime.state.inFlight && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(runtime.inspect()).toMatchObject({ clientClosed: 1, completed: 0, inFlight: null });
    await expect(client().responses.create(responseBody())).resolves.toMatchObject({ status: 'completed' });
  });

  it.each([
    { command: 'timeout_next', count: 0, delayMs: 1 },
    { command: 'timeout_next', count: 5, delayMs: 1 },
    { command: 'timeout_next', count: 1, delayMs: 5001 },
    { command: 'hold_next', delayMs: 0 },
    { command: 'inspect', extra: true }, { command: 'restart_production' },
  ])('rejects an unbounded or unknown control without effects %p', async body => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    expect((await control(body)).status).toBe(422);
    expect(runtime.inspect()).toMatchObject({ providerRequests: 0, nextFault: null });
  });

  it('enforces body limits, closed wire contracts, and fixed nonreflective rejection', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    expect((await control({ command: 'inspect', padding: 'x'.repeat(1024) })).status).toBe(413);
    const sdk = client();
    await expect(sdk.responses.create(responseBody({ input: 'x'.repeat(128 * 1024) })))
      .rejects.toMatchObject({ status: 413 });
    await expect(sdk.responses.create(responseBody({ stream: true })))
      .rejects.toMatchObject({ status: 422 });
    await expect(sdk.responses.create(responseBody({ model: promptSentinel })))
      .rejects.toMatchObject({ status: 422 });
    expect(runtime.inspect()).toMatchObject({ completed: 0, inFlight: null });
    expect(JSON.stringify(runtime.inspect())).not.toContain(promptSentinel);
  });

  it('caps provider and control request counts while keeping receipts bounded', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const sdk = client();
    for (let count = 0; count < SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxProviderRequests; count += 1) {
      await sdk.models.list();
    }
    await expect(sdk.models.list()).rejects.toMatchObject({ status: 429 });
    for (let count = 0; count < SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxControlRequests; count += 1) {
      expect((await control({ command: 'inspect' })).status).toBe(200);
    }
    expect((await control({ command: 'inspect' })).status).toBe(429);
    expect(runtime.state.receipts).toHaveLength(128);
  });

  it('times out an incomplete authenticated body and rejects its subsequent effect', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${endpoint()}${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'content-length': 100 },
      }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.write('{"command":"timeout_next"');
    });
    expect(status).toBe(408);
    expect(runtime.inspect()).toMatchObject({ providerRequests: 0, nextFault: null });
  });

  it('runs the exact CLI child contract and exits automatically at the bounded expiry', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(
      '../scripts/railway-backstage-heavy-openai-fixture.mjs', import.meta.url
    )), SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT], { env: childEnv({
      ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(Date.now() + 2000).toISOString(),
    }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill(); reject(new Error('preview fixture child did not expire'));
      }, 5000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', code => { clearTimeout(deadline); resolve(code); });
    });
    expect(errors).toBe('');
    expect(result).toBe(0);
    expect(output).toBe(`${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_READY_SENTINEL}\n`);
    expect(output).not.toContain(token);
  });

  it('expires and drains a held provider operation without a late completion', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv({
      ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(Date.now() + 500).toISOString(),
    }) });
    const address = runtime.server.address();
    await control({ command: 'hold_next', delayMs: 1000 });
    await expect(client().responses.create(responseBody())).rejects.toMatchObject({ status: 503 });
    await runtime.close();
    expect(runtime.inspect()).toMatchObject({ expired: true, ready: false,
      completed: 0, inFlight: null });
    expect(runtime.state.receipts[0].outcome).toBe('shutdown');
    await expect(fetch(`http://127.0.0.1:${address.port}/v1/models`)).rejects.toThrow();
  });
});
