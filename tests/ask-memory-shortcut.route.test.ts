import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const createJobMock = jest.fn();
const validateAIRequestMock = jest.fn();
const handleAIErrorMock = jest.fn();
const logRequestFeedbackMock = jest.fn();
const tryDispatchDaemonToolsMock = jest.fn();
const tryDispatchDagToolsMock = jest.fn();
const tryDispatchWorkerToolsMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const gptFallbackClassifierMock = jest.fn();
const mockRunThroughBrain = jest.fn();
const mockTryExecuteNaturalLanguageMemoryRouteShortcut = jest.fn();
const mockTryExecuteBackstageBookerRouteShortcut = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock,
  claimNextPendingJob: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  recoverStaleJobs: jest.fn(),
  updateJob: jest.fn(),
  getJobById: jest.fn(),
  getLatestJob: jest.fn(),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn()
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock
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

jest.unstable_mockModule('@services/naturalLanguageMemoryRouteShortcut.js', () => ({
  tryExecuteNaturalLanguageMemoryRouteShortcut: mockTryExecuteNaturalLanguageMemoryRouteShortcut
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  tryExecuteBackstageBookerRouteShortcut: mockTryExecuteBackstageBookerRouteShortcut
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomyHealthReport: jest.fn(async () => ({
    overallStatus: 'healthy',
    alerts: [],
    workers: []
  })),
  planAutonomousWorkerJob: jest.fn(async () => ({
    status: 'pending',
    retryCount: 0,
    maxRetries: 2,
    priority: 100,
    autonomyState: {
      planner: {
        reasons: []
      }
    },
    planningReasons: []
  }))
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

describe('/ask memory shortcut', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createJobMock.mockResolvedValue({ id: 'job-123' });
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Recall: RAW_20260308_VAN_PROBE2',
      body: {}
    });
    tryDispatchDaemonToolsMock.mockResolvedValue(null);
    tryDispatchDagToolsMock.mockResolvedValue(null);
    tryDispatchWorkerToolsMock.mockResolvedValue(null);
    detectCognitiveDomainMock.mockReturnValue({ domain: 'natural', confidence: 0.9 });
    gptFallbackClassifierMock.mockResolvedValue('natural');
    mockRunThroughBrain.mockResolvedValue({ result: 'unexpected trinity response' });
    mockTryExecuteBackstageBookerRouteShortcut.mockResolvedValue(null);
  });

  it('returns deterministic memory text before Trinity executes', async () => {
    mockTryExecuteNaturalLanguageMemoryRouteShortcut.mockResolvedValue({
      resultText: 'Persisted summary for Vancouver Raw',
      memory: {
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId: 'raw_20260308_van_probe2',
        message: 'Loaded latest saved memory.'
      }
    });

    const response = await request(buildApp()).post('/ask').send({
      prompt: 'Recall: RAW_20260308_VAN_PROBE2',
      sessionId: 'RAW_20260308_VAN_PROBE2'
    });

    expect(response.status).toBe(200);
    expect(response.body.result).toBe('Persisted summary for Vancouver Raw');
    expect(response.body.module).toBe('memory-dispatcher');
    expect(response.body.routingStages).toEqual(['MEMORY-DISPATCH']);
    expect(mockTryExecuteNaturalLanguageMemoryRouteShortcut).toHaveBeenCalledWith({
      prompt: 'Recall: RAW_20260308_VAN_PROBE2',
      sessionId: 'RAW_20260308_VAN_PROBE2'
    });
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('routes explicit wrestling-booking prompts through the backstage booker before Trinity executes', async () => {
    mockTryExecuteNaturalLanguageMemoryRouteShortcut.mockResolvedValue(null);
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Generate three rivalries for RAW after WrestleMania.',
      body: {}
    });
    mockTryExecuteBackstageBookerRouteShortcut.mockResolvedValue({
      resultText: 'Week 1: Gunther vs AJ Styles escalates. Week 2: Seth Rollins targets CM Punk.',
      dispatcher: {
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        reason: 'booking_verb+storyline_request+wrestling_brand'
      }
    });

    const response = await request(buildApp()).post('/ask').send({
      prompt: 'Generate three rivalries for RAW after WrestleMania.',
      sessionId: 'RAW_RIVALRY_TEST'
    });

    expect(response.status).toBe(200);
    expect(response.body.result).toContain('Gunther vs AJ Styles');
    expect(response.body.module).toBe('BACKSTAGE:BOOKER');
    expect(response.body.routingStages).toEqual(['BACKSTAGE-BOOKER-DISPATCH']);
    expect(mockTryExecuteBackstageBookerRouteShortcut).toHaveBeenLastCalledWith({
      prompt: 'Generate three rivalries for RAW after WrestleMania.',
      sessionId: 'RAW_RIVALRY_TEST'
    });
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });
});
