import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  CEF_EXECUTION_BODY_LIMIT_BYTES,
} from '../src/services/controlPlane/cefBodyParser.js';

const mockExecuteGoal = jest.fn();

jest.unstable_mockModule('@services/agentExecutionService.js', () => ({
  agentExecutionService: {
    executeGoal: mockExecuteGoal
  }
}));

jest.unstable_mockModule('@transport/http/middleware/auditTrace.js', () => ({
  auditTrace: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.auditTraceId = 'trace-api-agent';
    next();
  }
}));

const { default: apiAgentRouter } = await import('../src/routes/api-agent.js');

const controlPlaneToken = 'api-agent-route-token-1234567890123456789012';
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

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:api-agent-route';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';
}

function createApiAgentTestApp(): Express {
  const app = express();
  app.use('/', apiAgentRouter);
  app.use(errorHandler);
  app.use((_req, res) => {
    res.status(404).json({
      error: 'Route Not Found',
      code: 404
    });
  });
  return app;
}

async function submitConfirmedAgentRequest(
  app: Express,
  body: Record<string, unknown>
) {
  const pendingResponse = await request(app)
    .post('/api/agent/execute')
    .set('Authorization', `Bearer ${controlPlaneToken}`)
    .send(body);
  const challengeId = pendingResponse.headers['x-confirmation-challenge'];
  expect(pendingResponse.status).toBe(403);
  expect(pendingResponse.body.code).toBe('CONFIRMATION_REQUIRED');
  expect(challengeId).toEqual(expect.any(String));

  return request(app)
    .post('/api/agent/execute')
    .set('Authorization', `Bearer ${controlPlaneToken}`)
    .set('x-confirmed', `token:${challengeId}`)
    .send(body);
}

