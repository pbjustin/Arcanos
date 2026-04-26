import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  executeControlPlaneOperation,
  type ControlPlaneAuditEvent,
  type ControlPlaneCommandRunner,
} from '@services/controlPlane/index.js';
import type { ControlPlaneInvokeRequestPayload } from '@arcanos/protocol';

function buildRequest(overrides: Partial<ControlPlaneInvokeRequestPayload> = {}): ControlPlaneInvokeRequestPayload {
  return {
    operation: 'git.status',
    provider: 'codex-ide',
    target: { resource: 'repository' },
    environment: 'local',
    scope: 'repo:read',
    params: {},
    dryRun: true,
    traceId: 'trace-control-plane-1',
    requestedBy: 'test-runner',
    ...overrides,
  };
}

function buildAuditSink() {
  const events: ControlPlaneAuditEvent[] = [];
  return {
    events,
    auditEmitter: (event: ControlPlaneAuditEvent) => {
      events.push(event);
    },
  };
}

describe('executeControlPlaneOperation', () => {
  let runner: ControlPlaneCommandRunner & { run: jest.MockedFunction<ControlPlaneCommandRunner['run']> };

  beforeEach(() => {
    runner = {
      run: jest.fn(),
    };
  });

  it('defaults to dry-run planning and does not execute the command runner', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(
      buildRequest({ dryRun: undefined }),
      {
        commandRunner: runner,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
    expect(response.result).toEqual(expect.objectContaining({
      dryRun: true,
      allowed: true,
      operation: 'git.status',
      provider: 'codex-ide',
    }));
    expect(audit.events).toEqual([
      expect.objectContaining({
        status: 'accepted',
        approvalStatus: 'not_required',
        dryRun: true,
      }),
    ]);
  });

  it('denies unknown operations before execution', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(
      buildRequest({ operation: 'railway.up', provider: 'railway-cli', scope: 'railway:write', dryRun: false }),
      {
        commandRunner: runner,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_DENIED');
    expect(runner.run).not.toHaveBeenCalled();
    expect(audit.events[0]).toEqual(expect.objectContaining({
      status: 'denied',
      operation: 'railway.up',
    }));
  });

  it('denies requests missing required scopes', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(
      buildRequest({ scope: 'repo:verify', dryRun: false }),
      {
        commandRunner: runner,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_SCOPE');
    expect(response.error?.details).toEqual({ missingScopes: ['repo:read'] });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('requires an approval token for gated execution', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(
      buildRequest({
        operation: 'npm.run.build',
        provider: 'codex-ide',
        scope: 'repo:verify',
        dryRun: false,
      }),
      {
        commandRunner: runner,
        approvalTokenReader: () => undefined,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_APPROVAL');
    expect(runner.run).not.toHaveBeenCalled();
    expect(audit.events[0]).toEqual(expect.objectContaining({
      status: 'denied',
      approvalStatus: 'unconfigured',
    }));
  });

  it('requires approval for sensitive environment names with production prefixes or suffixes', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(
      buildRequest({
        operation: 'npm.test',
        provider: 'codex-ide',
        environment: 'prod-us-east',
        scope: 'repo:verify',
        dryRun: false,
      }),
      {
        commandRunner: runner,
        approvalTokenReader: () => undefined,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_APPROVAL');
    expect(runner.run).not.toHaveBeenCalled();
    expect(audit.events[0]).toEqual(expect.objectContaining({
      status: 'denied',
      approvalStatus: 'unconfigured',
      environment: 'prod-us-east',
    }));
  });

  it('redacts command stdout and stderr before returning output', async () => {
    const audit = buildAuditSink();
    const bearerFixture = `Bearer ${'a'.repeat(24)}`;
    const apiKeyFixture = ['api', '_key=', 'b'.repeat(24)].join('');
    runner.run.mockResolvedValue({
      exitCode: 0,
      stdout: bearerFixture,
      stderr: apiKeyFixture,
      signal: null,
      durationMs: 12,
    });

    const response = await executeControlPlaneOperation(
      buildRequest({ dryRun: false }),
      {
        commandRunner: runner,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(response.redactedOutput).toEqual(expect.objectContaining({
      stdout: '[REDACTED]',
      stderr: '[REDACTED]',
      exitCode: 0,
    }));
    expect(response.result).toEqual(response.redactedOutput);
  });

  it('reports command termination signals in failure responses', async () => {
    runner.run.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'terminated',
      signal: 'SIGTERM',
      durationMs: 25,
    });

    const response = await executeControlPlaneOperation(
      buildRequest({ dryRun: false }),
      {
        commandRunner: runner,
        auditEmitter: buildAuditSink().auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error).toEqual({
      code: 'ERR_CONTROL_PLANE_COMMAND_FAILED',
      message: 'Command failed with signal SIGTERM.',
      details: {
        exitCode: 1,
        signal: 'SIGTERM',
      },
    });
  });

  it('denies non-allowlisted MCP tool invocation before calling MCP', async () => {
    const audit = buildAuditSink();
    const mcpService = {
      invokeTool: jest.fn(),
      listTools: jest.fn(),
    };

    const response = await executeControlPlaneOperation(
      buildRequest({
        operation: 'mcp.invoke',
        provider: 'arcanos-mcp',
        target: { resource: 'memory.save' },
        scope: 'mcp:invoke',
        dryRun: false,
      }),
      {
        mcpService,
        auditEmitter: audit.auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_BAD_REQUEST');
    expect(mcpService.invokeTool).not.toHaveBeenCalled();
  });
});
