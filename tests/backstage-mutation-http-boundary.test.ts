import { readFileSync } from 'node:fs';
import { request as sendHttpRequest } from 'node:http';

import type { Request } from 'express';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

const originalAllowAllGpts = process.env.ALLOW_ALL_GPTS;
const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;
process.env.ALLOW_ALL_GPTS = 'false';
process.env.LEGACY_GPT_ROUTES = 'enabled';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const {
  BACKSTAGE_MUTATION_SCOPE,
  createBackstageMutationHttpBoundary,
  resolveBackstageMutationHttpOperation,
} = await import('../src/services/controlPlane/backstageMutationHttpBoundary.js');
const {
  createBackstageMutationConfirmationGate,
} = await import('../src/transport/http/middleware/backstageMutationConfirmationGate.js');
const {
  BACKSTAGE_ACTIONS,
  BACKSTAGE_MODULE_NAME,
  BACKSTAGE_MODULE_ROUTE,
  BACKSTAGE_MUTATION_ACTIONS,
  BACKSTAGE_PUBLIC_ACTIONS,
} = await import('../src/shared/backstage/backstageActionPolicy.js');
const {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} = await import('../src/shared/security/purposeBoundCredential.js');
const {
  getModuleMetadata,
  initializeModuleRegistry,
} = await import('../src/services/moduleRegistry.js');

const controlPlaneToken = 'backstage-control-plane-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

const backstageGptModuleMap = {
  backstage: {
    module: BACKSTAGE_MODULE_NAME,
    route: BACKSTAGE_MODULE_ROUTE,
  },
  'backstage-booker': {
    module: BACKSTAGE_MODULE_NAME,
    route: BACKSTAGE_MODULE_ROUTE,
  },
  'configured-booker-id': {
    module: BACKSTAGE_MODULE_NAME,
    route: BACKSTAGE_MODULE_ROUTE,
  },
  'other-gpt': {
    module: 'ARCANOS:CORE',
    route: 'core',
  },
} as const;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  scopes = BACKSTAGE_MUTATION_SCOPE,
  principalId = 'operator:backstage-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildRequest(
  path: string,
  body: unknown,
  params: Record<string, string> = {}
): Request {
  return {
    body,
    method: 'POST',
    originalUrl: path,
    params,
    path,
    query: {},
  } as unknown as Request;
}

function buildBoundaryApp(options: {
  duplicateMount?: boolean;
  maxPrincipalRequests?: number;
} = {}) {
  const app = express();
  const boundary = createBackstageMutationHttpBoundary({
    maxClientRequests: 100,
    maxPrincipalRequests: options.maxPrincipalRequests ?? 10,
    windowMs: 60_000,
  });
  const confirmation = createBackstageMutationConfirmationGate();
  const admission = options.duplicateMount
    ? [boundary, boundary, confirmation, confirmation]
    : [boundary, confirmation];
  const accepted = (_req: express.Request, res: express.Response) => {
    res.status(204).end();
  };

  app.use(express.json());
  app.post('/backstage/:operation', ...admission, accepted);
  app.post('/gpt/:gptId', ...admission, accepted);
  app.post('/dispatch', ...admission, accepted);
  app.post('/modules/:moduleRoute', ...admission, accepted);
  app.post('/queryroute', ...admission, accepted);
  return app;
}

