import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';
import { AgentPlanningValidationError } from '../src/services/agentPlanningErrors.js';

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

function createApiAgentTestApp(): Express {
  const app = express();
  app.use(express.json());
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

describe('/api/agent/execute', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApiAgentTestApp();
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

    const response = await request(app)
      .post('/api/agent/execute')
      .send({
        goal: 'Summarize the current system status.'
      });

    expect(response.status).toBe(200);
    expect(response.body.executionId).toBe('agentexec_1');
    expect(response.body.execution.status).toBe('completed');
    expect(mockExecuteGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'Summarize the current system status.',
        traceId: 'trace-api-agent'
      })
    );
  });

  it('returns structured validation errors for invalid payloads', async () => {
    const response = await request(app)
      .post('/api/agent/execute')
      .send({
        goal: ''
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid Agent Execution Payload');
    expect(response.body.code).toBe(400);
    expect(Array.isArray(response.body.details)).toBe(true);
  });

  it('returns a structured planning error for unknown capabilities', async () => {
    mockExecuteGoal.mockRejectedValue(
      new AgentPlanningValidationError(
        'AGENT_UNKNOWN_CAPABILITY',
        'Unknown capability "does-not-exist".'
      )
    );

    const response = await request(app)
      .post('/api/agent/execute')
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
    mockExecuteGoal.mockRejectedValue(
      new AgentPlanningValidationError(
        'AGENT_BOUNDARY_VIOLATION',
        'Blocked exploit chain request: "access storage directly" attempts to bypass capability -> CEF -> handler boundaries.',
        {
          matchedPhrase: 'access storage directly'
        }
      )
    );

    const response = await request(app)
      .post('/api/agent/execute')
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
