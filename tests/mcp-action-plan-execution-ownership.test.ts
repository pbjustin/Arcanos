import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createPlanMock = jest.fn();
const getAuthoritativePlanMock = jest.fn();
const listAuthoritativePlansMock = jest.fn();
const updateAuthoritativePlanStatusMock = jest.fn();
const buildClear2SummaryMock = jest.fn();
const requestExecutionMock = jest.fn();
const replayExecutionMock = jest.fn();
const readStatusMock = jest.fn();
const readResultMock = jest.fn();

jest.unstable_mockModule('../src/mcp/registry.js', () => ({
  MCP_FLAGS: {
    exposeDestructive: true,
    requireConfirmation: false,
    enableSessions: false,
  },
}));

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  createPlan: createPlanMock,
  getAuthoritativePlan: getAuthoritativePlanMock,
  listAuthoritativePlans: listAuthoritativePlansMock,
  updateAuthoritativePlanStatus: updateAuthoritativePlanStatusMock,
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
    readStatus: readStatusMock,
    readResult: readResultMock,
  })),
}));

const {
  createLegacyActionPlanMcpRegistrationBoundary,
  registerActionPlanMcpTools,
} = await import('../src/mcp/server/actionPlanTools.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

type RegisteredTool = {
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<any>;
};

class FakeMcpServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: unknown) => Promise<any>,
  ): void {
    this.tools.set(name, { config, handler });
  }
}

