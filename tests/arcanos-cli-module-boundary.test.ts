import { afterAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
process.env.LEGACY_GPT_ROUTES = 'enabled';

const express = (await import('express')).default;
const ArcanosCli = (await import('../src/services/arcanos-cli.js')).default;
jest.unstable_mockModule('@services/moduleLoader.js', () => ({
  clearModuleDefinitionCache: jest.fn(),
  loadModuleDefinitions: jest.fn(async () => [
    {
      route: 'cli',
      definition: ArcanosCli
    },
    {
      route: 'ordinary',
      definition: {
        name: 'ARCANOS:ORDINARY',
        actions: {
          query: async () => ({ ok: true })
        }
      }
    }
  ])
}));
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

describe('ARCANOS:CLI module boundary', () => {
  it('declares the CLI bridge as a GPT Access-only control-plane module', () => {
    expect(ArcanosCli).toEqual(expect.objectContaining({
      name: 'ARCANOS:CLI',
      exposeLegacyRoute: false,
      gptAccessOnly: true
    }));
    expect(Object.keys(ArcanosCli.actions)).toEqual([
      'status',
      'policy',
      'repoContext',
      'proposeCommand',
      'runApprovedCommand',
      'proposePatch',
      'applyApprovedPatch',
      'tailAudit'
    ]);
  });

  it('keeps CLI discoverable for GPT Access but blocks untrusted dispatch', async () => {
    expect(getModulesForRegistry()).toContainEqual(
      expect.objectContaining({
        id: 'ARCANOS:CLI',
        route: 'cli'
      })
    );
    expect(getModuleMetadata('ARCANOS:CLI')).toEqual(
      expect.objectContaining({
        exposeLegacyRoute: false,
        gptAccessOnly: true
      })
    );
    await expect(
      dispatchModuleAction('ARCANOS:CLI', 'status', {})
    ).rejects.toBeInstanceOf(ModuleAccessDeniedError);
  });

  it('omits CLI from public registry and legacy execution routes', async () => {
    const app = buildApp();
    const registryResponse = await request(app).get('/registry');
    const detailResponse = await request(app).get('/registry/ARCANOS%3ACLI');
    const moduleRouteResponse = await request(app)
      .post('/modules/cli')
      .send({
        module: 'ARCANOS:CLI',
        action: 'status',
        payload: {}
      });
    const queryRouteResponse = await request(app)
      .post('/queryroute')
      .send({
        module: 'ARCANOS:CLI',
        action: 'status',
        payload: {}
      });

    expect(
      registryResponse.body.modules.map(
        (entry: { name: string }) => entry.name
      )
    ).not.toContain('ARCANOS:CLI');
    expect(detailResponse.body).toEqual({
      exists: false,
      module: null
    });
    expect(moduleRouteResponse.status).toBe(404);
    expect(queryRouteResponse.status).toBe(404);
    expect(queryRouteResponse.body).toEqual({
      error: 'Module not found'
    });
  });
});
