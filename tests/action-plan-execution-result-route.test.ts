import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const capabilityMock = jest.fn();
const claimExecutionMock = jest.fn();
const startExecutionMock = jest.fn();
const submitResultMock = jest.fn();
const readStatusMock = jest.fn();
const readResultMock = jest.fn();
const apiLoggerWarnMock = jest.fn();

jest.unstable_mockModule('@services/actionPlanExecution/service.js', () => ({
  createActionPlanExecutionService: () => ({
    capability: capabilityMock,
    claimExecution: claimExecutionMock,
    startExecution: startExecutionMock,
    submitResult: submitResultMock,
    readStatus: readStatusMock,
    readResult: readResultMock,
  }),
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  apiLogger: { debug: jest.fn(), info: jest.fn(), warn: apiLoggerWarnMock, error: jest.fn() },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/action-plan-executions.js')).default;
const { ActionPlanExecutionError, ACTION_PLAN_EXECUTION_ERRORS } = await import(
  '../src/services/actionPlanExecution/errors.js'
);

const executorToken = 'e'.repeat(40);
const requesterToken = 'r'.repeat(40);
const keys = [
  'ACTION_PLAN_EXECUTOR_TOKEN', 'ACTION_PLAN_EXECUTOR_PRINCIPAL_ID',
  'ACTION_PLAN_EXECUTOR_INSTANCE_ID', 'ACTION_PLAN_EXECUTOR_AGENT_ID',
  'ACTION_PLAN_REQUEST_TOKEN', 'ACTION_PLAN_REQUEST_PRINCIPAL_ID',
] as const;
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));

function restoreEnv() {
  for (const key of keys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureEnv() {
  process.env.ACTION_PLAN_EXECUTOR_TOKEN = executorToken;
  process.env.ACTION_PLAN_EXECUTOR_PRINCIPAL_ID = 'executor-1';
  process.env.ACTION_PLAN_EXECUTOR_INSTANCE_ID = 'instance-1';
  process.env.ACTION_PLAN_EXECUTOR_AGENT_ID = 'agent-1';
  process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
  process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'requester-1';
}

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(router);
  return app;
}

function resultRequest() {
  return request(buildApp())
    .post('/plans/plan-1/executions/run-1/result')
    .set('Authorization', `Bearer ${executorToken}`)
    .set('Idempotency-Key', 'result-key-1');
}

describe('Phase 2E result-only HTTP boundary', () => {
  beforeEach(() => {
    restoreEnv();
    configureEnv();
    jest.clearAllMocks();
    submitResultMock.mockResolvedValue({
      ok: true,
      code: 'ACTION_PLAN_EXECUTION_RESULT_ACCEPTED',
      protocol_version: 'action-plan-execution-v1',
      execution_realm: 'local-test',
      plan_id: 'plan-1',
      run_id: 'run-1',
      action_id: 'action-1',
      snapshot_id: 'snapshot-1',
      state: 'FAILED',
      terminal_category: 'failed',
      disposition: 'RESULT_ACCEPTED',
      acceptance_receipt: 'receipt-1',
      status_location: '/plans/plan-1/executions/run-1',
      result_location: '/plans/plan-1/executions/run-1/result',
    });
  });

  afterAll(restoreEnv);

  it('submits one bounded result and cannot invoke command, claim, start, or read operations', async () => {
    const response = await resultRequest().send({
      action_id: 'action-1',
      snapshot_id: 'snapshot-1',
      outcome: 'failed',
      error: { code: 'SYNTHETIC_FAILURE', category: 'execution' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_RESULT_ACCEPTED',
      run_id: 'run-1',
      action_id: 'action-1',
      state: 'FAILED',
    });
    expect(submitResultMock).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1', runId: 'run-1', actionId: 'action-1', snapshotId: 'snapshot-1',
      outcome: 'failed', idempotencyKey: 'result-key-1',
      actor: expect.objectContaining({
        role: 'executor', principalId: 'executor-1', executorInstanceId: 'instance-1',
      }),
    }));
    expect(claimExecutionMock).not.toHaveBeenCalled();
    expect(startExecutionMock).not.toHaveBeenCalled();
    expect(readStatusMock).not.toHaveBeenCalled();
    expect(readResultMock).not.toHaveBeenCalled();
  });

  it.each([
    { plan_id: 'plan-1', action_ids: ['action-1'] },
    { action_id: 'action-1', snapshot_id: 'snapshot-1', outcome: 'succeeded', command: true },
    { action_id: 'action-1', snapshot_id: 'snapshot-1', outcome: 'unknown' },
    { action_id: 'action-1', snapshot_id: 'snapshot-1', outcome: 'failed', output: { impossible: true } },
  ])('rejects command-shaped, unknown, or contradictory result input with zero operation effect', async body => {
    const response = await resultRequest().send(body);
    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_REQUEST_INVALID');
    expect(submitResultMock).not.toHaveBeenCalled();
    expect(claimExecutionMock).not.toHaveBeenCalled();
    expect(startExecutionMock).not.toHaveBeenCalled();
  });

  it('requires the executor role and never trusts caller-supplied ownership fields', async () => {
    const response = await request(buildApp())
      .post('/plans/plan-1/executions/run-1/result')
      .set('Authorization', `Bearer ${requesterToken}`)
      .set('Idempotency-Key', 'result-key-1')
      .send({
        action_id: 'action-1', snapshot_id: 'snapshot-1', outcome: 'succeeded',
        executor_id: 'executor-1', realm: 'local-test',
      });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_FORBIDDEN');
    expect(submitResultMock).not.toHaveBeenCalled();
  });

  it('returns a fixed sanitized error when persistence rejects and does not leak nested sentinels', async () => {
    const sentinels = ['private-token-sentinel', 'C:\\private\\result.json', 'SELECT secret FROM results'];
    submitResultMock.mockRejectedValue(new Error(sentinels.join(' | ')));
    const response = await resultRequest().send({
      action_id: 'action-1', snapshot_id: 'snapshot-1', outcome: 'succeeded', output: { ok: true },
    });
    const observable = JSON.stringify({ body: response.body, logs: apiLoggerWarnMock.mock.calls });
    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: 'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED',
      message: 'ActionPlan execution persistence is unavailable.',
    });
    for (const sentinel of sentinels) expect(observable).not.toContain(sentinel);
  });

  it('preserves start-before-claim as a stable state conflict with zero result effect', async () => {
    startExecutionMock.mockRejectedValue(
      new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict),
    );
    const response = await request(buildApp())
      .post('/plans/plan-1/executions/run-1/start')
      .set('Authorization', `Bearer ${executorToken}`)
      .set('Idempotency-Key', 'start-key-1')
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ACTION_PLAN_EXECUTION_STATE_CONFLICT');
    expect(submitResultMock).not.toHaveBeenCalled();
  });
});
