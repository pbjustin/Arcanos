import { afterAll, describe, expect, it, jest } from '@jest/globals';

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
process.env.LEGACY_GPT_ROUTES = 'disabled';

const express = (await import('express')).default;
const request = (await import('supertest')).default;

const executeArcanosPipeline = jest.fn(async () => ({
  result: 'pipeline-ok',
  stages: ['stage-1']
}));

jest.unstable_mockModule('@services/arcanosPipeline.js', () => ({
  executeArcanosPipeline
}));

const { registerRoutes } = await import('../src/routes/register.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  return app;
}

describe('arcanos pipeline route gate', () => {
  afterAll(() => {
    if (originalLegacyGptRoutes === undefined) {
      delete process.env.LEGACY_GPT_ROUTES;
      return;
    }

    process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
  });

  it('keeps /arcanos-pipeline mounted when legacy GPT routes are disabled', async () => {
    const response = await request(buildApp())
      .post('/arcanos-pipeline')
      .send({
        messages: []
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      result: 'pipeline-ok',
      stages: ['stage-1']
    });
    expect(executeArcanosPipeline).toHaveBeenCalledWith([]);
  });
});
