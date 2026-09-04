import express from 'express';
import request from 'supertest';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { createApp } from '../src/app.js';
import {
  createApiBackstageNotionPartitionsRouter,
} from '../src/routes/api-backstage-notion-partitions.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const UNIVERSE_ID = 'my-universe-2k26';
const CONTROL_PLANE_TOKEN = `authority-status-boundary-${'x'.repeat(40)}`;
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    environmentName => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let principalSequence = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes = 'backstage:notion-sync'): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = CONTROL_PLANE_TOKEN;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:authority-status:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authorized(pending: request.Test): request.Test {
  return pending.set('Authorization', `Bearer ${CONTROL_PLANE_TOKEN}`);
}

function buildRouteApp(
  getAuthorityStatus: NonNullable<Parameters<
    typeof createApiBackstageNotionPartitionsRouter
  >[0]['getAuthorityStatus']>
): express.Express {
  const app = express();
  app.use(
    '/api/backstage/notion-partitions',
    createApiBackstageNotionPartitionsRouter({ getAuthorityStatus })
  );
  return app;
}

function successfulResult() {
  return {
    statusCode: 200,
    payload: {
      ok: true,
      data: {
        version: 1,
        surface: 'monolith_authority',
        authority: 'notion',
        status: 'current_complete',
        snapshotStatus: 'current_complete',
        freshnessSatisfied: true,
        syncInProgress: false,
        activeSnapshotReadable: true,
        activeSnapshotChunkCount: 3,
        latestSyncOutcome: 'unchanged',
        latestSyncFailurePhase: null,
        latestSyncFailureReason: null,
      },
    },
  };
}

describe('Backstage Notion monolith authority status protected route', () => {
  beforeEach(() => {
    principalSequence += 1;
    configureControlPlane();
  });

  it('authenticates and authorizes before reading authority state', async () => {
    const getAuthorityStatus = jest.fn(async () => successfulResult());
    const app = buildRouteApp(getAuthorityStatus);

    const unauthenticated = await request(app).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(getAuthorityStatus).not.toHaveBeenCalled();

    configureControlPlane('arcanos:read');
    const unauthorized = await authorized(request(app).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    ));
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(getAuthorityStatus).not.toHaveBeenCalled();
  });

  it('returns the bounded GET projection with no-store and its own rate bucket', async () => {
    const getAuthorityStatus = jest.fn(async () => successfulResult());
    const response = await authorized(request(
      buildRouteApp(getAuthorityStatus)
    ).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    ));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-authority-status'
    );
    expect(response.body).toEqual(successfulResult().payload);
    expect(getAuthorityStatus).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      dependencies: { readEnvironment: expect.any(Function) },
    });
  });

  it('routes HEAD through the same authenticated GET handler without a body', async () => {
    const getAuthorityStatus = jest.fn(async () => successfulResult());
    const response = await authorized(request(
      buildRouteApp(getAuthorityStatus)
    ).head(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    ));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-authority-status'
    );
    expect(response.text).toBeUndefined();
    expect(getAuthorityStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects noncanonical and body-bearing reads before the service', async () => {
    const getAuthorityStatus = jest.fn(async () => successfulResult());
    const app = buildRouteApp(getAuthorityStatus);
    const query = await authorized(request(app).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status?raw=true`
    ));
    const trailing = await authorized(request(app).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status/`
    ));
    const body = await authorized(request(app)
      .get(`/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`)
      .set('Content-Type', 'application/json')
      .send({ raw: true }));

    expect(query.status).toBe(404);
    expect(trailing.status).toBe(404);
    expect(body.status).toBe(400);
    expect(body.body.error.code).toBe(
      'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID'
    );
    expect(getAuthorityStatus).not.toHaveBeenCalled();
  });

  it('preserves fixed unavailable responses and contains unexpected failures', async () => {
    const unavailable = await authorized(request(buildRouteApp(async () => ({
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE',
          message: 'Notion authority status is unavailable.',
        },
      },
    }))).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    ));
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe(
      'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE'
    );

    principalSequence += 1;
    configureControlPlane();
    const failed = await authorized(request(buildRouteApp(async () => {
      throw new Error('hostile-root-id database-password=secret');
    })).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    ));
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_AUTHORITY_STATUS_INTERNAL_ERROR',
        message: 'Failed to read Notion authority status.',
      },
    });
    expect(JSON.stringify(failed.body)).not.toContain('hostile-root-id');
    expect(JSON.stringify(failed.body)).not.toContain('secret');
  });

  it('is recognized by the application-level pre-parser boundary', async () => {
    const response = await authorized(request(createApp()).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/authority-status`
    ));

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(
      'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE'
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
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
