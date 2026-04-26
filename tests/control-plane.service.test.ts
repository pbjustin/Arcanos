import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({ client: null }))
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: jest.fn()
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: jest.fn(() => ({ budgetId: 'test-budget' }))
}));

jest.unstable_mockModule('@core/db/repositories/executionLogRepository.js', () => ({
  logExecution: jest.fn(async () => undefined)
}));

jest.unstable_mockModule('@services/arcanosMcp.js', () => ({
  arcanosMcpService: {
    listTools: jest.fn(),
    invokeTool: jest.fn()
  }
}));

const { executeControlPlaneRequest } = await import('../src/services/controlPlane/service.js');

const repositoryRoot = process.cwd();
const fixedNow = () => new Date('2026-04-26T00:00:00.000Z');

function buildDeps(overrides: Record<string, unknown> = {}) {
  return {
    repositoryRoot,
    now: fixedNow,
    auditLogger: jest.fn(async () => undefined),
    ...overrides
  };
}

describe('executeControlPlaneRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('plans Railway deploy through confirmed Trinity without executing a command', async () => {
    const run = jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const trinityPlanner = {
      plan: jest.fn(async () => ({
        routingStages: [
          'ARCANOS-INTAKE:start',
          'GPT5-REASONING:complete',
          'ARCANOS-FINAL:complete'
        ]
      }))
    };

    const response = await executeControlPlaneRequest({
      requestId: 'control-plan-1',
      phase: 'plan',
      adapter: 'railway-cli',
      operation: 'deploy'
    }, buildDeps({
      processRunner: { run },
      trinityPlanner
    }) as never);

    expect(response.ok).toBe(true);
    expect(response.result?.status).toBe('planned');
    expect(response.result?.command).toMatchObject({
      executable: 'railway',
      args: ['up', '--detach'],
      cwd: repositoryRoot
    });
    expect(response.approval.required).toBe(false);
    expect(response.route.status).toBe('TRINITY_CONFIRMED');
    expect(trinityPlanner.plan).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('executes read-only Railway status directly and redacts sensitive output', async () => {
    const run = jest.fn(async () => ({
      exitCode: 0,
      stdout: 'Bearer abcdefghijklmnop',
      stderr: ''
    }));
    const trinityPlanner = {
      plan: jest.fn()
    };

    const response = await executeControlPlaneRequest({
      requestId: 'control-exec-1',
      phase: 'execute',
      adapter: 'railway-cli',
      operation: 'status'
    }, buildDeps({
      processRunner: { run },
      trinityPlanner
    }) as never);

    expect(response.ok).toBe(true);
    expect(response.route.status).toBe('DIRECT_FAST_PATH');
    expect(response.result?.stdout).toBe('[REDACTED]');
    expect(trinityPlanner.plan).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      'railway',
      ['status'],
      expect.objectContaining({
        cwd: repositoryRoot,
        timeoutMs: 30000
      })
    );
  });

  it('blocks Railway mutation without control-plane approval', async () => {
    const run = jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const response = await executeControlPlaneRequest({
      requestId: 'control-mut-1',
      phase: 'mutate',
      adapter: 'railway-cli',
      operation: 'deploy'
    }, buildDeps({
      processRunner: { run }
    }) as never);

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('CONTROL_PLANE_APPROVAL_REQUIRED');
    expect(response.approval).toMatchObject({
      required: true,
      satisfied: false,
      gate: 'control-plane-approval'
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs approved Railway mutation with least-privilege environment variables', async () => {
    const originalRailwayToken = process.env.RAILWAY_TOKEN;
    const originalUnrelatedEnv = process.env.CONTROL_PLANE_TEST_UNRELATED;
    process.env.RAILWAY_TOKEN = 'railway-token-value';
    process.env.CONTROL_PLANE_TEST_UNRELATED = 'not-forwarded-to-adapter-process';

    try {
      const run = jest.fn(async () => ({ exitCode: 0, stdout: 'deployed', stderr: '' }));

      const response = await executeControlPlaneRequest({
        requestId: 'control-mut-2',
        phase: 'mutate',
        adapter: 'railway-cli',
        operation: 'deploy',
        approval: {
          approved: true,
          approvedBy: 'operator:test',
          reason: 'deploy approved for test'
        }
      }, buildDeps({
        processRunner: { run }
      }) as never);

      expect(response.ok).toBe(true);
      expect(response.route.status).toBe('DIRECT_FAST_PATH');
      expect(run).toHaveBeenCalledWith(
        'railway',
        ['up', '--detach'],
        expect.objectContaining({
          env: expect.objectContaining({
            RAILWAY_TOKEN: 'railway-token-value'
          })
        })
      );
      const runOptions = run.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
      expect(runOptions.env.CONTROL_PLANE_TEST_UNRELATED).toBeUndefined();
    } finally {
      process.env.RAILWAY_TOKEN = originalRailwayToken;
      process.env.CONTROL_PLANE_TEST_UNRELATED = originalUnrelatedEnv;
    }
  });

  it('rejects cwd values outside the workspace before adapter execution', async () => {
    const run = jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const response = await executeControlPlaneRequest({
      requestId: 'control-cwd-1',
      phase: 'execute',
      adapter: 'arcanos-cli',
      operation: 'status',
      context: {
        cwd: path.dirname(repositoryRoot)
      }
    }, buildDeps({
      processRunner: { run }
    }) as never);

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('CWD_OUTSIDE_WORKSPACE');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects MCP tool invocation outside the control-plane allowlist', async () => {
    const mcpClient = {
      listTools: jest.fn(),
      invokeTool: jest.fn()
    };

    const response = await executeControlPlaneRequest({
      requestId: 'control-mcp-1',
      phase: 'execute',
      adapter: 'arcanos-mcp',
      operation: 'invokeTool',
      input: {
        toolName: 'ops.control_plane'
      }
    }, buildDeps({
      mcpClient
    }) as never);

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('MCP_TOOL_NOT_ALLOWLISTED');
    expect(mcpClient.invokeTool).not.toHaveBeenCalled();
  });
});
