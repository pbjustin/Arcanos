import { beforeEach, describe, expect, it, jest } from '@jest/globals';

process.env.LEGACY_GPT_ROUTES = 'enabled';

const express = (await import('express')).default;
const request = (await import('supertest')).default;

const mockRouteGptRequest = jest.fn();
const moduleActionHandler = jest.fn();

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
          query: moduleActionHandler
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

describe('module legacy route compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        echoedPrompt: 'hello'
      },
      _route: {
        gptId: 'test-legacy-gpt',
        timestamp: '2026-04-07T00:00:00.000Z'
      }
    });
  });

  it('proxies /modules/:route traffic through the canonical GPT dispatcher', async () => {
    const response = await request(buildApp())
      .post('/modules/test-route')
      .send({
        module: 'TEST:MODULE',
        action: 'query',
        payload: {
          prompt: 'hello'
        }
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-canonical-route']).toBe('/gpt/test-legacy-gpt');
    expect(response.headers['x-route-deprecated']).toBe('true');
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'test-legacy-gpt',
        body: {
          module: 'TEST:MODULE',
          action: 'query',
          payload: {
            prompt: 'hello'
          }
        }
      })
    );
    expect(moduleActionHandler).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        ok: true,
        echoedPrompt: 'hello'
      },
      _route: {
        gptId: 'test-legacy-gpt'
      }
    });
  });

  it('proxies /queryroute traffic through the canonical GPT dispatcher', async () => {
    const response = await request(buildApp())
      .post('/queryroute')
      .send({
        module: 'TEST:MODULE',
        action: 'query',
        payload: {
          prompt: 'hello'
        }
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-canonical-route']).toBe('/gpt/test-legacy-gpt');
    expect(response.headers['x-route-deprecated']).toBe('true');
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'test-legacy-gpt'
      })
    );
    expect(response.body._route.gptId).toBe('test-legacy-gpt');
  });
});
