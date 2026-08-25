import express from 'express';
import request from 'supertest';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

import {
  createApiBackstageNotionPartitionsRouter,
} from '../src/routes/api-backstage-notion-partitions.js';
import type {
  GetBackstageNotionPartitionDiagnosticsInput,
} from '../src/services/backstageNotionPartitionDiagnostics.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const UNIVERSE_ID = 'my-universe-2k26';
const HOT_ROOT_CANARY = '99999999-9999-4999-8999-999999999999';
const PATH = `/api/backstage/notion-partitions/${UNIVERSE_ID}/diagnostics`;
const TOKEN = `partition-diagnostics-route-${'x'.repeat(40)}`;
const originalCredentials = new Map(PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
  name => [name, process.env[name]] as const
));
const originalPrincipal = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let principalSequence = 0;

function clearCredentials(): void {
  for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[name];
  }
}

function configureControlPlane(): void {
  principalSequence += 1;
  clearCredentials();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = TOKEN;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:partition-diagnostics-route:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'backstage:notion-sync';
}

function authorized(pending: request.Test): request.Test {
  return pending.set('Authorization', `Bearer ${TOKEN}`);
}

function appWithDiagnostics(
  getDiagnostics: (
    input: GetBackstageNotionPartitionDiagnosticsInput
  ) => Promise<{ statusCode: number; payload: Record<string, unknown> }>,
  errorLog = jest.fn()
): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    req.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: errorLog,
    } as never;
    next();
  });
  app.use(
    '/api/backstage/notion-partitions',
    createApiBackstageNotionPartitionsRouter({
      readEnvironment: () => undefined,
      getDiagnostics,
    })
  );
  return app;
}

describe('Backstage Notion partition diagnostics protected route', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  afterAll(() => {
    clearCredentials();
    for (const [name, value] of originalCredentials) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
    if (originalPrincipal === undefined) {
      delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
    } else {
      process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipal;
    }
    if (originalScopes === undefined) {
      delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
    } else {
      process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
    }
  });

  test('calls the bounded diagnostic service only after protected admission', async () => {
    const getDiagnostics = jest.fn(async () => ({
      statusCode: 200,
      payload: {
        ok: true,
        data: {
          version: 1,
          universeId: UNIVERSE_ID,
          shards: [],
        },
      },
    }));
    const app = appWithDiagnostics(getDiagnostics);

    const denied = await request(app).get(PATH);
    expect(denied.status).toBe(401);
    expect(getDiagnostics).not.toHaveBeenCalled();

    const admitted = await authorized(request(app).get(PATH));
    expect(admitted.status).toBe(200);
    expect(admitted.headers['cache-control']).toBe('no-store');
    expect(admitted.body).toEqual({
      ok: true,
      data: { version: 1, universeId: UNIVERSE_ID, shards: [] },
    });
    expect(getDiagnostics).toHaveBeenCalledTimes(1);
    expect(getDiagnostics).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      dependencies: { readEnvironment: expect.any(Function) },
    });
  });

  test('preserves fixed service failures and bounds unexpected errors', async () => {
    const expectedFailure = jest.fn(async () => ({
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_UNAVAILABLE',
          message: 'Partition diagnostics are unavailable.',
        },
      },
    }));
    const expectedResponse = await authorized(
      request(appWithDiagnostics(expectedFailure)).get(PATH)
    );
    expect(expectedResponse.status).toBe(503);
    expect(expectedResponse.body.error.code).toBe(
      'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_UNAVAILABLE'
    );

    const errorLog = jest.fn();
    const unexpected = jest.fn(async () => {
      throw new Error(`provider-secret-${HOT_ROOT_CANARY}`);
    });
    const unexpectedResponse = await authorized(
      request(appWithDiagnostics(unexpected, errorLog)).get(PATH)
    );
    expect(unexpectedResponse.status).toBe(500);
    expect(unexpectedResponse.body).toEqual({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_INTERNAL_ERROR',
        message: 'Failed to read partition diagnostics.',
      },
    });
    expect(JSON.stringify(unexpectedResponse.body)).not.toContain('provider-secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('provider-secret');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(HOT_ROOT_CANARY);
  });

  test('serves HEAD through the same protected read without a response body', async () => {
    const getDiagnostics = jest.fn(async () => ({
      statusCode: 200,
      payload: { ok: true, data: { version: 1 } },
    }));
    const response = await authorized(
      request(appWithDiagnostics(getDiagnostics)).head(PATH)
    );

    expect(response.status).toBe(200);
    expect(response.text).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(getDiagnostics).toHaveBeenCalledTimes(1);
  });
});
