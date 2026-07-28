import express from 'express';
import request from 'supertest';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';

import {
  ASSISTANT_REGISTRY_SYNC_BODY_LIMIT_BYTES,
  assistantRegistryBodyParser,
} from '../src/services/controlPlane/assistantRegistryBodyParser.js';
import {
  createAssistantRegistryHttpBoundary,
} from '../src/services/controlPlane/assistantRegistryHttpBoundary.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken =
  'assistant-boundary-token-123456789012345678901';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let testPrincipalSequence = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = 'arcanos:read,mcp:invoke',
  principalId = `operator:assistant-boundary:${testPrincipalSequence}`
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authorized(pendingRequest: request.Test): request.Test {
  return pendingRequest.set(
    'Authorization',
    `Bearer ${controlPlaneToken}`
  );
}

function buildApp(options: {
  maxClientRequests?: number;
  windowMs?: number;
  syncHandler?: express.RequestHandler;
} = {}): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use('/api/assistants', createAssistantRegistryHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: options.windowMs ?? 60_000,
  }));
  app.use('/api/assistants', assistantRegistryBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.get('/api/assistants', (_req, res) => {
    res.status(200).json({ route: 'list' });
  });
  app.get('/api/assistants/:name', (req, res) => {
    res.status(200).json({ route: 'detail', name: req.params.name });
  });
  app.post(
    '/api/assistants/sync',
    options.syncHandler ?? ((_req, res) => {
      res.status(200).json({ route: 'sync' });
    })
  );
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status((error as { status?: number }).status ?? 500).json({
      code: 'BROAD_PARSER_REJECTED',
    });
  });
  return app;
}