function context(transport: 'http' | 'stdio' | 'internal' = 'http', trusted = true) {
  return {
    requestId: 'mcp-phase2e-request',
    traceId: 'mcp-phase2e-trace',
    transport,
    ...(trusted ? {
      actionPlanPrincipal: { role: 'requester', principalId: 'mcp-requester' },
    } : {}),
    req: {},
    openai: {},
    runtimeBudget: {},
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

function plan() {
  const timestamp = new Date('2026-07-17T12:00:00.000Z');
  return {
    id: 'plan-1',
    createdBy: 'user',
    origin: 'mcp-phase2e-test',
    status: 'approved',
    confidence: 0.9,
    requiresConfirmation: false,
    idempotencyKey: 'plan-create-key',
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    executionRealm: 'local-test',
    ownerPrincipalId: 'mcp-requester',
    executionProtocolVersion: 2,
    executionGeneration: 1,
    clearScore: {
      id: 'clear-1',
      planId: 'plan-1',
      clarity: 0.9,
      leverage: 0.9,
      efficiency: 0.9,
      alignment: 0.9,
      resilience: 0.9,
      overall: 0.9,
      decision: 'allow',
      notes: null,
      createdAt: timestamp,
    },
    actions: [{
      id: 'action-1',
      planId: 'plan-1',
      agentId: 'python-agent',
      capability: 'local.noop',
      params: {},
      timeoutMs: 1_000,
      rollbackAction: null,
      sortOrder: 0,
    }],
    executionResults: [{
      id: 'legacy-result',
      planId: 'plan-1',
      actionId: 'action-1',
      agentId: 'python-agent',
      status: 'success',
      output: { secretSentinel: 'must-not-be-returned' },
      error: null,
      signature: null,
      clearDecision: 'allow',
      createdAt: timestamp,
    }],
  } as const;
}

beforeEach(() => {
  jest.clearAllMocks();
  getAuthoritativePlanMock.mockResolvedValue(plan());
  listAuthoritativePlansMock.mockResolvedValue([plan()]);
  createPlanMock.mockResolvedValue(plan());
  buildClear2SummaryMock.mockReturnValue({
    clarity: 0.9,
    leverage: 0.9,
    efficiency: 0.9,
    alignment: 0.9,
    resilience: 0.9,
    overall: 0.9,
    decision: 'allow',
  });
  requestExecutionMock.mockResolvedValue({
    ok: true,
    code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
    protocol_version: 'action-plan-execution-v1',
    command_id: 'command-1',
    plan_id: 'plan-1',
    disposition: 'COMMAND_CREATED',
    runs: [{ run_id: 'run-1', action_id: 'action-1', state: 'REQUESTED' }],
  });
  replayExecutionMock.mockResolvedValue(null);
});

describe('Phase 2E MCP ActionPlan registry', () => {
  it('omits every legacy plan and agent tool while preserving unrelated tools', () => {
    const raw = new FakeMcpServer();
    const boundary = createLegacyActionPlanMcpRegistrationBoundary(raw);
    const handler = jest.fn(async () => ({}));

    boundary.registerTool('plans.execute', {}, handler);
    boundary.registerTool('plans.results', {}, handler);
    boundary.registerTool('agents.register', {}, handler);
    boundary.registerTool('clear.evaluate', {}, handler);

    expect([...raw.tools.keys()]).toEqual(['clear.evaluate']);
  });

  it.each(['stdio', 'internal'] as const)(
    'does not advertise ActionPlan tools to an unauthenticated %s context',
    transport => {
      const server = new FakeMcpServer();
      registerActionPlanMcpTools(server, context(transport, false));
      expect(server.tools.size).toBe(0);
    },
  );

  it('advertises only requester-safe ActionPlan tools to authenticated HTTP MCP', () => {
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context());

    expect([...server.tools.keys()].sort()).toEqual([
      'plans.create',
      'plans.execute',
      'plans.get',
      'plans.get_execution',
      'plans.get_execution_result',
      'plans.list',
    ]);
    expect([...server.tools.keys()]).not.toEqual(expect.arrayContaining([
      'plans.approve',
      'plans.block',
      'plans.expire',
      'plans.results',
      'agents.register',
    ]));
  });

  it('registers the strict schemas with the real MCP SDK', () => {
    const server = new McpServer(
      { name: 'phase2e-test', version: '1.0.0' },
      { capabilities: {} },
    );
    expect(() => registerActionPlanMcpTools(server, context())).not.toThrow();
    expect(Object.keys((server as any)._registeredTools).sort()).toEqual([
      'plans.create',
      'plans.execute',
      'plans.get',
      'plans.get_execution',
      'plans.get_execution_result',
      'plans.list',
    ]);
  });

  it('creates durable plans with server-derived owner and realm provenance', async () => {
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context());

    const output = await server.tools.get('plans.create')!.handler({
      created_by: 'user',
      origin: 'mcp-test',
      idempotency_key: 'create-key',
      actions: [{ agent_id: 'python-agent', capability: 'local.noop', params: {} }],
    });

    expect(createPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'mcp-test' }),
      {
        executionRealm: 'local-test',
        ownerPrincipalId: 'mcp-requester',
        executionProtocolVersion: 2,
        executionGeneration: 1,
      },
    );
    expect(output.structuredContent).not.toHaveProperty('executionResults');
    expect(JSON.stringify(output)).not.toContain('must-not-be-returned');
  });

  it('rejects unknown or oversized plan creation fields before persistence', async () => {
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context());
    const create = server.tools.get('plans.create')!.handler;

    const unknown = await create({
      created_by: 'user',
      origin: 'mcp-test',
      idempotency_key: 'create-key',
      actions: [{ agent_id: 'python-agent', capability: 'local.noop', params: {} }],
      executorKind: 'caller-selected',
    });
    const oversized = await create({
      created_by: 'user',
      origin: 'x'.repeat(513),
      idempotency_key: 'create-key',
      actions: [{ agent_id: 'python-agent', capability: 'local.noop', params: {} }],
    });

    expect(unknown.structuredContent.error.code).toBe('ERR_BAD_REQUEST');
    expect(oversized.structuredContent.error.code).toBe('ERR_BAD_REQUEST');
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('uses owner-scoped durable reads and never cache-fallback store operations', async () => {
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context());

    const listed = await server.tools.get('plans.list')!.handler({ limit: 10 });
    const fetched = await server.tools.get('plans.get')!.handler({ planId: 'plan-1' });

    expect(listAuthoritativePlansMock).toHaveBeenCalledWith({
      executionRealm: 'local-test',
      ownerPrincipalId: 'mcp-requester',
      status: undefined,
      limit: 10,
    });
    expect(getAuthoritativePlanMock).toHaveBeenCalledWith('plan-1');
    expect(JSON.stringify(listed)).not.toContain('must-not-be-returned');
    expect(JSON.stringify(fetched)).not.toContain('must-not-be-returned');
  });

  it('requires explicit idempotency and creates runs without fabricating results', async () => {
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context());
    const execute = server.tools.get('plans.execute')!.handler;

    const rejected = await execute({ planId: 'plan-1' });
    expect(rejected.structuredContent.error.code).toBe('ERR_BAD_REQUEST');
    expect(requestExecutionMock).not.toHaveBeenCalled();

    const accepted = await execute({ planId: 'plan-1', idempotencyKey: 'mcp-command-key' });
    expect(accepted.structuredContent.code).toBe('ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED');
    expect(requestExecutionMock).toHaveBeenCalledWith({
      planId: 'plan-1',
      actor: { role: 'requester', principalId: 'mcp-requester' },
      idempotencyKey: 'mcp-command-key',
      policyExpectation: { decision: 'allow', overall: 0.9, planExecutionGeneration: 1 },
      context: {
        requestId: 'mcp-phase2e-request',
        traceId: 'mcp-phase2e-trace',
        sourceService: 'mcp',
      },
    });
    expect(updateAuthoritativePlanStatusMock).not.toHaveBeenCalled();
    expect(replayExecutionMock).toHaveBeenCalledTimes(1);
  });

  it.each(['in_progress', 'completed', 'failed'] as const)(
    'replays a committed %s command before lifecycle and confirmation gates',
    async status => {
      getAuthoritativePlanMock.mockResolvedValue({ ...plan(), status });
      replayExecutionMock.mockResolvedValue({
        ok: true,
        code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
        protocol_version: 'action-plan-execution-v1',
        command_id: 'command-original',
        plan_id: 'plan-1',
        disposition: 'COMMAND_REPLAY',
        runs: [{ run_id: 'run-original', action_id: 'action-1', state: 'SUCCEEDED' }],
      });
      const server = new FakeMcpServer();
      registerActionPlanMcpTools(server, context());

      const output = await server.tools.get('plans.execute')!.handler({
        planId: 'plan-1',
        idempotencyKey: 'mcp-command-key',
      });

      expect(output.structuredContent).toMatchObject({
        disposition: 'COMMAND_REPLAY', command_id: 'command-original',
      });
      expect(buildClear2SummaryMock).not.toHaveBeenCalled();
      expect(requestExecutionMock).not.toHaveBeenCalled();
    },
  );

  it('does not reveal a plan owned by another principal', async () => {
    getAuthoritativePlanMock.mockResolvedValue({ ...plan(), ownerPrincipalId: 'other-requester' });
    const server = new FakeMcpServer();
    registerActionPlanMcpTools(server, context());

    const output = await server.tools.get('plans.get')!.handler({ planId: 'plan-1' });
    expect(output.structuredContent.error).toEqual(expect.objectContaining({
      code: 'ERR_NOT_FOUND',
      message: 'ActionPlan was not found.',
    }));
  });
});
