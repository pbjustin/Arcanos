import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createJobMock = jest.fn();
const validateAIRequestMock = jest.fn();
const handleAIErrorMock = jest.fn();
const logRequestFeedbackMock = jest.fn();
const tryDispatchDaemonToolsMock = jest.fn();
const tryDispatchWorkerToolsMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const gptFallbackClassifierMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock
}));

jest.unstable_mockModule('../src/routes/ask/daemonTools.js', () => ({
  tryDispatchDaemonTools: tryDispatchDaemonToolsMock
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

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const askRouter = (await import('../src/routes/ask.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', askRouter);
  return app;
}

describe('/ask worker tools integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'show me worker status',
      body: {}
    });
    tryDispatchDaemonToolsMock.mockResolvedValue(null);
    tryDispatchWorkerToolsMock.mockResolvedValue({
      result: 'Workers are healthy.',
      module: 'worker-tools',
      fallbackFlag: false,
      meta: {
        id: 'worker-tool-1',
        created: Date.now()
      }
    });
    detectCognitiveDomainMock.mockReturnValue({ domain: 'execution', confidence: 0.95 });
    gptFallbackClassifierMock.mockResolvedValue('execution');
  });

  it('returns worker tool responses before async queue handling', async () => {
    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'show me worker status'
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        result: 'Workers are healthy.',
        module: 'worker-tools',
        endpoint: 'ask'
      })
    );
    expect(tryDispatchWorkerToolsMock).toHaveBeenCalledTimes(1);
    expect(tryDispatchWorkerToolsMock).toHaveBeenCalledWith(
      expect.anything(),
      'show me worker status'
    );
    expect(createJobMock).not.toHaveBeenCalled();
    expect(handleAIErrorMock).not.toHaveBeenCalled();
  });
});
