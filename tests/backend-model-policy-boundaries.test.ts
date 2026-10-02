import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { getOpenAIAdapter, resetOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { resetCredentialCache } from '../src/services/openai/credentialProvider.js';
import { createResponses } from '../src/services/openaiClient.js';
import { runResponse } from '../src/lib/runResponse.js';
import { runTrinity } from '../src/trinity/trinity.js';
import visionRouter from '../src/routes/api-vision.js';
import queryFinetuneRouter from '../src/routes/queryFinetune.js';
import { handlePrompt } from '../src/transport/http/controllers/openaiController.js';
import { runAskToolMode } from '../src/routes/ask/toolRuntime.js';
import { tryDispatchDaemonTools } from '../src/routes/ask/daemonTools.js';

const authority = 'ft:synthetic:backend-authority';
const authorityKeys = ['FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL'];
const envKeys = [...authorityKeys, 'OPENAI_API_KEY', 'ARCANOS_MODEL', 'ARCANOS_FINE_TUNE'];
let savedEnv: Record<string, string | undefined>;
let sentPayloads: Array<Record<string, unknown>>;
let syntheticFetch: ReturnType<typeof jest.fn<typeof fetch>>;

function app() {
  const application = express();
  application.use(express.json());
  application.use(visionRouter);
  application.use(queryFinetuneRouter);
  application.post('/api/openai/prompt', handlePrompt);
  return application;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  authorityKeys.forEach(key => { delete process.env[key]; });
  process.env.FINETUNED_MODEL_ID = authority;
  process.env.OPENAI_API_KEY = 'synthetic-policy-test-key';
  process.env.ARCANOS_MODEL = 'gpt-5';
  process.env.ARCANOS_FINE_TUNE = 'ft:legacy:module-override';
  resetCredentialCache();
  resetOpenAIAdapter();
  sentPayloads = [];
  syntheticFetch = jest.fn<typeof fetch>(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sentPayloads.push(payload);
    return new Response(JSON.stringify({
      id: 'resp_synthetic_policy', object: 'response', status: 'completed',
      model: payload.model, output_text: 'Synthetic authority answer',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: 'Synthetic authority answer', annotations: [] }
      ] }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  getOpenAIAdapter({ apiKey: 'synthetic-policy-test-key', maxRetries: 0, fetch: syntheticFetch });
});

afterEach(() => {
  envKeys.forEach(key => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
  resetCredentialCache();
  resetOpenAIAdapter();
});

describe('backend generation boundaries use actual shared policy and synthetic SDK transport', () => {
  it('uses each service authority for Responses wrappers without legacy module overrides', async () => {
    await runResponse({ input: 'synthetic prompt' });
    await createResponses({ model: authority, input: 'synthetic prompt' });
    process.env.FINETUNED_MODEL_ID = 'ft:synthetic:worker-authority';
    await runResponse({ input: 'synthetic prompt' });
    expect(sentPayloads.map(payload => payload.model)).toEqual([
      authority, authority, 'ft:synthetic:worker-authority'
    ]);
    expect(sentPayloads[0].store).toBe(false);
  });

  it.each([
    ['intake', 'gpt-6-luna'], ['audit', 'gpt-6-luna'],
    ['reasoning', 'gpt-6.1-sol'], ['audit-escalation', 'gpt-6.1-sol'],
    ['final-escalation', authority]
  ] as const)('routes explicit %s helper/recovery roles through the policy', async (modelRole, model) => {
    await runResponse({ modelRole, input: 'synthetic prompt' });
    await createResponses({ model, input: 'synthetic prompt' }, { modelRole });
    expect(sentPayloads.map(payload => payload.model)).toEqual([model, model]);
  });

  it.each(['gpt-4o', 'gpt-6.1-sol', 'ft:synthetic:other-authority'])('rejects final model override %s before transport', async model => {
    await expect(runResponse({ model, input: 'synthetic prompt' })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
    await expect(createResponses({ model, input: 'synthetic prompt' })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
    await expect(runTrinity({ model, prompt: 'synthetic prompt' })).rejects.toMatchObject({ code: 'MODEL_OVERRIDE_CONFLICT' });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('does not substitute a helper when authority is unavailable', async () => {
    delete process.env.FINETUNED_MODEL_ID;
    process.env.AI_MODEL = 'gpt-6.1-sol';
    await expect(runResponse({ input: 'synthetic prompt' })).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
    await expect(runTrinity({ prompt: 'synthetic prompt' })).rejects.toMatchObject({ code: 'FINAL_AUTHORITY_UNAVAILABLE' });
    const response = await request(app()).post('/query-finetune').send({ prompt: 'synthetic prompt' });
    expect(response.status).toBe(503);
    const vision = await request(app()).post('/api/vision').send({ imageBase64: 'aW1hZ2U=' });
    const prompt = await request(app()).post('/api/openai/prompt').send({ prompt: 'synthetic prompt' });
    expect(vision.status).toBe(503);
    expect(prompt.status).toBe(503);
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('preserves a vision provider rejection without switching final authority', async () => {
    syntheticFetch.mockImplementationOnce(async (_input, init) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: {
        message: 'Synthetic authority does not accept image input', type: 'invalid_request_error', code: 'unsupported_image'
      } }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const response = await request(app()).post('/api/vision').send({ imageBase64: 'aW1hZ2U=' });
    expect(response.status).toBe(500);
    expect(sentPayloads.map(payload => payload.model)).toEqual([authority]);
    expect(syntheticFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['gpt-6.1-sol', 'ft:synthetic:other-authority', `${authority}-other`, 'ft:synthetic:Backend-authority', undefined])('rejects provider-reported final model %s before exposing output', async model => {
    syntheticFetch.mockImplementation(async (_input, init) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        id: 'resp_wrong_authority', object: 'response', status: 'completed', model,
        output_text: 'Untrusted final output',
        output: [{ type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: 'Untrusted final output', annotations: [] }
        ] }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await expect(runResponse({ input: 'synthetic prompt' })).rejects.toThrow(/model/);
    await expect(createResponses({ model: authority, input: 'synthetic prompt' })).rejects.toThrow(/model/);
    const vision = await request(app()).post('/api/vision').send({ imageBase64: 'aW1hZ2U=' });
    expect(vision.status).toBe(500);
    expect(vision.body.response).toBeUndefined();
    const client = getOpenAIAdapter().getClient();
    await expect(runAskToolMode({
      client, prompt: 'synthetic prompt', instructions: 'synthetic tools',
      moduleName: 'synthetic', responseIdPrefix: 'synthetic',
      responsesTools: [], chatCompletionTools: [],
      executeTool: async () => { throw new Error('No tool should execute'); }
    })).rejects.toThrow(/model/);
    await expect(tryDispatchDaemonTools(client, 'synthetic prompt', { source: 'daemon', instanceId: 'synthetic-instance' })).rejects.toThrow(/model/);
    expect(sentPayloads.map(payload => payload.model)).toEqual([authority, authority, authority, authority, authority]);
  });

  it('sends vision final answers to configured authority and accepts only a matching override', async () => {
    for (const model of [undefined, ` ${authority} `]) {
      const response = await request(app()).post('/api/vision').send({
        imageBase64: 'aW1hZ2U=', prompt: 'synthetic image', model
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ response: 'Synthetic authority answer', model: authority, tokens: 5 });
    }
    expect(sentPayloads.map(payload => payload.model)).toEqual([authority, authority]);
  });

  it('rejects HTTP final-model overrides before invoking a provider', async () => {
    const vision = await request(app()).post('/api/vision').send({ imageBase64: 'aW1hZ2U=', model: 'gpt-4o' });
    const prompt = await request(app()).post('/api/openai/prompt').send({ prompt: 'synthetic prompt', model: 'gpt-6.1-sol' });
    expect(vision.status).toBe(400);
    expect(prompt.status).toBe(400);
    expect(prompt.body.error).toBe('MODEL_OVERRIDE_CONFLICT');
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('uses the configured authority for tool-loop text and preserves daemon admission', async () => {
    const client = getOpenAIAdapter().getClient();
    const result = await runAskToolMode({
      client, prompt: 'synthetic prompt', instructions: 'synthetic tools',
      moduleName: 'synthetic', responseIdPrefix: 'synthetic',
      responsesTools: [], chatCompletionTools: [],
      executeTool: async () => { throw new Error('No tool should execute'); }
    });
    expect(result).toMatchObject({ result: 'Synthetic authority answer', activeModel: authority });
    const callCount = syntheticFetch.mock.calls.length;
    expect(await tryDispatchDaemonTools(client, 'synthetic prompt', { source: 'untrusted' })).toBeNull();
    expect(syntheticFetch).toHaveBeenCalledTimes(callCount);
    const daemonResult = await tryDispatchDaemonTools(client, 'synthetic prompt', { source: 'daemon', instanceId: 'synthetic-instance' });
    expect(daemonResult).toMatchObject({ result: 'Synthetic authority answer', activeModel: authority });
    expect(sentPayloads.map(payload => payload.model)).toEqual([authority, authority]);
  });
});
