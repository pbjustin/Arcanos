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

const resetOrchestrationShellMock = jest.fn();
const getOrchestrationShellStatusMock = jest.fn();

jest.unstable_mockModule('../src/services/orchestrationShell.js', () => ({
  resetOrchestrationShell: resetOrchestrationShellMock,
  getOrchestrationShellStatus: getOrchestrationShellStatusMock,
}));

const { default: orchestrationRouter } = await import(
  '../src/routes/orchestration.js'
);

const controlPlaneAccessToken =
  'orchestration-route-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let principalCounter = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(scopes: string): void {
  principalCounter += 1;
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneAccessToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
    `operator:orchestration-route-${principalCounter}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(): express.Express {
  const app = express();
  app.use('/', orchestrationRouter);
  return app;
}

function validResetRequest(app: express.Express, routePath = '/orchestration/reset') {
  return request(app)
    .post(routePath)
    .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
    .set('X-Confirmed', 'yes')
    .send({
      agentId: 'operator-agent',
      sessionId: 'session-123',
      contextSnapshotTag: 'before-reset',
    });
}

describe('orchestration route security', () => {
  beforeEach(() => {
    resetOrchestrationShellMock.mockReset();
    getOrchestrationShellStatusMock.mockReset();
  });

  it('does not accept confirmation as caller authentication', async () => {
    configureControlPlane('mcp:invoke');

    const response = await request(buildApp())
      .post('/orchestration/reset')
      .set('X-Confirmed', 'yes')
      .send({
        agentId: 'operator-agent',
        sessionId: 'session-123',
      });

    expect(response.status).toBe(401);
    expect(resetOrchestrationShellMock).not.toHaveBeenCalled();
  });

  it('requires mcp:invoke and preserves confirmation after authorization', async () => {
    configureControlPlane('arcanos:read');
    const scopeDeniedResponse = await validResetRequest(buildApp());

    expect(scopeDeniedResponse.status).toBe(403);
    expect(scopeDeniedResponse.body.error.code).toBe(
      'CONTROL_PLANE_SCOPE_DENIED'
    );
    expect(resetOrchestrationShellMock).not.toHaveBeenCalled();

    configureControlPlane('mcp:invoke');
    const confirmationResponse = await request(buildApp())
      .post('/orchestration/reset')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`)
      .send({
        agentId: 'operator-agent',
        sessionId: 'session-123',
      });

    expect(confirmationResponse.status).toBe(403);
    expect(confirmationResponse.body.confirmationRequired).toBe(true);
    expect(resetOrchestrationShellMock).not.toHaveBeenCalled();
  });

  it('executes a bounded authorized reset request', async () => {
    configureControlPlane('mcp:invoke');
    resetOrchestrationShellMock.mockResolvedValue({
      success: true,
      message: 'Reset complete',
      meta: {
        timestamp: '2026-07-25T00:00:00.000Z',
        stages: ['RESET'],
        gpt5Model: 'test-model',
        safeguardsApplied: true,
      },
      logs: ['complete'],
    });

    const response = await validResetRequest(buildApp());

    expect(response.status).toBe(200);
    expect(resetOrchestrationShellMock).toHaveBeenCalledWith({
      agentId: 'operator-agent',
      sessionId: 'session-123',
      contextSnapshotTag: 'before-reset',
    });
  });

  it('does not disclose reset exceptions', async () => {
    configureControlPlane('mcp:invoke');
    resetOrchestrationShellMock.mockRejectedValue(
      new Error('SENTINEL_ORCHESTRATION_INTERNAL_FAILURE')
    );

    const response = await validResetRequest(buildApp());

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain(
      'SENTINEL_ORCHESTRATION_INTERNAL_FAILURE'
    );
    expect(response.body.error).toBe('Orchestration reset failed');
  });

  it('protects orchestration status with arcanos:read', async () => {
    getOrchestrationShellStatusMock.mockResolvedValue({
      active: true,
      model: 'test-model',
      memoryEntries: 0,
    });
    configureControlPlane('mcp:invoke');
    const deniedResponse = await request(buildApp())
      .get('/orchestration/status')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(deniedResponse.status).toBe(403);
    expect(getOrchestrationShellStatusMock).not.toHaveBeenCalled();

    configureControlPlane('arcanos:read');
    const allowedResponse = await request(buildApp())
      .get('/orchestration/status')
      .set('Authorization', `Bearer ${controlPlaneAccessToken}`);

    expect(allowedResponse.status).toBe(200);
    expect(getOrchestrationShellStatusMock).toHaveBeenCalledTimes(1);
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