function authorizedPost(app: ReturnType<typeof buildBoundaryApp>, path: string) {
  return request(app)
    .post(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`)
    .set('X-Confirmed', 'yes');
}

async function postAbsoluteForm(
  app: ReturnType<typeof buildBoundaryApp>,
  path: string,
  body: Record<string, unknown>
): Promise<{ body: Record<string, unknown>; status: number }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected a TCP listener for absolute-form request test.');
  }

  const serializedBody = JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const pendingRequest = sendHttpRequest({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: `http://example.test${path}`,
        headers: {
          'Content-Length': Buffer.byteLength(serializedBody),
          'Content-Type': 'application/json',
          'X-Confirmed': 'yes',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            body: responseBody ? JSON.parse(responseBody) as Record<string, unknown> : {},
            status: response.statusCode ?? 0,
          });
        });
      });
      pendingRequest.on('error', reject);
      pendingRequest.end(serializedBody);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('Backstage mutation HTTP boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('keeps the declared policy synchronized with the registered module actions', async () => {
    await initializeModuleRegistry();
    const registeredActions = getModuleMetadata(BACKSTAGE_MODULE_NAME)?.actions ?? [];

    expect([...BACKSTAGE_ACTIONS].sort()).toEqual([...registeredActions].sort());
    expect(new Set([
      ...BACKSTAGE_PUBLIC_ACTIONS,
      ...BACKSTAGE_MUTATION_ACTIONS,
    ])).toEqual(new Set(BACKSTAGE_ACTIONS));
  });

  it.each([
    ['/backstage/book-event', {}, 'bookEvent', 'direct'],
    ['/backstage/book-gpt', { prompt: 'book it' }, 'saveStoryline', 'direct'],
    ['/backstage/track-storyline', {}, 'trackStoryline', 'direct'],
    ['/backstage/update-roster', [], 'updateRoster', 'direct'],
  ] as const)('classifies direct mutation %s', async (path, body, action, ingress) => {
    await expect(resolveBackstageMutationHttpOperation(
      buildRequest(path, body),
      { gptModuleMap: backstageGptModuleMap }
    )).resolves.toMatchObject({ action, ingress });
  });

  it.each(BACKSTAGE_MUTATION_ACTIONS)(
    'classifies canonical, dispatch, and compatibility aliases for %s',
    async (action) => {
      const requests = [
        buildRequest('/gpt/configured-booker-id', { action }, {
          gptId: 'configured-booker-id',
        }),
        buildRequest('/dispatch', {
          target: 'gpt',
          gptId: 'configured-booker-id',
          action,
        }),
        buildRequest('/modules/backstage-booker', {
          module: BACKSTAGE_MODULE_NAME,
          action,
          payload: {},
        }),
        buildRequest('/queryroute', {
          module: BACKSTAGE_MODULE_ROUTE,
          action,
          payload: {},
        }),
      ];

      for (const mutationRequest of requests) {
        await expect(resolveBackstageMutationHttpOperation(
          mutationRequest,
          { gptModuleMap: backstageGptModuleMap }
        )).resolves.toMatchObject({ action });
      }
    }
  );

  it.each(BACKSTAGE_PUBLIC_ACTIONS)(
    'leaves %s public through every action-selecting alias',
    async (action) => {
      const requests = [
        buildRequest('/gpt/backstage', { action }, { gptId: 'backstage' }),
        buildRequest('/dispatch', {
          target: 'gpt',
          gptId: 'backstage',
          action,
        }),
        buildRequest('/modules/backstage-booker', {
          module: BACKSTAGE_MODULE_NAME,
          action,
          payload: {},
        }),
        buildRequest('/queryroute', {
          module: BACKSTAGE_MODULE_NAME,
          action,
          payload: {},
        }),
      ];

      for (const publicRequest of requests) {
        await expect(resolveBackstageMutationHttpOperation(
          publicRequest,
          { gptModuleMap: backstageGptModuleMap }
        )).resolves.toBeNull();
      }
    }
  );

  it('preserves public defaults, invalid actions, other modules, and direct simulation', async () => {
    const requests = [
      buildRequest('/gpt/backstage', {}, { gptId: 'backstage' }),
      buildRequest('/gpt/backstage', { action: 'notAnAction' }, { gptId: 'backstage' }),
      buildRequest('/gpt/other-gpt', { action: 'updateRoster' }, { gptId: 'other-gpt' }),
      buildRequest('/backstage/simulate-match', {}),
      buildRequest('/queryroute', {
        module: 'OTHER:MODULE',
        action: 'updateRoster',
      }),
    ];

    for (const publicRequest of requests) {
      await expect(resolveBackstageMutationHttpOperation(
        publicRequest,
        { gptModuleMap: backstageGptModuleMap }
      )).resolves.toBeNull();
    }
  });

  it('rejects oversized dispatch identifiers from mutation classification before fuzzy matching', async () => {
    const oversizedGptId = `backstage-${'x'.repeat(10_000)}`;

    await expect(resolveBackstageMutationHttpOperation(
      buildRequest('/dispatch', {
        target: 'gpt',
        gptId: oversizedGptId,
        action: 'updateRoster',
      }),
      { gptModuleMap: backstageGptModuleMap }
    )).resolves.toBeNull();
  });

  it('does not treat confirmation as caller authentication', async () => {
    const response = await request(buildBoundaryApp())
      .post('/gpt/backstage')
      .set('X-Confirmed', 'yes')
      .send({ action: 'updateRoster' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['body operation', { operation: 'updateRoster' }, {}, {}],
    ['nested payload operationId', { payload: { operationId: 'updateRoster' } }, {}, {}],
    ['query operation', {}, { operation: 'updateRoster' }, {}],
    ['x-gpt-action header', {}, {}, { 'x-gpt-action': 'updateRoster' }],
    ['x-arcanos-action header', {}, {}, { 'x-arcanos-action': 'updateRoster' }],
  ] as const)(
    'protects canonical mutations selected through %s',
    async (_selector, body, query, headers) => {
      const response = await request(buildBoundaryApp())
        .post('/gpt/backstage')
        .set('X-Confirmed', 'yes')
        .set(headers)
        .query(query)
        .send(body);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    }
  );

  it.each([
    ['body operation', { operation: 'generateBooking' }, {}, {}],
    ['nested payload operationId', { payload: { operationId: 'generateBooking' } }, {}, {}],
    ['query operation', {}, { operation: 'generateBooking' }, {}],
    ['x-gpt-action header', {}, {}, { 'x-gpt-action': 'generateBooking' }],
    ['x-arcanos-action header', {}, {}, { 'x-arcanos-action': 'generateBooking' }],
  ] as const)(
    'keeps canonical public actions open through %s',
    async (_selector, body, query, headers) => {
      clearPurposeBoundCredentialEnvironment();
      const response = await request(buildBoundaryApp())
        .post('/gpt/backstage')
        .set(headers)
        .query(query)
        .send(body);

      expect(response.status).toBe(204);
    }
  );

  it('protects absolute-form request targets that Express routes as mutation paths', async () => {
    const response = await postAbsoluteForm(buildBoundaryApp(), '/dispatch', {
      target: 'gpt',
      gptId: 'backstage',
      action: 'updateRoster',
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: { code: 'CONTROL_PLANE_AUTH_REQUIRED' },
    });
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildBoundaryApp())
      .post('/dispatch')
      .set('X-Confirmed', 'yes')
      .send({
        target: 'gpt',
        gptId: 'backstage-booker',
        action: 'saveStoryline',
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it('requires the execution scope independently from identity', async () => {
    configureControlPlane('arcanos:read');

    const response = await authorizedPost(buildBoundaryApp(), '/modules/backstage-booker')
      .send({
        module: BACKSTAGE_MODULE_NAME,
        action: 'bookEvent',
        payload: {},
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
    expect(response.headers['x-ratelimit-bucket']).toBe('backstage-mutation-principal');
  });

  it('requires confirmation after authenticating and authorizing the operator', async () => {
    const response = await request(buildBoundaryApp())
      .post('/queryroute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        module: BACKSTAGE_MODULE_NAME,
        action: 'trackStoryline',
        payload: {},
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.headers['x-confirmation-status']).toBe('pending');
  });

  it('does not replay a header-selected mutation challenge across canonical actions', async () => {
    const app = buildBoundaryApp();
    const challengeResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'updateRoster')
      .send({ payload: { wrestlers: [{ name: 'A', overall: 90 }] } });
    const challengeId = challengeResponse.headers['x-confirmation-challenge'];

    expect(challengeResponse.status).toBe(403);
    expect(challengeId).toEqual(expect.any(String));

    const replayResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'trackStoryline')
      .set('X-Confirmed', `token:${challengeId}`)
      .send({ payload: { beat: { turn: 'heel' } } });

    expect(replayResponse.status).toBe(403);
    expect(replayResponse.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(replayResponse.body.confirmationChallenge.providedTokenStatus).toBe('invalid');
  });

  it('accepts a challenge only for the same canonical mutation action and principal', async () => {
    const app = buildBoundaryApp();
    const challengeResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'updateRoster')
      .send({ payload: { wrestlers: [{ name: 'A', overall: 90 }] } });
    const challengeId = challengeResponse.headers['x-confirmation-challenge'];

    expect(challengeResponse.status).toBe(403);
    expect(challengeId).toEqual(expect.any(String));

    const confirmedResponse = await authorizedPost(app, '/gpt/backstage')
      .set('X-GPT-Action', 'updateRoster')
      .set('X-Confirmed', `token:${challengeId}`)
      .send({ payload: { wrestlers: [{ name: 'A', overall: 90 }] } });

    expect(confirmedResponse.status).toBe(204);
    expect(confirmedResponse.headers['x-confirmation-status']).toBe('challenge-token');
  });

  it('binds a canon storyline challenge to the exact normalized mutation payload', async () => {
    const app = buildBoundaryApp();
    const payload = {
      universeId: 'promotion-east',
      mutationId: '8d64dad3-f080-4bac-88ec-994005dc7152',
      expectedVersion: 0,
      storyline: {
        key: 'world-title-chase',
        title: 'World Title Chase',
        summary: 'The challenger earns one final opportunity.',
        status: 'draft',
        participantNames: ['Alex Vega'],
      },
    };
    const challengeResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'upsertStoryline')
      .send({ payload });
    const challengeId = challengeResponse.headers['x-confirmation-challenge'];

    expect(challengeResponse.status).toBe(403);
    expect(challengeId).toEqual(expect.any(String));

    const changedResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'upsertStoryline')
      .set('X-Confirmed', `token:${challengeId}`)
      .send({
        payload: {
          ...payload,
          storyline: {
            ...payload.storyline,
            title: 'Changed After Confirmation',
          },
        },
      });

    expect(changedResponse.status).toBe(403);
    expect(changedResponse.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(changedResponse.body.confirmationChallenge.providedTokenStatus).toBe('invalid');

    const exactChallengeResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'upsertStoryline')
      .send({ payload });
    const exactChallengeId = exactChallengeResponse.headers['x-confirmation-challenge'];
    const confirmedResponse = await request(app)
      .post('/gpt/backstage')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-GPT-Action', 'upsertStoryline')
      .set('X-Confirmed', `token:${exactChallengeId}`)
      .send({ payload });

    expect(exactChallengeResponse.status).toBe(403);
    expect(confirmedResponse.status).toBe(204);
    expect(confirmedResponse.headers['x-confirmation-status']).toBe('challenge-token');
  });

  it.each([
    ['/backstage/book-event', {}],
    ['/gpt/backstage', { action: 'updateRoster' }],
    ['/dispatch', { target: 'gpt', gptId: 'backstage', action: 'trackStoryline' }],
    ['/modules/backstage-booker', {
      module: BACKSTAGE_MODULE_NAME,
      action: 'saveStoryline',
      payload: {},
    }],
    ['/queryroute', {
      module: BACKSTAGE_MODULE_ROUTE,
      action: 'bookEvent',
      payload: {},
    }],
  ] as const)('admits an authorized and confirmed mutation through %s', async (path, body) => {
    const response = await authorizedPost(buildBoundaryApp(), path).send(body);

    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-ratelimit-bucket']).toBe('backstage-mutation-principal');
  });

  it('keeps public generation and simulation open when control-plane auth is unconfigured', async () => {
    clearPurposeBoundCredentialEnvironment();
    const app = buildBoundaryApp();
    const responses = await Promise.all([
      request(app).post('/gpt/backstage').send({ action: 'generateBooking' }),
      request(app).post('/gpt/backstage').send({ action: 'simulateMatch' }),
      request(app).post('/dispatch').send({
        target: 'gpt',
        gptId: 'backstage',
        action: 'generateBookingWithHRC',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([204, 204, 204]);
  });

  it('shares one principal rate budget across aliases and charges duplicate mounts once', async () => {
    const app = buildBoundaryApp({
      duplicateMount: true,
      maxPrincipalRequests: 2,
    });
    const first = await authorizedPost(app, '/backstage/book-event').send({});
    const second = await authorizedPost(app, '/gpt/backstage').send({ action: 'updateRoster' });
    const throttled = await authorizedPost(app, '/dispatch').send({
      target: 'gpt',
      gptId: 'backstage',
      action: 'saveStoryline',
    });

    expect(first.status).toBe(204);
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect(second.status).toBe(204);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    expect(throttled.status).toBe(429);
    expect(throttled.headers['x-ratelimit-bucket']).toBe('backstage-mutation-principal');
  });

  it('mounts the shared boundary before provider admission and each execution seam', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const backstageSource = readFileSync(
      new URL('../src/routes/backstage.ts', import.meta.url),
      'utf8'
    );
    const dispatchSource = readFileSync(
      new URL('../src/routes/dispatch.ts', import.meta.url),
      'utf8'
    );
    const gptRouterSource = readFileSync(
      new URL('../src/routes/gptRouter.ts', import.meta.url),
      'utf8'
    );
    const modulesSource = readFileSync(
      new URL('../src/routes/modules.ts', import.meta.url),
      'utf8'
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );
    const directBoundaryIndex = appSource.indexOf(
      "app.use('/backstage/book-event', backstageMutationHttpBoundary)"
    );
    const postParserBoundaryIndex = appSource.indexOf("'/dispatch',", broadParserIndex);
    const providerAdmissionIndex = appSource.indexOf('app.use(publicProviderAdmission)');
    const dispatchRouteIndex = dispatchSource.lastIndexOf("router.post(");
    const dispatchBoundaryIndex = dispatchSource.indexOf(
      'backstageMutationHttpBoundary',
      dispatchRouteIndex
    );
    const dispatchHandlerIndex = dispatchSource.indexOf(
      'universalDispatch',
      dispatchBoundaryIndex
    );
    const gptRouteIndex = gptRouterSource.lastIndexOf('router.post(');
    const gptNotionAuthIndex = gptRouterSource.indexOf(
      'optionalBackstageNotionEnrichmentAuth',
      gptRouteIndex
    );
    const gptCanonicalBoundaryIndex = gptRouterSource.indexOf(
      'canonicalGptIdentifierBoundary',
      gptNotionAuthIndex
    );
    const gptBoundaryIndex = gptRouterSource.indexOf(
      'backstageMutationHttpBoundary',
      gptNotionAuthIndex
    );
    const gptProviderIndex = gptRouterSource.indexOf(
      'publicProviderGptAdmission',
      gptBoundaryIndex
    );

    expect(directBoundaryIndex).toBeGreaterThan(-1);
    expect(directBoundaryIndex).toBeLessThan(broadParserIndex);
    expect(postParserBoundaryIndex).toBeGreaterThan(broadParserIndex);
    expect(postParserBoundaryIndex).toBeLessThan(providerAdmissionIndex);
    for (const path of ['/book-event', '/book-gpt', '/update-roster', '/track-storyline']) {
      expect(backstageSource).toContain(
        `router.post('${path}', backstageMutationHttpBoundary, backstageMutationConfirmationGate`
      );
    }
    expect(backstageSource).toContain("router.post('/simulate-match', confirmGate");
    expect(dispatchRouteIndex).toBeGreaterThan(-1);
    expect(dispatchBoundaryIndex).toBeGreaterThan(dispatchRouteIndex);
    expect(dispatchHandlerIndex).toBeGreaterThan(dispatchBoundaryIndex);
    expect(gptRouteIndex).toBeGreaterThan(-1);
    expect(gptNotionAuthIndex).toBeGreaterThan(gptRouteIndex);
    expect(gptCanonicalBoundaryIndex).toBeGreaterThan(gptNotionAuthIndex);
    expect(gptBoundaryIndex).toBeGreaterThan(gptRouteIndex);
    expect(gptBoundaryIndex).toBeGreaterThan(gptNotionAuthIndex);
    expect(gptProviderIndex).toBeGreaterThan(gptBoundaryIndex);
    expect(modulesSource).toContain('backstageMutationConfirmationGate');
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
  if (originalAllowAllGpts === undefined) {
    delete process.env.ALLOW_ALL_GPTS;
  } else {
    process.env.ALLOW_ALL_GPTS = originalAllowAllGpts;
  }
  if (originalLegacyGptRoutes === undefined) {
    delete process.env.LEGACY_GPT_ROUTES;
  } else {
    process.env.LEGACY_GPT_ROUTES = originalLegacyGptRoutes;
  }
});
