/**
 * Active Phase 2B CLEAR decision characterization at the Phase 2E boundary.
 *
 * The exact pre-Phase-2E suite remains immutable in Git blob
 * 4e66c0006dd22cd5f1957e31077b4613ac0b3b30. Its legacy result-write and
 * execution-lock behavior is also preserved by the Phase 2E historical
 * characterization harness. These tests assert the same CLEAR decisions while
 * proving the command-only boundary creates no legacy result side effects.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ActionPlanRecord, ClearDecision } from '../src/shared/types/actionPlan.js';

const getAuthoritativePlanMock = jest.fn();
const updateAuthoritativePlanStatusMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const requestExecutionMock = jest.fn();
const replayExecutionMock = jest.fn();
const createExecutionResultMock = jest.fn();
const acquireExecutionLockMock = jest.fn();
const apiLoggerErrorMock = jest.fn();
const apiLoggerWarnMock = jest.fn();

type RegisteredTool = { handler: (args: unknown) => Promise<any> };

class FakeMcpServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<any>): void {
    this.tools.set(name, { handler });
  }
}

jest.unstable_mockModule('../src/mcp/registry.js', () => ({
  MCP_FLAGS: { exposeDestructive: true, requireConfirmation: false, enableSessions: false },
}));

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  createPlan: jest.fn(),
  getPlan: getAuthoritativePlanMock,
  getAuthoritativePlan: getAuthoritativePlanMock,
  listPlans: jest.fn(),
  listAuthoritativePlans: jest.fn(),
  updateAuthoritativePlanStatus: updateAuthoritativePlanStatusMock,
  approvePlan: jest.fn(),
  blockPlan: jest.fn(),
  expirePlan: jest.fn(),
  createExecutionResult: createExecutionResultMock,
  getExecutionResults: jest.fn(),
}));

jest.unstable_mockModule('../src/services/clear2.js', () => ({
  buildClear2Summary: buildClear2SummaryMock,
}));

jest.unstable_mockModule('../src/services/actionPlanExecution/realm.js', () => ({
  deriveActionPlanExecutionRealm: jest.fn(() => 'local-test'),
}));

jest.unstable_mockModule('../src/services/actionPlanExecution/service.js', () => ({
  createActionPlanExecutionService: jest.fn(() => ({
    requestExecution: requestExecutionMock,
    replayExecution: replayExecutionMock,
  })),
}));

jest.unstable_mockModule('../src/services/safety/executionLock.js', () => ({
  acquireExecutionLock: acquireExecutionLockMock,
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(), info: jest.fn(), warn: apiLoggerWarnMock, error: apiLoggerErrorMock,
  },
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const plansRouter = (await import('../src/routes/plans.js')).default;
const { registerActionPlanMcpTools } = await import('../src/mcp/server/actionPlanTools.js');

const requesterToken = 'r'.repeat(40);
const operatorToken = 'o'.repeat(40);
const envKeys = [
  'ACTION_PLAN_REQUEST_TOKEN',
  'ACTION_PLAN_REQUEST_PRINCIPAL_ID',
  'ACTION_PLAN_OPERATOR_TOKEN',
  'ACTION_PLAN_OPERATOR_PRINCIPAL_ID',
  'ACTION_PLAN_EXECUTION_LOCAL_REALM',
  'NODE_ENV',
] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let idempotencySequence = 0;

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureEnvironment(): void {
  process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
  process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'phase2b-requester';
  process.env.ACTION_PLAN_OPERATOR_TOKEN = operatorToken;
  process.env.ACTION_PLAN_OPERATOR_PRINCIPAL_ID = 'phase2b-operator';
  process.env.ACTION_PLAN_EXECUTION_LOCAL_REALM = 'local-test';
  process.env.NODE_ENV = 'test';
}

const principleScores = {
  clarity: 0.8,
  leverage: 0.8,
  efficiency: 0.8,
  alignment: 0.8,
  resilience: 0.8,
};

function clearResult(overall: number, decision: ClearDecision) {
  return { ...principleScores, overall, decision, notes: `synthetic ${decision}` };
}

function storedScore(planId: string, decision: ClearDecision) {
  return {
    id: `score-${decision}`,
    planId,
    ...principleScores,
    overall: decision === 'allow' ? 0.8 : decision === 'confirm' ? 0.5 : 0.2,
    decision,
    notes: null,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
  };
}

function buildPlan(previousDecision: ClearDecision | null = null): ActionPlanRecord {
  const planId = 'phase2b-clear-plan';
  const timestamp = new Date('2026-07-17T00:00:00.000Z');
  return {
    id: planId,
    createdBy: 'user',
    origin: 'phase2b-test',
    status: 'approved',
    confidence: 0.75,
    requiresConfirmation: false,
    idempotencyKey: 'phase2b-clear-plan-key',
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerPrincipalId: 'phase2b-requester',
    executionRealm: 'local-test',
    executionProtocolVersion: 2,
    executionGeneration: 1,
    clearScore: previousDecision ? storedScore(planId, previousDecision) : null,
    actions: [{
      id: 'action-one',
      planId,
      agentId: 'python-agent',
      capability: 'terminal.run',
      params: { command: 'synthetic-noop' },
      timeoutMs: 1_000,
      rollbackAction: null,
      sortOrder: 0,
    }],
  };
}

function buildHttpApp() {
  const app = express();
  app.use(express.json({ limit: '64kb', strict: true }));
  app.use(plansRouter);
  return app;
}

function executeHttp(planId: string, key = `phase2b-http-${++idempotencySequence}`) {
  return request(buildHttpApp())
    .post(`/plans/${planId}/execute`)
    .set('Authorization', `Bearer ${requesterToken}`)
    .set('Idempotency-Key', key)
    .send({});
}

function operatorMutation(planId: string, operation: 'approve' | 'block' | 'expire') {
  return request(buildHttpApp())
    .post(`/plans/${planId}/${operation}`)
    .set('Authorization', `Bearer ${operatorToken}`)
    .send({});
}

function buildMcpContext() {
  return {
    requestId: 'phase2b-mcp-request',
    traceId: 'phase2b-mcp-trace',
    transport: 'http',
    actionPlanPrincipal: { role: 'requester', principalId: 'phase2b-requester' },
    req: {},
    openai: {},
    runtimeBudget: {},
    logger: {
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    },
  } as any;
}

async function executeMcp(planId: string, key = `phase2b-mcp-${++idempotencySequence}`) {
  const context = buildMcpContext();
  const server = new FakeMcpServer();
  registerActionPlanMcpTools(server, context);
  const tool = server.tools.get('plans.execute');
  expect(tool).toBeDefined();
  return { context, output: await tool!.handler({ planId, idempotencyKey: key }), server };
}

function acceptedCommand(planId: string) {
  return {
    ok: true,
    code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
    protocol_version: 'action-plan-execution-v1',
    command_id: 'phase2b-command',
    plan_id: planId,
    disposition: 'COMMAND_CREATED',
    runs: [{ run_id: 'phase2b-run', action_id: 'action-one', state: 'REQUESTED' }],
  };
}

function circularThrownValue(): Record<string, unknown> {
  const value: Record<string, unknown> = { kind: 'circular' };
  value.self = value;
  return value;
}

const disclosureMarker = 'phase2b-private-dependency-marker';
const evaluatorFailureCases: Array<[string, () => unknown, string[]]> = [
  ['ordinary error', () => new Error('ordinary dependency detail'), ['ordinary dependency detail']],
  ['credential marker', () => new Error(disclosureMarker), [disclosureMarker]],
  ['authorization text', () => new Error(`Authorization Bearer ${disclosureMarker}`), [disclosureMarker]],
  ['filesystem path', () => new Error('C:\\private\\clear\\dependency.log'), ['private\\clear']],
  ['SQL text', () => new Error('SELECT * FROM private_clear_table'), ['private_clear_table']],
  ['provider JSON', () => new Error(JSON.stringify({ provider: disclosureMarker })), [disclosureMarker]],
  ['nested cause', () => new Error('outer detail', { cause: new Error(disclosureMarker) }), ['outer detail', disclosureMarker]],
  ['non-Error string', () => disclosureMarker, [disclosureMarker]],
  ['circular object', circularThrownValue, ['circular']],
  ['very long message', () => new Error('x'.repeat(20_000)), ['x'.repeat(128)]],
  ['Unicode/control', () => new Error(`internal-雪\r\n${disclosureMarker}`), ['internal-雪', disclosureMarker]],
  ['undefined thrown value', () => undefined, []],
];

beforeEach(() => {
  restoreEnvironment();
  configureEnvironment();
  jest.clearAllMocks();
  idempotencySequence = 0;
  replayExecutionMock.mockResolvedValue(null);
  requestExecutionMock.mockResolvedValue(acceptedCommand('phase2b-clear-plan'));
  updateAuthoritativePlanStatusMock.mockImplementation(async (input: { status: string }) => ({
    ...buildPlan(),
    status: input.status,
  }));
});

afterAll(restoreEnvironment);

describe('CLEAR execution decision persistence at the Phase 2E command boundary', () => {
  it.each([
    ['allow with no stored score', null, clearResult(0.8, 'allow'), 'allow', 0.8],
    ['allow with explicit null score', null, { ...principleScores, overall: null, decision: 'allow' }, 'allow', null],
    ['allow over stored confirm', 'confirm', clearResult(0.8, 'allow'), 'allow', 0.8],
    ['confirm over stored allow', 'allow', clearResult(0.5, 'confirm'), 'confirm', 0.5],
    ['confirm with explicit null score', null, { ...principleScores, overall: null, decision: 'confirm' }, 'confirm', null],
  ] as const)(
    'authorizes command runs for %s without fabricating results',
    async (_label, prior, current, expectedDecision, expectedOverall) => {
      const plan = buildPlan(prior);
      getAuthoritativePlanMock.mockResolvedValue(plan);
      buildClear2SummaryMock.mockReturnValue(current);

      const http = await executeHttp(plan.id);
      const mcp = await executeMcp(plan.id);

      expect(http.status).toBe(202);
      expect(http.body.code).toBe('ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED');
      expect(mcp.output.structuredContent.code).toBe('ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED');
      expect(requestExecutionMock).toHaveBeenCalledTimes(2);
      expect(requestExecutionMock.mock.calls.map(call => call[0].policyExpectation)).toEqual([
        { decision: expectedDecision, overall: expectedOverall, planExecutionGeneration: 1 },
        { decision: expectedDecision, overall: expectedOverall, planExecutionGeneration: 1 },
      ]);
      expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
      expect(createExecutionResultMock).not.toHaveBeenCalled();
      expect(acquireExecutionLockMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['finite score', clearResult(0.2, 'block')],
    ['explicit null score', { ...principleScores, overall: null, decision: 'block' }],
  ] as const)('persists only an explicit coherent block with %s', async (_label, current) => {
    const plan = buildPlan('allow');
    getAuthoritativePlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(current);

    const http = await executeHttp(plan.id);
    const mcp = await executeMcp(plan.id);

    expect(http.status).toBe(403);
    expect(mcp.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_GATED',
      message: 'CLEAR re-evaluation blocked this plan',
      details: { tool: 'plans.execute', category: 'ACTION_PLAN_POLICY_BLOCKED' },
    }));
    expect(updateAuthoritativePlanStatusMock).toHaveBeenCalledTimes(2);
    expect(updateAuthoritativePlanStatusMock).toHaveBeenCalledWith({
      planId: plan.id,
      executionRealm: 'local-test',
      status: 'blocked',
      allowedCurrentStatuses: ['approved'],
    });
    expect(requestExecutionMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null result', null, 503, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.'],
    ['missing decision', { ...principleScores, overall: 0.8 }, 503, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.'],
    ['non-finite score', { ...principleScores, overall: Number.NaN, decision: 'block' }, 500, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.'],
    ['contradictory result', clearResult(0.2, 'allow'), 500, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.'],
  ] as const)(
    'suppresses every write for %s',
    async (_label, current, status, category, message) => {
      const plan = buildPlan('allow');
      getAuthoritativePlanMock.mockResolvedValue(plan);
      buildClear2SummaryMock.mockReturnValue(current);

      const http = await executeHttp(plan.id);
      const mcp = await executeMcp(plan.id);

      expect(http.status).toBe(status);
      expect(http.body).toEqual({ error: category, message });
      expect(mcp.output.structuredContent.error).toEqual({
        code: 'ERR_INTERNAL',
        message,
        details: { tool: 'plans.execute', category },
        requestId: 'phase2b-mcp-request',
      });
      expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
      expect(requestExecutionMock).not.toHaveBeenCalled();
      expect(createExecutionResultMock).not.toHaveBeenCalled();
    },
  );

  it.each(evaluatorFailureCases)(
    'sanitizes HTTP and MCP evaluator failure: %s',
    async (_label, buildThrown, forbiddenValues) => {
      const plan = buildPlan();
      getAuthoritativePlanMock.mockResolvedValue(plan);
      buildClear2SummaryMock.mockImplementation(() => { throw buildThrown(); });

      const http = await executeHttp(plan.id);
      const mcp = await executeMcp(plan.id);
      const observable = JSON.stringify({
        http: http.body,
        mcp: mcp.output,
        httpLogs: apiLoggerErrorMock.mock.calls,
        mcpLogs: mcp.context.logger.warn.mock.calls,
      });

      expect(http.status).toBe(503);
      expect(http.body).toEqual({
        error: 'CLEAR_EVALUATION_UNAVAILABLE',
        message: 'CLEAR evaluation is unavailable.',
      });
      expect(mcp.output.structuredContent.error).toEqual(expect.objectContaining({
        code: 'ERR_INTERNAL',
        message: 'CLEAR evaluation is unavailable.',
        details: { tool: 'plans.execute', category: 'CLEAR_EVALUATION_UNAVAILABLE' },
      }));
      expect(forbiddenValues.some(value => observable.includes(value))).toBe(false);
      expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
      expect(requestExecutionMock).not.toHaveBeenCalled();
    },
  );

  it.each(['rejects', 'returns-null', 'returns-undefined'] as const)(
    'fails safely when explicit-block persistence %s',
    async mode => {
      const plan = buildPlan('allow');
      getAuthoritativePlanMock.mockResolvedValue(plan);
      buildClear2SummaryMock.mockReturnValue(clearResult(0.2, 'block'));
      if (mode === 'rejects') {
        updateAuthoritativePlanStatusMock.mockRejectedValue(new Error(disclosureMarker));
      } else if (mode === 'returns-null') {
        updateAuthoritativePlanStatusMock.mockResolvedValue(null);
      } else {
        updateAuthoritativePlanStatusMock.mockResolvedValue(undefined);
      }

      const http = await executeHttp(plan.id);
      const mcp = await executeMcp(plan.id);
      const observable = JSON.stringify({
        http: http.body,
        mcp: mcp.output,
        httpLogs: apiLoggerErrorMock.mock.calls,
        mcpLogs: mcp.context.logger.warn.mock.calls,
      });

      expect(http.status).toBe(500);
      expect(http.body).toEqual({
        error: 'CLEAR_PERSISTENCE_FAILED',
        message: 'CLEAR decision persistence failed.',
      });
      expect(mcp.output.structuredContent.error).toEqual(expect.objectContaining({
        code: 'ERR_INTERNAL',
        message: 'CLEAR decision persistence failed.',
        details: { tool: 'plans.execute', category: 'CLEAR_PERSISTENCE_FAILED' },
      }));
      expect(observable).not.toContain(disclosureMarker);
      expect(requestExecutionMock).not.toHaveBeenCalled();
      expect(createExecutionResultMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['blocked', false, null, 403, 'ACTION_PLAN_POLICY_BLOCKED', 'lifecycle_blocked'],
    ['completed', false, null, 409, 'ACTION_PLAN_TERMINAL', 'terminal_state'],
    [undefined, true, null, 409, 'ACTION_PLAN_STATE_UNAVAILABLE', 'state_missing'],
    ['private-state', false, null, 409, 'ACTION_PLAN_STATE_INVALID', 'state_unknown'],
    ['approved', false, new Date('2000-01-01T00:00:00.000Z'), 409, 'ACTION_PLAN_TERMINAL', 'expiry_elapsed'],
  ] as const)(
    'rejects lifecycle state %s before CLEAR or command effects',
    async (status, omitStatus, expiresAt, httpStatus, category, reasonCode) => {
      const plan = { ...buildPlan('allow'), status, expiresAt } as unknown as ActionPlanRecord;
      if (omitStatus) delete (plan as unknown as Record<string, unknown>).status;
      getAuthoritativePlanMock.mockResolvedValue(plan);

      const http = await executeHttp(plan.id);
      const mcp = await executeMcp(plan.id);

      expect(http.status).toBe(httpStatus);
      expect(http.body).toEqual(expect.objectContaining({ category, reasonCode }));
      expect(mcp.output.structuredContent.error).toEqual(expect.objectContaining({
        code: 'ERR_GATED',
        details: expect.objectContaining({ category, reasonCode }),
      }));
      expect(buildClear2SummaryMock).not.toHaveBeenCalled();
      expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
      expect(requestExecutionMock).not.toHaveBeenCalled();
      expect(createExecutionResultMock).not.toHaveBeenCalled();
    },
  );

  it('keeps operator lifecycle mutations on authenticated HTTP and omits legacy destructive MCP tools', async () => {
    const planned = { ...buildPlan('allow'), status: 'planned' } as ActionPlanRecord;
    const approved = { ...planned, status: 'approved' } as ActionPlanRecord;
    getAuthoritativePlanMock.mockResolvedValue(planned);
    updateAuthoritativePlanStatusMock.mockResolvedValue(approved);

    const response = await operatorMutation(planned.id, 'approve');
    const context = buildMcpContext();
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('approved');
    expect(updateAuthoritativePlanStatusMock).toHaveBeenCalledWith({
      planId: planned.id,
      executionRealm: 'local-test',
      status: 'approved',
      allowedCurrentStatuses: ['planned', 'awaiting_confirmation'],
    });
    expect([...server.tools.keys()]).not.toEqual(expect.arrayContaining([
      'plans.approve', 'plans.block', 'plans.expire', 'plans.results',
    ]));
  });

  it('does not let diagnostic logger failure mask a stable sanitized evaluator response', async () => {
    const plan = buildPlan();
    getAuthoritativePlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockImplementation(() => { throw new Error(disclosureMarker); });
    apiLoggerErrorMock.mockImplementation(() => { throw new Error('logger unavailable'); });

    const response = await executeHttp(plan.id);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'CLEAR_EVALUATION_UNAVAILABLE',
      message: 'CLEAR evaluation is unavailable.',
    });
    expect(JSON.stringify(response.body)).not.toContain(disclosureMarker);
  });
});
