import { readFileSync } from 'node:fs';

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

interface IngestResult {
  parentId: string;
  source: string;
  chunkCount: number;
  contentLength: number;
  metadata: Record<string, unknown>;
}

interface QueryResult {
  answer: string;
  sources: string[];
  verification: string;
  sourceDetails: unknown[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const ingestUrlMock = jest.fn<(url: string) => Promise<IngestResult>>();
const ingestContentMock = jest.fn<
  (options: {
    id?: string;
    content: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<IngestResult>
>();
const answerQuestionMock = jest.fn<(question: string) => Promise<QueryResult>>();

jest.unstable_mockModule('@services/webRag.js', () => ({
  ingestUrl: ingestUrlMock,
  ingestContent: ingestContentMock,
  answerQuestion: answerQuestionMock,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const ragRouter = (await import('../src/routes/rag.js')).default;
const {
  RAG_MAX_CONTENT_LENGTH,
  RAG_MAX_QUESTION_LENGTH,
} = await import('../src/routes/rag.js');
const {
  createRagHttpBoundary,
} = await import('../src/services/controlPlane/ragHttpBoundary.js');
const {
  RAG_FETCH_BODY_LIMIT_BYTES,
  RAG_QUERY_BODY_LIMIT_BYTES,
  RAG_SAVE_BODY_LIMIT_BYTES,
  ragBodyParser,
} = await import('../src/services/controlPlane/ragBodyParser.js');

const controlPlaneToken = 'rag-boundary-token-12345678901234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = 'arcanos:read,mcp:invoke',
  principalId = 'operator:rag-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildIngestResult(
  source = 'https://example.com/guide',
  parentId = 'rag-parent'
): IngestResult {
  return {
    parentId,
    source,
    chunkCount: 2,
    contentLength: 42,
    metadata: { sourceType: 'web' },
  };
}

function buildQueryResult(answer = 'bounded answer'): QueryResult {
  return {
    answer,
    sources: ['https://example.com/guide'],
    verification: 'verified',
    sourceDetails: [],
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildApp(options: {
  maxClientRequests?: number;
  windowMs?: number;
} = {}): import('express').Express {
  const app = express();
  app.set('trust proxy', true);
  app.use('/rag', createRagHttpBoundary({
    maxClientRequests: options.maxClientRequests ?? 100,
    windowMs: options.windowMs ?? 60_000,
  }));
  app.use('/rag', ragBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', ragRouter);
  app.post('/ragged', (_req, res) => res.status(204).end());
  app.use((
    error: unknown,
    _req: import('express').Request,
    res: import('express').Response,
    _next: import('express').NextFunction
  ) => {
    res.status((error as { status?: number }).status ?? 500).json({
      code: 'BROAD_PARSER_REJECTED',
    });
  });
  return app;
}

function authenticatedPost(
  app: import('express').Express,
  path: '/rag/fetch' | '/rag/query' | '/rag/save'
) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

async function challengeConfirmedPost(
  app: import('express').Express,
  path: '/rag/fetch' | '/rag/save',
  body: Record<string, unknown>
) {
  const pendingResponse = await authenticatedPost(app, path).send(body);
  const challengeId = pendingResponse.headers['x-confirmation-challenge'];

  expect(pendingResponse.status).toBe(403);
  expect(pendingResponse.body.confirmationRequired).toBe(true);
  expect(typeof challengeId).toBe('string');

  return authenticatedPost(app, path)
    .set('X-Confirmed', `token:${challengeId}`)
    .send(body);
}

async function waitForMockCalls(
  mock: { mock: { calls: unknown[][] } },
  expectedCalls: number
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (mock.mock.calls.length >= expectedCalls) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`Expected ${expectedCalls} mock calls.`);
}

describe('RAG HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
    jest.clearAllMocks();
    ingestUrlMock.mockImplementation(async (url) => buildIngestResult(url));
    ingestContentMock.mockImplementation(async (options) => (
      buildIngestResult(options.source ?? 'manual', options.id ?? 'rag-parent')
    ));
    answerQuestionMock.mockImplementation(async () => buildQueryResult());
  });

  it('authenticates before parsing malformed or oversized bodies', async () => {
    const app = buildApp();
    const malformedResponse = await request(app)
      .post('/rag/query')
      .set('Content-Type', 'application/json')
      .send('{"question":');
    const oversizedResponse = await request(app)
      .post('/rag/save')
      .send({
        content: 'x'.repeat(RAG_SAVE_BODY_LIMIT_BYTES),
      });

    expect(malformedResponse.status).toBe(401);
    expect(malformedResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
    expect(malformedResponse.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(oversizedResponse.status).toBe(401);
    expect(oversizedResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
    expect(ingestContentMock).not.toHaveBeenCalled();
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildApp())
      .post('/rag/query')
      .send({ question: 'status' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  it('keeps invalid bearer traffic from exhausting authenticated ingress', async () => {
    const app = buildApp({
      maxClientRequests: 1,
      windowMs: 60_000,
    });
    const clientAddress = '198.51.100.54';

    const denied = await request(app)
      .post('/rag/query')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token')
      .send({ question: 'one' });
    const throttled = await request(app)
      .post('/rag/query')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token')
      .send({ question: 'two' });
    const authenticated = await authenticatedPost(app, '/rag/query')
      .set('X-Forwarded-For', clientAddress)
      .send({ question: 'authorized' });

    expect(denied.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
  });

  it('separates query and ingestion scopes', async () => {
    configureControlPlane('arcanos:read');
    const readOnlyApp = buildApp();
    const queryResponse = await authenticatedPost(
      readOnlyApp,
      '/rag/query'
    ).send({ question: 'What is indexed?' });
    const ingestionDenied = await authenticatedPost(
      readOnlyApp,
      '/rag/save'
    ).send({ content: 'operator document' });

    expect(queryResponse.status).toBe(200);
    expect(queryResponse.body).toEqual(buildQueryResult());
    expect(ingestionDenied.status).toBe(403);
    expect(ingestionDenied.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED'
    );

    configureControlPlane('mcp:invoke');
    const mutationOnlyApp = buildApp();
    const queryDenied = await authenticatedPost(
      mutationOnlyApp,
      '/rag/query'
    ).send({ question: 'What is indexed?' });
    const ingestionPending = await authenticatedPost(
      mutationOnlyApp,
      '/rag/save'
    ).send({ content: 'operator document' });

    expect(queryDenied.status).toBe(403);
    expect(queryDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(ingestionPending.status).toBe(403);
    expect(ingestionPending.body.confirmationRequired).toBe(true);
    expect(ingestContentMock).not.toHaveBeenCalled();
  });

  it('principal-throttles repeated requests that fail scope authorization', async () => {
    configureControlPlane('arcanos:read', 'operator:rag-scope-throttle');
    const app = buildApp();
    const deniedResponses = [];

    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      deniedResponses.push(
        await authenticatedPost(app, '/rag/save')
          .send({ content: 'operator document' })
      );
    }
    const throttledResponse = await authenticatedPost(app, '/rag/save')
      .send({ content: 'operator document' });

    expect(deniedResponses).toHaveLength(10);
    expect(deniedResponses.every(
      (response) => (
        response.status === 403
        && response.body.error.code === 'CONTROL_PLANE_SCOPE_DENIED'
      )
    )).toBe(true);
    expect(throttledResponse.status).toBe(429);
    expect(ingestContentMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'malformed JSON',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedPost>
      ) => pendingRequest
        .set('Content-Type', 'application/json')
        .send('{"question":'),
      status: 400,
    },
    {
      name: 'an array body',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedPost>
      ) => pendingRequest.send([]),
      status: 400,
    },
    {
      name: 'compressed content',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedPost>
      ) => pendingRequest
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('{}'),
      status: 415,
    },
    {
      name: 'non-JSON content',
      configure: (
        pendingRequest: ReturnType<typeof authenticatedPost>
      ) => pendingRequest
        .set('Content-Type', 'text/plain')
        .send('question=operator'),
      status: 415,
    },
  ])('returns a stable parser response for $name', async ({
    configure,
    status,
  }) => {
    configureControlPlane('arcanos:read');
    const response = await configure(
      authenticatedPost(buildApp(), '/rag/query')
    );

    expect(response.status).toBe(status);
    expect(response.body.error).toEqual({
      code: 'RAG_REQUEST_INVALID',
      message: 'RAG request is invalid.',
    });
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/rag/fetch', RAG_FETCH_BODY_LIMIT_BYTES],
    ['/rag/query', RAG_QUERY_BODY_LIMIT_BYTES],
    ['/rag/save', RAG_SAVE_BODY_LIMIT_BYTES],
  ] as const)('applies the dedicated parser limit to %s', async (
    path,
    bodyLimit
  ) => {
    const response = await authenticatedPost(buildApp(), path)
      .send({
        content: 'x'.repeat(bodyLimit),
        padding: 'x'.repeat(bodyLimit),
        question: 'x'.repeat(bodyLimit),
        url: `https://example.com/${'x'.repeat(bodyLimit)}`,
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('RAG_REQUEST_INVALID');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('rejects invalid or extra query fields without provider work', async () => {
    const app = buildApp();
    const emptyResponse = await authenticatedPost(app, '/rag/query')
      .send({ question: '   ' });
    const longResponse = await authenticatedPost(app, '/rag/query')
      .send({ question: 'x'.repeat(RAG_MAX_QUESTION_LENGTH + 1) });
    const extraResponse = await authenticatedPost(app, '/rag/query')
      .send({ question: 'bounded', topK: 50 });

    expect(emptyResponse.status).toBe(400);
    expect(longResponse.status).toBe(400);
    expect(extraResponse.status).toBe(400);
    expect(emptyResponse.body.error.code).toBe('RAG_REQUEST_INVALID');
    expect(answerQuestionMock).not.toHaveBeenCalled();
  });

  it('rejects unsafe URL shapes before issuing an ingestion challenge', async () => {
    const app = buildApp();
    const schemeResponse = await authenticatedPost(app, '/rag/fetch')
      .send({ url: 'file:///etc/passwd' });
    const credentialResponse = await authenticatedPost(app, '/rag/fetch')
      .send({ url: 'https://user:password@example.com/private' });

    expect(schemeResponse.status).toBe(400);
    expect(credentialResponse.status).toBe(400);
    expect(schemeResponse.body.error.code).toBe('RAG_REQUEST_INVALID');
    expect(schemeResponse.headers['x-confirmation-challenge']).toBeUndefined();
    expect(credentialResponse.headers['x-confirmation-challenge']).toBeUndefined();
    expect(ingestUrlMock).not.toHaveBeenCalled();
  });

  it('bounds saved content and nested metadata before confirmation', async () => {
    const app = buildApp();
    let deeplyNested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 9; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const contentResponse = await authenticatedPost(app, '/rag/save')
      .send({ content: 'x'.repeat(RAG_MAX_CONTENT_LENGTH + 1) });
    const metadataResponse = await authenticatedPost(app, '/rag/save')
      .send({ content: 'bounded', metadata: deeplyNested });
    const dangerousKeyResponse = await authenticatedPost(app, '/rag/save')
      .send({
        content: 'bounded',
        metadata: JSON.parse('{"constructor":{"polluted":true}}'),
      });

    expect(contentResponse.status).toBe(400);
    expect(metadataResponse.status).toBe(400);
    expect(dangerousKeyResponse.status).toBe(400);
    expect(metadataResponse.headers['x-confirmation-challenge']).toBeUndefined();
    expect(ingestContentMock).not.toHaveBeenCalled();
  });

  it('requires a body-, path-, principal-, and one-use ingestion challenge', async () => {
    const primaryPrincipal = 'operator:rag-boundary';
    const alternatePrincipal = 'operator:rag-alternate';
    configureControlPlane('mcp:invoke', primaryPrincipal);
    const app = buildApp();
    const originalBody = {
      content: 'original document',
      metadata: { sourceType: 'manual' },
    };
    const changedBody = {
      content: 'changed document',
      metadata: { sourceType: 'manual' },
    };
    const pendingResponse = await authenticatedPost(app, '/rag/save')
      .set('X-Confirmed', 'yes')
      .set('X-Gpt-Id', 'trusted-rag-client')
      .set('X-Arcanos-Confirm-Token', 'non-challenge-approval')
      .send(originalBody);
    const primaryChallengeId =
      pendingResponse.headers['x-confirmation-challenge'];

    const pathMismatchResponse = await authenticatedPost(app, '/rag/fetch')
      .set('X-Confirmed', `token:${primaryChallengeId}`)
      .send({ url: 'https://example.com/guide' });
    const fetchChallengeId =
      pathMismatchResponse.headers['x-confirmation-challenge'];

    configureControlPlane('mcp:invoke', alternatePrincipal);
    const principalMismatchResponse = await authenticatedPost(app, '/rag/save')
      .set('X-Confirmed', `token:${primaryChallengeId}`)
      .send(originalBody);
    const alternateChallengeId =
      principalMismatchResponse.headers['x-confirmation-challenge'];
    const bodyMismatchResponse = await authenticatedPost(app, '/rag/save')
      .set('X-Confirmed', `token:${alternateChallengeId}`)
      .send(changedBody);
    const changedBodyChallengeId =
      bodyMismatchResponse.headers['x-confirmation-challenge'];
    const confirmedResponse = await authenticatedPost(app, '/rag/save')
      .set('X-Confirmed', `token:${changedBodyChallengeId}`)
      .send(changedBody);
    const replayResponse = await authenticatedPost(app, '/rag/save')
      .set('X-Confirmed', `token:${changedBodyChallengeId}`)
      .send(changedBody);

    expect(pendingResponse.status).toBe(403);
    expect(pendingResponse.body.confirmationRequired).toBe(true);
    expect(typeof primaryChallengeId).toBe('string');
    expect(pathMismatchResponse.status).toBe(403);
    expect(typeof fetchChallengeId).toBe('string');
    expect(principalMismatchResponse.status).toBe(403);
    expect(typeof alternateChallengeId).toBe('string');
    expect(bodyMismatchResponse.status).toBe(403);
    expect(typeof changedBodyChallengeId).toBe('string');
    expect(confirmedResponse.status).toBe(200);
    expect(replayResponse.status).toBe(403);
    expect(ingestUrlMock).not.toHaveBeenCalled();
    expect(ingestContentMock).toHaveBeenCalledTimes(1);
    expect(ingestContentMock).toHaveBeenCalledWith(changedBody);
  });

  it('preserves authorized fetch, save, and query response projections', async () => {
    const app = buildApp();
    const fetchResponse = await challengeConfirmedPost(
      app,
      '/rag/fetch',
      { url: 'https://example.com/guide' }
    );
    const saveResponse = await challengeConfirmedPost(
      app,
      '/rag/save',
      {
        id: 'manual-guide',
        content: 'Operator-provided guide',
        source: 'manual',
        metadata: { owner: 'operator' },
      }
    );
    const queryResponse = await authenticatedPost(app, '/rag/query')
      .send({ question: 'What does the guide say?' });

    expect(fetchResponse.status).toBe(200);
    expect(fetchResponse.body).toEqual({
      id: 'rag-parent',
      parentId: 'rag-parent',
      url: 'https://example.com/guide',
      chunkCount: 2,
      contentLength: 42,
      metadata: { sourceType: 'web' },
    });
    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body).toEqual({
      id: 'manual-guide',
      parentId: 'manual-guide',
      source: 'manual',
      chunkCount: 2,
      contentLength: 42,
      metadata: { sourceType: 'web' },
    });
    expect(queryResponse.status).toBe(200);
    expect(queryResponse.body).toEqual(buildQueryResult());
  });

  it('rejects excess work without queueing and admits work after release', async () => {
    const app = buildApp();
    const deferreds: Array<Deferred<QueryResult>> = [];
    answerQuestionMock.mockImplementation(() => {
      const deferred = createDeferred<QueryResult>();
      deferreds.push(deferred);
      return deferred.promise;
    });

    const firstResponse = authenticatedPost(app, '/rag/query')
      .send({ question: 'first' })
      .then((response) => response);
    const secondResponse = authenticatedPost(app, '/rag/query')
      .send({ question: 'second' })
      .then((response) => response);
    let admittedAfterRelease: typeof firstResponse | undefined;

    try {
      await waitForMockCalls(answerQuestionMock, 2);
      const busyResponse = await authenticatedPost(app, '/rag/query')
        .send({ question: 'third' });

      expect(busyResponse.status).toBe(429);
      expect(busyResponse.headers['retry-after']).toBe('5');
      expect(busyResponse.body.error).toEqual({
        code: 'RAG_OPERATION_BUSY',
        message: 'RAG operation capacity is temporarily unavailable.',
      });
      expect(answerQuestionMock).toHaveBeenCalledTimes(2);

      deferreds[0].resolve(buildQueryResult('first completed'));
      expect((await firstResponse).status).toBe(200);

      admittedAfterRelease = authenticatedPost(app, '/rag/query')
        .send({ question: 'fourth' })
        .then((response) => response);
      await waitForMockCalls(answerQuestionMock, 3);
      expect(answerQuestionMock).toHaveBeenCalledTimes(3);

      deferreds[1].resolve(buildQueryResult('second completed'));
      deferreds[2].resolve(buildQueryResult('fourth completed'));
      const remainingResponses = await Promise.all([
        secondResponse,
        admittedAfterRelease,
      ]);
      expect(remainingResponses.map((response) => response.status)).toEqual([
        200,
        200,
      ]);
    } finally {
      for (const deferred of deferreds) {
        deferred.resolve(buildQueryResult('test cleanup'));
      }
      await Promise.allSettled([
        firstResponse,
        secondResponse,
        ...(admittedAfterRelease ? [admittedAfterRelease] : []),
      ]);
    }
  });

  it('returns a stable failure and releases one of two occupied slots', async () => {
    const privateSentinel = 'PRIVATE_RAG_PROVIDER_SENTINEL';
    const app = buildApp();
    const deferreds: Array<Deferred<QueryResult>> = [];
    answerQuestionMock.mockImplementation(() => {
      const deferred = createDeferred<QueryResult>();
      deferreds.push(deferred);
      return deferred.promise;
    });
    const failingResponse = authenticatedPost(app, '/rag/query')
      .send({ question: 'failing' })
      .then((response) => response);
    const occupiedResponse = authenticatedPost(app, '/rag/query')
      .send({ question: 'occupied' })
      .then((response) => response);
    let recoveryResponse: typeof failingResponse | undefined;

    try {
      await waitForMockCalls(answerQuestionMock, 2);
      const busyResponse = await authenticatedPost(app, '/rag/query')
        .send({ question: 'busy' });
      expect(busyResponse.status).toBe(429);
      expect(answerQuestionMock).toHaveBeenCalledTimes(2);

      deferreds[0].reject(new Error(privateSentinel));
      const failedResponse = await failingResponse;
      expect(failedResponse.status).toBe(500);
      expect(failedResponse.body.error).toEqual({
        code: 'RAG_OPERATION_FAILED',
        message: 'RAG operation could not be completed.',
      });
      expect(failedResponse.text).not.toContain(privateSentinel);

      recoveryResponse = authenticatedPost(app, '/rag/query')
        .send({ question: 'recovery' })
        .then((response) => response);
      await waitForMockCalls(answerQuestionMock, 3);
      deferreds[1].resolve(buildQueryResult('occupied completed'));
      deferreds[2].resolve(buildQueryResult('recovered'));

      expect((await occupiedResponse).status).toBe(200);
      expect((await recoveryResponse).status).toBe(200);
    } finally {
      for (const deferred of deferreds) {
        deferred.resolve(buildQueryResult('test cleanup'));
      }
      await Promise.allSettled([
        failingResponse,
        occupiedResponse,
        ...(recoveryResponse ? [recoveryResponse] : []),
      ]);
    }
  });

  it('preserves a busy ingestion challenge until admission, then consumes it once', async () => {
    const app = buildApp();
    const pendingSave = await authenticatedPost(app, '/rag/save')
      .send({ content: 'confirmed document' });
    const saveChallenge =
      pendingSave.headers['x-confirmation-challenge'];
    const deferreds: Array<Deferred<QueryResult>> = [];
    answerQuestionMock.mockImplementation(() => {
      const deferred = createDeferred<QueryResult>();
      deferreds.push(deferred);
      return deferred.promise;
    });
    const firstQuery = authenticatedPost(app, '/rag/query')
      .send({ question: 'first' })
      .then((response) => response);
    const secondQuery = authenticatedPost(app, '/rag/query')
      .send({ question: 'second' })
      .then((response) => response);

    try {
      await waitForMockCalls(answerQuestionMock, 2);
      const busySave = await authenticatedPost(app, '/rag/save')
        .set('X-Confirmed', `token:${saveChallenge}`)
        .send({ content: 'confirmed document' });

      expect(busySave.status).toBe(429);
      expect(busySave.body.error.code).toBe('RAG_OPERATION_BUSY');
      expect(ingestContentMock).not.toHaveBeenCalled();

      deferreds[0].resolve(buildQueryResult('first completed'));
      expect((await firstQuery).status).toBe(200);

      const admittedSave = await authenticatedPost(app, '/rag/save')
        .set('X-Confirmed', `token:${saveChallenge}`)
        .send({ content: 'confirmed document' });
      const replayedSave = await authenticatedPost(app, '/rag/save')
        .set('X-Confirmed', `token:${saveChallenge}`)
        .send({ content: 'confirmed document' });

      expect(admittedSave.status).toBe(200);
      expect(replayedSave.status).toBe(403);
      expect(replayedSave.body.confirmationRequired).toBe(true);
      expect(ingestContentMock).toHaveBeenCalledTimes(1);
    } finally {
      for (const deferred of deferreds) {
        deferred.resolve(buildQueryResult('test cleanup'));
      }
      await Promise.allSettled([firstQuery, secondQuery]);
    }
  });

  it('terminates unknown protected paths and methods without capturing neighbors', async () => {
    const app = buildApp();
    const unknownResponse = await request(app)
      .post('/rag/unknown')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({});
    const methodResponse = await request(app)
      .get('/rag/query')
      .set('Authorization', `Bearer ${controlPlaneToken}`);
    const neighborResponse = await request(app).post('/ragged');

    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(methodResponse.status).toBe(404);
    expect(neighborResponse.status).toBe(204);
  });

  it.each([
    ['/rag/query/', 200],
    ['/RAG/QUERY', 200],
    ['/rag/query/extra', 404],
    ['/rag/query%2Fextra', 404],
  ])('keeps the canonical path boundary for POST %s', async (
    path,
    expectedStatus
  ) => {
    const response = await request(buildApp())
      .post(path)
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ question: 'bounded' });

    expect(response.status).toBe(expectedStatus);
  });

  it('returns no-store metadata for successful reads', async () => {
    const response = await authenticatedPost(buildApp(), '/rag/query')
      .send({ question: 'bounded' });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it('mounts authentication and bounded parsing before the broad parser', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.use('/rag', ragHttpBoundary)"
    );
    const bodyParserIndex = appSource.indexOf(
      "app.use('/rag', ragBodyParser)"
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(bodyParserIndex).toBeGreaterThan(boundaryIndex);
    expect(bodyParserIndex).toBeLessThan(broadParserIndex);
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
