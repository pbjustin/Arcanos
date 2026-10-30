import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const createResponse = jest.fn();
let available = true;
jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({
    adapter: available ? { responses: { create: createResponse } } : undefined,
  }),
}));

const { default: router } = await import('../src/routes/api-vision.js');
const authority = 'ft:gpt-4.1:fixture:answer-presentation';
const previousAuthority = process.env.FINETUNED_MODEL_ID;
const answer = '## Audit Summary\nThe image contains a warning.\n\nCOMPLIANCE STATUS\nNot verified.';

function app() {
  return express().use(express.json()).use(router);
}

describe('vision answer presentation at the actual HTTP boundary', () => {
  beforeEach(() => {
    available = true;
    process.env.FINETUNED_MODEL_ID = authority;
    createResponse.mockReset().mockResolvedValue({
      id: 'vision-presentation-fixture', model: authority, status: 'completed',
      output_text: answer, output: [], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      presentation: 'caller-or-provider-value-must-not-control-the-envelope',
    });
  });

  afterEach(() => {
    if (previousAuthority === undefined) delete process.env.FINETUNED_MODEL_ID;
    else process.env.FINETUNED_MODEL_ID = previousAuthority;
  });

  it('labels final answer text independently of request and provider presentation properties', async () => {
    const response = await request(app()).post('/api/vision').send({
      imageBase64: 'Zml4dHVyZQ==', prompt: 'Describe the image.',
      presentation: 'untrusted-request-value',
    });
    expect(response.status).toBe(200);
    expect(response.body.response).toBe(answer);
    expect(response.body.presentation).toBe('public-answer-v1');
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it('never labels validation or unavailable-provider errors as public answer text', async () => {
    const invalid = await request(app()).post('/api/vision').send({ presentation: 'public-answer-v1' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.presentation).toBeUndefined();
    available = false;
    const unavailable = await request(app()).post('/api/vision').send({ imageBase64: 'Zml4dHVyZQ==' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.presentation).toBeUndefined();
    expect(createResponse).not.toHaveBeenCalled();
  });
});
