import express, {
  type Request,
  type Response,
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
  BACKSTAGE_NOTION_PARTITION_SYNC_BODY_LIMIT_BYTES,
  backstageNotionPartitionSyncBodyParser,
  getBackstageNotionPartitionSyncParsedRequest,
} from '../src/services/controlPlane/backstageNotionPartitionSyncBodyParser.js';
import {
  requireBackstageNotionPartitionSyncConfirmation,
} from '../src/services/controlPlane/backstageNotionPartitionSyncConfirmation.js';
import {
  createBackstageNotionPartitionSyncHttpBoundary,
  resolveBackstageNotionPartitionSyncHttpOperation,
} from '../src/services/controlPlane/backstageNotionPartitionSyncHttpBoundary.js';
import {
  createApiBackstageNotionPartitionsRouter,
} from '../src/routes/api-backstage-notion-partitions.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';
import type {
  EnqueueBackstageNotionPartitionSyncOperationInput,
  GetBackstageNotionPartitionSyncOperationStatusInput,
} from '../src/services/backstageNotionPartitionSyncOperations.js';
import { createApp } from '../src/app.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const UNIVERSE_ID = 'my-universe-2k26';
const SHARD_KEY = 'raw/year-1';
const SYNC_ID = '11111111-1111-4111-8111-111111111111';
const CONTROL_PLANE_TOKEN = `partition-sync-boundary-${'x'.repeat(40)}`;
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    environmentName => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
const originalPartitionMode =
  process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME];
const originalPartitionConfiguration =
  process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME];
let principalSequence = 0;

function invokeBodyParserWithRawHeaders(
  rawHeaders: string[]
): Readonly<{
  statusCode: number;
  body: unknown;
  nextCalled: boolean;
}> {
  const routePath =
    `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`;
  const headerValues = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase();
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) {
      continue;
    }
    headerValues.set(name, [...(headerValues.get(name) ?? []), value]);
  }
  const req = {
    method: 'POST',
    originalUrl: routePath,
    url: routePath,
    path: routePath,
    baseUrl: '',
    rawHeaders,
    body: { version: 1, shardKey: SHARD_KEY },
    get: (name: string): string | undefined => {
      const values = headerValues.get(name.toLowerCase());
      return values?.join(', ');
    },
  } as unknown as Request;
  const responseState: {
    statusCode: number;
    body: unknown;
    headers: Map<string, string>;
    headersSent: boolean;
    writableEnded: boolean;
  } = {
    statusCode: 200,
    body: undefined,
    headers: new Map(),
    headersSent: false,
    writableEnded: false,
  };
  const res = {
    get headersSent(): boolean {
      return responseState.headersSent;
    },
    get writableEnded(): boolean {
      return responseState.writableEnded;
    },
    setHeader(name: string, value: string): Response {
      responseState.headers.set(name.toLowerCase(), value);
      return this as unknown as Response;
    },
    status(statusCode: number): Response {
      responseState.statusCode = statusCode;
      return this as unknown as Response;
    },
    json(body: unknown): Response {
      responseState.body = body;
      responseState.headersSent = true;
      responseState.writableEnded = true;
      return this as unknown as Response;
    },
  } as unknown as Response;
  let nextCalled = false;
  backstageNotionPartitionSyncBodyParser(req, res, () => {
    nextCalled = true;
  });
  return Object.freeze({
    statusCode: responseState.statusCode,
    body: responseState.body,
    nextCalled,
  });
}

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = 'backstage:notion-sync',
  principalId = `operator:partition-sync:${principalSequence}`
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = CONTROL_PLANE_TOKEN;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function authorized(pendingRequest: request.Test): request.Test {
  return pendingRequest.set(
    'Authorization',
    `Bearer ${CONTROL_PLANE_TOKEN}`
  );
}

function validCreate(
  app: express.Express,
  idempotencyKey = 'partition-sync-key-1'
): request.Test {
  return authorized(
    request(app)
      .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
      .set('Idempotency-Key', idempotencyKey)
  ).send({ version: 1, shardKey: SHARD_KEY });
}

