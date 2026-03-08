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
const mockTryExecutePromptRouteShortcut = jest.fn();

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

jest.unstable_mockModule('@services/promptRouteShortcuts.js', () => ({
  tryExecutePromptRouteShortcut: mockTryExecutePromptRouteShortcut
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

describe('/ask prompt shortcuts', () => {
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
    mockTryExecutePromptRouteShortcut.mockResolvedValue(null);
  });

  it('returns deterministic memory text before Trinity executes', async () => {
    mockTryExecutePromptRouteShortcut.mockResolvedValue({
      shortcutId: 'memory',
      resultText: 'Persisted summary for Vancouver Raw',
      response: {
        requestIdPrefix: 'memory',
        module: 'memory-dispatcher',
        activeModel: 'memory-dispatcher',
        routingStage: 'MEMORY-DISPATCH',
        auditFlag: 'MEMORY_SHORTCUT_ACTIVE',
        sessionId: 'raw_20260308_van_probe2',
        contextSummary: 'Memory dispatcher retrieved for session raw_20260308_van_probe2.'
      },
      dispatcher: {
        module: 'memory-dispatcher',
        action: 'retrieved',
        reason: 'retrieve'
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
    expect(mockTryExecutePromptRouteShortcut).toHaveBeenCalledWith({
      prompt: 'Recall: RAW_20260308_VAN_PROBE2',
      sessionId: 'RAW_20260308_VAN_PROBE2'
    });
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('routes explicit wrestling-booking prompts through the backstage booker before Trinity executes', async () => {
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Generate three rivalries for RAW after WrestleMania.',
      body: {}
    });
    mockTryExecutePromptRouteShortcut.mockResolvedValue({
      shortcutId: 'backstage-booker',
      resultText: 'Week 1: Gunther vs AJ Styles escalates. Week 2: Seth Rollins targets CM Punk.',
      response: {
        requestIdPrefix: 'booker',
        module: 'BACKSTAGE:BOOKER',
        activeModel: 'backstage-booker',
        routingStage: 'BACKSTAGE-BOOKER-DISPATCH',
        auditFlag: 'BACKSTAGE_BOOKER_SHORTCUT_ACTIVE',
        sessionId: 'RAW_RIVALRY_TEST',
        contextSummary: 'Backstage Booker generated a booking response for session RAW_RIVALRY_TEST.'
      },
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
    expect(mockTryExecutePromptRouteShortcut).toHaveBeenLastCalledWith({
      prompt: 'Generate three rivalries for RAW after WrestleMania.',
      sessionId: 'RAW_RIVALRY_TEST'
    });
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });
});
