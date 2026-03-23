import express from 'express';
import request from 'supertest';

import introspectionRouter from '../src/routes/introspection.js';

describe('custom GPT OpenAPI contract route', () => {
  function buildApp() {
    const app = express();
    app.use(introspectionRouter);
    return app;
  }

  it('serves the canonical GPT route contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/custom_gpt_route.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual(['/ask', '/gpt/{gptId}']);
    expect(response.body.paths?.['/ask']?.post?.deprecated).toBe(true);
    expect(response.body.paths?.['/ask']?.post?.operationId).toBe('legacyAskCompatibility');
    expect(response.body.paths?.['/ask']?.post?.responses?.['410']).toBeDefined();
    expect(response.body.components?.headers?.AskRouteModeHeader).toBeDefined();
    expect(response.body.paths?.['/gpt/{gptId}']?.post?.operationId).toBe('invokeGptRoute');
  });
});
