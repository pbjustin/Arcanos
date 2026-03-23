import express, { type Express } from 'express';
import request from 'supertest';
import askRouter from '../src/routes/ask.js';

let app: Express;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', askRouter);
});

describe('ask route validation', () => {
  it('rejects GPT-routed payloads before entering the generic /ask pipeline', async () => {
    const res = await request(app).post('/ask').send({
      gptId: 'arcanos-gaming',
      prompt: 'Ping the gaming backend'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('GPT-routed requests must target /gpt/:gptId');
    expect(res.body.deprecated).toBe(true);
    expect(res.body.canonicalRoute).toBe('/gpt/arcanos-gaming');
    expect(res.body.details).toContain("Received gptId 'arcanos-gaming' on /ask; use /gpt/arcanos-gaming instead.");
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers.sunset).toBeDefined();
    expect(res.headers['x-route-deprecated']).toBe('true');
    expect(res.headers['x-ask-route-mode']).toBe('compat');
    expect(res.headers['x-canonical-route']).toBe('/gpt/arcanos-gaming');
    expect(res.headers.link).toContain('/contracts/custom_gpt_route.openapi.v1.json');
    expect(res.headers.link).toContain('/gpt/arcanos-gaming');
  });

  it('rejects payloads without any recognized text fields', async () => {
    const res = await request(app).post('/ask').send({ sessionId: 'demo-session' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.join(' ')).toContain('prompt, message, userInput, content, text, query');
  });

  it('accepts alternate prompt field names', async () => {
    const res = await request(app).post('/ask').send({
      userInput: 'Hello from test',
      clientContext: { routingDirectives: ['concise'] }
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    expect(res.body.clientContext).toEqual({ routingDirectives: ['concise'] });
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers['x-route-deprecated']).toBe('true');
    expect(res.headers['x-ask-route-mode']).toBe('compat');
    expect(res.headers['x-canonical-route']).toBe('/gpt/{gptId}');
  });

  it('treats CI mock OpenAI keys as placeholders and still returns a mock response', async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    const ciMockApiKey = ['sk', 'mock', 'for', 'ci', 'testing'].join('-');
    Reflect.set(process.env, 'OPENAI_API_KEY', ciMockApiKey);

    try {
      const res = await request(app).post('/ask').send({ prompt: 'Hello from CI mock key' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    } finally {
      if (previousApiKey === undefined) {
        Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      } else {
        Reflect.set(process.env, 'OPENAI_API_KEY', previousApiKey);
      }
    }
  });

  it('can hard-disable /ask with a 410 removal response', async () => {
    const previousAskRouteMode = process.env.ASK_ROUTE_MODE;
    Reflect.set(process.env, 'ASK_ROUTE_MODE', 'gone');

    try {
      const res = await request(app).post('/ask').send({
        prompt: 'Legacy route probe',
        gptId: 'arcanos-core'
      });

      expect(res.status).toBe(410);
      expect(res.body.error).toBe('Legacy /ask route has been removed; use /gpt/:gptId');
      expect(res.body.deprecated).toBe(true);
      expect(res.body.canonicalRoute).toBe('/gpt/arcanos-core');
      expect(res.headers.deprecation).toBe('true');
      expect(res.headers.sunset).toBeDefined();
      expect(res.headers['x-route-deprecated']).toBe('true');
      expect(res.headers['x-ask-route-mode']).toBe('gone');
      expect(res.headers['x-canonical-route']).toBe('/gpt/arcanos-core');
    } finally {
      if (previousAskRouteMode === undefined) {
        Reflect.deleteProperty(process.env, 'ASK_ROUTE_MODE');
      } else {
        Reflect.set(process.env, 'ASK_ROUTE_MODE', previousAskRouteMode);
      }
    }
  });
});
