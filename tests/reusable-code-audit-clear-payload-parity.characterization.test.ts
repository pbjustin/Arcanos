import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ActionPlanRecord } from '../src/shared/types/actionPlan.js';

const getPlanMock = jest.fn();
const updateAuthoritativePlanStatusMock = jest.fn();
const createExecutionResultMock = jest.fn();
const validateCapabilityMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const acquireExecutionLockMock = jest.fn();
const emitSafetyAuditEventMock = jest.fn();
const apiLoggerErrorMock = jest.fn();
const requestExecutionMock = jest.fn();
const replayExecutionMock = jest.fn();

type RegisteredTool = {
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
};

class FakeMcpServer {
  public readonly tools = new Map<string, RegisteredTool>();

  constructor(
    _info: { name: string; version: string },
    _options: { capabilities?: Record<string, unknown> },
  ) {}

  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: unknown) => Promise<unknown>,
  ): void {
    this.tools.set(name, { config, handler });
  }
}

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: FakeMcpServer,
}));

jest.unstable_mockModule('../src/mcp/registry.js', () => ({
  MCP_FLAGS: {
    exposeDestructive: true,
    requireConfirmation: false,
    enableSessions: false,
  },
}));

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  createPlan: jest.fn(),
  getPlan: getPlanMock,
  getAuthoritativePlan: getPlanMock,
  approvePlan: jest.fn(),
  blockPlan: jest.fn(),
  expirePlan: jest.fn(),
  listPlans: jest.fn(),
  listAuthoritativePlans: jest.fn(),
  updateAuthoritativePlanStatus: updateAuthoritativePlanStatusMock,
  createExecutionResult: createExecutionResultMock,
  getExecutionResults: jest.fn(),
}));

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  validateCapability: validateCapabilityMock,
  listAgents: jest.fn(async () => []),
  getAgent: jest.fn(),
  registerAgent: jest.fn(),
  updateHeartbeat: jest.fn(),
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

jest.unstable_mockModule('../src/services/safety/auditEvents.js', () => ({
  emitSafetyAuditEvent: emitSafetyAuditEventMock,
}));

jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
  apiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: apiLoggerErrorMock,
  },
  aiLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  dbLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  workerLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/core/logic/arcanos.js', () => ({
  runARCANOS: jest.fn(),
}));

jest.unstable_mockModule('../src/core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: jest.fn(),
}));

jest.unstable_mockModule('../src/trinity/trinity.js', () => ({
  runTrinity: jest.fn(),
}));

jest.unstable_mockModule('../src/config/openai.js', () => ({
  DEFAULT_FINE_TUNE: 'ft:reusable-code-audit',
}));

jest.unstable_mockModule('../src/services/webRag.js', () => ({
  ingestUrl: jest.fn(),
  ingestContent: jest.fn(),
  answerQuestion: jest.fn(),
}));

jest.unstable_mockModule('../src/services/researchHub.js', () => ({
  connectResearchBridge: jest.fn(() => ({
    requestResearch: jest.fn(),
  })),
}));

jest.unstable_mockModule('../src/core/db/index.js', () => ({
  saveMemory: jest.fn(),
  loadMemory: jest.fn(),
  deleteMemory: jest.fn(),
  query: jest.fn(),
}));

jest.unstable_mockModule('../src/services/moduleLoader.js', () => ({
  loadModuleDefinitions: jest.fn(async () => []),
  clearModuleDefinitionCache: jest.fn(),
}));

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  dispatchModuleAction: jest.fn(),
}));

jest.unstable_mockModule('../src/services/memoryListing.js', () => ({
  buildActiveMemorySelect: jest.fn(),
  normalizeMemoryEntries: jest.fn(),
}));

jest.unstable_mockModule('../src/platform/logging/diagnostics.js', () => ({
  runHealthCheck: jest.fn(),
}));

jest.unstable_mockModule('../src/services/gptFastPath.js', () => ({
  executeFastGptPrompt: jest.fn(),
}));

jest.unstable_mockModule('../src/shared/gpt/gptFastPath.js', () => ({
  classifyGptFastPathRequest: jest.fn(),
}));

jest.unstable_mockModule('../src/services/controlPlane/service.js', () => ({
  executeControlPlaneRequest: jest.fn(),
  getControlPlaneCapabilities: jest.fn(() => ({})),
  requiresControlPlaneApproval: jest.fn(() => false),
}));

jest.unstable_mockModule('../src/mcp/modulesAllowlist.js', () => ({
  isModuleActionAllowed: jest.fn(() => false),
}));

jest.unstable_mockModule('../src/mcp/server/dagTools.js', () => ({
  registerDagMcpTools: jest.fn(),
}));