describe('assistant registry HTTP ingress boundary', () => {
  beforeEach(() => {
    testPrincipalSequence += 1;
    configureControlPlane();
  });

  it('authenticates before parsing malformed or oversized sync bodies', async () => {
    const app = buildApp();
    const malformed = await request(app)
      .post('/api/assistants/sync')
      .set('Content-Type', 'application/json')
      .send('{');
    const oversized = await request(app)
      .post('/api/assistants/sync')
      .send({ value: 'x'.repeat(ASSISTANT_REGISTRY_SYNC_BODY_LIMIT_BYTES) });

    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(oversized.status).toBe(401);
    expect(oversized.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });

  it('separates read and sync scopes and marks responses no-store', async () => {
    configureControlPlane('arcanos:read');
    const readApp = buildApp();
    const reads = await Promise.all([
      authorized(request(readApp).get('/api/assistants')),
      authorized(request(readApp).get('/api/assistants/')),
      authorized(request(readApp).get('/api/assistants/alpha')),
      authorized(request(readApp).head('/api/assistants/alpha/')),
    ]);
    const syncDenied = await authorized(
      request(readApp).post('/api/assistants/sync')
    ).send({});

    expect(reads.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    for (const response of reads) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.headers['x-ratelimit-bucket']).toBe(
        'assistant-registry-read'
      );
    }
    expect(syncDenied.status).toBe(403);
    expect(syncDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');

    configureControlPlane('mcp:invoke');
    const syncApp = buildApp();
    const sync = await authorized(
      request(syncApp).post('/api/assistants/sync/')
    ).send({});
    const readDenied = await authorized(
      request(syncApp).get('/api/assistants')
    );

    expect(sync.status).toBe(200);
    expect(sync.headers['x-ratelimit-bucket']).toBe(
      'assistant-registry-sync'
    );
    expect(readDenied.status).toBe(403);
    expect(readDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('accepts one optional trailing slash and rejects non-canonical paths', async () => {
    const app = buildApp();
    const responses = await Promise.all([
      authorized(request(app).get('/api/assistants//')),
      authorized(request(app).get('/api/assistants/alpha//')),
      authorized(request(app).get('/api/assistants/alpha/beta')),
      authorized(request(app).get('/API/assistants')),
      authorized(request(app).put('/api/assistants/sync')).send({}),
      authorized(request(app).get('/api/assistants/%2F')),
      authorized(request(app).get('/api/assistants/%ZZ')),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: 'Route Not Found',
        code: 404,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('accepts only a strict empty JSON object for sync', async () => {
    const freshApp = (): express.Express => {
      testPrincipalSequence += 1;
      configureControlPlane();
      return buildApp();
    };
    const malformed = await authorized(
      request(freshApp())
        .post('/api/assistants/sync')
        .set('Content-Type', 'application/json')
        .send('{')
    );
    const missing = await authorized(
      request(freshApp()).post('/api/assistants/sync')
    );
    const primitive = await authorized(
      request(freshApp())
        .post('/api/assistants/sync')
        .set('Content-Type', 'application/json')
        .send('true')
    );
    const nonEmpty = await authorized(
      request(freshApp()).post('/api/assistants/sync')
    ).send({ force: true });
    const unsupported = await authorized(
      request(freshApp())
        .post('/api/assistants/sync')
        .set('Content-Type', 'text/plain')
        .send('{}')
    );
    const compressed = await authorized(
      request(freshApp())
        .post('/api/assistants/sync')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('{}')
    );
    const oversized = await authorized(
      request(freshApp()).post('/api/assistants/sync')
    ).send({ value: 'x'.repeat(ASSISTANT_REGISTRY_SYNC_BODY_LIMIT_BYTES) });
    const vendorJson = await authorized(
      request(freshApp())
        .post('/api/assistants/sync')
        .set('Content-Type', 'application/vnd.arcanos+json')
        .send('{}')
    );

    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(primitive.status).toBe(400);
    expect(nonEmpty.status).toBe(400);
    expect(unsupported.status).toBe(415);
    expect(compressed.status).toBe(415);
    expect(oversized.status).toBe(413);
    expect(vendorJson.status).toBe(200);
    for (const response of [
      malformed,
      missing,
      primitive,
      nonEmpty,
      unsupported,
      compressed,
      oversized,
    ]) {
      expect(response.body.error.code).toBe(
        'ASSISTANT_REGISTRY_REQUEST_INVALID'
      );
      expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    }
  });

  it('rejects bodies on reads', async () => {
    configureControlPlane('arcanos:read');
    const response = await authorized(
      request(buildApp())
        .get('/api/assistants')
        .set('Content-Type', 'application/json')
        .send({})
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(
      'ASSISTANT_REGISTRY_REQUEST_INVALID'
    );
  });

  it('keeps invalid-address throttling separate from authenticated traffic', async () => {
    const app = buildApp({
      maxClientRequests: 1,
      windowMs: 60_000,
    });
    const clientAddress = '198.51.100.48';
    const invalidAuthorization = [
      'Bearer',
      'invalid-assistant-token',
    ].join(' ');
    const invalid = await request(app)
      .get('/api/assistants')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', invalidAuthorization);
    const throttled = await request(app)
      .get('/api/assistants')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', invalidAuthorization);
    const authenticated = await authorized(
      request(app).get('/api/assistants')
    ).set('X-Forwarded-For', clientAddress);

    expect(invalid.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
  });

  it('limits sync starts to five per authenticated principal', async () => {
    const app = buildApp();
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await authorized(
        request(app).post('/api/assistants/sync')
      ).send({}));
    }

    expect(responses.slice(0, 5).map((response) => response.status)).toEqual(
      [200, 200, 200, 200, 200]
    );
    expect(responses[5].status).toBe(429);
    expect(responses[5].headers['x-ratelimit-bucket']).toBe(
      'assistant-registry-sync'
    );
  });

  it('limits reads to 120 per authenticated principal', async () => {
    configureControlPlane('arcanos:read');
    const app = buildApp();
    const responses = [];
    for (let attempt = 0; attempt < 121; attempt += 1) {
      responses.push(await authorized(
        request(app).get('/api/assistants')
      ));
    }

    expect(responses.slice(0, 120).every(
      (response) => response.status === 200
    )).toBe(true);
    expect(responses[120].status).toBe(429);
    expect(responses[120].headers['x-ratelimit-bucket']).toBe(
      'assistant-registry-read'
    );
  });

  it('rejects a concurrent sync with a bounded retry hint', async () => {
    let releaseSync!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const app = buildApp({
      syncHandler: async (_req, res) => {
        markStarted();
        await held;
        res.status(200).json({ route: 'sync' });
      },
    });

    const first = authorized(
      request(app).post('/api/assistants/sync')
    ).send({}).then((response) => response);
    await started;
    const concurrent = await authorized(
      request(app).post('/api/assistants/sync')
    ).send({});
    releaseSync();
    const completed = await first;

    expect(concurrent.status).toBe(409);
    expect(concurrent.headers['retry-after']).toBe('5');
    expect(concurrent.body.error.code).toBe(
      'ASSISTANT_REGISTRY_SYNC_IN_PROGRESS'
    );
    expect(completed.status).toBe(200);
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
