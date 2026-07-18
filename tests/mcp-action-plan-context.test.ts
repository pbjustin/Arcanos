import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: jest.fn(() => ({ client: {} })),
}));
jest.unstable_mockModule('../src/platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudget: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../src/lib/requestId.js', () => ({
  generateRequestId: jest.fn(() => 'generated-mcp-request'),
}));
jest.unstable_mockModule('../src/mcp/log.js', () => ({
  createMcpLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

const {
  buildMcpInternalContext,
  buildMcpRequestContext,
  buildMcpStdioContext,
  readMcpActionPlanRequesterPrincipalId,
} = await import('../src/mcp/context.js');

const originalPrincipal = process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID;
const originalMcpToken = process.env.MCP_BEARER_TOKEN;
const originalRequestToken = process.env.ACTION_PLAN_REQUEST_TOKEN;
const originalRequestPrincipal = process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID;

function request() {
  return {
    header: jest.fn(() => undefined),
    body: {},
    requestId: 'http-mcp-request',
    traceId: 'http-mcp-trace',
  } as any;
}

beforeEach(() => {
  delete process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID;
  process.env.MCP_BEARER_TOKEN = 'm'.repeat(32);
  delete process.env.ACTION_PLAN_REQUEST_TOKEN;
  delete process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID;
});

afterEach(() => {
  if (originalPrincipal === undefined) delete process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID;
  else process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID = originalPrincipal;
  if (originalMcpToken === undefined) delete process.env.MCP_BEARER_TOKEN;
  else process.env.MCP_BEARER_TOKEN = originalMcpToken;
  if (originalRequestToken === undefined) delete process.env.ACTION_PLAN_REQUEST_TOKEN;
  else process.env.ACTION_PLAN_REQUEST_TOKEN = originalRequestToken;
  if (originalRequestPrincipal === undefined) delete process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID;
  else process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = originalRequestPrincipal;
});

describe('MCP ActionPlan requester context', () => {
  it('binds a bounded configured principal only to HTTP MCP', () => {
    process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID = 'mcp-requester:preview';

    expect(readMcpActionPlanRequesterPrincipalId()).toBe('mcp-requester:preview');
    expect(buildMcpRequestContext(request())).toEqual(expect.objectContaining({
      transport: 'http',
      actionPlanPrincipal: {
        role: 'requester',
        principalId: 'mcp-requester:preview',
      },
    }));
    expect(buildMcpStdioContext()).not.toHaveProperty('actionPlanPrincipal');
    expect(buildMcpInternalContext()).not.toHaveProperty('actionPlanPrincipal');
  });

  it.each([
    '',
    ' leading',
    'trailing ',
    'contains whitespace',
    '*invalid*',
    'x'.repeat(129),
  ])('fails closed for malformed configured identity %j', value => {
    process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID = value;
    expect(readMcpActionPlanRequesterPrincipalId()).toBeNull();
    expect(buildMcpRequestContext(request())).not.toHaveProperty('actionPlanPrincipal');
  });

  it('rejects a principal or bearer reused by another ActionPlan role', () => {
    process.env.ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID = 'mcp-requester';
    process.env.ACTION_PLAN_REQUEST_TOKEN = 'r'.repeat(32);
    process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'mcp-requester';
    expect(readMcpActionPlanRequesterPrincipalId()).toBeNull();

    process.env.ACTION_PLAN_REQUEST_PRINCIPAL_ID = 'http-requester';
    process.env.ACTION_PLAN_REQUEST_TOKEN = process.env.MCP_BEARER_TOKEN;
    expect(readMcpActionPlanRequesterPrincipalId()).toBeNull();
  });
});