jest.unstable_mockModule('../src/mcp/server/jobTools.js', () => ({
  registerJobMcpTools: jest.fn(),
}));

jest.unstable_mockModule('../src/mcp/server/controlPlaneTools.js', () => ({
  registerControlPlaneMcpTools: jest.fn(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const plansRouter = (await import('../src/routes/plans.js')).default;
const { buildClearRecheckInput } = await import('../src/mcp/server/helpers.js');
const { createMcpServer } = await import('../src/mcp/server/index.js');

const originalEnv = { ...process.env };
const requesterToken = 'r'.repeat(40);
const blockedClearSummary = {
  clarity: 0,
  leverage: 0,
  efficiency: 0,
  alignment: 0,
  resilience: 0,
  overall: 0,
  decision: 'block',
  notes: 'characterization stop before execution',
};

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', plansRouter);
  return app;
}

function executeThroughHttp(planId: string) {
  return request(buildApp())
    .post(`/plans/${planId}/execute`)
    .set('Authorization', `Bearer ${requesterToken}`)
    .set('Idempotency-Key', 'reusable-audit-http-command')
    .send({});
}

function buildMcpContext() {
  return {
    requestId: 'reusable-audit-mcp-request',
    traceId: 'reusable-audit-mcp-trace',
    sessionId: 'reusable-audit-mcp-session',
    transport: 'http',
    actionPlanPrincipal: { role: 'requester', principalId: 'reusable-audit-requester' },
    openai: {},
    runtimeBudget: {},
    req: {},
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

async function executeThroughMcp(planId: string) {
  const context = buildMcpContext();
  const server = await createMcpServer(context) as FakeMcpServer;
  const tool = server.tools.get('plans.execute');

  expect(tool).toBeDefined();

  return {
    context,
    output: await tool!.handler({ planId, idempotencyKey: 'reusable-audit-mcp-command' }),
  };
}

function buildPlan(rollbackAction: unknown): ActionPlanRecord {
  const timestamp = new Date('2026-07-16T18:30:00.000Z');
  return {
    id: 'reusable-audit-clear-plan',
    createdBy: 'user',
    origin: 'reusable-code-audit',
    status: 'approved',
    confidence: 0.625,
    requiresConfirmation: true,
    idempotencyKey: 'reusable-audit-clear-idempotency',
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerPrincipalId: 'reusable-audit-requester',
    executionRealm: 'local-test',
    executionProtocolVersion: 2,
    executionGeneration: 1,
    clearScore: null,
    actions: [
      {
        id: 'action-b',
        planId: 'reusable-audit-clear-plan',
        agentId: 'agent-shared',
        capability: 'inspect',
        params: {
          order: 1,
          nested: { token_like_value: 'forwarded-without-normalization' },
        },
        timeoutMs: 1_500,
        rollbackAction: null,
        sortOrder: 2,
      },
      {
        id: 'action-a',
        planId: 'reusable-audit-clear-plan',
        agentId: 'agent-shared',
        capability: 'execute',
        params: null,
        timeoutMs: undefined as unknown as number,
        rollbackAction,
        sortOrder: 1,
      },
    ],
  };
}

describe('reusable-code audit: HTTP and MCP CLEAR recheck payload parity', () => {
  beforeEach(() => {
    restoreEnvironment();
    process.env.ACTION_PLAN_REQUEST_TOKEN = requesterToken;
    process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'reusable-audit-requester';
    process.env.ACTION_PLAN_EXECUTION_LOCAL_REALM = 'local-test';
    process.env.NODE_ENV = 'test';
    jest.clearAllMocks();
    getPlanMock.mockReset();
    updateAuthoritativePlanStatusMock.mockReset();
    createExecutionResultMock.mockReset();
    validateCapabilityMock.mockReset();
    buildClear2SummaryMock.mockReset();
    acquireExecutionLockMock.mockReset();
    emitSafetyAuditEventMock.mockReset();
    apiLoggerErrorMock.mockReset();
    requestExecutionMock.mockReset();
    replayExecutionMock.mockReset();

    validateCapabilityMock.mockResolvedValue(true);
    buildClear2SummaryMock.mockReturnValue(blockedClearSummary);
    replayExecutionMock.mockResolvedValue(null);
    requestExecutionMock.mockResolvedValue({
      ok: true,
      code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
      protocol_version: 'action-plan-execution-v1',
      command_id: 'reusable-audit-command',
      plan_id: 'reusable-audit-clear-plan',
      disposition: 'COMMAND_CREATED',
      runs: [
        { run_id: 'run-action-b', action_id: 'action-b', state: 'REQUESTED' },
        { run_id: 'run-action-a', action_id: 'action-a', state: 'REQUESTED' },
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnvironment();
  });

  it.each([
    ['null rollback data', null, false],
    ['falsey non-null rollback data', false, true],
  ])(
    'passes the same ordered payload through HTTP and the actual MCP plans.execute handler for %s',
    async (_label, rollbackAction, expectedHasRollbacks) => {
      const plan = buildPlan(rollbackAction);
      getPlanMock.mockResolvedValue(plan);
      updateAuthoritativePlanStatusMock.mockResolvedValue({ ...plan, status: 'blocked' });

      const httpResponse = await executeThroughHttp(plan.id);

      expect(httpResponse.status).toBe(403);
      expect(httpResponse.body).toEqual({
        error: 'CLEAR re-evaluation blocked this plan',
        clearScore: blockedClearSummary,
      });
      expect(buildClear2SummaryMock).toHaveBeenCalledTimes(1);

      const httpPayload = buildClear2SummaryMock.mock.calls[0]?.[0];
      const helperPayload = buildClearRecheckInput(plan);
      expect(httpPayload).toEqual(helperPayload);
      expect(httpPayload).toEqual({
        actions: [
          {
            action_id: 'action-b',
            agent_id: 'agent-shared',
            capability: 'inspect',
            params: {
              order: 1,
              nested: { token_like_value: 'forwarded-without-normalization' },
            },
            timeout_ms: 1_500,
          },
          {
            action_id: 'action-a',
            agent_id: 'agent-shared',
            capability: 'execute',
            params: null,
            timeout_ms: undefined,
          },
        ],
        origin: 'reusable-code-audit',
        confidence: 0.625,
        hasRollbacks: expectedHasRollbacks,
        capabilitiesKnown: true,
        agentsRegistered: true,
      });

      const mcpExecution = await executeThroughMcp(plan.id);
      const mcpPayload = buildClear2SummaryMock.mock.calls[1]?.[0];

      expect(buildClear2SummaryMock).toHaveBeenCalledTimes(2);
      expect(mcpPayload).toEqual(httpPayload);
      expect(mcpExecution.output).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'ERR_GATED',
              message: 'CLEAR re-evaluation blocked this plan',
              details: {
                tool: 'plans.execute',
                category: 'ACTION_PLAN_POLICY_BLOCKED',
              },
              requestId: 'reusable-audit-mcp-request',
            },
          }, null, 2),
        }],
        structuredContent: {
          error: {
            code: 'ERR_GATED',
            message: 'CLEAR re-evaluation blocked this plan',
            details: {
              tool: 'plans.execute',
              category: 'ACTION_PLAN_POLICY_BLOCKED',
            },
            requestId: 'reusable-audit-mcp-request',
          },
        },
        isError: true,
      });

      expect((httpPayload as { actions: Array<{ params: unknown }> }).actions[0]?.params)
        .toBe(plan.actions[0]?.params);
      expect((httpPayload as { actions: Array<{ params: unknown }> }).actions[1]?.params)
        .toBeNull();
      expect((httpPayload as { actions: Array<Record<string, unknown>> }).actions.map(action => action.action_id))
        .toEqual(['action-b', 'action-a']);
      expect(Object.hasOwn(
        (httpPayload as { actions: Array<Record<string, unknown>> }).actions[1]!,
        'timeout_ms',
      )).toBe(true);
      expect((httpPayload as { actions: Array<Record<string, unknown>> }).actions[1]?.timeout_ms)
        .toBeUndefined();

      expect(getPlanMock).toHaveBeenNthCalledWith(1, plan.id);
      expect(getPlanMock).toHaveBeenNthCalledWith(2, plan.id);
      expect(validateCapabilityMock).not.toHaveBeenCalled();
      expect(updateAuthoritativePlanStatusMock.mock.calls).toEqual([
        [{
          planId: plan.id,
          executionRealm: 'local-test',
          status: 'blocked',
          allowedCurrentStatuses: ['approved'],
        }],
        [{
          planId: plan.id,
          executionRealm: 'local-test',
          status: 'blocked',
          allowedCurrentStatuses: ['approved'],
        }],
      ]);
      expect(createExecutionResultMock).not.toHaveBeenCalled();
      expect(acquireExecutionLockMock).not.toHaveBeenCalled();
      expect(emitSafetyAuditEventMock).not.toHaveBeenCalled();
      expect(mcpExecution.context.logger.info).toHaveBeenCalledWith(
        'mcp.tool.end',
        expect.objectContaining({
          tool: 'plans.execute',
          isError: true,
        }),
      );
    },
  );

  it('keeps capability ownership out of the HTTP and MCP adapters and creates no legacy result writes', async () => {
    const plan = buildPlan(null);
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue({
      ...blockedClearSummary,
      overall: 1,
      decision: 'allow',
    });

    const httpResponse = await executeThroughHttp(plan.id);
    const mcpExecution = await executeThroughMcp(plan.id);

    expect(httpResponse.status).toBe(202);
    expect(mcpExecution.output).not.toHaveProperty('isError');
    expect(validateCapabilityMock).not.toHaveBeenCalled();
    expect(buildClear2SummaryMock).toHaveBeenCalledTimes(2);
    expect(requestExecutionMock).toHaveBeenCalledTimes(2);
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
  });

  it('preserves Phase 1 payload parity while creating command runs without fabricating results', async () => {
    const plan = buildPlan(null);
    const allowSummary = {
      ...blockedClearSummary,
      overall: 1,
      decision: 'allow',
      notes: 'characterization allow execution',
    };
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(allowSummary);

    const httpResponse = await executeThroughHttp(plan.id);
    const mcpExecution = await executeThroughMcp(plan.id);

    expect(httpResponse.status).toBe(202);
    expect(httpResponse.body).toEqual(expect.objectContaining({
      code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
      plan_id: plan.id,
      runs: expect.arrayContaining([
        expect.objectContaining({ action_id: 'action-b', state: 'REQUESTED' }),
        expect.objectContaining({ action_id: 'action-a', state: 'REQUESTED' }),
      ]),
    }));
    expect(mcpExecution.output).toEqual(expect.objectContaining({
      structuredContent: expect.objectContaining({
        code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
        plan_id: plan.id,
      }),
    }));
    expect(buildClear2SummaryMock.mock.calls[0]?.[0])
      .toEqual(buildClear2SummaryMock.mock.calls[1]?.[0]);
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
    expect(requestExecutionMock.mock.calls).toEqual([
      [expect.objectContaining({
        planId: plan.id,
        idempotencyKey: 'reusable-audit-http-command',
        policyExpectation: { decision: 'allow', overall: 1, planExecutionGeneration: 1 },
      })],
      [expect.objectContaining({
        planId: plan.id,
        idempotencyKey: 'reusable-audit-mcp-command',
        policyExpectation: { decision: 'allow', overall: 1, planExecutionGeneration: 1 },
      })],
    ]);
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
    expect(emitSafetyAuditEventMock).not.toHaveBeenCalled();
  });

  it('preserves protocol envelopes while sanitizing block-persistence failures', async () => {
    const plan = buildPlan(null);
    const persistenceError = new Error('characterization persistence unavailable');

    getPlanMock.mockResolvedValue(plan);
    updateAuthoritativePlanStatusMock.mockRejectedValue(persistenceError);

    const httpResponse = await executeThroughHttp(plan.id);
    const mcpExecution = await executeThroughMcp(plan.id);

    expect(httpResponse.status).toBe(500);
    expect(httpResponse.body).toEqual({
      error: 'CLEAR_PERSISTENCE_FAILED',
      message: 'CLEAR decision persistence failed.',
    });
    expect(mcpExecution.output).toEqual(expect.objectContaining({
      isError: true,
      structuredContent: {
        error: {
          code: 'ERR_INTERNAL',
          message: 'CLEAR decision persistence failed.',
          details: {
            tool: 'plans.execute',
            category: 'CLEAR_PERSISTENCE_FAILED',
          },
          requestId: 'reusable-audit-mcp-request',
        },
      },
    }));
    expect(buildClear2SummaryMock).toHaveBeenCalledTimes(2);
    expect(updateAuthoritativePlanStatusMock).toHaveBeenCalledTimes(2);
    expect(apiLoggerErrorMock).toHaveBeenCalledWith(
      'CLEAR execution failed',
      expect.objectContaining({
        module: 'plans',
        errorCode: 'CLEAR_PERSISTENCE_FAILED',
        operation: 'plans.execute.persist_block',
        dependency: 'actionPlanStore',
        errorClass: 'Error',
        retryable: true,
      }),
    );
    expect(mcpExecution.context.logger.warn).toHaveBeenCalledWith(
      'mcp.action_plan.rejected',
      expect.objectContaining({
        tool: 'plans.execute',
        errorCode: 'CLEAR_PERSISTENCE_FAILED',
        errorClass: 'Error',
      }),
    );
    expect(JSON.stringify({
      http: httpResponse.body,
      mcp: mcpExecution.output,
      httpLogs: apiLoggerErrorMock.mock.calls,
      mcpLogs: mcpExecution.context.logger.warn.mock.calls,
    }).includes(persistenceError.message)).toBe(false);
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
  });
});
