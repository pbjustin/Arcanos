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
const blockPlanMock = jest.fn();
const createExecutionResultMock = jest.fn();
const validateCapabilityMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const acquireExecutionLockMock = jest.fn();
const emitSafetyAuditEventMock = jest.fn();
const apiLoggerErrorMock = jest.fn();

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
  approvePlan: jest.fn(),
  blockPlan: blockPlanMock,
  expirePlan: jest.fn(),
  listPlans: jest.fn(),
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

function buildMcpContext() {
  return {
    requestId: 'reusable-audit-mcp-request',
    traceId: 'reusable-audit-mcp-trace',
    sessionId: 'reusable-audit-mcp-session',
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
    output: await tool!.handler({ planId }),
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
    jest.clearAllMocks();
    getPlanMock.mockReset();
    blockPlanMock.mockReset();
    createExecutionResultMock.mockReset();
    validateCapabilityMock.mockReset();
    buildClear2SummaryMock.mockReset();
    acquireExecutionLockMock.mockReset();
    emitSafetyAuditEventMock.mockReset();
    apiLoggerErrorMock.mockReset();

    validateCapabilityMock.mockResolvedValue(true);
    buildClear2SummaryMock.mockReturnValue(blockedClearSummary);
    blockPlanMock.mockResolvedValue(undefined);
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
      blockPlanMock.mockResolvedValue({ ...plan, status: 'blocked' });

      const httpResponse = await request(buildApp())
        .post(`/plans/${plan.id}/execute`)
        .send({});

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
                planId: plan.id,
                clearRecheck: blockedClearSummary,
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
              planId: plan.id,
              clearRecheck: blockedClearSummary,
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
      expect(validateCapabilityMock.mock.calls).toEqual([
        ['agent-shared', 'inspect'],
        ['agent-shared', 'execute'],
        ['agent-shared', 'inspect'],
        ['agent-shared', 'execute'],
      ]);
      expect(blockPlanMock.mock.calls).toEqual([[plan.id], [plan.id]]);
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

  it('preserves the different HTTP and MCP capability-gate envelopes and stops before CLEAR persistence', async () => {
    const plan = buildPlan(null);
    getPlanMock.mockResolvedValue(plan);
    validateCapabilityMock.mockImplementation(
      async (_agentId: unknown, capability: unknown) => capability === 'inspect',
    );

    const httpResponse = await request(buildApp())
      .post(`/plans/${plan.id}/execute`)
      .send({});
    const mcpExecution = await executeThroughMcp(plan.id);

    expect(httpResponse.status).toBe(403);
    expect(httpResponse.body).toEqual({
      error: 'Agent agent-shared lacks capability: execute',
      actionId: 'action-a',
    });
    expect(mcpExecution.output).toEqual(expect.objectContaining({
      isError: true,
      structuredContent: {
        error: {
          code: 'ERR_GATED',
          message: 'Agent agent-shared lacks capability: execute',
          details: {
            planId: plan.id,
            agentId: 'agent-shared',
            capability: 'execute',
          },
          requestId: 'reusable-audit-mcp-request',
        },
      },
    }));
    expect(validateCapabilityMock.mock.calls).toEqual([
      ['agent-shared', 'inspect'],
      ['agent-shared', 'execute'],
      ['agent-shared', 'inspect'],
      ['agent-shared', 'execute'],
    ]);
    expect(buildClear2SummaryMock).not.toHaveBeenCalled();
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
  });

  it('preserves Phase 1 payload parity while persisting the authoritative current recheck decision', async () => {
    const plan = buildPlan(null);
    const allowSummary = {
      ...blockedClearSummary,
      overall: 1,
      decision: 'allow',
      notes: 'characterization allow execution',
    };
    const releaseMock = jest.fn(async () => undefined);

    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(allowSummary);
    acquireExecutionLockMock.mockResolvedValue({ release: releaseMock });
    createExecutionResultMock.mockImplementation(
      async (
        planId: unknown,
        actionId: unknown,
        agentId: unknown,
        status: unknown,
        clearDecision: unknown,
      ) => ({
        planId,
        actionId,
        agentId,
        status,
        clearDecision,
      }),
    );

    const httpResponse = await request(buildApp())
      .post(`/plans/${plan.id}/execute`)
      .send({});
    const mcpExecution = await executeThroughMcp(plan.id);

    const expectedResults = [
      {
        planId: plan.id,
        actionId: 'action-b',
        agentId: 'agent-shared',
        status: 'success',
        clearDecision: 'allow',
      },
      {
        planId: plan.id,
        actionId: 'action-a',
        agentId: 'agent-shared',
        status: 'success',
        clearDecision: 'allow',
      },
    ];

    expect(httpResponse.status).toBe(200);
    expect(httpResponse.body).toEqual({
      plan_id: plan.id,
      status: 'executed',
      results: expectedResults,
    });
    expect(mcpExecution.output).toEqual(expect.objectContaining({
      structuredContent: {
        plan_id: plan.id,
        status: 'executed',
        results: expectedResults,
      },
    }));
    expect(buildClear2SummaryMock.mock.calls[0]?.[0])
      .toEqual(buildClear2SummaryMock.mock.calls[1]?.[0]);
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock.mock.calls).toEqual([
      [plan.id, 'action-b', 'agent-shared', 'success', 'allow'],
      [plan.id, 'action-a', 'agent-shared', 'success', 'allow'],
      [plan.id, 'action-b', 'agent-shared', 'success', 'allow'],
      [plan.id, 'action-a', 'agent-shared', 'success', 'allow'],
    ]);
    expect(acquireExecutionLockMock.mock.calls).toEqual([
      [`policy-task:${plan.id}`],
      [`policy-task:${plan.id}`],
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(2);
    expect(emitSafetyAuditEventMock).not.toHaveBeenCalled();
  });

  it('preserves protocol envelopes while sanitizing block-persistence failures', async () => {
    const plan = buildPlan(null);
    const persistenceError = new Error('characterization persistence unavailable');

    getPlanMock.mockResolvedValue(plan);
    blockPlanMock.mockRejectedValue(persistenceError);

    const httpResponse = await request(buildApp())
      .post(`/plans/${plan.id}/execute`)
      .send({});
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
    expect(blockPlanMock.mock.calls).toEqual([[plan.id], [plan.id]]);
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
    expect(mcpExecution.context.logger.error).toHaveBeenCalledWith(
      'mcp.clear.error',
      expect.objectContaining({
        tool: 'plans.execute',
        errorCode: 'CLEAR_PERSISTENCE_FAILED',
        operation: 'plans.execute.persist_block',
        dependency: 'actionPlanStore',
        errorClass: 'Error',
        retryable: true,
      }),
    );
    expect(JSON.stringify({
      http: httpResponse.body,
      mcp: mcpExecution.output,
      httpLogs: apiLoggerErrorMock.mock.calls,
      mcpLogs: mcpExecution.context.logger.error.mock.calls,
    }).includes(persistenceError.message)).toBe(false);
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
  });
});
