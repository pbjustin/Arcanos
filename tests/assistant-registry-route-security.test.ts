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

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const getAssistantNamesMock = jest.fn<() => Promise<string[]>>();
const getAssistantMock = jest.fn<
  (name: string) => Promise<Record<string, unknown> | undefined>
>();
const syncAssistantRegistryMock = jest.fn<
  () => Promise<{
    changed: boolean;
    registry: Record<string, Record<string, unknown>>;
  }>
>();

class MockAssistantRegistrySyncInProgressError extends Error {}

jest.unstable_mockModule('@services/openai-assistants.js', () => ({
  AssistantRegistrySyncInProgressError:
    MockAssistantRegistrySyncInProgressError,
  getAssistantNames: getAssistantNamesMock,
  getAssistant: getAssistantMock,
  syncAssistantRegistry: syncAssistantRegistryMock,
}));

const assistantRegistryRouter = (
  await import('../src/routes/api-assistants.js')
).default;

const controlPlaneToken =
  'assistant-route-token-123456789012345678901234';
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
  principalId = `operator:assistant-route:${testPrincipalSequence}`
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

function buildApp(options: {
  throwingLogger?: boolean;
} = {}): express.Express {
  const app = express();
  if (options.throwingLogger) {
    app.use((req, _res, next) => {
      req.logger = {
        error: () => {
          throw new Error('logger-sentinel');
        },
      } as typeof req.logger;
      next();
    });
  }
  app.use('/api/assistants', assistantRegistryRouter);
  return app;
}

function authorized(pendingRequest: request.Test): request.Test {
  return pendingRequest.set(
    'Authorization',
    `Bearer ${controlPlaneToken}`
  );
}

describe('assistant registry route security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testPrincipalSequence += 1;
    configureControlPlane();
    getAssistantNamesMock.mockResolvedValue(['ALPHA', 'BETA']);
    getAssistantMock.mockResolvedValue({
      id: 'asst_secret',
      name: 'Alpha',
      normalizedName: 'ALPHA',
      model: 'gpt-4.1-mini',
      instructions: 'hidden instructions',
      tools: [{ type: 'file_search' }],
    });
    syncAssistantRegistryMock.mockResolvedValue({
      changed: true,
      registry: {
        ALPHA: {
          id: 'asst_secret',
          name: 'Alpha',
          normalizedName: 'ALPHA',
          model: 'gpt-4.1-mini',
          instructions: 'hidden instructions',
          tools: [{ type: 'file_search' }],
        },
      },
    });
  });

  it('returns only sorted names and public detail metadata', async () => {
    const app = buildApp();
    const list = await authorized(
      request(app).get('/api/assistants')
    );
    const detail = await authorized(
      request(app).get('/api/assistants/alpha')
    );

    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      ok: true,
      count: 2,
      names: ['ALPHA', 'BETA'],
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({
      ok: true,
      assistant: {
        name: 'Alpha',
        normalizedName: 'ALPHA',
        model: 'gpt-4.1-mini',
      },
    });
    const serialized = JSON.stringify({ list: list.body, detail: detail.body });
    expect(serialized).not.toContain('asst_secret');
    expect(serialized).not.toContain('hidden instructions');
    expect(serialized).not.toContain('file_search');
    expect(syncAssistantRegistryMock).not.toHaveBeenCalled();
  });

  it('keeps misses local and does not echo the requested name', async () => {
    getAssistantMock.mockResolvedValueOnce(undefined);
    const response = await authorized(
      request(buildApp()).get('/api/assistants/private-sentinel-name')
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ASSISTANT_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain(
      'private-sentinel-name'
    );
    expect(syncAssistantRegistryMock).not.toHaveBeenCalled();
  });

  it('requires an issued one-use challenge even with manual confirmation', async () => {
    const response = await authorized(
      request(buildApp())
        .post('/api/assistants/sync')
        .set('x-confirmed', 'yes')
    ).send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toMatch(
      /^[0-9a-f-]{36}$/u
    );
    expect(syncAssistantRegistryMock).not.toHaveBeenCalled();
  });

  it('runs provider sync only after consuming the bound challenge', async () => {
    const app = buildApp();
    const pending = await authorized(
      request(app).post('/api/assistants/sync')
    ).send({});
    const challenge = pending.headers['x-confirmation-challenge'];
    const confirmed = await authorized(
      request(app)
        .post('/api/assistants/sync')
        .set('x-confirmed', `token:${challenge}`)
    ).send({});
    const replay = await authorized(
      request(app)
        .post('/api/assistants/sync')
        .set('x-confirmed', `token:${challenge}`)
    ).send({});

    expect(pending.status).toBe(403);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({
      ok: true,
      changed: true,
      count: 1,
    });
    expect(JSON.stringify(confirmed.body)).not.toContain('asst_secret');
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(syncAssistantRegistryMock).toHaveBeenCalledTimes(1);
  });

  it('binds confirmation to the authenticated principal and workspace intent', async () => {
    const app = buildApp();
    const pending = await authorized(
      request(app).post('/api/assistants/sync')
    ).send({});
    const challenge = pending.headers['x-confirmation-challenge'];

    configureControlPlane('operator:different-assistant-route');
    const rebound = await authorized(
      request(app)
        .post('/api/assistants/sync')
        .set('x-confirmed', `token:${challenge}`)
    ).send({});

    expect(rebound.status).toBe(403);
    expect(rebound.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(syncAssistantRegistryMock).not.toHaveBeenCalled();
  });

  it('returns fixed failures without leaking provider errors', async () => {
    syncAssistantRegistryMock.mockRejectedValueOnce(
      new Error('provider-sentinel-secret')
    );
    const app = buildApp();
    const pending = await authorized(
      request(app).post('/api/assistants/sync')
    ).send({});
    const confirmed = await authorized(
      request(app)
        .post('/api/assistants/sync')
        .set(
          'x-confirmed',
          `token:${pending.headers['x-confirmation-challenge']}`
        )
    ).send({});

    expect(confirmed.status).toBe(502);
    expect(confirmed.body.error).toEqual({
      code: 'ASSISTANT_REGISTRY_SYNC_FAILED',
      message: 'Assistant registry synchronization failed.',
    });
    expect(JSON.stringify(confirmed.body)).not.toContain(
      'provider-sentinel-secret'
    );
  });

  it('completes fixed failures even when request logging throws', async () => {
    getAssistantNamesMock.mockRejectedValueOnce(
      new Error('registry-read-sentinel')
    );
    const readFailure = await authorized(
      request(buildApp({ throwingLogger: true })).get('/api/assistants')
    );

    syncAssistantRegistryMock.mockRejectedValueOnce(
      new Error('registry-sync-sentinel')
    );
    const syncApp = buildApp({ throwingLogger: true });
    const pending = await authorized(
      request(syncApp).post('/api/assistants/sync')
    ).send({});
    const syncFailure = await authorized(
      request(syncApp)
        .post('/api/assistants/sync')
        .set(
          'x-confirmed',
          `token:${pending.headers['x-confirmation-challenge']}`
        )
    ).send({});

    expect(readFailure.status).toBe(503);
    expect(readFailure.body.error.code).toBe(
      'ASSISTANT_REGISTRY_UNAVAILABLE'
    );
    expect(syncFailure.status).toBe(502);
    expect(syncFailure.body.error.code).toBe(
      'ASSISTANT_REGISTRY_SYNC_FAILED'
    );
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
