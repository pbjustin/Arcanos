import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStructuredJson } from '@arcanos/openai';

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
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_READY_SENTINEL,
  SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS,
} from '../scripts/railway-backstage-heavy-openai-fixture.mjs';
import { createOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { normalizeResponsesDraft } from '../src/services/openai/requestBuilders/normalize.js';
import { resolveGenerativeModel } from '../src/services/openai/credentialProvider.js';
import { createSingleChatCompletion, ensureModelMatchesExpectation } from '../src/services/openai/chatFallbacks.js';
import { TRINITY_COMPACT_STRUCTURED_REASONING_SCHEMA,
  TRINITY_STRUCTURED_REASONING_SCHEMA } from '../src/core/logic/trinitySchema.js';
import { buildBackstageHeavyProbePrompt } from '../scripts/railway-backstage-heavy-e2e-probe.mjs';
import { assertBackstageBookerFinalCompactOutputValid,
  resolveBackstageCompactOutputContract } from '../src/shared/backstage/backstageCompactOutputContract.js';

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
    apiKey: SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY,
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

  it('separates the normal-startup self-heal SDK key from the legacy profile', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const normalStartupKey = 'sk-arcanos-self-heal-preview-protocol-v1';
    const sdk = client({ apiKey: normalStartupKey });
    await expect(sdk.models.list()).resolves.toMatchObject({ object: 'list' });
    const legacyKeyResponse = await fetch(`${endpoint()}/v1/models`, {
      headers: { authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}` },
    });
    expect(legacyKeyResponse.status).toBe(401);
    expect(runtime.inspect()).toMatchObject({ providerRequests: 1, rejected: 1 });

    const legacy = await startBackstageHeavyOpenAIFixture({
      port: 0, firstResponseDelayMs: 0, expectedRunId: 'legacy-key-profile-1544',
    });
    try {
      const legacyBaseURL = `http://127.0.0.1:${legacy.server.address().port}/v1`;
      const wrongProfile = createOpenAIAdapter({ apiKey: normalStartupKey,
        baseURL: legacyBaseURL, maxRetries: 0 }).getClient();
      await expect(wrongProfile.models.list()).rejects.toMatchObject({ status: 401 });
      const legacyClient = createOpenAIAdapter({ apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
        baseURL: legacyBaseURL, maxRetries: 0 }).getClient();
      await expect(legacyClient.models.list()).resolves.toMatchObject({ object: 'list' });
    } finally { await legacy.close(); }
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
    const structured = await sdk.responses.create(responseBody({ text: { format: {
      type: 'json_schema', ...TRINITY_STRUCTURED_REASONING_SCHEMA,
    } } }));
    expect(parseStructuredJson(structured)).toMatchObject({ response_mode: 'answer',
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

  it('admits exactly the fixed Trinity models and preserves each requested model identity', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const sdk = client();
    expect(SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS).toEqual([
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID, 'gpt-6.1-sol', 'gpt-6-luna',
    ]);
    expect((await sdk.models.list()).data.map(model => model.id))
      .toEqual(SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS);
    for (const model of SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS) {
      await expect(sdk.responses.create(responseBody({ model })))
        .resolves.toMatchObject({ model, status: 'completed' });
      await expect(sdk.chat.completions.create({ model,
        messages: [{ role: 'user', content: promptSentinel }] }))
        .resolves.toMatchObject({ model });
    }
    for (const model of ['gpt-6.1-sol-unapproved', 'gpt-6-sol', promptSentinel]) {
      await expect(sdk.responses.create(responseBody({ model })))
        .rejects.toMatchObject({ status: 422 });
    }
    const receipt = runtime.inspect();
    expect(receipt.receipts.slice(1, 7).map(item => [item.model, item.purpose]))
      .toEqual(SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS.flatMap(model => [
        [model, 'synthetic-completion'], [model, 'synthetic-completion'],
      ]));
    expect(receipt.receipts.slice(7).every(item => item.model === undefined)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(promptSentinel);
  });

  it.each([1, 2])('completes current run Web attempt %s through the actual Responses SDK and Backstage validator', async attempt => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const prompt = buildBackstageHeavyProbePrompt(`self-heal-run-1544-web-${attempt}`);
    const normalized = normalizeResponsesDraft({
      model: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
      prompt,
      preparedMessages: [
        { role: 'system', content: 'Complete the isolated fictional booking request.' },
        { role: 'user', content: prompt },
      ],
      includeRoutingMessage: false,
      maxTokens: BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
      temperature: 0, top_p: 1, store: false,
    });
    const response = await client().responses.create({
      model: normalized.model, input: normalized.input,
      max_output_tokens: normalized.maxOutputTokens, store: false,
    });
    expect(response.status).toBe('completed');
    expect(response.output_text).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);
    const contract = resolveBackstageCompactOutputContract(prompt, normalized.maxOutputTokens);
    expect(contract.itemPolicy).toMatchObject({ mode: 'exact', count: 6 });
    const validationOptions = { compactDirectResponse: true,
      enforceParsedItemContract: true, usedCompactOutputRetry: false };
    expect(() => assertBackstageBookerFinalCompactOutputValid(
      response.output_text, contract, validationOptions)).not.toThrow();
    expect(() => assertBackstageBookerFinalCompactOutputValid(
      'Synthetic preview provider completed the isolated request.', contract, validationOptions))
      .toThrow(expect.objectContaining({ code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE' }));
    expect(runtime.inspect().receipts[0].purpose).toBe('backstage-web-completion');
    expect(JSON.stringify([response, runtime.inspect()])).not.toContain(prompt);
    expect(JSON.stringify(runtime.inspect())).not.toContain(token);
  });

  it('preserves the fixed Backstage answer through central production completion and Trinity decoding', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const prompt = buildBackstageHeavyProbePrompt('self-heal-run-1544-web-1');
    const previousAuthority = process.env.FINETUNED_MODEL_ID;
    process.env.FINETUNED_MODEL_ID = BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID;
    try {
      const final = await createSingleChatCompletion(client(), {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
        maxRetries: 0, timeoutMs: 2000,
      });
      expect(final.choices[0].message.content).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);
      expect(final.fallbackFlag).toBe(false);
    } finally {
      if (previousAuthority === undefined) delete process.env.FINETUNED_MODEL_ID;
      else process.env.FINETUNED_MODEL_ID = previousAuthority;
    }
    for (const schema of [TRINITY_STRUCTURED_REASONING_SCHEMA, TRINITY_COMPACT_STRUCTURED_REASONING_SCHEMA]) {
      const response = await client().responses.create(responseBody({ input: prompt,
        model: 'gpt-6.1-sol', text: { format: { type: 'json_schema', ...schema } } }));
      expect(parseStructuredJson(response).final_answer)
        .toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);
      const chat = await client().chat.completions.create({ model: 'gpt-6-luna',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: schema } });
      expect(JSON.parse(chat.choices[0].message.content).final_answer)
        .toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);
    }
    const chat = await client().chat.completions.create({ model: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
      messages: [{ role: 'user', content: prompt }] });
    expect(chat.choices[0].message.content).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);
    expect(runtime.inspect().receipts).toHaveLength(6);
    expect(runtime.inspect().receipts.every(receipt => receipt.purpose === 'backstage-web-completion'
      && receipt.outcome === 'completed')).toBe(true);
  });

  it.each([
    ['foreign run', prompt => prompt.replace('self-heal-run-1544-web-1', 'foreign-run-1544-web-1')],
    ['unapproved attempt', prompt => prompt.replace('-web-1.', '-web-3.')],
    ['base run', prompt => prompt.replace('-web-1.', '.')],
    ['missing sentinel', prompt => prompt.replace(BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL, '')],
    ['missing directive', prompt => prompt.replace(BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE, '')],
    ['duplicate sentinel', prompt => `${prompt} ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL}`],
    ['duplicate directive', prompt => `${prompt} ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE}`],
    ['duplicate allowed run', prompt => `${prompt} Run self-heal-run-1544-web-2.`],
    ['foreign additional run', prompt => `${prompt} Run foreign-run-1544-web-1.`],
    ['truncated fixture', prompt => prompt.slice(0, 400)],
  ])('does not select the Backstage completion for %s', async (_label, change) => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const response = await client().responses.create(responseBody({
      input: change(buildBackstageHeavyProbePrompt('self-heal-run-1544-web-1')),
    }));
    expect(response.output_text).toBe('Synthetic preview provider completed the isolated request.');
    expect(runtime.inspect().receipts[0].purpose).toBe('synthetic-completion');
  });

  it('requires the Backstage marker in user input and rejects an unsupported JSON object response', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const prompt = buildBackstageHeavyProbePrompt('self-heal-run-1544-web-1');
    const response = await client().responses.create(responseBody({ input: [
      { role: 'developer', content: [{ type: 'input_text', text: prompt }] },
      { role: 'user', content: [{ type: 'input_text', text: promptSentinel }] },
    ] }));
    expect(response.output_text).toBe('Synthetic preview provider completed the isolated request.');
    const chat = await client().chat.completions.create({ model: 'gpt-6-luna',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: promptSentinel }] });
    expect(chat.choices[0].message.content).toBe(response.output_text);
    await expect(client().responses.create(responseBody({ input: prompt,
      text: { format: { type: 'json_object' } } }))).rejects.toMatchObject({ status: 422 });
    expect(runtime.inspect()).toMatchObject({ completed: 2, inFlight: null });
    expect(runtime.inspect().receipts.map(receipt => receipt.outcome))
      .toEqual(['completed', 'completed', 'rejected']);
    expect(JSON.stringify(runtime.inspect())).not.toContain(promptSentinel);
  });

  it('serves cold SDK model retrieval only for the three fixed preview identities', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const sdk = client();
    for (const model of SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS) {
      await expect(sdk.models.retrieve(model)).resolves.toMatchObject({ id: model,
        object: 'model', created: 0, owned_by: 'arcanos-preview-fixture' });
    }
    for (const model of ['gpt-6-sol', 'gpt-6-luna/extra', promptSentinel]) {
      await expect(sdk.models.retrieve(model)).rejects.toMatchObject({ status: 404 });
    }
    const extraQuery = await fetch(`${endpoint()}/v1/models/gpt-6-luna?other=1`, {
      headers: { authorization: `Bearer ${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY}` },
    });
    expect(extraQuery.status).toBe(404);
    expect(JSON.stringify(runtime.inspect())).not.toContain(promptSentinel);
  });

  it('returns fixed CLEAR scores only for the production audit instructions', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const auditPrompt = 'You are an expert auditor for AI reasoning.\n'
      + 'Evaluate the following Reasoning Ledger based on the CLEAR principles.\n'
      + 'Each score must be between 0 and 5.\n' + promptSentinel + '\n'
      + buildBackstageHeavyProbePrompt('self-heal-run-1544-web-1');
    const response = await client().responses.create(responseBody({ model: 'gpt-6-luna',
      input: [{ role: 'developer', content: [{ type: 'input_text', text: auditPrompt }] }],
      text: { format: { type: 'json_object' } } }));
    expect(JSON.parse(response.output_text)).toEqual({ clarity: 5, leverage: 5,
      efficiency: 5, alignment: 5, resilience: 5, overall: 5 });
    expect(runtime.inspect().receipts[0]).toMatchObject({ model: 'gpt-6-luna', purpose: 'clear-audit' });
    const unrelated = await client().responses.create(responseBody({ input: 'clarity leverage CLEAR' }));
    expect(unrelated.output_text).toContain('Synthetic preview provider');
    expect(JSON.stringify([response, runtime.inspect()])).not.toContain(promptSentinel);
  });

  const predictivePrompt = candidates => [
    'ARCANOS:CORE bounded production self-healing decision agent.',
    'Select at most one provided self-healing candidate, or choose no action.',
    `Candidates=${candidates}`,
    'Return JSON only with this schema: {"selectedCandidateIndex":number|null,"chooseNoAction":boolean,"reason":string,"safeToExecute":boolean,"confidence":number}',
    promptSentinel,
  ].join('\n');

  it('returns a bounded predictive selection for a supplied candidate through direct and structured paths', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const input = predictivePrompt(JSON.stringify([{ index: 0, action: 'reload_ai_provider', target: 'local' }]))
      + '\n' + buildBackstageHeavyProbePrompt('self-heal-run-1544-web-2');
    const direct = await client().responses.create(responseBody({ input }));
    const decision = JSON.parse(direct.output_text);
    expect(decision).toEqual({ selectedCandidateIndex: 0, chooseNoAction: false,
      reason: 'Synthetic isolated preview selection of the first supplied candidate.',
      safeToExecute: true, confidence: 0.95 });
    const structured = await client().responses.create(responseBody({ input, model: 'gpt-6.1-sol',
      text: { format: { type: 'json_schema', ...TRINITY_STRUCTURED_REASONING_SCHEMA } } }));
    expect(JSON.parse(parseStructuredJson(structured).final_answer)).toEqual(decision);
    const chat = await client().chat.completions.create({ model: 'gpt-6-luna',
      messages: [{ role: 'user', content: input }] });
    expect(JSON.parse(chat.choices[0].message.content)).toEqual(decision);
    expect(runtime.inspect().receipts.every(item => item.purpose === 'predictive-decision')).toBe(true);
    expect(JSON.stringify([direct, structured, chat, runtime.inspect()])).not.toContain(promptSentinel);
  });

  it.each(['[]', 'not-json', '[{"index":1}]',
    '[{"index":0}]\nCandidates=[{"index":0}]'])('refuses to invent a predictive candidate for %s', async candidates => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const response = await client().responses.create(responseBody({ input: predictivePrompt(candidates) }));
    expect(JSON.parse(response.output_text)).toMatchObject({ selectedCandidateIndex: null,
      chooseNoAction: true, safeToExecute: false });
    expect(runtime.inspect()).toMatchObject({ completed: 1, timedOut: 0, inFlight: null });
  });

  it('authenticates controls before reading a body and separates provider authority', async () => {
    runtime = await startSelfHealPreviewOpenAIFixture({ port: 0, env: childEnv() });
    const early = await new Promise((resolve, reject) => {
      const request = httpRequest(`${endpoint()}${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH}`, {
        method: 'POST', headers: { 'content-length': 1_000_000,
          authorization: `Bearer ${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY}` },
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
