/**
 * Historical Phase 2E characterization for commit
 * 410c04a890c021ae51148e58391f8e653be11943.
 *
 * These assertions preserve the unsafe pre-implementation behavior. They are
 * evidence for the command/result protocol split, not the desired contract.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { executionResultInputSchema } from '../src/shared/types/actionPlan.js';
import type { ActionPlanRecord } from '../src/shared/types/actionPlan.js';

const getPlanMock = jest.fn();
const createExecutionResultMock = jest.fn();
const validateCapabilityMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const acquireExecutionLockMock = jest.fn();
const emitSafetyAuditEventMock = jest.fn();

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  createPlan: jest.fn(),
  getPlan: getPlanMock,
  approvePlan: jest.fn(),
  blockPlan: jest.fn(),
  expirePlan: jest.fn(),
  listPlans: jest.fn(),
  createExecutionResult: createExecutionResultMock,
  getExecutionResults: jest.fn(),
}));

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  validateCapability: validateCapabilityMock,
}));

jest.unstable_mockModule('../src/services/clear2.js', () => ({
  buildClear2Summary: buildClear2SummaryMock,
}));

jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
  acquireExecutionLock: acquireExecutionLockMock,
}));

jest.unstable_mockModule('../src/services/safety/auditEvents.js', () => ({
  emitSafetyAuditEvent: emitSafetyAuditEventMock,
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const plansRouter = (await import('../src/routes/plans.js')).default;

const initialEnvironment = { ...process.env };

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, initialEnvironment);
}

function buildPlan(): ActionPlanRecord {
  const timestamp = new Date('2026-07-17T12:00:00.000Z');
  return {
    id: 'phase2e-historical-plan',
    createdBy: 'user',
    origin: 'phase2e-historical-characterization',
    status: 'approved',
    confidence: 0.9,
    requiresConfirmation: true,
    idempotencyKey: 'phase2e-historical-plan-key',
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    clearScore: null,
    actions: [
      {
        id: 'python-action',
        planId: 'phase2e-historical-plan',
        agentId: 'python-daemon',
        capability: 'terminal.run',
        params: { command: 'synthetic-no-op' },
        timeoutMs: 1_000,
        rollbackAction: null,
        sortOrder: 0,
      },
      {
        id: 'sibling-action-never-submitted',
        planId: 'phase2e-historical-plan',
        agentId: 'python-daemon',
        capability: 'terminal.run',
        params: { command: 'synthetic-sibling-no-op' },
        timeoutMs: 1_000,
        rollbackAction: null,
        sortOrder: 1,
      },
    ],
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', plansRouter);
  return app;
}

function persistedResult(
  planId: unknown,
  actionId: unknown,
  agentId: unknown,
  status: unknown,
  clearDecision: unknown,
) {
  return { planId, actionId, agentId, status, clearDecision };
}

describe('Phase 2E historical execution ownership baseline @ 410c04a890c021ae51148e58391f8e653be11943', () => {
  beforeEach(() => {
    restoreEnvironment();
    jest.clearAllMocks();
    getPlanMock.mockReset();
    createExecutionResultMock.mockReset();
    validateCapabilityMock.mockReset();
    buildClear2SummaryMock.mockReset();
    acquireExecutionLockMock.mockReset();
    emitSafetyAuditEventMock.mockReset();

    getPlanMock.mockResolvedValue(buildPlan());
    validateCapabilityMock.mockResolvedValue(true);
    buildClear2SummaryMock.mockReturnValue({ overall: 0.9, decision: 'allow' });
    acquireExecutionLockMock.mockResolvedValue({ release: jest.fn(async () => undefined) });
    createExecutionResultMock.mockImplementation(persistedResult);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnvironment();
  });

  it('historically ignores one submitted Python failure and fabricates success for it and an unsubmitted sibling', async () => {
    const plan = buildPlan();
    const failedPythonResult = {
      execution_id: 'python-local-execution-1',
      plan_id: plan.id,
      action_id: 'python-action',
      agent_id: 'python-daemon',
      status: 'failure',
      output: null,
      error: 'synthetic local execution failure',
      timestamp: '2026-07-17T12:00:01.000Z',
    };

    expect(executionResultInputSchema.safeParse(failedPythonResult).success).toBe(true);

    const response = await request(buildApp())
      .post(`/plans/${plan.id}/execute`)
      .send(failedPythonResult);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      plan_id: plan.id,
      status: 'executed',
      results: [
        persistedResult(plan.id, 'python-action', 'python-daemon', 'success', 'allow'),
        persistedResult(
          plan.id,
          'sibling-action-never-submitted',
          'python-daemon',
          'success',
          'allow',
        ),
      ],
    });
    expect(createExecutionResultMock.mock.calls).toEqual([
      [plan.id, 'python-action', 'python-daemon', 'success', 'allow'],
      [plan.id, 'sibling-action-never-submitted', 'python-daemon', 'success', 'allow'],
    ]);
    expect(response.body).not.toHaveProperty('error', failedPythonResult.error);
    expect(response.body).not.toHaveProperty('execution_id');
  });

  it('historically accepts a result-shaped body that executionResultInputSchema rejects, proving the schema is not applied at /execute', async () => {
    const plan = buildPlan();
    const malformedResult = {
      action_id: 'python-action',
      agent_id: 'python-daemon',
      status: 'not-a-valid-execution-status',
      output: { ignored: true },
    };

    expect(executionResultInputSchema.safeParse(malformedResult).success).toBe(false);

    const response = await request(buildApp())
      .post(`/plans/${plan.id}/execute`)
      .send(malformedResult);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('executed');
    expect(createExecutionResultMock.mock.calls).toEqual([
      [plan.id, 'python-action', 'python-daemon', 'success', 'allow'],
      [plan.id, 'sibling-action-never-submitted', 'python-daemon', 'success', 'allow'],
    ]);
  });
});
