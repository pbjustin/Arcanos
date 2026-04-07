import { afterEach, describe, expect, it } from '@jest/globals';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { registerRoutes } = await import('../src/routes/register.js');

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;

function buildApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  return app;
}

describe('legacy GPT route gate', () => {
  afterEach(() => {
    process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
  });

  it('omits deprecated root routes when legacy GPT routes are disabled', async () => {
    process.env.LEGACY_GPT_ROUTES = 'disabled';

    const app = buildApp();

    const arcanosResponse = await request(app)
      .post('/arcanos')
      .send({ userInput: 'health check' });
    const writeResponse = await request(app)
      .post('/write')
      .send({ prompt: 'hello' });

    expect(arcanosResponse.status).toBe(404);
    expect(writeResponse.status).toBe(404);
  });
});
