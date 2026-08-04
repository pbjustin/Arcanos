import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE
} from '../src/shared/backstage/backstageRoster.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
const controlPlaneToken = 'legacy-module-token-12345678901234567890';
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
    },
    {
      route: 'backstage-booker',
      definition: {
        name: 'BACKSTAGE:BOOKER',
        description: null,
        gptIds: ['backstage-booker', 'backstage'],
        defaultAction: 'updateRoster',
        actions: {
          updateRoster: moduleActionHandler
        }
      }
    }
  ])
}));

const modulesModule = await import('../src/routes/modules.js');
const modulesRouter = modulesModule.default;
const { getModuleMetadata } = modulesModule;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', modulesRouter);
  return app;
}

function configureControlPlane(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:legacy-module-backstage';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

describe('module legacy route compatibility', () => {
  afterAll(() => {
    if (originalLegacyGptRoutes === undefined) {
      delete process.env.LEGACY_GPT_ROUTES;
    } else {
      process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
    }

    for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      const originalValue = originalCredentialEnvironment.get(environmentName);
      if (originalValue === undefined) {
        delete process.env[environmentName];
      } else {
        process.env[environmentName] = originalValue;
      }
    }
    if (originalPrincipalId === undefined) {
      delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
    } else {
      process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
    }
    if (originalScopes === undefined) {
      delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
    } else {
      process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'test-legacy-gpt',
        body: {
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
      echoedPrompt: 'hello'
    });
    expect(response.body._route).toBeUndefined();
  });

  it('preserves the legacy /modules/:route validation contract before dispatching', async () => {
    const response = await request(buildApp())
      .post('/modules/test-route')
      .send({
        action: 'query',
        payload: {
          prompt: 'hello'
        }
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Module not found'
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(moduleActionHandler).not.toHaveBeenCalled();
  });

  it('resolves module metadata by module name and route without using GPT ids', () => {
    expect(getModuleMetadata('TEST:MODULE')).toEqual(expect.objectContaining({
      name: 'TEST:MODULE',
      route: 'test-route',
      actions: ['query']
    }));
    expect(getModuleMetadata('test-route')).toEqual(expect.objectContaining({
      name: 'TEST:MODULE',
      route: 'test-route',
      actions: ['query']
    }));
    expect(getModuleMetadata('test-legacy-gpt')).toBeNull();
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
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'test-legacy-gpt',
        body: {
          action: 'query',
          payload: {
            prompt: 'hello'
          }
        }
      })
    );
    expect(response.body).toMatchObject({
      ok: true,
      echoedPrompt: 'hello'
    });
    expect(response.body._route).toBeUndefined();
  });

  it.each([
    '/modules/backstage-booker',
    '/queryroute'
  ])('maps an invalid Backstage roster through %s to the stable client error', async (route) => {
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: false,
      error: {
        code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
        message: 'Roster payload must be an array.'
      },
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        route: 'backstage-booker',
        action: 'updateRoster',
        timestamp: '2026-08-03T00:00:00.000Z'
      }
    });

    const response = await request(buildApp())
      .post(route)
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-Confirmed', 'yes')
      .send({
        module: 'BACKSTAGE:BOOKER',
        action: 'updateRoster',
        payload: { invalid: true }
      });

    expect(response.status).toBe(400);
    expect(response.headers['x-canonical-route']).toBe('/gpt/backstage-booker');
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
        message: 'Roster payload must be an array.'
      }
    });
    expect(mockRouteGptRequest).toHaveBeenCalledWith(expect.objectContaining({
      gptId: 'backstage-booker',
      body: {
        action: 'updateRoster',
        payload: { invalid: true }
      }
    }));
    expect(moduleActionHandler).not.toHaveBeenCalled();
  });

  it.each([
    '/modules/backstage-booker',
    '/queryroute'
  ])('preserves a successful Backstage roster array through %s', async (route) => {
    const refreshedRoster = [{ name: 'Rhea Ripley', overall: 96 }];
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: true,
      result: refreshedRoster,
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        route: 'backstage-booker',
        action: 'updateRoster',
        timestamp: '2026-08-03T00:00:00.000Z'
      }
    });

    const response = await request(buildApp())
      .post(route)
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-Confirmed', 'yes')
      .send({
        module: 'BACKSTAGE:BOOKER',
        action: 'updateRoster',
        payload: refreshedRoster
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(refreshedRoster);
  });

  it.each([
    '/modules/backstage-booker',
    '/queryroute'
  ])('maps a failed Backstage roster transaction through %s to unavailable', async (route) => {
    mockRouteGptRequest.mockResolvedValueOnce({
      ok: false,
      error: {
        code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
        message: 'Roster update persistence could not be confirmed.'
      },
      _route: {
        gptId: 'backstage-booker',
        module: 'BACKSTAGE:BOOKER',
        route: 'backstage-booker',
        action: 'updateRoster',
        timestamp: '2026-08-03T00:00:00.000Z'
      }
    });

    const response = await request(buildApp())
      .post(route)
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-Confirmed', 'yes')
      .send({
        module: 'BACKSTAGE:BOOKER',
        action: 'updateRoster',
        payload: [{ name: 'Rhea Ripley', overall: 96 }]
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
        message: 'Roster update persistence could not be confirmed.'
      }
    });
  });

  it('preserves the legacy /queryroute validation contract before dispatching', async () => {
    const response = await request(buildApp())
      .post('/queryroute')
      .send({
        module: 'TEST:MODULE',
        payload: {
          prompt: 'hello'
        }
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Action is required'
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('does not fall through to raw GPT ids for unknown /queryroute modules', async () => {
    const response = await request(buildApp())
      .post('/queryroute')
      .send({
        module: 'no-such-gpt',
        action: 'query',
        payload: {
          prompt: 'hello'
        }
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: 'Module not found'
    });
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });
});
