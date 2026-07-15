import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import requestContext from '../src/middleware/requestContext.js';

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
const { guardPublicGamingCanaryResponse } = await import('../src/services/publicGamingCanary.js');

type MockRequest = {
  method: string;
  path: string;
  body?: unknown;
  requestId?: string;
  traceId?: string;
  logger?: { info?: jest.Mock };
};

function createResponse() {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn()
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
      '/gpt-access/mcp'
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

  it('contains an unsafe Gaming request in the public Gaming envelope', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming',
      body: { action: 'query', payload: { mode: 'guide', prompt: 'Guide me.' } },
      requestId: 'req-gaming-unsafe',
      traceId: 'trace-gaming-unsafe'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      ok: true,
      requestId: 'req-gaming-unsafe',
      traceId: 'trace-gaming-unsafe',
      result: {
        ok: false,
        route: 'gaming',
        mode: 'guide',
        error: {
          code: 'UNSAFE_TO_PROCEED',
          message: 'ARCANOS Gaming is temporarily unavailable because runtime integrity checks did not pass.'
        }
      },
      _route: {
        requestId: 'req-gaming-unsafe',
        traceId: 'trace-gaming-unsafe',
        gptId: 'arcanos-gaming',
        module: 'ARCANOS:GAMING',
        action: 'query',
        route: 'gaming',
        timestamp: expect.any(String)
      }
    });
    expect(JSON.stringify(response.json.mock.calls[0]?.[0])).not.toContain('PATTERN_INTEGRITY_FAILURE');
  });

  it('contains the fixed evidence retry path in the same correlated unsafe Gaming envelope', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming/evidence-retry',
      body: {
        game: 'Palworld',
        mode: 'guide',
        originalPrompt: 'Look up a current beginner guide for Palworld 1.0.',
        candidateUrls: [],
        requestedVersion: '1.0',
        evidenceAttempt: 1
      },
      requestId: 'req-evidence-unsafe',
      traceId: 'trace-evidence-unsafe'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-evidence-unsafe',
      traceId: 'trace-evidence-unsafe',
      result: expect.objectContaining({
        ok: false,
        route: 'gaming',
        mode: 'guide',
        error: expect.objectContaining({ code: 'UNSAFE_TO_PROCEED' })
      }),
      _route: expect.objectContaining({
        requestId: 'req-evidence-unsafe',
        traceId: 'trace-evidence-unsafe',
        gptId: 'arcanos-gaming',
        route: 'gaming'
      })
    }));
  });

  it('returns a closed public canary unavailable response without generic unsafe details', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming/canary',
      body: { action: 'canary', payload: { scope: 'public_pipeline' } },
      requestId: 'req-canary-unsafe',
      traceId: 'trace-canary-unsafe'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    const body = response.json.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      ok: false,
      action: 'canary',
      scope: 'public_pipeline',
      schemaVersion: '1.4.0',
      intent: 'public_canary',
      route: 'public_canary',
      requestId: 'req-canary-unsafe',
      traceId: 'trace-canary-unsafe',
      code: 'PUBLIC_CANARY_UNAVAILABLE',
      usedFallback: false,
      acceptedSources: 0,
      checks: {
        requestValidation: 'passed',
        dispatcher: 'passed',
        publicRoute: 'failed',
        fixtureValidation: 'skipped',
        grounding: 'skipped',
        networkRetrieval: 'skipped',
        providerExecution: 'skipped',
        responseConstruction: 'passed',
        responseGuard: 'passed'
      }
    });
    expect(guardPublicGamingCanaryResponse(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('PATTERN_INTEGRITY_FAILURE');
    expect(JSON.stringify(body)).not.toContain('conditions');
    expect(JSON.stringify(body)).not.toContain('quarantine');
    expect(buildUnsafeToProceedPayloadMock).not.toHaveBeenCalled();
  });

  it('keeps malformed canary validation at HTTP 400 during unsafe state', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming/canary',
      body: { action: 'canary', payload: { scope: 'public_pipeline', prompt: 'inspect internals' } },
      requestId: 'req-canary-invalid',
      traceId: 'trace-canary-invalid'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      ok: false,
      code: 'BAD_REQUEST',
      requestId: 'req-canary-invalid',
      traceId: 'trace-canary-invalid',
      usedFallback: false,
      acceptedSources: 0
    });
    expect(guardPublicGamingCanaryResponse(body)).toBe(true);
    expect(buildUnsafeToProceedPayloadMock).not.toHaveBeenCalled();
  });

  it('rejects an operational Gaming query before the unsafe gameplay envelope', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming',
      body: {
        action: 'query',
        payload: {
          mode: 'guide',
          prompt: 'Reach my backend and see if this has been implemented correctly.'
        }
      },
      requestId: 'req-operational-unsafe',
      traceId: 'trace-operational-unsafe'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      action: 'query',
      error: {
        code: 'OPERATIONAL_REQUEST_NOT_GAMEPLAY',
        message: 'This request asks about the public integration rather than gameplay. Use the public canary operation.'
      },
      _route: expect.objectContaining({ route: 'gaming_validation' })
    }));
    expect(response.json).not.toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ route: 'gaming' })
    }));
    expect(buildUnsafeToProceedPayloadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['trace ID only', { traceId: 'trace-only' }, 'trace-only', 'trace-only'],
    ['request ID only', { requestId: 'request-only' }, 'request-only', 'request-only'],
    ['no IDs', {}, 'unknown', 'unknown']
  ])('keeps an unsafe Gaming response correlated with %s', (_caseName, ids, expectedRequestId, expectedTraceId) => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming',
      body: { action: 'query', payload: { mode: 'guide', prompt: 'Guide me.' } },
      ...ids
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expectedRequestId,
      traceId: expectedTraceId,
      _route: expect.objectContaining({
        requestId: expectedRequestId,
        traceId: expectedTraceId
      })
    }));
  });

  it.each([
    ['missing action', { payload: { mode: 'guide', prompt: 'Guide me.' } }, 'GPT_ACTION_REQUIRED'],
    ['missing payload', { action: 'query', prompt: 'Guide me.' }, 'BAD_REQUEST'],
    ['invalid mode', { action: 'query', payload: { mode: 'speedrun', prompt: 'Guide me.' } }, 'GAMEPLAY_MODE_REQUIRED'],
    ['missing prompt', { action: 'query', payload: { mode: 'guide' } }, 'PROMPT_REQUIRED']
  ])('keeps unsafe-state Gaming validation at HTTP 400 for %s', (_caseName, body, expectedCode) => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/gaming',
      body,
      requestId: 'req-invalid',
      traceId: 'trace-invalid'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      requestId: 'req-invalid',
      traceId: 'trace-invalid',
      error: expect.objectContaining({ code: expectedCode }),
      _route: expect.objectContaining({
        requestId: 'req-invalid',
        traceId: 'trace-invalid',
        gptId: 'gaming'
      })
    }));
  });

  it('validates the merged Gaming payload before returning an unsafe-state envelope', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/gaming/',
      body: {
        action: 'query',
        mode: 'build',
        payload: { prompt: 'Build help.' }
      },
      requestId: 'req-merged',
      traceId: 'trace-merged'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ mode: 'build', error: expect.objectContaining({ code: 'UNSAFE_TO_PROCEED' }) }),
      _route: expect.objectContaining({ gptId: 'gaming' })
    }));
  });

  it('returns correlated JSON 400 before the unsafe response in real middleware order', async () => {
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.use(unsafeExecutionGate);
    app.post('/gpt/arcanos-gaming', (_req, res) => res.status(200).json({ reachedRoute: true }));

    const response = await request(app)
      .post('/gpt/arcanos-gaming')
      .send({ action: 'query', payload: { mode: 'speedrun', prompt: 'Guide me.' } });

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      requestId: response.headers['x-request-id'],
      traceId: response.headers['x-trace-id'],
      error: expect.objectContaining({ code: 'GAMEPLAY_MODE_REQUIRED' })
    }));
    expect(response.body.reachedRoute).toBeUndefined();
  });

  it.each([
    ['operation alias', { body: { operation: 'query', payload: { mode: 'guide', prompt: 'Guide me.' } } }],
    ['query parameter', { body: { payload: { mode: 'guide', prompt: 'Guide me.' } }, query: { action: 'query' } }],
    ['action header', {
      body: { payload: { mode: 'guide', prompt: 'Guide me.' } },
      header: (name: string) => name === 'x-gpt-action' ? 'query' : undefined
    }]
  ])('rejects the %s when the literal body action is absent', (_caseName, requestParts) => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/gaming',
      requestId: 'req-alias',
      traceId: 'trace-alias',
      ...requestParts
    } as MockRequest as any, response as any, next);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unsupported',
      error: expect.objectContaining({ code: 'GPT_ACTION_REQUIRED' }),
      _route: expect.objectContaining({ route: 'gaming_validation' })
    }));
    expect(buildUnsafeToProceedPayloadMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe unsupported Gaming action before generic blocking', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/arcanos-gaming',
      body: { action: 'nonsense', payload: { mode: 'guide', prompt: 'Guide me.' } },
      requestId: 'req-generic-unsafe',
      traceId: 'trace-generic-unsafe'
    } as MockRequest as any, response as any, next);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      action: 'unsupported',
      requestId: 'req-generic-unsafe',
      traceId: 'trace-generic-unsafe',
      error: expect.objectContaining({ code: 'BAD_REQUEST' }),
      _route: expect.objectContaining({ route: 'gaming_validation' })
    }));
    expect(response.json).not.toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ route: 'gaming' })
    }));
    expect(buildUnsafeToProceedPayloadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['query_and_wait', '/gpt/gaming'],
    ['dag.dispatch', '/gpt/arcanos-gaming']
  ])('uses the generic unsafe block for legacy gateway action %s at %s', (action, path) => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path,
      body: { action, prompt: 'Guide me.' },
      requestId: 'req-generic-unsafe',
      traceId: 'trace-generic-unsafe'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'UNSAFE_TO_PROCEED',
      requestId: 'req-generic-unsafe',
      traceId: 'trace-generic-unsafe'
    }));
    expect(buildUnsafeToProceedPayloadMock).toHaveBeenCalledTimes(1);
  });

  it('uses the generic unsafe response for an unrecognized double-slash path', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path: '/gpt/gaming//',
      body: { action: 'query', payload: { mode: 'guide', prompt: 'Guide me.' } },
      requestId: 'req-generic-unsafe',
      traceId: 'trace-generic-unsafe'
    } as MockRequest as any, response as any, next);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'UNSAFE_TO_PROCEED',
      requestId: 'req-generic-unsafe',
      traceId: 'trace-generic-unsafe'
    }));
    expect(buildUnsafeToProceedPayloadMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/gpt/Gaming', 'gaming'],
    ['/gpt/ARCANOS-GAMING/', 'arcanos-gaming']
  ])('keeps normalized Gaming alias %s inside the public envelope', (path, expectedGptId) => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'POST',
      path,
      body: { action: 'query', payload: { mode: 'guide', prompt: 'Guide me.' } },
      requestId: 'req-normalized',
      traceId: 'trace-normalized'
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ route: 'gaming' }),
      _route: expect.objectContaining({ gptId: expectedGptId })
    }));
  });

  it('preserves available correlation IDs for blocked non-Gaming mutations', () => {
    const next = jest.fn();
    const response = createResponse();
    hasUnsafeBlockingConditionsMock.mockReturnValue(true);

    unsafeExecutionGate({
      method: 'PUT',
      path: '/mutate',
      body: { action: 'write' },
      requestId: ' req-generic '
    } as MockRequest as any, response as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: 'UNSAFE_TO_PROCEED',
      conditions: ['PATTERN_INTEGRITY_FAILURE'],
      requestId: 'req-generic',
      traceId: 'req-generic'
    });
  });
});
