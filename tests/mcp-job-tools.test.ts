import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

const mockGetJobById = jest.fn();
const mockRunThroughBrain = jest.fn();
const mockRunARCANOS = jest.fn();
const mockRunTrinity = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockRegisterDagMcpTools = jest.fn();
const mockRegisterResource = jest.fn();
const mockRegisterResourceTemplate = jest.fn();
const mockExecuteFastGptPrompt = jest.fn();
const mockClassifyGptFastPathRequest = jest.fn();

class FakeMcpServer {
  public readonly tools = new Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<unknown> }>();

  constructor(_info: { name: string; version: string }, _options: { capabilities?: Record<string, unknown> }) {}

  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: unknown) => Promise<unknown>
  ) {
    this.tools.set(name, { config, handler });
  }

  registerResource(...args: unknown[]) {
    mockRegisterResource(...args);
  }

  registerResourceTemplate(...args: unknown[]) {
    mockRegisterResourceTemplate(...args);
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

jest.unstable_mockModule('../src/core/lib/errors/index.js', () => ({
  resolveErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

jest.unstable_mockModule('../src/core/logic/trinity.js', () => ({
  runThroughBrain: mockRunThroughBrain,
}));

jest.unstable_mockModule('../src/core/logic/arcanos.js', () => ({
  runARCANOS: mockRunARCANOS,
}));

jest.unstable_mockModule('../src/trinity/trinity.js', () => ({
  runTrinity: mockRunTrinity,
}));

jest.unstable_mockModule('../src/config/openai.js', () => ({
  DEFAULT_FINE_TUNE: 'ft:test',
}));

jest.unstable_mockModule('../src/shared/types/actionPlan.js', () => ({
  actionPlanInputSchema: z.object({}).passthrough(),
}));

jest.unstable_mockModule('../src/services/clear2.js', () => ({
  buildClear2Summary: jest.fn(() => ({ decision: 'allow' })),
}));

jest.unstable_mockModule('../src/stores/actionPlanStore.js', () => ({
  createPlan: jest.fn(),
  getPlan: jest.fn(),
  listPlans: jest.fn(),
  approvePlan: jest.fn(),
  blockPlan: jest.fn(),
  expirePlan: jest.fn(),
  createExecutionResult: jest.fn(),
  getExecutionResults: jest.fn(),
}));

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  validateCapability: jest.fn(async () => true),
  listAgents: jest.fn(async () => []),
  getAgent: jest.fn(),
  registerAgent: jest.fn(),
  updateHeartbeat: jest.fn(),
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
  initializeDatabase: jest.fn(),
  getPool: jest.fn(),
  isDatabaseConnected: jest.fn(() => true),
  getStatus: jest.fn(async () => ({ connected: true })),
  close: jest.fn(),
  refreshDatabaseCollation: jest.fn(),
  initializeTables: jest.fn(),
  saveMemory: jest.fn(),
  loadMemory: jest.fn(),
  deleteMemory: jest.fn(),
  query: jest.fn(),
  transaction: jest.fn(),
  initializeDatabaseWithSchema: jest.fn(),
}));

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  getJobById: mockGetJobById,
  createJob: jest.fn(),
  updateJob: jest.fn(),
  findOrCreateGptJob: jest.fn(),
  requestJobCancellation: jest.fn(),
  claimNextPendingJob: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  recoverStaleJobs: jest.fn(async () => ({ recoveredJobIds: [], skippedJobIds: [] })),
  recoverStalledJobsForWorkers: jest.fn(async () => ({ recoveredJobIds: [], skippedJobIds: [] })),
  getLatestJob: jest.fn(),
  getJobQueueSummary: jest.fn(async () => null),
  getJobExecutionStatsSince: jest.fn(async () => null),
  cleanupExpiredGptJobs: jest.fn(async () => ({ deletedJobIds: [], deletedCount: 0 })),
  requeueFailedJob: jest.fn(),
  listFailedJobs: jest.fn(async () => []),
}));

