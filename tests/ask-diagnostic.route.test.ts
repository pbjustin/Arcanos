import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const validateAIRequestMock = jest.fn();
const handleAIErrorMock = jest.fn();
const logRequestFeedbackMock = jest.fn();
const tryDispatchDaemonToolsMock = jest.fn();
const tryDispatchDagToolsMock = jest.fn();
const tryDispatchWorkerToolsMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const gptFallbackClassifierMock = jest.fn();
const mockRunThroughBrain = jest.fn();
const mockTryExecutePromptRouteShortcut = jest.fn();

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: mockRunThroughBrain
}));

jest.unstable_mockModule('../src/routes/ask/daemonTools.js', () => ({
  tryDispatchDaemonTools: tryDispatchDaemonToolsMock
}));

jest.unstable_mockModule('../src/routes/ask/dagTools.js', () => ({
  tryDispatchDagTools: tryDispatchDagToolsMock
}));

jest.unstable_mockModule('../src/routes/ask/workerTools.js', () => ({
  tryDispatchWorkerTools: tryDispatchWorkerToolsMock
}));

jest.unstable_mockModule('@dispatcher/detectCognitiveDomain.js', () => ({
  detectCognitiveDomain: detectCognitiveDomainMock
}));

jest.unstable_mockModule('@dispatcher/gptDomainClassifier.js', () => ({
  gptFallbackClassifier: gptFallbackClassifierMock
}));

jest.unstable_mockModule('@services/promptRouteShortcuts.js', () => ({
  tryExecutePromptRouteShortcut: mockTryExecutePromptRouteShortcut
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const askRouter = (await import('../src/routes/ask.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', askRouter);
  return app;
}

describe('/ask diagnostic shortcut', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ASK_ROUTE_MODE = 'compat';
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'ping',
      body: {}
    });
    tryDispatchDaemonToolsMock.mockResolvedValue(null);
    tryDispatchDagToolsMock.mockResolvedValue(null);
    tryDispatchWorkerToolsMock.mockResolvedValue(null);
    detectCognitiveDomainMock.mockReturnValue({ domain: 'natural', confidence: 0.9 });
    gptFallbackClassifierMock.mockResolvedValue('natural');
    mockTryExecutePromptRouteShortcut.mockResolvedValue(null);
    mockRunThroughBrain.mockResolvedValue({
      result: 'unexpected trinity response'
    });
  });

  it('rejects deprecated brain traffic by default and points callers to the canonical GPT route', async () => {
    delete process.env.ASK_ROUTE_MODE;

    const response = await request(buildApp()).post('/brain').send({
      prompt: 'ping',
      gptId: 'arcanos-core'
    });

    expect(response.status).toBe(410);
    expect(response.headers['x-canonical-route']).toBe('/gpt/arcanos-core');
    expect(response.headers['x-route-deprecated']).toBe('true');
    expect(response.headers['x-ask-route-mode']).toBe('gone');
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      error: 'Legacy ask-style route has been removed; use /gpt/:gptId',
      deprecated: true,
      canonicalRoute: '/gpt/arcanos-core'
    });
    expect(validateAIRequestMock).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('returns a deterministic diagnostic response and bypasses stateful layers', async () => {
    const app = buildApp();
    const payload = {
      mode: 'diagnostic',
      action: 'ping',
      prompt: 'ping',
      sessionId: 'diag-session-1'
    };

    const first = await request(app).post('/brain').send(payload);
    const second = await request(app).post('/brain').send(payload);
    const third = await request(app).post('/brain').send(payload);

    expect(first.status).toBe(200);
    expect(first.headers['x-response-bytes']).toBeTruthy();
    expect(first.body).toEqual({
      result: 'backend operational',
      module: 'diagnostic',
      meta: {
        id: 'diagnostic-brain-v1',
        created: 0
      },
      activeModel: 'diagnostic',
      fallbackFlag: false,
      routingStages: ['DIAGNOSTIC-SHORTCUT'],
      gpt5Used: false,
      endpoint: 'brain'
    });
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    expect(validateAIRequestMock).not.toHaveBeenCalled();
    expect(tryDispatchDaemonToolsMock).not.toHaveBeenCalled();
    expect(tryDispatchDagToolsMock).not.toHaveBeenCalled();
    expect(tryDispatchWorkerToolsMock).not.toHaveBeenCalled();
    expect(mockTryExecutePromptRouteShortcut).not.toHaveBeenCalled();
    expect(detectCognitiveDomainMock).not.toHaveBeenCalled();
    expect(gptFallbackClassifierMock).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('accepts action-only ping probes before chat validation runs', async () => {
    const response = await request(buildApp()).post('/brain').send({
      action: 'ping'
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body.result).toBe('backend operational');
    expect(response.body.module).toBe('diagnostic');
    expect(validateAIRequestMock).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('reuses the same diagnostic shortcut on /brain', async () => {
    const response = await request(buildApp()).post('/brain').send({
      mode: 'diagnostic',
      prompt: 'ping'
    });

    expect(response.status).toBe(200);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body.result).toBe('backend operational');
    expect(response.body.routingStages).toEqual(['DIAGNOSTIC-SHORTCUT']);
    expect(validateAIRequestMock).not.toHaveBeenCalled();
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });
});
