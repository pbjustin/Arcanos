import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const buildUnsafeToProceedPayloadMock = jest.fn(() => ({
  error: 'UNSAFE_TO_PROCEED',
  conditions: ['PATTERN_INTEGRITY_FAILURE']
}));
const hasUnsafeBlockingConditionsMock = jest.fn();

jest.unstable_mockModule('@services/safety/runtimeState.js', () => ({
  buildUnsafeToProceedPayload: buildUnsafeToProceedPayloadMock,
  hasUnsafeBlockingConditions: hasUnsafeBlockingConditionsMock
}));

const { unsafeExecutionGate } = await import('../src/transport/http/middleware/unsafeExecutionGate.js');

type MockRequest = {
  method: string;
  path: string;
  body?: unknown;
  logger?: { info?: jest.Mock };
};

function createResponse() {
  const response = {
    status: jest.fn(),
    json: jest.fn()
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('transport/http/middleware/unsafeExecutionGate', () => {
  beforeEach(() => {
    buildUnsafeToProceedPayloadMock.mockClear();
    hasUnsafeBlockingConditionsMock.mockReset();
  });

  it('bypasses non-mutating requests', () => {
    const next = jest.fn();
    const response = createResponse();

    unsafeExecutionGate({
      method: 'GET',
      path: '/healthz'
    } as MockRequest as any, response as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('bypasses the quarantine release path even for mutating requests', () => {
    const next = jest.fn();
    const response = createResponse();

    unsafeExecutionGate({
      method: 'POST',
      path: '/status/safety/quarantine/quarantine-123/release'
    } as MockRequest as any, response as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('does not bypass diagnostics actions sent through /gpt', () => {
    const logger = { info: jest.fn() };
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    for (const body of [
      { action: 'diagnostics' },
      '{"action":"diagnostics"}',
      { '{"action":"diagnostics"}': '' }
    ]) {
      const next = jest.fn();
      const response = createResponse();

      unsafeExecutionGate({
        method: 'POST',
        path: '/gpt/arcanos-core',
        body,
        logger
      } as MockRequest as any, response as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(503);
    }

    expect(logger.info).not.toHaveBeenCalledWith('unsafe_execution_gate.bypass', expect.anything());
  });

  it('bypasses approved read-only GPT access POST paths', () => {
    const logger = { info: jest.fn() };

    for (const path of [
      '/gpt-access/jobs/result',
      '/gpt-access/diagnostics/deep',
      '/gpt-access/db/explain',
      '/gpt-access/logs/query',
      '/gpt-access/mcp',
      '/gpt-access/operator/run'
    ]) {
      const next = jest.fn();
      const response = createResponse();

      unsafeExecutionGate({
        method: 'POST',
        path,
        body: {},
        logger
      } as MockRequest as any, response as any, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.status).not.toHaveBeenCalled();
    }

    expect(logger.info).toHaveBeenCalledWith('unsafe_execution_gate.bypass', {
      reason: 'gpt_access_readonly',
      path: '/gpt-access/jobs/result'
    });
  });

  it('does not treat GPT access AI job creation as a read-only bypass', () => {
    const next = jest.fn();
    const response = createResponse();
    const logger = { info: jest.fn() };
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt-access/jobs/create',
      body: {},
      logger
    } as MockRequest as any, response as any, next);

    expect(logger.info).not.toHaveBeenCalledWith('unsafe_execution_gate.bypass', expect.anything());
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('falls through when GPT request bodies are invalid JSON or blank strings', () => {
    hasUnsafeBlockingConditionsMock.mockReturnValue(false);

    for (const body of ['not-json', '   ', '["diagnostics"]']) {
      const next = jest.fn();
      const response = createResponse();

      unsafeExecutionGate({
        method: 'POST',
        path: '/gpt/arcanos-core',
        body
      } as MockRequest as any, response as any, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(response.status).not.toHaveBeenCalled();
    }
  });

  it('allows mutating requests when no unsafe blocking conditions are active', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(false);

    unsafeExecutionGate({
      method: 'POST',
      path: '/mutate',
      body: { action: 'write' }
    } as MockRequest as any, response as any, next);

    expect(hasUnsafeBlockingConditionsMock).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it('blocks mutating requests when unsafe conditions are active', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/mutate',
      body: { action: 'write' }
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: 'UNSAFE_TO_PROCEED',
      conditions: ['PATTERN_INTEGRITY_FAILURE']
    });
  });
});
