import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const codebaseRouter = (await import('../src/routes/api-codebase.js')).default;

const controlPlaneAccessToken = 'codebase-route-token-1234567890abcdef';
const controlPlaneEnvironmentNames = [
  'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  'ARCANOS_CONTROL_PLANE_SCOPES',
] as const;
const originalControlPlaneEnvironment = new Map(
  controlPlaneEnvironmentNames.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);

function buildApp() {
  const app = express();
  app.use('/api/codebase', codebaseRouter);
  return app;
}

function configureControlPlane(scopes = 'repo:read'): void {
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:codebase-test';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authorized(requestBuilder: any): any {
  return requestBuilder.set('Authorization', `Bearer ${controlPlaneAccessToken}`);
}

describe('/api/codebase control-plane authentication', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('rejects anonymous reads before repository access', async () => {
    const response = await request(buildApp()).get('/api/codebase/tree');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    delete process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;

    const response = await authorized(
      request(buildApp()).get('/api/codebase/tree')
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it('requires the repository read scope', async () => {
    configureControlPlane('arcanos:read');

    const response = await authorized(
      request(buildApp()).get('/api/codebase/tree')
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('allows an authorized repository listing without cacheable output', async () => {
    const response = await authorized(
      request(buildApp()).get('/api/codebase/tree')
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      status: 'success',
      data: expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ name: 'src', type: 'directory' }),
          expect.objectContaining({ name: 'package.json', type: 'file' }),
        ]),
      }),
    }));
  });

  it('does not disclose filesystem errors and terminates unknown subpaths', async () => {
    const traversalResponse = await authorized(
      request(buildApp()).get('/api/codebase/file').query({ path: '../package.json' })
    );
    const unknownResponse = await authorized(
      request(buildApp()).post('/api/codebase/unknown')
    );

    expect(traversalResponse.status).toBe(400);
    expect(traversalResponse.body.message).toBe('Unable to read file');
    expect(JSON.stringify(traversalResponse.body)).not.toContain('outside');
    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
  });

  it('rejects malformed and out-of-range file bounds', async () => {
    for (const query of [
      { path: 'package.json', maxBytes: '-1' },
      { path: 'package.json', maxBytes: '1.5' },
      { path: 'package.json', maxBytes: '262145' },
      { path: 'package.json', startLine: '0' },
      { path: 'package.json', startLine: '3', endLine: '2' },
    ]) {
      const response = await authorized(
        request(buildApp()).get('/api/codebase/file').query(query)
      );

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Unable to read file');
    }
  });
});

afterAll(() => {
  for (const [environmentName, value] of originalControlPlaneEnvironment) {
    if (value === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = value;
    }
  }
});
