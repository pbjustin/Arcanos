import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ActionPlanRecord, ClearDecision } from '../src/shared/types/actionPlan.js';

const getPlanMock = jest.fn();
const blockPlanMock = jest.fn();
const createExecutionResultMock = jest.fn();
const validateCapabilityMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const acquireExecutionLockMock = jest.fn();
const emitSafetyAuditEventMock = jest.fn();
const apiLoggerErrorMock = jest.fn();

type RegisteredTool = {
  handler: (args: unknown) => Promise<any>;
};

class FakeMcpServer {
  public readonly tools = new Map<string, RegisteredTool>();

  constructor(_info: unknown, _options: unknown) {}

  registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<any>): void {
    this.tools.set(name, { handler });
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
  aiLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  dbLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  workerLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../src/core/logic/arcanos.js', () => ({ runARCANOS: jest.fn() }));
jest.unstable_mockModule('../src/core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: jest.fn() }));
jest.unstable_mockModule('../src/trinity/trinity.js', () => ({ runTrinity: jest.fn() }));
jest.unstable_mockModule('../src/config/openai.js', () => ({ DEFAULT_FINE_TUNE: 'ft:phase2b-test' }));
jest.unstable_mockModule('../src/services/webRag.js', () => ({
  ingestUrl: jest.fn(),
  ingestContent: jest.fn(),
  answerQuestion: jest.fn(),
}));
jest.unstable_mockModule('../src/services/researchHub.js', () => ({
  connectResearchBridge: jest.fn(() => ({ requestResearch: jest.fn() })),
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
jest.unstable_mockModule('../src/routes/modules.js', () => ({ dispatchModuleAction: jest.fn() }));
jest.unstable_mockModule('../src/services/memoryListing.js', () => ({
  buildActiveMemorySelect: jest.fn(),
  normalizeMemoryEntries: jest.fn(),
}));
jest.unstable_mockModule('../src/platform/logging/diagnostics.js', () => ({ runHealthCheck: jest.fn() }));
jest.unstable_mockModule('../src/services/gptFastPath.js', () => ({ executeFastGptPrompt: jest.fn() }));
jest.unstable_mockModule('../src/shared/gpt/gptFastPath.js', () => ({ classifyGptFastPathRequest: jest.fn() }));
jest.unstable_mockModule('../src/services/controlPlane/service.js', () => ({
  executeControlPlaneRequest: jest.fn(),
  getControlPlaneCapabilities: jest.fn(() => ({})),
  requiresControlPlaneApproval: jest.fn(() => false),
}));
jest.unstable_mockModule('../src/mcp/modulesAllowlist.js', () => ({ isModuleActionAllowed: jest.fn(() => false) }));
jest.unstable_mockModule('../src/mcp/server/dagTools.js', () => ({ registerDagMcpTools: jest.fn() }));
jest.unstable_mockModule('../src/mcp/server/jobTools.js', () => ({ registerJobMcpTools: jest.fn() }));
jest.unstable_mockModule('../src/mcp/server/controlPlaneTools.js', () => ({ registerControlPlaneMcpTools: jest.fn() }));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const plansRouter = (await import('../src/routes/plans.js')).default;
const { createMcpServer } = await import('../src/mcp/server/index.js');

const principleScores = {
  clarity: 0.8,
  leverage: 0.8,
  efficiency: 0.8,
  alignment: 0.8,
  resilience: 0.8,
};

const disclosureMarker = ['phase2b', 'http', 'opaque', 'marker'].join('-');

function circularThrownValue(): Record<string, unknown> {
  const value: Record<string, unknown> = { kind: 'circular' };
  value.self = value;
  return value;
}

function revokedProxyThrownValue(): object {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

const evaluatorFailureCases: Array<[string, () => unknown, string[]]> = [
  ['ordinary error', () => new Error('ordinary dependency detail'), ['ordinary dependency detail']],
  ['credential-like marker', () => new Error(disclosureMarker), [disclosureMarker]],
  ['authorization text', () => new Error(['Authorization', 'Bearer', disclosureMarker].join(' ')), [disclosureMarker]],
  ['filesystem path', () => new Error(['C:', 'private', 'clear', 'dependency.log'].join('\\')), ['private\\clear']],
  ['SQL text', () => new Error(['SELECT', '*', 'FROM', 'private_clear_table'].join(' ')), ['private_clear_table']],
  ['provider JSON', () => new Error(JSON.stringify({ provider: 'synthetic', payload: disclosureMarker })), [disclosureMarker]],
  ['nested cause', () => new Error('outer detail', { cause: new Error(disclosureMarker) }), ['outer detail', disclosureMarker]],
  ['non-Error string', () => disclosureMarker, [disclosureMarker]],
  ['circular object', circularThrownValue, ['circular']],
  ['very long message', () => new Error('x'.repeat(20_000)), ['x'.repeat(128)]],
  ['Unicode and control characters', () => new Error(`internal-雪\r\n${disclosureMarker}`), ['internal-雪', disclosureMarker]],
  ['timeout', () => Object.assign(new Error(disclosureMarker), { name: 'TimeoutError' }), [disclosureMarker]],
  ['abort', () => Object.assign(new Error(disclosureMarker), { name: 'AbortError' }), [disclosureMarker]],
  ['revoked Proxy', revokedProxyThrownValue, []],
  ['undefined thrown value', () => undefined, []],
];

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
    requiresConfirmation: true,
    idempotencyKey: 'phase2b-clear-plan-key',
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    clearScore: previousDecision ? storedScore(planId, previousDecision) : null,
    actions: [
      {
        id: 'action-one',
        planId,
        agentId: 'agent-one',
        capability: 'inspect',
        params: { order: 1 },
        timeoutMs: 1_000,
        rollbackAction: null,
        sortOrder: 0,
      },
      {
        id: 'action-two',
        planId,
        agentId: 'agent-two',
        capability: 'execute',
        params: { order: 2 },
        timeoutMs: 1_000,
        rollbackAction: false,
        sortOrder: 1,
      },
    ],
  };
}

function buildHttpApp() {
  const app = express();
  app.use(express.json());
  app.use('/', plansRouter);
  app.use((_error: unknown, _req: unknown, res: any, _next: unknown) => {
    res.status(599).json({ error: 'unhandled-test-error' });
  });
  return app;
}

function buildMcpContext() {
  return {
    requestId: 'phase2b-mcp-request',
    traceId: 'phase2b-mcp-trace',
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

async function executeMcp(planId: string) {
  const context = buildMcpContext();
  const server = await createMcpServer(context) as FakeMcpServer;
  const tool = server.tools.get('plans.execute');
  expect(tool).toBeDefined();
  return { context, output: await tool!.handler({ planId }) };
}

async function executeMcpTool(toolName: string, args: unknown) {
  const context = buildMcpContext();
  const server = await createMcpServer(context) as FakeMcpServer;
  const tool = server.tools.get(toolName);
  expect(tool).toBeDefined();
  return { context, output: await tool!.handler(args) };
}

function mockExecutionResultPersistence(): void {
  createExecutionResultMock.mockImplementation(async (
    planId: unknown,
    actionId: unknown,
    agentId: unknown,
    status: unknown,
    clearDecision: unknown,
  ) => ({ planId, actionId, agentId, status, clearDecision }));
}

describe('CLEAR execution decision persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateCapabilityMock.mockResolvedValue(true);
    acquireExecutionLockMock.mockImplementation(async () => ({ release: jest.fn(async () => undefined) }));
    blockPlanMock.mockImplementation(async (planId: string) => ({ ...buildPlan(), id: planId, status: 'blocked' }));
    mockExecutionResultPersistence();
  });

  it.each([
    ['allow with no stored score', null, clearResult(0.8, 'allow'), 'allow'],
    ['allow with an explicit decision and null current score', null, { ...principleScores, overall: null, decision: 'allow' }, 'allow'],
    ['allow over a stored confirm', 'confirm', clearResult(0.8, 'allow'), 'allow'],
    ['confirm over a stored allow', 'allow', clearResult(0.5, 'confirm'), 'confirm'],
  ] as const)('persists the current %s outcome across HTTP and MCP', async (_label, prior, current, expected) => {
    const plan = buildPlan(prior);
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(current);

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);

    expect(httpResponse.status).toBe(200);
    expect(mcpResponse.output).not.toHaveProperty('isError');
    expect(createExecutionResultMock).toHaveBeenCalledTimes(4);
    expect(createExecutionResultMock.mock.calls.map(call => call[4])).toEqual([
      expected,
      expected,
      expected,
      expected,
    ]);
    expect(blockPlanMock).not.toHaveBeenCalled();
  });

  it.each([
    ['finite score over stored allow', 'allow', clearResult(0.2, 'block')],
    ['null score with no stored decision', null, { ...principleScores, overall: null, decision: 'block' }],
  ] as const)('preserves an explicit current block with %s and creates no execution results', async (_label, prior, current) => {
    const plan = buildPlan(prior);
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(current);

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);

    expect(httpResponse.status).toBe(403);
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_GATED',
      message: 'CLEAR re-evaluation blocked this plan',
    }));
    expect(blockPlanMock.mock.calls).toEqual([[plan.id], [plan.id]]);
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null result', null, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.', 503],
    ['missing decision', { ...principleScores, overall: 0.8 }, 'CLEAR_EVALUATION_UNAVAILABLE', 'CLEAR evaluation is unavailable.', 503],
    ['non-finite score', { ...principleScores, overall: Number.NaN, decision: 'block' }, 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.', 500],
    ['contradictory result', clearResult(0.2, 'allow'), 'CLEAR_RESULT_INVALID', 'CLEAR evaluation returned an invalid result.', 500],
  ] as const)('suppresses all writes for %s', async (_label, result, category, message, httpStatus) => {
    const plan = buildPlan('allow');
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(result);

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);

    expect(httpResponse.status).toBe(httpStatus);
    expect(httpResponse.body).toEqual({ error: category, message });
    expect(mcpResponse.output.structuredContent.error).toEqual({
      code: 'ERR_INTERNAL',
      message,
      details: { tool: 'plans.execute', category },
      requestId: 'phase2b-mcp-request',
    });
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
    expect(acquireExecutionLockMock).not.toHaveBeenCalled();
  });

  it('returns evaluation-unavailable without leaking an evaluator exception', async () => {
    const plan = buildPlan('allow');
    const internalDetail = ['phase2b', 'evaluator', 'internal'].join('-');
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockImplementation(() => {
      throw new Error(internalDetail);
    });

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);
    const observable = JSON.stringify({
      http: httpResponse.body,
      mcp: mcpResponse.output,
      httpLogs: apiLoggerErrorMock.mock.calls,
      mcpLogs: mcpResponse.context.logger.error.mock.calls,
    });

    expect(httpResponse.status).toBe(503);
    expect(httpResponse.body).toEqual({
      error: 'CLEAR_EVALUATION_UNAVAILABLE',
      message: 'CLEAR evaluation is unavailable.',
    });
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_INTERNAL',
      message: 'CLEAR evaluation is unavailable.',
      details: { tool: 'plans.execute', category: 'CLEAR_EVALUATION_UNAVAILABLE' },
    }));
    expect(observable.includes(internalDetail)).toBe(false);
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
  });

  it.each(evaluatorFailureCases)('sanitizes HTTP and MCP evaluator failure: %s', async (_label, buildThrown, forbiddenValues) => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockImplementation(() => {
      throw buildThrown();
    });

    const response = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);
    const observable = JSON.stringify({
      body: response.body,
      text: response.text,
      logs: apiLoggerErrorMock.mock.calls,
      mcp: mcpResponse.output,
      mcpLogs: mcpResponse.context.logger.error.mock.calls,
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'CLEAR_EVALUATION_UNAVAILABLE',
      message: 'CLEAR evaluation is unavailable.',
    });
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_INTERNAL',
      message: 'CLEAR evaluation is unavailable.',
      details: { tool: 'plans.execute', category: 'CLEAR_EVALUATION_UNAVAILABLE' },
    }));
    expect(forbiddenValues.some(value => observable.includes(value))).toBe(false);
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
  });

  it('applies the same sanitized outcome contract to the direct MCP CLEAR tool', async () => {
    const internalDetail = ['phase2b', 'direct-clear', 'internal'].join('-');
    buildClear2SummaryMock.mockImplementation(() => {
      throw new Error(internalDetail);
    });

    const response = await executeMcpTool('clear.evaluate', { objective: 'synthetic' });
    const observable = JSON.stringify({
      output: response.output,
      logs: response.context.logger.error.mock.calls,
    });

    expect(response.output.structuredContent.error).toEqual({
      code: 'ERR_INTERNAL',
      message: 'CLEAR evaluation is unavailable.',
      details: { tool: 'clear.evaluate', category: 'CLEAR_EVALUATION_UNAVAILABLE' },
      requestId: 'phase2b-mcp-request',
    });
    expect(observable.includes(internalDetail)).toBe(false);
  });

  it.each(['rejects', 'returns-null', 'returns-undefined'] as const)('fails safely when block persistence %s', async mode => {
    const plan = buildPlan('allow');
    const internalDetail = ['phase2b', 'persistence', 'internal'].join('-');
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.2, 'block'));
    if (mode === 'rejects') {
      blockPlanMock.mockRejectedValue(new Error(internalDetail));
    } else if (mode === 'returns-null') {
      blockPlanMock.mockResolvedValue(null);
    } else {
      blockPlanMock.mockResolvedValue(undefined);
    }

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);
    const observable = JSON.stringify({
      http: httpResponse.body,
      mcp: mcpResponse.output,
      httpLogs: apiLoggerErrorMock.mock.calls,
      mcpLogs: mcpResponse.context.logger.error.mock.calls,
    });

    expect(httpResponse.status).toBe(500);
    expect(httpResponse.body).toEqual({
      error: 'CLEAR_PERSISTENCE_FAILED',
      message: 'CLEAR decision persistence failed.',
    });
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_INTERNAL',
      message: 'CLEAR decision persistence failed.',
      details: { tool: 'plans.execute', category: 'CLEAR_PERSISTENCE_FAILED' },
    }));
    expect(observable.includes(internalDetail)).toBe(false);
    expect(createExecutionResultMock).not.toHaveBeenCalled();
  });

  it('documents partial per-action writes while returning a sanitized persistence failure', async () => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    createExecutionResultMock
      .mockResolvedValueOnce({ actionId: 'action-one', clearDecision: 'allow' })
      .mockRejectedValueOnce(new Error('partial write internal detail'))
      .mockResolvedValueOnce({ actionId: 'action-one', clearDecision: 'allow' })
      .mockRejectedValueOnce(new Error('partial write internal detail'));

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);

    expect(httpResponse.status).toBe(500);
    expect(httpResponse.body.error).toBe('CLEAR_PERSISTENCE_FAILED');
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      message: 'CLEAR decision persistence failed.',
    }));
    expect(createExecutionResultMock).toHaveBeenCalledTimes(4);
    expect(acquireExecutionLockMock).toHaveBeenCalledTimes(2);
  });

  it('releases the lock before a delayed sibling write settles after Promise.all rejection', async () => {
    const plan = buildPlan();
    const releaseMock = jest.fn(async () => undefined);
    let delayedSettled = false;
    let resolveDelayed!: () => void;
    const delayedWrite = new Promise(resolve => {
      resolveDelayed = () => {
        delayedSettled = true;
        resolve({ actionId: 'action-two', clearDecision: 'allow' });
      };
    });
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    acquireExecutionLockMock.mockResolvedValue({ release: releaseMock });
    createExecutionResultMock.mockImplementation(async (_planId: string, actionId: string) => {
      if (actionId === 'action-one') throw new Error('first action rejected');
      return delayedWrite;
    });

    const response = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('CLEAR_PERSISTENCE_FAILED');
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(delayedSettled).toBe(false);

    resolveDelayed();
    await delayedWrite;
    expect(delayedSettled).toBe(true);
  });

  it('retains cleanup diagnostics when persistence and lock release both fail', async () => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    createExecutionResultMock.mockRejectedValue(new Error('unobservable persistence detail'));
    acquireExecutionLockMock.mockResolvedValue({
      release: jest.fn(async () => {
        throw new Error('unobservable release detail');
      }),
    });

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);

    expect(httpResponse.status).toBe(500);
    expect(httpResponse.body.error).toBe('CLEAR_PERSISTENCE_FAILED');
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      message: 'CLEAR decision persistence failed.',
    }));
    expect(apiLoggerErrorMock.mock.calls.map(call => call[1]?.operation)).toEqual(expect.arrayContaining([
      'plans.execute.persist_results',
      'plans.execute.release_lock',
    ]));
    expect(mcpResponse.context.logger.error.mock.calls.map(call => call[1]?.operation)).toEqual(expect.arrayContaining([
      'plans.execute.persist_results',
      'plans.execute.release_lock',
    ]));
  });

  it.each([
    ['missing release', {}],
    ['non-callable release', { release: 'not-a-function' }],
  ])('fails MCP execution when the acquired lock has %s', async (_label, malformedLock) => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    acquireExecutionLockMock.mockResolvedValue(malformedLock);

    const response = await executeMcp(plan.id);

    expect(response.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_INTERNAL',
      message: 'CLEAR operation failed.',
      details: { tool: 'plans.execute', category: 'CLEAR_OPERATION_FAILED' },
    }));
    expect(createExecutionResultMock).toHaveBeenCalledTimes(2);
  });

  it('keeps HTTP persistence error handling stable for a hostile message getter', async () => {
    const plan = buildPlan();
    const hostileError = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('unobservable getter detail');
      },
    });
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    createExecutionResultMock.mockRejectedValue(hostileError);

    const response = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'CLEAR_PERSISTENCE_FAILED',
      message: 'CLEAR decision persistence failed.',
    });
  });

  it.each(['persistence', 'release'] as const)('does not treat an undefined %s rejection as success', async stage => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    if (stage === 'persistence') {
      createExecutionResultMock.mockRejectedValue(undefined);
    } else {
      acquireExecutionLockMock.mockImplementation(async () => ({
        release: jest.fn(() => Promise.reject(undefined)),
      }));
    }

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);
    const expectedCategory = stage === 'persistence' ? 'CLEAR_PERSISTENCE_FAILED' : 'CLEAR_OPERATION_FAILED';
    const expectedMessage = stage === 'persistence'
      ? 'CLEAR decision persistence failed.'
      : 'CLEAR operation failed.';

    expect(httpResponse.status).toBe(500);
    expect(httpResponse.body).toEqual({ error: expectedCategory, message: expectedMessage });
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_INTERNAL',
      message: expectedMessage,
      details: { tool: 'plans.execute', category: expectedCategory },
    }));
    expect(apiLoggerErrorMock.mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'CLEAR execution failed',
        expect.objectContaining({ errorCode: expectedCategory, errorClass: 'ThrownUndefined' }),
      ]),
    ]));
    expect(mcpResponse.context.logger.error.mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining([
        'mcp.clear.error',
        expect.objectContaining({ errorCode: expectedCategory, errorClass: 'ThrownUndefined' }),
      ]),
    ]));
  });

  it('re-evaluates and persists the explicit decision on retry after a rejected write', async () => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    createExecutionResultMock
      .mockRejectedValueOnce(new Error('first attempt rejected'))
      .mockResolvedValueOnce({ actionId: 'action-two', clearDecision: 'allow' })
      .mockResolvedValueOnce({ actionId: 'action-one', clearDecision: 'allow' })
      .mockResolvedValueOnce({ actionId: 'action-two', clearDecision: 'allow' });

    const first = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const retry = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});

    expect(first.status).toBe(500);
    expect(first.body.error).toBe('CLEAR_PERSISTENCE_FAILED');
    expect(retry.status).toBe(200);
    expect(createExecutionResultMock.mock.calls.map(call => call[4])).toEqual([
      'allow',
      'allow',
      'allow',
      'allow',
    ]);
    expect(buildClear2SummaryMock).toHaveBeenCalledTimes(2);
  });

  it('suppresses a concurrent duplicate request after the execution lock', async () => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    acquireExecutionLockMock
      .mockResolvedValueOnce({ release: jest.fn(async () => undefined) })
      .mockResolvedValueOnce(null);

    const [first, duplicate] = await Promise.all([
      request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({}),
      request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({}),
    ]);

    expect([first.status, duplicate.status].sort()).toEqual([200, 409]);
    expect(createExecutionResultMock).toHaveBeenCalledTimes(2);
    expect(emitSafetyAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event: 'policy_task_duplicate_suppressed',
    }));
  });

  it('documents the existing race boundary for concurrent conflicting rechecks', async () => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock
      .mockReturnValueOnce(clearResult(0.8, 'allow'))
      .mockReturnValueOnce(clearResult(0.2, 'block'));

    const [allowResponse, blockResponse] = await Promise.all([
      request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({ request: 'allow' }),
      request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({ request: 'block' }),
    ]);

    expect([allowResponse.status, blockResponse.status].sort()).toEqual([200, 403]);
    expect(createExecutionResultMock).toHaveBeenCalledTimes(2);
    expect(createExecutionResultMock.mock.calls.every(call => call[4] === 'allow')).toBe(true);
    expect(blockPlanMock).toHaveBeenCalledWith(plan.id);
    expect(acquireExecutionLockMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing stored block as an early policy gate', async () => {
    const plan = buildPlan('block');
    getPlanMock.mockResolvedValue(plan);

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);

    expect(httpResponse.status).toBe(403);
    expect(mcpResponse.output.structuredContent.error.code).toBe('ERR_GATED');
    expect(buildClear2SummaryMock).not.toHaveBeenCalled();
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
  });

  it('ignores a partial result attached to an evaluator failure', async () => {
    const plan = buildPlan();
    const failure = Object.assign(new Error('evaluator failed'), {
      partialResult: clearResult(0.2, 'block'),
    });
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockImplementation(() => {
      throw failure;
    });

    const response = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('CLEAR_EVALUATION_UNAVAILABLE');
    expect(blockPlanMock).not.toHaveBeenCalled();
    expect(createExecutionResultMock).not.toHaveBeenCalled();
  });

  it('does not let a failing HTTP logger mask the sanitized response', async () => {
    const plan = buildPlan();
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockImplementation(() => {
      throw new Error('unobservable evaluator detail');
    });
    apiLoggerErrorMock.mockImplementation(() => {
      throw new Error('unobservable logger detail');
    });

    const response = await request(buildHttpApp())
      .post(`/plans/${plan.id}/execute`)
      .send({})
      .timeout({ deadline: 1_000 });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'CLEAR_EVALUATION_UNAVAILABLE',
      message: 'CLEAR evaluation is unavailable.',
    });
  });

  it('reports lock-release failure after persisting results without exposing the exception', async () => {
    const plan = buildPlan();
    const internalDetail = ['phase2b', 'lock-release', 'internal'].join('-');
    getPlanMock.mockResolvedValue(plan);
    buildClear2SummaryMock.mockReturnValue(clearResult(0.8, 'allow'));
    acquireExecutionLockMock.mockImplementation(async () => ({
      release: jest.fn(async () => {
        throw new Error(internalDetail);
      }),
    }));

    const httpResponse = await request(buildHttpApp()).post(`/plans/${plan.id}/execute`).send({});
    const mcpResponse = await executeMcp(plan.id);
    const observable = JSON.stringify({
      http: httpResponse.body,
      mcp: mcpResponse.output,
      httpLogs: apiLoggerErrorMock.mock.calls,
      mcpLogs: mcpResponse.context.logger.error.mock.calls,
    });

    expect(httpResponse.status).toBe(500);
    expect(httpResponse.body).toEqual({
      error: 'CLEAR_OPERATION_FAILED',
      message: 'CLEAR operation failed.',
    });
    expect(mcpResponse.output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_INTERNAL',
      message: 'CLEAR operation failed.',
      details: { tool: 'plans.execute', category: 'CLEAR_OPERATION_FAILED' },
    }));
    expect(createExecutionResultMock).toHaveBeenCalledTimes(4);
    expect(createExecutionResultMock.mock.calls.every(call => call[4] === 'allow')).toBe(true);
    expect(observable.includes(internalDetail)).toBe(false);
  });
});