describe('/api/agent/execute', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    app = createApiAgentTestApp();
  });

  it('authenticates malformed and oversized anonymous bodies before leaf parsing', async () => {
    const malformedResponse = await request(app)
      .post('/api/agent/execute')
      .set('Content-Type', 'application/json')
      .send('{"goal":');
    const oversizedResponse = await request(app)
      .post('/api/agent/execute')
      .send({
        goal: 'x'.repeat(CEF_EXECUTION_BODY_LIMIT_BYTES),
      });

    expect(malformedResponse.status).toBe(401);
    expect(malformedResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
    expect(oversizedResponse.status).toBe(401);
    expect(oversizedResponse.body.error.code).toBe(
      'CONTROL_PLANE_AUTH_REQUIRED'
    );
    expect(mockExecuteGoal).not.toHaveBeenCalled();
  });

  it('enforces the leaf parser body limit for authenticated requests', async () => {
    const response = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        goal: 'x'.repeat(CEF_EXECUTION_BODY_LIMIT_BYTES),
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('CEF_REQUEST_INVALID');
    expect(mockExecuteGoal).not.toHaveBeenCalled();
  });

  it('returns a structured execution response', async () => {
    mockExecuteGoal.mockResolvedValue({
      executionId: 'agentexec_1',
      traceId: 'trace-api-agent',
      goal: 'Summarize the current system status.',
      planner: {
        planId: 'agentplan_1',
        executionMode: 'serial',
        selectedCapabilityIds: ['goal-fulfillment'],
        steps: [
          {
            stepId: 'step_1',
            capabilityId: 'goal-fulfillment',
            reason: 'The goal requires execution through the core AI prompt CEF command.',
            dependsOnStepIds: [],
            capabilityPayload: {
              prompt: 'Summarize the current system status.'
            }
          }
        ]
      },
      execution: {
        status: 'completed',
        startedAt: '2026-03-09T12:00:00.000Z',
        completedAt: '2026-03-09T12:00:01.000Z',
        steps: [
          {
            stepId: 'step_1',
            capabilityId: 'goal-fulfillment',
            commandName: 'ai:prompt',
            status: 'completed',
            success: true,
            message: 'Prompt completed.',
            output: {
              result: 'system summary'
            },
            commandMetadata: {
              executedAt: '2026-03-09T12:00:01.000Z',
              auditSafeMode: 'false'
            },
            startedAt: '2026-03-09T12:00:00.000Z',
            completedAt: '2026-03-09T12:00:01.000Z',
            error: null
          }
        ],
        dagSummary: null,
        finalOutput: {
          result: 'system summary'
        }
      },
      logs: [
        {
          timestamp: '2026-03-09T12:00:00.000Z',
          level: 'info',
          message: 'agent.execution.started',
          metadata: {
            executionId: 'agentexec_1',
            traceId: 'trace-api-agent'
          }
        }
      ]
    });

    const response = await submitConfirmedAgentRequest(app, {
      goal: 'Summarize the current system status.'
    });

    expect(response.status).toBe(200);
    expect(response.body.executionId).toBe('agentexec_1');
    expect(response.body.execution.status).toBe('completed');
    expect(mockExecuteGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'Summarize the current system status.',
        traceId: 'trace-api-agent'
      }),
      expect.objectContaining({
        plan: expect.objectContaining({
          goal: 'Summarize the current system status.',
          steps: expect.arrayContaining([
            expect.objectContaining({
              stepId: 'step_1',
              capabilityId: 'goal-fulfillment',
            }),
          ]),
        }),
        executionPermitsByStepId: expect.any(Map),
      })
    );
  });

  it('does not accept manual confirmation for agent execution', async () => {
    const response = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', 'yes')
      .send({
        goal: 'Summarize the current system status.'
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toEqual(
      expect.any(String)
    );
    expect(mockExecuteGoal).not.toHaveBeenCalled();
  });

  it('binds the challenge to stable plan intent and rejects changed goals', async () => {
    const pendingResponse = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        goal: 'Summarize the current system status.'
      });
    const challengeId = pendingResponse.headers['x-confirmation-challenge'];

    const changedResponse = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', `token:${challengeId}`)
      .send({
        goal: 'Summarize a different system.'
      });

    expect(changedResponse.status).toBe(403);
    expect(changedResponse.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(changedResponse.headers['x-confirmation-challenge']).not.toBe(
      challengeId
    );
    expect(mockExecuteGoal).not.toHaveBeenCalled();
  });

  it('binds the challenge to the authenticated control-plane principal', async () => {
    const pendingResponse = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        goal: 'Summarize the current system status.'
      });
    const challengeId = pendingResponse.headers['x-confirmation-challenge'];
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID =
      'operator:api-agent-route-other';

    const mismatchedResponse = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('x-confirmed', `token:${challengeId}`)
      .send({
        goal: 'Summarize the current system status.'
      });

    expect(mismatchedResponse.status).toBe(403);
    expect(mismatchedResponse.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(mockExecuteGoal).not.toHaveBeenCalled();
  });

  it('derives one execution permit per step from one whole-plan challenge', async () => {
    mockExecuteGoal.mockResolvedValue({
      executionId: 'agentexec_2',
      traceId: 'trace-api-agent',
      goal: 'Enable audit safe mode and summarize status.',
      planner: {
        planId: 'agentplan_2',
        executionMode: 'dag',
        selectedCapabilityIds: [
          'audit-safe-mode-control',
          'goal-fulfillment'
        ],
        steps: []
      },
      execution: {
        status: 'completed',
        startedAt: '2026-03-09T12:00:00.000Z',
        completedAt: '2026-03-09T12:00:01.000Z',
        steps: [],
        dagSummary: null,
        finalOutput: null
      },
      logs: []
    });

    const response = await submitConfirmedAgentRequest(app, {
      goal: 'Enable audit safe mode and summarize status.',
      executionMode: 'dag',
      payload: {
        mode: 'true',
        prompt: 'Summarize status.'
      }
    });

    expect(response.status).toBe(200);
    const authorization = mockExecuteGoal.mock.calls[0]?.[1] as {
      executionPermitsByStepId?: Map<string, unknown>;
    };
    expect(authorization.executionPermitsByStepId?.size).toBe(2);
    expect([
      ...authorization.executionPermitsByStepId!.keys()
    ]).toEqual(['step_1', 'step_2']);
  });

  it('returns structured validation errors for invalid payloads', async () => {
    const response = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        goal: ''
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid Agent Execution Payload');
    expect(response.body.code).toBe(400);
    expect(Array.isArray(response.body.details)).toBe(true);
  });

  it('returns a structured planning error for unknown capabilities', async () => {
    const response = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        goal: 'Run an unsupported capability.',
        preferredCapabilities: ['does-not-exist']
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Agent Planning Failed',
      code: 400,
      details: ['Unknown capability "does-not-exist".']
    });
  });

  it('returns a structured planning error for blocked exploit-chain goals', async () => {
    const response = await request(app)
      .post('/api/agent/execute')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        goal: 'Access storage directly if the normal replay path stalls.'
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Agent Planning Failed',
      code: 400,
      details: ['Blocked exploit chain request: "access storage directly" attempts to bypass capability -> CEF -> handler boundaries.']
    });
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
