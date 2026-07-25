import { afterAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
process.env.LEGACY_GPT_ROUTES = 'enabled';

const productivityHandler = jest.fn(async () => ({ ok: true }));
const ordinaryHandler = jest.fn(async () => ({ ok: true }));
const legacyHiddenHandler = jest.fn(async () => ({ ok: true }));

jest.unstable_mockModule('@services/moduleLoader.js', () => ({
  clearModuleDefinitionCache: jest.fn(),
  loadModuleDefinitions: jest.fn(async () => [
    {
      route: 'productivity',
      definition: {
        name: 'ARCANOS:PRODUCTIVITY',
        description: 'Protected productivity capability.',
        gptAccessOnly: true,
        exposeLegacyRoute: false,
        actions: {
          'state.current': productivityHandler
        },
        actionMetadata: {
          'state.current': {
            description: 'Read current productivity state.',
            risk: 'readonly',
            requiresConfirmation: false,
            idempotent: true,
            executionTarget: 'python-daemon',
            inputSchema: {
              type: 'object',
              additionalProperties: false
            },
            outputSchema: {
              type: 'object',
              additionalProperties: false
            },
            timeoutMs: 10_000,
            requiredDeviceScopes: ['productivity.read'],
            readOnly: true,
            mayModifyFiles: false
          }
        }
      }
    },
    {
      route: 'legacy-hidden',
      definition: {
        name: 'ARCANOS:LEGACY_HIDDEN',
        exposeLegacyRoute: false,
        actions: {
          query: legacyHiddenHandler
        }
      }
    },
    {
      route: 'ordinary',
      definition: {
        name: 'ARCANOS:ORDINARY',
        actions: {
          query: ordinaryHandler
        }
      }
    }
  ])
}));

const express = (await import('express')).default;
const modulesModule = await import('../src/routes/modules.js');
const {
  default: modulesRouter,
  dispatchModuleAction,
  getModuleMetadata,
  getModulesForRegistry,
  ModuleAccessDeniedError
} = modulesModule;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', modulesRouter);
  return app;
}

afterAll(() => {
  if (originalLegacyGptRoutes === undefined) {
    delete process.env.LEGACY_GPT_ROUTES;
  } else {
    process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
  }
});

describe('GPT Access-only module isolation', () => {
  it('omits protected modules from legacy routes and the public registry', async () => {
    const app = buildApp();
    const moduleRouteResponse = await request(app)
      .post('/modules/productivity')
      .send({
        module: 'ARCANOS:PRODUCTIVITY',
        action: 'state.current',
        payload: {}
      });
    const queryRouteResponse = await request(app)
      .post('/queryroute')
      .send({
        module: 'ARCANOS:PRODUCTIVITY',
        action: 'state.current',
        payload: {}
      });
    const registryResponse = await request(app).get('/registry');
    const protectedRegistryResponse = await request(app)
      .get('/registry/ARCANOS%3APRODUCTIVITY');

    expect(moduleRouteResponse.status).toBe(404);
    expect(queryRouteResponse.status).toBe(404);
    expect(registryResponse.body.modules).toEqual([
      expect.objectContaining({ name: 'ARCANOS:ORDINARY' })
    ]);
    expect(protectedRegistryResponse.body).toEqual({
      exists: false,
      module: null
    });
    expect(productivityHandler).not.toHaveBeenCalled();
    expect(legacyHiddenHandler).not.toHaveBeenCalled();
  });

  it('requires trusted context for protected dispatch and preserves ordinary handlers', async () => {
    const payload = { focus: 'today' };
    const context = {
      source: 'gpt-access' as const,
      principalId: 'operator:primary',
      workspaceId: 'personal',
      actorKey: 'auth:fingerprint',
      requestId: 'request-1',
      traceId: 'trace-1',
      idempotencyKey: 'turn-1'
    };

    await expect(
      dispatchModuleAction('ARCANOS:PRODUCTIVITY', 'state.current', payload)
    ).rejects.toBeInstanceOf(ModuleAccessDeniedError);
    await expect(
      dispatchModuleAction('ARCANOS:PRODUCTIVITY', 'state.current', payload, context)
    ).resolves.toEqual({ ok: true });
    await expect(
      dispatchModuleAction('ARCANOS:ORDINARY', 'query', payload, context)
    ).resolves.toEqual({ ok: true });

    expect(productivityHandler).toHaveBeenCalledWith(payload, context);
    expect(ordinaryHandler).toHaveBeenCalledWith(payload);
  });

  it('keeps action metadata internal and defaults missing metadata to privileged', () => {
    const publicRegistry = getModulesForRegistry();
    const dispatchRegistry = getModulesForRegistry({ includeActionMetadata: true });
    const publicProductivity = publicRegistry.find(
      (module) => module.id === 'ARCANOS:PRODUCTIVITY'
    );
    const dispatchProductivity = dispatchRegistry.find(
      (module) => module.id === 'ARCANOS:PRODUCTIVITY'
    );

    expect(publicProductivity).not.toHaveProperty('actionMetadata');
    expect(dispatchProductivity?.actionMetadata?.['state.current']).toEqual(
      expect.objectContaining({
        risk: 'readonly',
        requiresConfirmation: false,
        executionTarget: 'python-daemon',
        inputSchema: {
          type: 'object',
          additionalProperties: false
        },
        outputSchema: {
          type: 'object',
          additionalProperties: false
        },
        timeoutMs: 10_000,
        requiredDeviceScopes: ['productivity.read'],
        readOnly: true,
        mayModifyFiles: false
      })
    );
    expect(getModuleMetadata('ARCANOS:ORDINARY')?.actionMetadata.query).toEqual({
      risk: 'privileged',
      requiresConfirmation: true
    });
  });
});