jest.unstable_mockModule('../src/services/moduleLoader.js', () => ({
  loadModuleDefinitions: jest.fn(async () => []),
  clearModuleDefinitionCache: jest.fn(),
}));

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  dispatchModuleAction: mockDispatchModuleAction,
}));

jest.unstable_mockModule('../src/services/memoryListing.js', () => ({
  buildActiveMemorySelect: jest.fn(),
  normalizeMemoryEntries: jest.fn(),
}));

jest.unstable_mockModule('../src/platform/logging/diagnostics.js', () => ({
  runHealthCheck: jest.fn(),
}));

jest.unstable_mockModule('../src/mcp/server/dagTools.js', () => ({
  registerDagMcpTools: mockRegisterDagMcpTools,
}));

jest.unstable_mockModule('../src/services/gptFastPath.js', () => ({
  executeFastGptPrompt: mockExecuteFastGptPrompt,
}));

jest.unstable_mockModule('../src/shared/gpt/gptFastPath.js', () => ({
  classifyGptFastPathRequest: mockClassifyGptFastPathRequest,
}));

jest.unstable_mockModule('../src/mcp/modulesAllowlist.js', () => ({
  isModuleActionAllowed: jest.fn(() => true),
}));

const { createMcpServer } = await import('../src/mcp/server/index.js');