function buildPartitionConfiguration(generation = 'generation-1'): string {
  return JSON.stringify({
    version: 1,
    generation,
    universes: [{
      universeId: UNIVERSE_ID,
      shards: [{
        shardKey: SHARD_KEY,
        rootPageId: '11111111-2222-4333-8444-555555555555',
        displayName: 'Raw Year 1',
        retrievalTier: 'hot',
        required: true,
        scopeTags: ['raw'],
        categoryTags: ['current'],
        capacity: {
          maxPages: 512,
          maxChunks: 2_048,
          maxDepth: 16,
          maxContentCodePoints: 4_000_000,
        },
      }],
    }],
  });
}

function buildApp(options: {
  maxClientRequests?: number;
  maxPrincipalRequests?: number;
  windowMs?: number;
  confirmationState?: {
    configurationGeneration: string;
    configurationDigest: string;
    effects: number;
  };
} = {}): express.Express {
  const app = express();
  const namespace = '/api/backstage/notion-partitions';
  app.use(namespace, createBackstageNotionPartitionSyncHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    maxPrincipalRequests: options.maxPrincipalRequests ?? 100,
    windowMs: options.windowMs ?? 60_000,
  }));
  app.use(namespace, backstageNotionPartitionSyncBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.post(`${namespace}/:universeId/syncs`, (req, res) => {
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    const parsed = getBackstageNotionPartitionSyncParsedRequest(req);
    if (!operation || operation.kind !== 'create' || !parsed) {
      res.status(500).json({ code: 'TEST_BOUNDARY_CONTEXT_MISSING' });
      return;
    }
    const proceed = (): void => {
      if (options.confirmationState) {
        options.confirmationState.effects += 1;
      }
      res.status(202).json({
        ok: true,
        universeId: operation.universeId,
        shardKey: parsed.body.shardKey,
      });
    };
    if (!options.confirmationState) {
      proceed();
      return;
    }
    requireBackstageNotionPartitionSyncConfirmation(
      req,
      res,
      proceed,
      {
        universeId: operation.universeId,
        request: parsed.body,
        idempotencyKey: parsed.idempotencyKey,
        configurationGeneration:
          options.confirmationState.configurationGeneration,
        configurationDigest: options.confirmationState.configurationDigest,
      }
    );
  });
  app.get(`${namespace}/:universeId/syncs/:syncId`, (req, res) => {
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    res.status(200).json({
      ok: true,
      kind: operation?.kind,
      universeId: operation?.universeId,
      syncId: operation?.kind === 'status' ? operation.syncId : null,
    });
  });
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

function buildRouteApp(
  options: Parameters<typeof createApiBackstageNotionPartitionsRouter>[0]
): express.Express {
  const app = express();
  app.use(
    '/api/backstage/notion-partitions',
    createApiBackstageNotionPartitionsRouter(options)
  );
  return app;
}

describe('Backstage Notion partition synchronization HTTP boundary', () => {
  beforeEach(() => {
    principalSequence += 1;
    configureControlPlane();
  });

  it('authenticates before parsing malformed or oversized request bodies', async () => {
    const app = buildApp();
    const malformed = await request(app)
      .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'partition-sync-key-1')
      .send('{');
    const oversized = await request(app)
      .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
      .set('Idempotency-Key', 'partition-sync-key-2')
      .send({
        version: 1,
        shardKey: 'x'.repeat(BACKSTAGE_NOTION_PARTITION_SYNC_BODY_LIMIT_BYTES),
      });

    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(oversized.status).toBe(401);
    expect(oversized.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
  });

  it('requires the dedicated scope and marks every protected response no-store', async () => {
    configureControlPlane('arcanos:read');
    const denied = await authorized(
      request(buildApp()).get(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`
      )
    );

    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(denied.headers['cache-control']).toBe('no-store');

    configureControlPlane();
    const allowed = await authorized(
      request(buildApp()).get(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`
      )
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(allowed.headers.pragma).toBe('no-cache');
    expect(allowed.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-partition-sync-status'
    );
  });

  it('admits only exact methods, paths, identifiers, and query-free requests', async () => {
    const app = buildApp();
    const paths = [
      request(app).get(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}/`
      ),
      request(app).get(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}?raw=true`
      ),
      request(app).get(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/not-a-uuid`
      ),
      request(app).get(
        `/api/backstage/notion-partitions/%6dy-universe-2k26/syncs/${SYNC_ID}`
      ),
      request(app).put(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`
      ),
      request(app).post(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/extra`
      ),
    ];
    const responses = await Promise.all(paths.map(pending => authorized(pending)));

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
          message: 'The partition synchronization was not found.',
        },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }

    const head = await authorized(
      request(app).head(
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`
      )
    );
    expect(head.status).toBe(200);
  });

  it('requires one exact visible-ASCII idempotency key and a closed v1 body', async () => {
    const run = async (
      configure: (pending: request.Test) => request.Test
    ): Promise<request.Response> => {
      principalSequence += 1;
      configureControlPlane();
      return configure(authorized(
        request(buildApp())
          .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
      ));
    };
    const missingKey = await run(pending => pending.send({
      version: 1,
      shardKey: SHARD_KEY,
    }));
    const shortKey = await run(pending => pending
      .set('Idempotency-Key', 'short')
      .send({ version: 1, shardKey: SHARD_KEY }));
    const spacedKey = await run(pending => pending
      .set('Idempotency-Key', 'partition sync key')
      .send({ version: 1, shardKey: SHARD_KEY }));
    const unknownField = await run(pending => pending
      .set('Idempotency-Key', 'partition-sync-key-3')
      .send({ version: 1, shardKey: SHARD_KEY, rootPageId: 'forbidden' }));
    const wrongVersion = await run(pending => pending
      .set('Idempotency-Key', 'partition-sync-key-4')
      .send({ version: 2, shardKey: SHARD_KEY }));
    const malformed = await run(pending => pending
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'partition-sync-key-5')
      .send('{'));
    const primitive = await run(pending => pending
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'partition-sync-key-6')
      .send('true'));
    const unsupported = await run(pending => pending
      .set('Content-Type', 'text/plain')
      .set('Idempotency-Key', 'partition-sync-key-7')
      .send(JSON.stringify({ version: 1, shardKey: SHARD_KEY })));
    const compressed = await run(pending => pending
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .set('Idempotency-Key', 'partition-sync-key-8')
      .send(JSON.stringify({ version: 1, shardKey: SHARD_KEY })));
    const oversized = await run(pending => pending
      .set('Idempotency-Key', 'partition-sync-key-9')
      .send({
        version: 1,
        shardKey: 'x'.repeat(BACKSTAGE_NOTION_PARTITION_SYNC_BODY_LIMIT_BYTES),
      }));

    for (const response of [
      missingKey,
      shortKey,
      spacedKey,
      unknownField,
      wrongVersion,
      malformed,
      primitive,
    ]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(
        'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID'
      );
      expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    }
    expect(unsupported.status).toBe(415);
    expect(compressed.status).toBe(415);
    expect(oversized.status).toBe(413);
  });

  it('rejects duplicate keys and ambiguous transfer framing with one fixed error', () => {
    const contentType = ['Content-Type', 'application/json'];
    const duplicateKey = invokeBodyParserWithRawHeaders([
      ...contentType,
      'Idempotency-Key', 'partition-sync-key-a',
      'Idempotency-Key', 'partition-sync-key-b',
      'Content-Length', '44',
    ]);
    const duplicateTransferEncoding = invokeBodyParserWithRawHeaders([
      ...contentType,
      'Idempotency-Key', 'partition-sync-key-transfer',
      'Transfer-Encoding', 'chunked',
      'Transfer-Encoding', 'chunked',
    ]);
    const duplicateContentLength = invokeBodyParserWithRawHeaders([
      ...contentType,
      'Idempotency-Key', 'partition-sync-key-length',
      'Content-Length', '44',
      'Content-Length', '44',
    ]);
    const conflictingFraming = invokeBodyParserWithRawHeaders([
      ...contentType,
      'Idempotency-Key', 'partition-sync-key-conflict',
      'Transfer-Encoding', 'chunked',
      'Content-Length', '44',
    ]);
    const unsupportedTransferEncoding = invokeBodyParserWithRawHeaders([
      ...contentType,
      'Idempotency-Key', 'partition-sync-key-transfer-unsupported',
      'Transfer-Encoding', 'gzip',
    ]);
    const duplicateContentType = invokeBodyParserWithRawHeaders([
      ...contentType,
      ...contentType,
      'Idempotency-Key', 'partition-sync-key-content-type',
      'Content-Length', '44',
    ]);
    const duplicateContentEncoding = invokeBodyParserWithRawHeaders([
      ...contentType,
      'Content-Encoding', 'identity',
      'Content-Encoding', 'identity',
      'Idempotency-Key', 'partition-sync-key-content-encoding',
      'Content-Length', '44',
    ]);

    for (const rejected of [
      duplicateKey,
      duplicateTransferEncoding,
      duplicateContentLength,
      conflictingFraming,
      unsupportedTransferEncoding,
    ]) {
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toEqual({
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID',
          message: 'Partition synchronization request is invalid.',
        },
      });
      expect(rejected.nextCalled).toBe(false);
    }
    for (const rejected of [duplicateContentType, duplicateContentEncoding]) {
      expect(rejected.statusCode).toBe(415);
      expect(rejected.body).toEqual({
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID',
          message: 'Partition synchronization request is invalid.',
        },
      });
      expect(rejected.nextCalled).toBe(false);
    }
  });

  it('accepts only application/json and rejects bodies on status reads', async () => {
    const vendorJson = await authorized(
      request(buildApp())
        .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
        .set('Content-Type', 'application/vnd.arcanos+json')
        .set('Idempotency-Key', 'partition-sync-key-vendor')
        .send(JSON.stringify({ version: 1, shardKey: SHARD_KEY }))
    );
    const create = await authorized(
      request(buildApp())
        .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
        .set('Content-Type', 'application/json; charset=utf-8')
        .set('Idempotency-Key', 'partition-sync-key-json')
        .send(JSON.stringify({ version: 1, shardKey: SHARD_KEY }))
    );
    const readWithBody = await authorized(
      request(buildApp())
        .get(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`)
        .set('Content-Type', 'application/json')
        .send({})
    );

    expect(vendorJson.status).toBe(415);
    expect(vendorJson.body.error.code).toBe(
      'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID'
    );
    expect(create.status).toBe(202);
    expect(create.body).toMatchObject({
      universeId: UNIVERSE_ID,
      shardKey: SHARD_KEY,
    });
    expect(readWithBody.status).toBe(400);
    expect(readWithBody.body.error.code).toBe(
      'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID'
    );
  });

  it('limits effectful starts per authenticated principal', async () => {
    const app = buildApp({
      maxPrincipalRequests: 5,
      windowMs: 60_000,
    });
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await validCreate(app, `partition-sync-rate-${attempt}`));
    }

    expect(responses.slice(0, 5).every(response => response.status === 202)).toBe(true);
    expect(responses[5]?.status).toBe(429);
    expect(responses[5]?.headers['x-ratelimit-bucket']).toBe(
      'backstage-notion-partition-sync-create'
    );
  });

  it('consumes one exact actor, target, key, and configuration-bound challenge', async () => {
    const confirmationState = {
      configurationGeneration: 'generation-1',
      configurationDigest: 'a'.repeat(64),
      effects: 0,
    };
    const app = buildApp({ confirmationState });
    const pending = await validCreate(app);
    const challenge = pending.headers['x-confirmation-challenge'];
    const changedKey = await validCreate(app, 'partition-sync-key-changed')
      .set('x-confirmed', `token:${challenge}`);
    const secondPending = await validCreate(app);
    const secondChallenge = secondPending.headers['x-confirmation-challenge'];
    confirmationState.configurationGeneration = 'generation-2';
    const changedConfiguration = await validCreate(app)
      .set('x-confirmed', `token:${secondChallenge}`);
    confirmationState.configurationGeneration = 'generation-1';
    const thirdPending = await validCreate(app);
    const thirdChallenge = thirdPending.headers['x-confirmation-challenge'];
    configureControlPlane(
      'backstage:notion-sync',
      'operator:partition-sync:different'
    );
    const changedActor = await validCreate(app)
      .set('x-confirmed', `token:${thirdChallenge}`);

    expect(pending.status).toBe(403);
    expect(changedKey.status).toBe(403);
    expect(changedConfiguration.status).toBe(403);
    expect(changedActor.status).toBe(403);
    expect(confirmationState.effects).toBe(0);

    configureControlPlane();
    const acceptedPending = await validCreate(app);
    const acceptedChallenge = acceptedPending.headers['x-confirmation-challenge'];
    const accepted = await validCreate(app)
      .set('x-confirmed', `token:${acceptedChallenge}`);
    const replay = await validCreate(app)
      .set('x-confirmed', `token:${acceptedChallenge}`);

    expect(accepted.status).toBe(202);
    expect(replay.status).toBe(403);
    expect(confirmationState.effects).toBe(1);
  });
});

describe('Backstage Notion partition synchronization protected route', () => {
  beforeEach(() => {
    principalSequence += 1;
    configureControlPlane();
  });

  it('is composed before the broad parser and through the application API router', async () => {
    const previousMode =
      process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME];
    const previousConfiguration =
      process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME];
    process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME] = 'monolith';
    delete process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME];
    try {
      const app = createApp();
      const unauthenticatedMalformed = await request(app)
        .post(`/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', 'partition-sync-app-key')
        .send('{');
      const disabled = await validCreate(app, 'partition-sync-app-key');

      expect(unauthenticatedMalformed.status).toBe(401);
      expect(unauthenticatedMalformed.body.error.code).toBe(
        'CONTROL_PLANE_AUTH_REQUIRED'
      );
      expect(disabled.status).toBe(409);
      expect(disabled.body.error.code).toBe(
        'BACKSTAGE_NOTION_PARTITION_SYNC_DISABLED'
      );
    } finally {
      if (previousMode === undefined) {
        delete process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME];
      } else {
        process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME] =
          previousMode;
      }
      if (previousConfiguration === undefined) {
        delete process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME];
      } else {
        process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME] =
          previousConfiguration;
      }
    }
  });

  it('confirms the configured target and admits only its captured generation', async () => {
    let currentConfiguration = buildPartitionConfiguration('generation-1');
    let capturedInput: EnqueueBackstageNotionPartitionSyncOperationInput | null = null;
    const app = buildRouteApp({
      readEnvironment: name => {
        if (name === BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME) {
          return 'shadow';
        }
        if (name === BACKSTAGE_NOTION_PARTITIONS_ENV_NAME) {
          return currentConfiguration;
        }
        return undefined;
      },
      enqueueOperation: async input => {
        capturedInput = input;
        const confirmedConfiguration = currentConfiguration;
        currentConfiguration = buildPartitionConfiguration('generation-2');
        expect(input.dependencies?.readEnvironment?.(
          BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
        )).toBe('shadow');
        expect(input.dependencies?.readEnvironment?.(
          BACKSTAGE_NOTION_PARTITIONS_ENV_NAME
        )).toBe(confirmedConfiguration);
        return {
          statusCode: 202,
          payload: {
            ok: true,
            syncId: SYNC_ID,
            universeId: UNIVERSE_ID,
            shardKey: SHARD_KEY,
            status: 'queued',
            deduplicated: false,
            statusUrl:
              `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`,
          },
        };
      },
    });

    const pending = await validCreate(app, 'partition-sync-route-key');
    const challenge = pending.headers['x-confirmation-challenge'];
    const admitted = await validCreate(app, 'partition-sync-route-key')
      .set('x-confirmed', `token:${challenge}`);

    expect(pending.status).toBe(403);
    expect(challenge).toEqual(expect.any(String));
    expect(admitted.status).toBe(202);
    expect(admitted.headers['cache-control']).toBe('no-store');
    expect(admitted.body).toEqual({
      ok: true,
      syncId: SYNC_ID,
      universeId: UNIVERSE_ID,
      shardKey: SHARD_KEY,
      status: 'queued',
      deduplicated: false,
      statusUrl:
        `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`,
    });
    expect(JSON.stringify(admitted.body)).not.toContain('partition-sync-route-key');
    expect(JSON.stringify(admitted.body)).not.toContain(CONTROL_PLANE_TOKEN);
    expect(capturedInput).not.toBeNull();
    if (!capturedInput) {
      throw new Error('Expected partition synchronization operation input');
    }
    expect(capturedInput.universeId).toBe(UNIVERSE_ID);
    expect(capturedInput.body).toEqual({ version: 1, shardKey: SHARD_KEY });
    expect(capturedInput.idempotencyKey).toBe('partition-sync-route-key');
    expect(capturedInput.actorKey).not.toContain(CONTROL_PLANE_TOKEN);
  });

  it('does not inspect partition configuration while synchronization is disabled', async () => {
    let configurationReads = 0;
    const app = buildRouteApp({
      readEnvironment: name => {
        if (name === BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME) {
          return 'monolith';
        }
        if (name === BACKSTAGE_NOTION_PARTITIONS_ENV_NAME) {
          configurationReads += 1;
          throw new Error('configuration must remain unread');
        }
        return undefined;
      },
      enqueueOperation: async () => {
        throw new Error('disabled synchronization must not enqueue');
      },
    });

    const response = await validCreate(app, 'partition-sync-disabled-key');

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(
      'BACKSTAGE_NOTION_PARTITION_SYNC_DISABLED'
    );
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(configurationReads).toBe(0);
  });

  it('projects bounded status results and retry guidance without exposing inputs', async () => {
    let capturedInput:
      GetBackstageNotionPartitionSyncOperationStatusInput | null = null;
    const app = buildRouteApp({
      getOperationStatus: async input => {
        capturedInput = input;
        return {
          statusCode: 503,
          retryAfterSeconds: 30,
          payload: {
            ok: false,
            error: {
              code: 'BACKSTAGE_NOTION_PARTITION_SYNC_JOBS_UNAVAILABLE',
              message: 'Durable partition synchronization is unavailable.',
            },
          },
        };
      },
    });

    const response = await authorized(request(app).get(
      `/api/backstage/notion-partitions/${UNIVERSE_ID}/syncs/${SYNC_ID}`
    ));

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_JOBS_UNAVAILABLE',
        message: 'Durable partition synchronization is unavailable.',
      },
    });
    expect(capturedInput).not.toBeNull();
    if (!capturedInput) {
      throw new Error('Expected partition synchronization status input');
    }
    expect(capturedInput.universeId).toBe(UNIVERSE_ID);
    expect(capturedInput.syncId).toBe(SYNC_ID);
    expect(capturedInput.actorKey).not.toContain(CONTROL_PLANE_TOKEN);
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
  if (originalPartitionMode === undefined) {
    delete process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME];
  } else {
    process.env[BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME] =
      originalPartitionMode;
  }
  if (originalPartitionConfiguration === undefined) {
    delete process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME];
  } else {
    process.env[BACKSTAGE_NOTION_PARTITIONS_ENV_NAME] =
      originalPartitionConfiguration;
  }
});
