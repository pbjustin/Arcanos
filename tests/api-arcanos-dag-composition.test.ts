import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'dag-composition-token-12345678901234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

const memoryConsistencyGateMock = jest.fn(
  (_req: Request, res: Response, _next: NextFunction) => {
    res.status(418).json({
      ok: false,
      error: {
        code: 'WRITING_PLANE_GATE_REACHED',
      },
    });
  }
);
const mockCreateRun = jest.fn();

jest.unstable_mockModule(
  '@transport/http/middleware/memoryConsistencyGate.js',
  () => ({
    memoryConsistencyGate: memoryConsistencyGateMock,
  })
);

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlStatus: jest.fn(),
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    createRun: mockCreateRun,
    getLatestRun: jest.fn(),
    getRun: jest.fn(),
    waitForRunUpdate: jest.fn(),
    getRunTrace: jest.fn(),
    getRunTree: jest.fn(),
    getNode: jest.fn(),
    getRunEvents: jest.fn(),
    getRunMetrics: jest.fn(),
    getRunErrors: jest.fn(),
    getRunLineage: jest.fn(),
    cancelRun: jest.fn(),
    getRunVerification: jest.fn(),
    getFeatureFlags: jest.fn(),
    getExecutionLimits: jest.fn(),
  },
}));

const unrelatedApiRouteModules = [
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-commands.js',
  '@routes/api-control-plane.js',
  '@routes/api-assistants.js',
  '@routes/api-vision.js',
  '@routes/api-transcribe.js',
  '@routes/api-update.js',
  '@routes/api-daemon.js',
  '@routes/api-agent.js',
  '@routes/api-prompt-debug.js',
  '@routes/api-ai-routing-debug.js',
  '@routes/api-reusable-code.js',
  '@routes/pr-analysis.js',
  '@routes/openai.js',
  '@routes/afol.js',
  '@routes/web-search.js',
] as const;

for (const moduleName of unrelatedApiRouteModules) {
  jest.unstable_mockModule(moduleName, () => ({
    default: express.Router(),
  }));
}

const request = (await import('supertest')).default;
const {
  dagHttpBoundary,
} = await import('../src/services/controlPlane/dagHttpBoundary.js');
const apiRouter = (await import('../src/routes/api/index.js')).default;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:dag-composition';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,mcp:invoke';
}

function buildApp(): express.Express {
  const app = express();
  app.use('/api/arcanos/dag', dagHttpBoundary);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', apiRouter);
  return app;
}

describe('API DAG production composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    mockCreateRun.mockResolvedValue({
      runId: 'run-composition',
      sessionId: 'session-composition',
      template: 'verification-default',
      status: 'queued',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    });
  });

  it('dispatches authenticated DAG execution before the writing-plane gate', async () => {
    const response = await request(buildApp())
      .post('/api/arcanos/dag/runs')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        sessionId: 'session-composition',
        template: 'verification-default',
        input: { goal: 'verify control-plane routing' },
      });

    expect(response.status).toBe(202);
    expect(response.body.data.run.runId).toBe('run-composition');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
  });

  it('rejects anonymous malformed JSON before parsing or writing-plane dispatch', async () => {
    const response = await request(buildApp())
      .post('/api/arcanos/dag/runs')
      .set('Content-Type', 'application/json')
      .send('{"sessionId":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('keeps neighboring ARCANOS writing-plane traffic behind its gate', async () => {
    const response = await request(buildApp())
      .post('/api/arcanos/ask')
      .send({ prompt: 'writing-plane request' });

    expect(response.status).toBe(418);
    expect(response.body.error.code).toBe('WRITING_PLANE_GATE_REACHED');
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
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
