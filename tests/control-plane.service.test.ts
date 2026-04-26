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

const {
  executeControlPlaneRequest,
  requiresControlPlaneApproval
} = await import('../src/services/controlPlane/service.js');

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

  it('treats null process exit codes as adapter failures', async () => {
    const run = jest.fn(async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'terminated by SIGTERM'
    }));

    const response = await executeControlPlaneRequest({
      requestId: 'control-exec-signal-1',
      phase: 'execute',
      adapter: 'railway-cli',
      operation: 'status'
    }, buildDeps({
      processRunner: { run }
    }) as never);

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'CONTROL_PLANE_ADAPTER_FAILED',
      details: {
        exitCode: null,
        signal: 'SIGTERM'
      }
    });
    expect(response.result?.exitCode).toBeNull();
    expect(response.result?.signal).toBe('SIGTERM');
  });

  it('treats signaled process results as failures even with a zero exit code', async () => {
    const run = jest.fn(async () => ({
      exitCode: 0,
      signal: 'SIGTERM',
      stdout: 'terminated',
      stderr: ''
    }));

    const response = await executeControlPlaneRequest({
      requestId: 'control-exec-signal-2',
      phase: 'execute',
      adapter: 'railway-cli',
      operation: 'status'
    }, buildDeps({
      processRunner: { run }
    }) as never);

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'CONTROL_PLANE_ADAPTER_FAILED',
      details: {
        exitCode: 0,
        signal: 'SIGTERM'
      }
    });
  });

  it('surfaces safe spawn diagnostics when the configured adapter binary is missing', async () => {
    const originalRailwayCliBin = process.env.RAILWAY_CLI_BIN;
    process.env.RAILWAY_CLI_BIN = path.join(repositoryRoot, 'missing-railway-cli-for-test');

    try {
      const response = await executeControlPlaneRequest({
        requestId: 'control-spawn-error-1',
        phase: 'execute',
        adapter: 'railway-cli',
        operation: 'status'
      }, buildDeps() as never);

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('CONTROL_PLANE_ADAPTER_FAILED');
      expect(response.result?.exitCode).toBe(1);
      expect(response.result?.stderr).toContain('ENOENT');
    } finally {
      if (originalRailwayCliBin === undefined) {
        delete process.env.RAILWAY_CLI_BIN;
      } else {
        process.env.RAILWAY_CLI_BIN = originalRailwayCliBin;
      }
    }
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

  it('resolves relative cwd values against the configured repository root', async () => {
    const nestedRepositoryRoot = path.join(repositoryRoot, 'packages');
    const run = jest.fn(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));

    const response = await executeControlPlaneRequest({
      requestId: 'control-cwd-2',
      phase: 'execute',
      adapter: 'arcanos-cli',
      operation: 'status',
      context: {
        cwd: 'cli'
      }
    }, buildDeps({
      repositoryRoot: nestedRepositoryRoot,
      processRunner: { run }
    }) as never);

    expect(response.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: path.join(nestedRepositoryRoot, 'cli')
      })
    );
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

  it('requires approval for mutating MCP tools even when requested in execute phase', () => {
    expect(requiresControlPlaneApproval({
      phase: 'execute',
      adapter: 'arcanos-mcp',
      operation: 'invokeTool',
      input: {
        toolName: 'memory.save',
        toolArguments: {
          key: 'test',
          value: 'value'
        }
      }
    })).toBe(true);

    expect(requiresControlPlaneApproval({
      phase: 'execute',
      adapter: 'railway-cli',
      operation: 'status'
    })).toBe(false);
  });

  it('filters MCP tool discovery to the control-plane allowlist', async () => {
    const mcpClient = {
      listTools: jest.fn(async () => ({
        tools: [
          { name: 'ops.health_report', description: 'allowed read-only tool' },
          { name: 'memory.save', description: 'allowed approval-gated tool' },
          { name: 'gpt.generate', description: 'not a control-plane tool' }
        ],
        nextCursor: 'cursor-1'
      })),
      invokeTool: jest.fn()
    };

    const response = await executeControlPlaneRequest({
      requestId: 'control-mcp-list-1',
      phase: 'execute',
      adapter: 'arcanos-mcp',
      operation: 'listTools'
    }, buildDeps({
      mcpClient
    }) as never);

    const data = response.result?.data as { tools: Array<{ name: string }> };
    expect(response.ok).toBe(true);
    expect(data.tools.map((tool) => tool.name)).toEqual([
      'ops.health_report',
      'memory.save'
    ]);
  });

  it('redacts secret-like process output and thrown error messages', async () => {
    const processRun = jest.fn(async () => ({
      exitCode: 0,
      stdout: 'Cookie: session=abcdef1234567890',
      stderr: ''
    }));

    const processResponse = await executeControlPlaneRequest({
      requestId: 'control-redact-1',
      phase: 'execute',
      adapter: 'railway-cli',
      operation: 'status'
    }, buildDeps({
      processRunner: { run: processRun }
    }) as never);

    expect(processResponse.result?.stdout).toBe('[REDACTED]');

    const mcpClient = {
      listTools: jest.fn(),
      invokeTool: jest.fn(async () => {
        throw new Error('downstream failed with Cookie: session=abcdef1234567890');
      })
    };

    const mcpResponse = await executeControlPlaneRequest({
      requestId: 'control-redact-2',
      phase: 'execute',
      adapter: 'arcanos-mcp',
      operation: 'invokeTool',
      input: {
        toolName: 'memory.load',
        toolArguments: {
          key: 'safe-key'
        }
      }
    }, buildDeps({
      mcpClient
    }) as never);

    expect(mcpResponse.ok).toBe(false);
    expect(mcpResponse.error?.message).toBe('[REDACTED]');
  });
});
