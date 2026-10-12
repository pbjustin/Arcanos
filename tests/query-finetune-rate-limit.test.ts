import { describe, expect, it } from '@jest/globals';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const queryFinetuneRouter = (await import('../src/routes/queryFinetune.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', queryFinetuneRouter);
  app.get('/api/arcanos/health', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('queryFinetune rate limit scoping', () => {
  it('does not rate-limit unrelated routes mounted after the router', async () => {
    const app = buildApp();

    for (let index = 0; index < 35; index += 1) {
      const response = await request(app).get('/api/arcanos/health');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    }
  });

  it('rejects identity rotation after the query route client budget is exhausted', async () => {
    const app = buildApp();
    for (let index = 0; index < 30; index += 1) {
      await request(app).post('/query-finetune')
        .set('X-Session-Id', `synthetic-session-${index}`)
        .set('Authorization', `Bearer test-invalid-${index}`)
        .set('X-Forwarded-For', `198.51.100.${index + 1}`)
        .send({})
        .expect(400);
    }

    const exhausted = await request(app).post('/query-finetune')
      .set('X-Session-Id', 'synthetic-session-overflow')
      .set('Authorization', 'Bearer test-invalid-overflow')
      .set('X-Forwarded-For', '198.51.100.99')
      .send({});

    expect(exhausted.status).toBe(429);
    expect(exhausted.headers['x-ratelimit-bucket']).toBe('query-finetune');
  });
});
