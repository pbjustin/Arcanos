import { afterAll, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { resetGptModuleMapCache } from '../src/platform/runtime/gptRouterConfig.js';
import introspectionRouter from '../src/routes/introspection.js';

const CURRENT_GPT_ROUTER_HASH = 'e02a4e9739fe4772aac59afe24a99f45348090434c90d7acb560d28c14bd4e2a';
const ROUTING_OVERRIDE_KEYS = [
  'GPT_MODULE_MAP',
  'GPTID_ARCANOS_GAMING',
  'GPTID_ARCANOS_TUTOR',
  'GPTID_BACKSTAGE_BOOKER'
] as const;
const originalGptRouterHash = process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;
const originalRoutingOverrides = Object.fromEntries(
  ROUTING_OVERRIDE_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ROUTING_OVERRIDE_KEYS)[number], string | undefined>;

beforeAll(() => {
  resetGptModuleMapCache();
  for (const key of ROUTING_OVERRIDE_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
});

afterAll(() => {
  resetGptModuleMapCache();
  for (const key of ROUTING_OVERRIDE_KEYS) {
    const originalValue = originalRoutingOverrides[key];
    if (originalValue === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = originalValue;
    }
  }
  if (originalGptRouterHash === undefined) {
    Reflect.deleteProperty(process.env, 'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG');
  } else {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = originalGptRouterHash;
  }
});

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
    expect(response.body.info.version).toBe('1.5.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual([
      '/gpt/{gptId}',
      '/gpt/arcanos-gaming/canary',
    ]);
    expect(response.body.paths?.['/gpt/{gptId}']?.post?.operationId).toBe('invokeGptRoute');
    expect(response.body.paths?.['/gpt/arcanos-gaming/canary']?.post?.operationId)
      .toBe('canaryArcanosGaming');
    expect(response.body.info.description).toContain('may also echo the same gptId');
    expect(response.body.info.description).not.toContain('must not duplicate gptId');
    expect(response.body.components?.schemas?.GptRouteRequest?.properties?.gptId).toEqual(
      expect.objectContaining({
        type: 'string',
        minLength: 1,
      })
    );

    const requestExamples =
      response.body.paths?.['/gpt/{gptId}']?.post?.requestBody?.content?.['application/json']
        ?.examples;
    expect(requestExamples).not.toHaveProperty('diagnostics');
    expect(requestExamples).not.toHaveProperty('getStatus');
    expect(requestExamples).not.toHaveProperty('getResult');
    const requestExampleActions = Object.values(requestExamples ?? {}).map((example) => {
      const typedExample = example as { value?: { action?: unknown } };
      return typedExample.value?.action;
    });
    expect(requestExampleActions).toEqual(
      expect.arrayContaining(['dag.capabilities', 'dag.dispatch', 'dag.status', 'dag.trace'])
    );
    expect(requestExampleActions).not.toContain('system_state');

    const diagnosticsControlActionsSchema =
      response.body.components?.schemas?.GptDispatcherDiagnosticsResponse?.properties
        ?.controlActions;
    expect(diagnosticsControlActionsSchema?.maxItems).toBe(0);
    expect(diagnosticsControlActionsSchema?.items?.enum).toBeUndefined();
    expect(JSON.stringify(requestExamples)).not.toContain('runtime.inspect');
    expect(JSON.stringify(requestExamples)).not.toContain('workers.status');
  });

  it('serves the dedicated ARCANOS Gaming builder contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/arcanos_gaming.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.info.version).toBe('1.5.0');
    expect(response.body.servers).toEqual([
      {
        url: 'https://acranos-production.up.railway.app',
        description: 'Canonical ARCANOS production deployment',
      },
    ]);
    expect(response.body.paths?.['/gpt/arcanos-gaming']?.post?.operationId)
      .toBe('queryArcanosGaming');
    expect(response.body.paths?.['/gpt/arcanos-gaming/canary']?.post?.operationId)
      .toBe('canaryArcanosGaming');
    expect(response.body.paths?.['/gpt-access/gaming/sources/ingestions']?.post?.operationId)
      .toBe('ingestGamingSources');
    expect(response.body.paths?.['/gpt-access/gaming/sources/refreshes']?.post?.operationId)
      .toBe('refreshGamingSources');
    expect(response.body.paths?.[
      '/gpt-access/gaming/sources/ingestions/{ingestionId}'
    ]?.get?.operationId).toBe('getGamingSourceIngestionStatus');
    expect(Object.keys(response.body.paths ?? {})).toEqual([
      '/gpt/arcanos-gaming',
      '/gpt/arcanos-gaming/canary',
      '/gpt-access/gaming/sources/ingestions',
      '/gpt-access/gaming/sources/refreshes',
      '/gpt-access/gaming/sources/ingestions/{ingestionId}',
    ]);
    expect(response.body.paths?.['/gpt/arcanos-gaming']?.post?.security).toBeUndefined();
    expect(response.body.paths?.['/gpt/arcanos-gaming/canary']?.post?.security).toBeUndefined();
    expect(response.body.paths?.['/gpt-access/gaming/sources/ingestions']?.post?.security)
      .toEqual([{ bearerAuth: [] }]);
  });

  it('serves the dedicated Backstage Booker builder contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/backstage_booker.openapi.v1.json');

    const asyncResultPath =
      '/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result';
    const asyncResultOperation = response.body.paths?.[asyncResultPath]?.get;

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.info?.version).toBe('1.6.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual([
      '/gpt/backstage-booker',
      asyncResultPath,
      '/gpt-access/capabilities/v1/backstage-booker/run',
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}',
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary',
    ]);
    expect(response.body.paths).not.toHaveProperty('/jobs/{jobId}/result');
    expect(response.body.paths?.['/gpt/backstage-booker']?.post?.operationId)
      .toBe('runBackstageBooker');
    expect(response.body.paths?.['/gpt/backstage-booker']?.post?.security)
      .toEqual([{ bearerAuth: [] }]);
    expect(response.body.paths?.['/gpt/backstage-booker']?.post?.['x-openai-isConsequential'])
      .toBe(false);
    expect(asyncResultOperation?.operationId)
      .toBe('getBackstageBookerJobResult');
    expect(asyncResultOperation?.security)
      .toEqual([{ bearerAuth: [] }]);
    expect(asyncResultOperation?.['x-openai-isConsequential']).toBe(false);
    expect(asyncResultOperation?.parameters).toEqual([
      expect.objectContaining({
        name: 'jobId',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ format: 'uuid' }),
      }),
      expect.objectContaining({
        name: 'waitForResultMs',
        in: 'query',
        required: false,
        schema: {
          type: 'integer',
          minimum: 0,
          maximum: 30000,
          default: 30000,
        },
      }),
    ]);
    expect(JSON.stringify(asyncResultOperation?.parameters)).not.toContain(
      'x-arcanos-job-read-token'
    );
    expect(Object.keys(asyncResultOperation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '429', '503'])
    );
    for (const status of ['400', '401', '503']) {
      expect(asyncResultOperation?.responses?.[status]?.content?.['application/json']?.schema)
        .toEqual({ $ref: '#/components/schemas/BackstagePublicErrorResponse' });
    }
    expect(asyncResultOperation?.responses?.['429']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/RateLimitResponse' });
    expect(asyncResultOperation?.responses?.['429']?.headers?.['Retry-After'])
      .toEqual({ $ref: '#/components/headers/RetryAfter' });
    expect(response.body.paths?.['/gpt/backstage-booker']?.post?.responses?.['401']
      ?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/BackstagePublicErrorResponse' });
    const acceptedSchema =
      response.body.components?.schemas?.BackstageAsyncAcceptedResponse;
    expect(acceptedSchema?.required).not.toContain('jobReadToken');
    expect(acceptedSchema?.required).not.toContain('jobReadTokenHeader');
    expect(acceptedSchema?.required).not.toContain('stream');
    expect(acceptedSchema?.properties).not.toHaveProperty('jobReadToken');
    expect(acceptedSchema?.properties).not.toHaveProperty('jobReadTokenHeader');
    expect(acceptedSchema?.properties).not.toHaveProperty('stream');
    expect(acceptedSchema?.properties?.poll?.description).toContain(
      'getBackstageBookerJobResult'
    );
    const resultSchema =
      response.body.components?.schemas?.BackstageJobResultLookup;
    expect(resultSchema?.required).not.toContain('stream');
    expect(resultSchema?.properties).not.toHaveProperty('stream');
    expect(resultSchema?.properties?.poll?.description).toContain(
      'getBackstageBookerJobResult'
    );
    expect(response.body.components?.parameters).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('x-arcanos-job-read-token');
    expect(JSON.stringify(response.body)).not.toContain('jobReadToken');
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/run'
    ]?.post?.operationId).toBe('writeBackstageCanon');
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/run'
    ]?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/run'
    ]?.post?.['x-openai-isConsequential']).toBe(true);
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}'
    ]?.get?.operationId).toBe('getBackstageUniverse');
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}'
    ]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}'
    ]?.get?.['x-openai-isConsequential']).toBe(false);
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary'
    ]?.get?.operationId).toBe('getBackstageStoryline');
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary'
    ]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(response.body.paths?.[
      '/gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary'
    ]?.get?.['x-openai-isConsequential']).toBe(false);
  });

  it('serves the canonical job-result contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/job_result.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual(['/jobs/{jobId}/result']);
    expect(response.body.paths?.['/jobs/{jobId}/result']?.get?.operationId).toBe('getJobResult');
    expect(response.body.components?.schemas?.JobResultLookup?.required).toEqual(
      expect.arrayContaining(['jobId', 'poll', 'stream'])
    );
    expect(response.body.components?.schemas?.RouteError?.properties?.error?.oneOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'string' })])
    );
  });

  it('serves the canonical job-status contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/job_status.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual(['/jobs/{jobId}']);
    expect(response.body.paths?.['/jobs/{jobId}']?.get?.operationId).toBe('getJobStatus');
    expect(response.body.components?.schemas?.JobStatus?.required).toEqual(
      expect.arrayContaining(['id', 'jobId', 'poll', 'stream'])
    );
    expect(response.body.components?.schemas?.RouteError?.properties?.error?.oneOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'string' })])
    );
  });

  it('serves the authenticated ActionPlan execution contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/action_plan_execution.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.paths?.['/plans/{planId}/execute']?.post?.operationId)
      .toBe('requestActionPlanExecution');
    expect(response.body.paths?.['/plans/{planId}/executions/{runId}/result']?.post?.operationId)
      .toBe('submitActionPlanExecutionResult');
    for (const pathItem of Object.values(response.body.paths ?? {})) {
      for (const operation of Object.values(pathItem as Record<string, unknown>)) {
        const typed = operation as { operationId?: string; security?: unknown[] };
        if (typed.operationId) {
          expect(typed.security).toBeDefined();
          expect(typed.security).not.toHaveLength(0);
        }
      }
    }
  });

  it('serves the Custom GPT bridge OpenAPI contract with the smoke action documented', async () => {
    const response = await request(buildApp())
      .get('/openapi/custom-gpt-bridge.yaml');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toContain('yaml');
    expect(response.text).toContain('/api/bridge/gpt');
    expect(response.text).toContain('version: 1.2.0');
    expect(response.text).toContain('health_echo');
    expect(response.text).toContain('query_and_wait');
    expect(response.text).toContain('env:');
    expect(response.text).toContain('OPENAI_ACTION_SHARED_SECRET:');

    const healthOperation = response.text
      .split('/api/bridge/health:')[1]
      ?.split('/jobs/{jobId}:')[0] ?? '';
    expect(healthOperation).toContain('security:');
    expect(healthOperation).toContain('bearerAuth:');
    expect(healthOperation).toContain('openaiActionSecretHeader:');
    expect(healthOperation).toContain('actionSecretHeader:');
    expect(healthOperation).toContain('"401":');
    expect(healthOperation).toContain('oneOf:');
    expect(healthOperation).toContain('BridgeHealthResponse');
    expect(healthOperation).toContain('BridgeErrorResponse');

    const pendingSchema = response.text.split('BridgePendingResponse:')[1]?.split('BridgeErrorResponse:')[0] ?? '';
    expect(pendingSchema).toContain('result:');
    expect(pendingSchema).toContain('job_status:');
    expect(pendingSchema).not.toContain('stream:');
    const createOperation =
      response.text.split('/api/bridge/gpt:')[1]?.split('/api/bridge/health:')[0] ?? '';
    expect(createOperation).toContain('#/components/parameters/idempotencyKey');
    expect(createOperation).toContain('"404":');
    expect(createOperation).toContain('"410":');
  });

  it('excludes protected catalog modules from public GPT introspection', async () => {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
    const response = await request(buildApp()).get('/_introspection');
    const protectedIdentifiers = [
      'cli',
      'arcanos-cli',
      'ARCANOS:CLI',
      'local-agent',
      'arcanos-local-agent',
      'ARCANOS:LOCAL_AGENT',
      'productivity',
      'arcanos-productivity',
      'ARCANOS:PRODUCTIVITY'
    ];
    const protectedLookups = await Promise.all(
      protectedIdentifiers.map((identifier) =>
        request(buildApp()).get(
          `/_introspection/gpt/${encodeURIComponent(identifier)}`
        )
      )
    );
    const moduleNames = response.body.modules.map(
      (entry: { name: string }) => entry.name
    );

    expect(response.status).toBe(200);
    expect(response.body.counts.modules).toBe(12);
    expect(moduleNames).not.toContain('ARCANOS:CLI');
    expect(moduleNames).not.toContain('ARCANOS:LOCAL_AGENT');
    expect(moduleNames).not.toContain('ARCANOS:PRODUCTIVITY');
    expect(response.body.gptMap).not.toHaveProperty('cli');
    expect(response.body.gptMap).not.toHaveProperty('local-agent');
    expect(response.body.gptMap).not.toHaveProperty('productivity');
    for (const lookup of protectedLookups) {
      expect(lookup.status).toBe(404);
      expect(lookup.body).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: 'UNKNOWN_GPT'
          })
        })
      );
    }
  });
});