function buildContext() {
  return {
    requestId: 'mcp-req-1',
    sessionId: 'mcp-session-1',
    openai: {},
    runtimeBudget: {},
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

describe('createMcpServer job control tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyGptFastPathRequest.mockReturnValue({
      path: 'fast_path',
      eligible: true,
      reason: 'explicit_fast_mode',
      queueBypassed: true,
      promptLength: 35,
      messageCount: 0,
      maxWords: null,
      timeoutMs: 8_000,
      action: null,
      promptGenerationIntent: true,
      explicitMode: 'fast',
    });
    mockExecuteFastGptPrompt.mockResolvedValue({
      ok: true,
      result: {
        result: 'Write a fast prompt.',
        module: 'fast_path',
      },
      routeDecision: {
        path: 'fast_path',
        reason: 'explicit_fast_mode',
        queueBypassed: true,
        promptLength: 35,
        messageCount: 0,
        maxWords: null,
        timeoutMs: 8_000,
      },
      _route: {
        requestId: 'mcp-req-1',
        gptId: 'arcanos-core',
        module: 'GPT:FAST_PATH',
        action: 'query',
        route: 'fast_path',
        timestamp: '2026-04-21T12:00:00.000Z',
      },
    });
  });

  it('registers tools only and does not expose MCP resource templates', async () => {
    await createMcpServer(buildContext());

    expect(mockRegisterResource).not.toHaveBeenCalled();
    expect(mockRegisterResourceTemplate).not.toHaveBeenCalled();
  });

  it('registers explicit control-plane jobs.status and jobs.result tools with required jobId schemas', async () => {
    const server = await createMcpServer(buildContext()) as FakeMcpServer;

    const generateTool = server.tools.get('gpt.generate');
    const statusTool = server.tools.get('jobs.status');
    const resultTool = server.tools.get('jobs.result');

    expect(generateTool?.config).toMatchObject({
      title: 'GPT Generate',
      description: expect.stringContaining('fast path'),
    });
    expect(statusTool?.config).toMatchObject({
      title: 'Job Status',
      description: expect.stringContaining('Control plane'),
    });
    expect(resultTool?.config).toMatchObject({
      title: 'Job Result',
      description: expect.stringContaining('Control plane'),
    });

    const generateSchema = generateTool?.config.inputSchema as z.ZodTypeAny;
    const statusSchema = statusTool?.config.inputSchema as z.ZodTypeAny;
    const resultSchema = resultTool?.config.inputSchema as z.ZodTypeAny;

    expect(generateSchema.safeParse({
      gptId: 'arcanos-core',
      prompt: 'Generate a prompt for a launch email',
      mode: 'fast',
    }).success).toBe(true);
    expect(generateSchema.safeParse({ prompt: '   ' }).success).toBe(false);
    expect(statusSchema.safeParse({ jobId: 'job-123' }).success).toBe(true);
    expect(statusSchema.safeParse({ jobId: '   ' }).success).toBe(false);
    expect(resultSchema.safeParse({ jobId: 'job-123' }).success).toBe(true);
    expect(resultSchema.safeParse({}).success).toBe(false);
  });

  it('serves gpt.generate through the GPT fast path', async () => {
    const server = await createMcpServer(buildContext()) as FakeMcpServer;
    const output = await server.tools.get('gpt.generate')!.handler({
      gptId: 'arcanos-core',
      prompt: 'Generate a prompt for a launch email',
      mode: 'fast',
    });

    expect(mockClassifyGptFastPathRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        promptText: 'Generate a prompt for a launch email',
        explicitMode: 'fast',
      })
    );
    expect(mockExecuteFastGptPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'arcanos-core',
        prompt: 'Generate a prompt for a launch email',
        timeoutMs: 8_000,
        routeDecision: expect.objectContaining({
          path: 'fast_path',
          timeoutMs: 8_000,
        }),
      })
    );
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          result: {
            result: 'Write a fast prompt.',
            module: 'fast_path',
          },
          routeDecision: expect.objectContaining({
            path: 'fast_path',
            queueBypassed: true,
          }),
        }),
      })
    );
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
    expect(mockRunARCANOS).not.toHaveBeenCalled();
    expect(mockRunTrinity).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('serves jobs.status entirely through the control plane', async () => {
    mockGetJobById.mockResolvedValue({
      id: 'job-123',
      job_type: 'gpt',
      status: 'running',
      created_at: '2026-04-14T10:00:00.000Z',
      updated_at: '2026-04-14T10:00:02.000Z',
      completed_at: null,
      cancel_requested_at: null,
      cancel_reason: null,
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      output: null,
      error_message: null,
    });

    const server = await createMcpServer(buildContext()) as FakeMcpServer;
    const output = await server.tools.get('jobs.status')!.handler({ jobId: 'job-123' });

    expect(mockGetJobById).toHaveBeenCalledWith('job-123');
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          action: 'get_status',
          jobId: 'job-123',
          status: 'running',
          lifecycleStatus: 'running',
        }),
      })
    );
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
    expect(mockRunARCANOS).not.toHaveBeenCalled();
    expect(mockRunTrinity).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('serves jobs.result entirely through the control plane', async () => {
    mockGetJobById.mockResolvedValue({
      id: 'job-456',
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-14T10:00:00.000Z',
      updated_at: '2026-04-14T10:00:03.000Z',
      completed_at: '2026-04-14T10:00:03.000Z',
      retention_until: null,
      idempotency_until: null,
      expires_at: null,
      output: {
        text: 'final output',
      },
      error_message: null,
    });

    const server = await createMcpServer(buildContext()) as FakeMcpServer;
    const output = await server.tools.get('jobs.result')!.handler({ jobId: 'job-456' });

    expect(mockGetJobById).toHaveBeenCalledWith('job-456');
    expect(output).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          ok: true,
          action: 'get_result',
          jobId: 'job-456',
          status: 'completed',
          output: {
            text: 'final output',
          },
        }),
      })
    );
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
    expect(mockRunARCANOS).not.toHaveBeenCalled();
    expect(mockRunTrinity).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('returns an MCP not-found error for missing jobs.result lookups', async () => {
    mockGetJobById.mockResolvedValue(null);

    const server = await createMcpServer(buildContext()) as FakeMcpServer;
    const output = await server.tools.get('jobs.result')!.handler({ jobId: 'job-missing' });

    expect(mockGetJobById).toHaveBeenCalledWith('job-missing');
    expect(output).toEqual(
      expect.objectContaining({
        isError: true,
        structuredContent: {
          error: expect.objectContaining({
            code: 'ERR_NOT_FOUND',
            message: 'Async GPT job was not found.',
            details: {
              action: 'get_result',
              jobId: 'job-missing',
            },
          }),
        },
      })
    );
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
    expect(mockRunARCANOS).not.toHaveBeenCalled();
    expect(mockRunTrinity).not.toHaveBeenCalled();
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
