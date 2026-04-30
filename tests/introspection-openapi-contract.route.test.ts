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
    expect(Object.keys(response.body.paths ?? {})).toEqual(['/gpt/{gptId}']);
    expect(response.body.paths?.['/gpt/{gptId}']?.post?.operationId).toBe('invokeGptRoute');
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

  it('serves the canonical job-result contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/job_result.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual(['/jobs/{jobId}/result']);
    expect(response.body.paths?.['/jobs/{jobId}/result']?.get?.operationId).toBe('getJobResult');
  });

  it('serves the canonical job-status contract with no-store caching', async () => {
    const response = await request(buildApp())
      .get('/contracts/job_status.openapi.v1.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.openapi).toBe('3.1.0');
    expect(Object.keys(response.body.paths ?? {})).toEqual(['/jobs/{jobId}']);
    expect(response.body.paths?.['/jobs/{jobId}']?.get?.operationId).toBe('getJobStatus');
  });

  it('serves the Custom GPT bridge OpenAPI contract with the smoke action documented', async () => {
    const response = await request(buildApp())
      .get('/openapi/custom-gpt-bridge.yaml');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toContain('yaml');
    expect(response.text).toContain('/api/bridge/gpt');
    expect(response.text).toContain('health_echo');
    expect(response.text).toContain('query_and_wait');
    expect(response.text).toContain('env:');
    expect(response.text).toContain('OPENAI_ACTION_SHARED_SECRET:');

    const pendingSchema = response.text.split('BridgePendingResponse:')[1]?.split('BridgeErrorResponse:')[0] ?? '';
    expect(pendingSchema).toContain('result:');
    expect(pendingSchema).toContain('job_status:');
    expect(pendingSchema).not.toContain('stream:');
  });
});
