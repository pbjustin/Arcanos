import { afterEach, describe, expect, it, jest } from '@jest/globals';

const verifyAndConsumeNonceMock = jest.fn();
const issueConfirmationNonceMock = jest.fn();

jest.unstable_mockModule('../src/mcp/registry.js', () => ({
  MCP_FLAGS: {
    exposeDestructive: true,
    requireConfirmation: false,
    enableSessions: false,
  },
}));

jest.unstable_mockModule('../src/mcp/confirm.js', () => ({
  verifyAndConsumeNonce: verifyAndConsumeNonceMock,
  issueConfirmationNonce: issueConfirmationNonceMock,
}));

jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  validateCapability: jest.fn(),
}));

const { wrapTool } = await import('../src/mcp/server/helpers.js');

function buildContext(loggerOverrides: Partial<Record<'debug' | 'info' | 'warn' | 'error', jest.Mock>> = {}) {
  return {
    requestId: 'phase2b-request',
    traceId: 'phase2b-trace',
    openai: {},
    runtimeBudget: {},
    req: {},
    logger: {
      debug: loggerOverrides.debug ?? jest.fn(),
      info: loggerOverrides.info ?? jest.fn(),
      warn: loggerOverrides.warn ?? jest.fn(),
      error: loggerOverrides.error ?? jest.fn(),
    },
  } as any;
}

function containsForbiddenValue(value: unknown, forbiddenValues: readonly string[]): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return true;
  }
  return forbiddenValues.some(forbidden => serialized.includes(forbidden));
}

function circularThrownValue(): Record<string, unknown> {
  const value: Record<string, unknown> = { kind: 'circular' };
  value.self = value;
  return value;
}

const syntheticMarker = ['phase2b', 'opaque', 'marker'].join('-');
const authorizationText = ['Authorization', 'Bearer', syntheticMarker].join(' ');
const filesystemPath = ['C:', 'private', 'runtime', 'dependency.log'].join('\\');
const sqlText = ['SELECT', '*', 'FROM', 'private_table'].join(' ');
const providerBody = JSON.stringify({ provider: 'synthetic', payload: syntheticMarker });

const thrownValues: Array<[string, () => unknown, string[]]> = [
  ['ordinary error', () => new Error('ordinary dependency detail'), ['ordinary dependency detail']],
  ['credential-like marker', () => new Error(syntheticMarker), [syntheticMarker]],
  ['authorization text', () => new Error(authorizationText), [authorizationText, syntheticMarker]],
  ['filesystem path', () => new Error(filesystemPath), [filesystemPath]],
  ['SQL text', () => new Error(sqlText), [sqlText]],
  ['provider JSON', () => new Error(providerBody), [providerBody, syntheticMarker]],
  ['nested cause', () => new Error('outer detail', { cause: new Error(syntheticMarker) }), ['outer detail', syntheticMarker]],
  ['non-Error string', () => syntheticMarker, [syntheticMarker]],
  ['circular object', circularThrownValue, ['circular']],
  ['very long message', () => new Error('x'.repeat(20_000)), ['x'.repeat(128)]],
  ['Unicode and control characters', () => new Error(`internal-雪\r\n${syntheticMarker}`), ['internal-雪', syntheticMarker]],
  ['timeout', () => Object.assign(new Error(syntheticMarker), { name: 'TimeoutError' }), [syntheticMarker]],
  ['abort', () => Object.assign(new Error(syntheticMarker), { name: 'AbortError' }), [syntheticMarker]],
  ['attacker-controlled error class', () => Object.assign(new Error('detail'), { name: syntheticMarker }), [syntheticMarker]],
];

describe('MCP external error disclosure contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(thrownValues)('sanitizes %s', async (_label, buildThrown, forbiddenValues) => {
    const context = buildContext();
    const handler = wrapTool('clear.evaluate', context, async () => {
      throw buildThrown();
    });

    const output = await handler({ input: 'not logged' });

    expect(output).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'ERR_INTERNAL',
            message: 'MCP operation failed.',
            details: {
              tool: 'clear.evaluate',
              category: 'MCP_OPERATION_FAILED',
            },
            requestId: 'phase2b-request',
          },
        }, null, 2),
      }],
      structuredContent: {
        error: {
          code: 'ERR_INTERNAL',
          message: 'MCP operation failed.',
          details: {
            tool: 'clear.evaluate',
            category: 'MCP_OPERATION_FAILED',
          },
          requestId: 'phase2b-request',
        },
      },
      isError: true,
    });

    const observable = {
      output,
      infoCalls: context.logger.info.mock.calls,
      errorCalls: context.logger.error.mock.calls,
    };
    expect(containsForbiddenValue(observable, forbiddenValues)).toBe(false);
    expect(context.logger.error).toHaveBeenCalledWith('mcp.tool.error', {
      tool: 'clear.evaluate',
      durationMs: expect.any(Number),
      errorCode: 'MCP_OPERATION_FAILED',
      errorClass: expect.any(String),
      requestId: 'phase2b-request',
      traceId: 'phase2b-trace',
      retryable: false,
    });
  });

  it.each(['info', 'error'] as const)('returns a sanitized error when the %s logger throws', async level => {
    const throwingLogger = jest.fn(() => {
      throw new Error(syntheticMarker);
    });
    const context = buildContext({ [level]: throwingLogger });
    const handler = wrapTool('plans.execute', context, async () => {
      throw new Error(syntheticMarker);
    });

    const output = await handler({});

    expect(output).toEqual(expect.objectContaining({
      isError: true,
      structuredContent: {
        error: expect.objectContaining({
          code: 'ERR_INTERNAL',
          message: 'MCP operation failed.',
          requestId: 'phase2b-request',
        }),
      },
    }));
    expect(containsForbiddenValue(output, [syntheticMarker])).toBe(false);
  });

  it('preserves a successful result when start and end logging fail', async () => {
    const context = buildContext({
      info: jest.fn(() => {
        throw new Error(syntheticMarker);
      }),
    });
    const handler = wrapTool('clear.evaluate', context, async () => ({ ok: true }));

    await expect(handler({})).resolves.toEqual({ ok: true });
  });
});
