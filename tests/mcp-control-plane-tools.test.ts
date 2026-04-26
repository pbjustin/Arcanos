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

function buildContext() {
  return {
    requestId: 'mcp-control-plane-req-1',
    sessionId: 'mcp-control-plane-session-1',
    req: {},
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
});
