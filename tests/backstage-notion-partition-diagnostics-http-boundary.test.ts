import express, {
  type Request,
} from 'express';
import request from 'supertest';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import {
  backstageNotionPartitionSyncBodyParser,
} from '../src/services/controlPlane/backstageNotionPartitionSyncBodyParser.js';
import {
  createBackstageNotionPartitionSyncHttpBoundary,
  resolveBackstageNotionPartitionSyncHttpOperation,
} from '../src/services/controlPlane/backstageNotionPartitionSyncHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const UNIVERSE_ID = 'my-universe-2k26';
const SYNC_ID = '11111111-1111-4111-8111-111111111111';
const CONTROL_PLANE_TOKEN = `partition-diagnostics-${'x'.repeat(40)}`;
const NAMESPACE = '/api/backstage/notion-partitions';
const DIAGNOSTICS_PATH = `${NAMESPACE}/${UNIVERSE_ID}/diagnostics`;
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
  principalSequence += 1;
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = CONTROL_PLANE_TOKEN;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:partition-diagnostics:${principalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authorized(pendingRequest: request.Test): request.Test {
  return pendingRequest.set('Authorization', `Bearer ${CONTROL_PLANE_TOKEN}`);
}

function buildApp(options: {
  readonly maxClientRequests?: number;
  readonly maxPrincipalRequests?: number;
  readonly handlerCalls?: { value: number };
} = {}): express.Express {
  const app = express();
  app.use(NAMESPACE, createBackstageNotionPartitionSyncHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    maxPrincipalRequests: options.maxPrincipalRequests ?? 100,
    windowMs: 60_000,
  }));
  app.use(NAMESPACE, backstageNotionPartitionSyncBodyParser);
  app.get(`${NAMESPACE}/:universeId/diagnostics`, (req, res) => {
    if (options.handlerCalls) {
      options.handlerCalls.value += 1;
    }
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    res.status(200).json({
      ok: true,
      kind: operation?.kind,
      universeId: operation?.universeId,
    });
  });
  app.get(`${NAMESPACE}/:universeId/syncs/:syncId`, (req, res) => {
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    res.status(200).json({ ok: true, kind: operation?.kind });
  });
  return app;
}

function directRequest(
  method: string,
  originalUrl: string,
  path = originalUrl
): Request {
  return {
    method,
    originalUrl,
    url: originalUrl,
    path,
    baseUrl: '',
  } as Request;
}

describe('Backstage Notion partition diagnostics HTTP boundary', () => {
  beforeEach(() => {
    configureControlPlane();
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

  it('classifies only exact bodyless GET and HEAD diagnostics paths', () => {
    expect(resolveBackstageNotionPartitionSyncHttpOperation(
      directRequest('GET', DIAGNOSTICS_PATH)
    )).toEqual({ kind: 'diagnostics', universeId: UNIVERSE_ID });
    expect(resolveBackstageNotionPartitionSyncHttpOperation(
      directRequest('HEAD', DIAGNOSTICS_PATH)
    )).toEqual({ kind: 'diagnostics', universeId: UNIVERSE_ID });

    for (const candidate of [
      directRequest('POST', DIAGNOSTICS_PATH),
      directRequest('PUT', DIAGNOSTICS_PATH),
      directRequest('GET', `${DIAGNOSTICS_PATH}?verbose=true`),
      directRequest('GET', `${DIAGNOSTICS_PATH}/`),
      directRequest('GET', `${DIAGNOSTICS_PATH}/extra`),
      directRequest(
        'GET',
        `${NAMESPACE}/%6dy-universe-2k26/diagnostics`
      ),
      directRequest(
        'GET',
        `${NAMESPACE}/${UNIVERSE_ID}\\diagnostics`
      ),
      directRequest(
        'GET',
        `${NAMESPACE}/${UNIVERSE_ID}/diagnostics%00`
      ),
    ]) {
      expect(resolveBackstageNotionPartitionSyncHttpOperation(candidate)).toBeNull();
    }
  });

  it('authenticates and authorizes before the parser or handler can inspect a body', async () => {
    const handlerCalls = { value: 0 };
    const app = buildApp({ handlerCalls });
    const unauthenticated = await request(app)
      .get(DIAGNOSTICS_PATH)
      .set('Content-Type', 'application/json')
      .send('{');

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(unauthenticated.headers['cache-control']).toBe('no-store');
    expect(handlerCalls.value).toBe(0);

    configureControlPlane('arcanos:read');
    const wrongScope = await authorized(request(app).get(DIAGNOSTICS_PATH));
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(handlerCalls.value).toBe(0);
  });

  it('applies no-store, security headers, and a distinct diagnostics rate bucket', async () => {
    const app = buildApp();
    const diagnostics = await authorized(request(app).get(DIAGNOSTICS_PATH));
    const head = await authorized(request(app).head(DIAGNOSTICS_PATH));
    const syncStatus = await authorized(request(app).get(
      `${NAMESPACE}/${UNIVERSE_ID}/syncs/${SYNC_ID}`
    ));

    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body).toEqual({
      ok: true,
      kind: 'diagnostics',
      universeId: UNIVERSE_ID,
    });
    expect(diagnostics.headers['cache-control']).toBe('no-store');
    expect(diagnostics.headers.pragma).toBe('no-cache');
    expect(diagnostics.headers['x-content-type-options']).toBe('nosniff');
    expect(diagnostics.headers['x-frame-options']).toBe('DENY');
    expect(diagnostics.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-partition-diagnostics'
    );
    expect(head.status).toBe(200);
    expect(head.text).toBeUndefined();
    expect(head.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-partition-diagnostics'
    );
    expect(syncStatus.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-partition-sync-status'
    );
  });

  it('rejects bodies and every non-canonical HTTP request before the handler', async () => {
    const handlerCalls = { value: 0 };
    const app = buildApp({ handlerCalls });
    const body = await authorized(
      request(app)
        .get(DIAGNOSTICS_PATH)
        .set('Content-Type', 'application/json')
        .send({ verbose: true })
    );
    expect(body.status).toBe(400);
    expect(body.body.error.code).toBe(
      'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID'
    );

    const rejected = await Promise.all([
      request(app).get(`${DIAGNOSTICS_PATH}?verbose=true`),
      request(app).get(`${DIAGNOSTICS_PATH}/`),
      request(app).get(`${DIAGNOSTICS_PATH}/extra`),
      request(app).post(DIAGNOSTICS_PATH),
      request(app).put(DIAGNOSTICS_PATH),
      request(app).get(`${NAMESPACE}/%6dy-universe-2k26/diagnostics`),
      request(app).get(`${NAMESPACE}/${UNIVERSE_ID}/diagnostics%00`),
    ].map(pending => authorized(pending)));
    for (const response of rejected) {
      expect(response.status).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(handlerCalls.value).toBe(0);
  });
});
