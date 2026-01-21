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
  it('rejects payloads without any recognized text fields', async () => {
    const res = await request(app).post('/ask').send({ sessionId: 'demo-session' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.join(' ')).toContain('prompt, userInput, content, text, query');
  });

  it('accepts alternate prompt field names', async () => {
    const res = await request(app).post('/ask').send({
      userInput: 'Hello from test',
      clientContext: { routingDirectives: ['concise'] }
    });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
    expect(res.body.clientContext).toEqual({ routingDirectives: ['concise'] });
  });
});
