import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../src/mcp/server/helpers.js', () => ({
  wrapTool: (_toolName: string, _ctx: unknown, handler: (args: unknown) => Promise<unknown>) => handler,
}));

const { registerControlPlaneMcpTools } = await import('../src/mcp/server/controlPlaneTools.js');

type RegisteredTool = {
  config: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
};

function buildFakeServer() {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    server: {
      registerTool(name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) {
        tools.set(name, { config, handler });
      },
    },
  };
}

function buildContext(arcanosMcp?: {
  invokeTool: jest.Mock;
  listTools: jest.Mock;
}) {
  return {
    requestId: 'mcp-control-plane-req-1',
    sessionId: 'mcp-control-plane-session-1',
    req: arcanosMcp
      ? {
          app: {
            locals: {
              arcanosMcp,
            },
          },
        }
      : {},
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as any;
}

describe('registerControlPlaneMcpTools', () => {
  it('registers the control-plane invoke tool', () => {
    const { server, tools } = buildFakeServer();

    registerControlPlaneMcpTools(server as any, buildContext());

    expect(Array.from(tools.keys())).toEqual(['control_plane.invoke']);
    expect(tools.get('control_plane.invoke')?.config).toEqual(expect.objectContaining({
      title: 'Control Plane Invoke',
      annotations: { readOnlyHint: false },
    }));
  });

  it('preserves gptId through the shared schema for GPT-scoped route workflows', async () => {
    const { server, tools } = buildFakeServer();
    registerControlPlaneMcpTools(server as any, buildContext());

    const output = await tools.get('control_plane.invoke')!.handler({
      operation: 'control-plane.route.trinity.request',
      provider: 'backend-api',
      gptId: 'arcanos-core',
      target: { resource: 'trinity-route' },
      environment: 'local',
      scope: 'backend:read',
      params: {},
      dryRun: false,
      traceId: 'trace-mcp-control-plane-gpt',
      requestedBy: 'test-runner',
    }) as { structuredContent: Record<string, unknown> };

    expect(output.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        allowed: true,
        trinityRequested: true,
        trinityConfirmed: false,
      }),
    }));
  });

  it('denies GPT-scoped route workflows when gptId is omitted', async () => {
    const { server, tools } = buildFakeServer();
    registerControlPlaneMcpTools(server as any, buildContext());

    const output = await tools.get('control_plane.invoke')!.handler({
      operation: 'control-plane.route.trinity.request',
      provider: 'backend-api',
      target: { resource: 'trinity-route' },
      environment: 'local',
      scope: 'backend:read',
      params: {},
      dryRun: false,
      traceId: 'trace-mcp-control-plane-missing-gpt',
      requestedBy: 'test-runner',
    }) as { structuredContent: Record<string, unknown> };

    expect(output.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'ERR_CONTROL_PLANE_GPT_POLICY',
      }),
    }));
  });

  it('uses the request-scoped MCP port for executed MCP operations', async () => {
    const arcanosMcp = {
      invokeTool: jest.fn(),
      listTools: jest.fn(async () => ({
        tools: [{ name: 'modules.list' }],
      })),
    };
    const { server, tools } = buildFakeServer();
    registerControlPlaneMcpTools(server as any, buildContext(arcanosMcp));

    const output = await tools.get('control_plane.invoke')!.handler({
      operation: 'mcp.list-tools',
      provider: 'arcanos-mcp',
      target: { resource: 'tools' },
      environment: 'local',
      scope: 'mcp:read',
      params: {},
      dryRun: false,
      traceId: 'trace-mcp-control-plane-list',
      requestedBy: 'test-runner',
    }) as { structuredContent: Record<string, unknown> };

    expect(arcanosMcp.listTools).toHaveBeenCalledWith({
      request: undefined,
    });
    expect(output.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      result: {
        tools: [{ name: 'modules.list' }],
      },
    }));
  });

  it('fails closed with a stable error when an executed MCP operation has no port', async () => {
    const { server, tools } = buildFakeServer();
    registerControlPlaneMcpTools(server as any, buildContext());

    const output = await tools.get('control_plane.invoke')!.handler({
      operation: 'mcp.list-tools',
      provider: 'arcanos-mcp',
      target: { resource: 'tools' },
      environment: 'local',
      scope: 'mcp:read',
      params: {},
      dryRun: false,
      traceId: 'trace-mcp-control-plane-unavailable',
      requestedBy: 'test-runner',
    }) as { structuredContent: Record<string, unknown> };

    expect(output.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'ERR_CONTROL_PLANE_EXECUTION',
        message: 'ARCANOS MCP service is unavailable for this control-plane operation.',
      },
    }));
  });
});
