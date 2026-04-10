import { afterAll, describe, expect, it, jest } from '@jest/globals';

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
process.env.LEGACY_GPT_ROUTES = 'disabled';

const express = (await import('express')).default;
const request = (await import('supertest')).default;

const mockRouteGptRequest = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest
}));

jest.unstable_mockModule('@services/moduleLoader.js', () => ({
  clearModuleDefinitionCache: jest.fn(),
  loadModuleDefinitions: jest.fn(async () => [
    {
      route: 'test-route',
      definition: {
        name: 'TEST:MODULE',
        description: null,
        gptIds: ['test-legacy-gpt'],
        defaultAction: 'query',
        actions: {
          query: jest.fn()
        }
      }
    }
  ])
}));

const modulesRouter = (await import('../src/routes/modules.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', modulesRouter);
  return app;
}

describe('disabled module legacy route gate', () => {
  afterAll(() => {
    if (originalLegacyGptRoutes === undefined) {
      delete process.env.LEGACY_GPT_ROUTES;
      return;
    }

    process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
  });

  it('omits /queryroute and /modules/:moduleRoute when legacy GPT routes are disabled', async () => {
    const app = buildApp();

    const queryRouteResponse = await request(app)
      .post('/queryroute')
      .send({ module: 'TEST:MODULE', action: 'query', payload: { prompt: 'hello' } });
    const moduleRouteResponse = await request(app)
      .post('/modules/test-route')
      .send({ module: 'TEST:MODULE', action: 'query', payload: { prompt: 'hello' } });

    expect(queryRouteResponse.status).toBe(404);
    expect(moduleRouteResponse.status).toBe(404);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });
});
