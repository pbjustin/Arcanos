import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

let allowWritingPlaneGate = false;
const memoryConsistencyGateMock = jest.fn(
  (_req: Request, res: Response, next: NextFunction) => {
    if (allowWritingPlaneGate) {
      next();
      return;
    }

    res.status(418).json({
      ok: false,
      error: {
        code: 'WRITING_PLANE_GATE_REACHED',
      },
    });
  }
);

jest.unstable_mockModule(
  '@transport/http/middleware/memoryConsistencyGate.js',
  () => ({
    memoryConsistencyGate: memoryConsistencyGateMock,
  })
);

jest.unstable_mockModule('@services/safety/runtimeState.js', () => ({
  activateUnsafeCondition: jest.fn(() => ({})),
  buildUnsafeToProceedPayload: jest.fn(() => ({})),
  clearUnsafeCondition: jest.fn(() => false),
  clearUnsafeConditionsByQuarantine: jest.fn(() => 0),
  getActiveQuarantines: jest.fn(() => []),
  getActiveUnsafeConditions: jest.fn(() => []),
  getSafetyRuntimeSnapshot: jest.fn(() => ({
    conditions: [],
    counters: {
      duplicateSuppressions: 0,
      healthyCycles: {},
      heartbeatMisses: {},
      quarantineActivations: 0,
      workerFailures: {},
    },
    quarantines: [],
    trustedHashes: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  getTrustedHash: jest.fn(() => undefined),
  hasUnsafeBlockingConditions: jest.fn(() => false),
  incrementHeartbeatMiss: jest.fn(() => 0),
  incrementHealthyCycle: jest.fn(() => 0),
  incrementWorkerFailure: jest.fn(() => 0),
  reconcileAutoRecoverableQuarantinesForProcessStart: jest.fn(() => 0),
  recordDuplicateSuppression: jest.fn(() => 0),
  registerQuarantine: jest.fn(() => ({})),
  releaseQuarantine: jest.fn(() => false),
  resetFailureSignals: jest.fn(),
  resetSafetyRuntimeStateForTests: jest.fn(),
  setTrustedHash: jest.fn(),
}));

const recordHeartbeat = jest.fn();
const getTokenForInstance = jest.fn(() => null);
const setTokenForInstance = jest.fn();
const saveTokens = jest.fn();
const daemonStore = {
  recordHeartbeat,
  getTokenForInstance,
  setTokenForInstance,
  saveTokens,
  listPendingCommands: jest.fn(() => []),
  acknowledgeCommands: jest.fn(() => 0),
  recordCommandResult: jest.fn(),
  getCommandResult: jest.fn(() => null),
  createPendingActions: jest.fn(),
  consumePendingActions: jest.fn(() => 0),
  queueCommand: jest.fn(),
  queueCommandForInstance: jest.fn(),
};

jest.unstable_mockModule('@routes/api-daemon/context.js', () => ({
  daemonLogger: {
    child: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  daemonStore,
}));

const unrelatedApiRouteModules = [
  '@routes/api-arcanos.js',
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-commands.js',
  '@routes/api-control-plane.js',
  '@routes/api-assistants.js',
  '@routes/api-vision.js',
  '@routes/api-transcribe.js',
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
const apiRouter = (await import('../src/routes/api/index.js')).default;

const daemonEnvironmentName = 'ARCANOS_DAEMON_ACCESS_TOKEN';
const daemonAccessToken = 'daemon-composition-access-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', apiRouter);
  return app;
}

describe('daemon-plane production composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPurposeBoundCredentialEnvironment();
    process.env[daemonEnvironmentName] = daemonAccessToken;
    allowWritingPlaneGate = false;
    getTokenForInstance.mockReturnValue(null);
  });

  it('authenticates daemon traffic before the writing-plane consistency gate', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .send({
        clientId: 'composition-client',
        instanceId: 'composition-instance',
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('DAEMON_AUTH_REQUIRED');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  it('keeps authenticated daemon handlers entirely outside the writing-plane gate', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/heartbeat')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({
        clientId: 'composition-client',
        instanceId: 'composition-instance',
      });

    expect(response.status).toBe(200);
    expect(recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('terminates authenticated unknown daemon paths before writing-plane rerouting', async () => {
    const response = await request(buildApp())
      .post('/api/daemon/unknown-operation')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({ operation: 'unknown' });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Daemon endpoint not found');
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
  });

  it('keeps the canonical public update route separate from daemon authority', async () => {
    allowWritingPlaneGate = true;

    const response = await request(buildApp())
      .post('/api/update')
      .set('x-arcanos-daemon-token', daemonAccessToken)
      .send({
        updateType: 'status',
        data: { ok: true },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });

  it('keeps the writing-plane gate active for unrelated API paths', async () => {
    const response = await request(buildApp())
      .get('/api/commands')
      .set('x-arcanos-daemon-token', daemonAccessToken);

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
});
