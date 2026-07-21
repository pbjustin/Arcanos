import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const createJobMock = jest.fn();
const validateAIRequestMock = jest.fn();
const handleAIErrorMock = jest.fn();
const logRequestFeedbackMock = jest.fn();
const runTrinityWritingPipelineMock = jest.fn();
const tryDispatchDaemonToolsMock = jest.fn();
const tryDispatchDagToolsMock = jest.fn();
const tryDispatchWorkerToolsMock = jest.fn();
const detectCognitiveDomainMock = jest.fn();
const gptFallbackClassifierMock = jest.fn();
const tryExecutePromptRouteShortcutMock = jest.fn();
const updateAiExecutionContextMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  createJob: createJobMock,
  claimNextPendingJob: jest.fn(),
  recordJobHeartbeat: jest.fn(),
  scheduleJobRetry: jest.fn(),
  deferJobForProviderRecovery: jest.fn(),
  recoverStaleJobs: jest.fn(),
  updateJob: jest.fn(),
  getJobById: jest.fn(),
  getLatestJob: jest.fn(),
  getJobQueueSummary: jest.fn(),
  getJobExecutionStatsSince: jest.fn(),
}));

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock,
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock,
}));

jest.unstable_mockModule('../src/routes/ask/daemonTools.js', () => ({
  tryDispatchDaemonTools: tryDispatchDaemonToolsMock,
}));

jest.unstable_mockModule('../src/routes/ask/dagTools.js', () => ({
  tryDispatchDagTools: tryDispatchDagToolsMock,
}));

jest.unstable_mockModule('../src/routes/ask/workerTools.js', () => ({
  tryDispatchWorkerTools: tryDispatchWorkerToolsMock,
}));

jest.unstable_mockModule('@dispatcher/detectCognitiveDomain.js', () => ({
  detectCognitiveDomain: detectCognitiveDomainMock,
}));

jest.unstable_mockModule('@dispatcher/gptDomainClassifier.js', () => ({
  gptFallbackClassifier: gptFallbackClassifierMock,
}));

jest.unstable_mockModule('@services/promptRouteShortcuts.js', () => ({
  tryExecutePromptRouteShortcut: tryExecutePromptRouteShortcutMock,
}));

jest.unstable_mockModule('@services/openai/aiExecutionContext.js', () => ({
  createAiExecutionContext: jest.fn((input: Record<string, unknown>) => ({
    provider: 'openai',
    sourceType: input.sourceType ?? 'unknown',
    sourceName: input.sourceName ?? 'unknown',
    totals: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    operationCounts: {},
    models: {},
  })),
  runWithAiExecutionContext: jest.fn((
    _context: unknown,
    callback: () => unknown,
  ) => callback()),
  getAiExecutionContext: jest.fn(() => null),
  updateAiExecutionContext: updateAiExecutionContextMock,
  assertAiBudgetAllowsCall: jest.fn(),
  recordAiOperationResult: jest.fn(),
  summarizeAiExecutionContext: jest.fn(() => ({})),
}));

jest.unstable_mockModule('@transport/http/aiRouteTelemetry.js', () => ({
  beginAiRouteTrace: jest.fn(),
  completeAiRouteTrace: jest.fn(),
  failAiRouteTrace: jest.fn(),
}));

jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({
  getWorkerAutonomyHealthReport: jest.fn(async () => ({
    overallStatus: 'healthy',
    alerts: [],
    workers: [],
  })),
  planAutonomousWorkerJob: jest.fn(async () => ({
    status: 'pending',
    retryCount: 0,
    maxRetries: 2,
    priority: 100,
    autonomyState: { planner: { reasons: [] } },
    planningReasons: [],
  })),
}));

jest.unstable_mockModule('@platform/logging/diagnostics.js', () => ({
  runHealthCheck: jest.fn(),
}));

jest.unstable_mockModule('@platform/resilience/unifiedHealth.js', () => ({
  checkRedisHealth: jest.fn(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const askRouter = (await import('../src/routes/ask.js')).default;
const systemStateRouter = (await import('../src/routes/system-state.js')).default;
const intentStoreModule = await import('../src/routes/ask/intent_store.js');
const { recordChatIntent } = intentStoreModule;
const {
  clearPromptDebugTracesForTest,
  flushPromptDebugTracePersistenceForTest,
} = await import('../src/services/promptDebugTraceService.js');

const originalEnv = { ...process.env };
const fixedNow = new Date('2026-07-16T18:30:00.000Z');

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
}

function buildAskApp(logger: {
  info: ReturnType<typeof jest.fn>;
  warn: ReturnType<typeof jest.fn>;
  error: ReturnType<typeof jest.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'reusable-audit-system-state-request';
    req.traceId = 'reusable-audit-system-state-trace';
    req.logger = logger;
    next();
  });
  app.use('/', askRouter);
  return app;
}

function buildDirectApp() {
  const app = express();
  app.use(express.json());
  app.use('/', systemStateRouter);
  return app;
}

describe('reusable-code audit: /brain and /system-state characterization', () => {
  let tempDir = '';
  let storagePath = '';
  let requestLogger: {
    info: ReturnType<typeof jest.fn>;
    warn: ReturnType<typeof jest.fn>;
    error: ReturnType<typeof jest.fn>;
  };

  beforeEach(async () => {
    restoreEnvironment();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arcanos-system-state-audit-'));
    storagePath = path.join(tempDir, 'prompt-debug-events.jsonl');
    process.env.ASK_ROUTE_MODE = 'compat';
    process.env.PROMPT_DEBUG_EVENTS_PATH = storagePath;
    await clearPromptDebugTracesForTest();

    requestLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  afterEach(async () => {
    process.env.PROMPT_DEBUG_EVENTS_PATH = storagePath;
    await clearPromptDebugTracesForTest();
    await fsp.rm(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnvironment();
  });

  it('documents unique-session isolation because the intent store exposes no reset seam', () => {
    const resetExports = Object.keys(intentStoreModule).filter((name) =>
      /(?:clear|reset).*intent|intent.*(?:clear|reset)/iu.test(name)
    );

    expect(resetExports).toEqual([]);
  });

  it('returns the same successful state body while preserving /brain headers, logging, and prompt-debug persistence', async () => {
    const sessionId = 'reusable-audit-system-state-success';
    recordChatIntent('Preserve current system-state behavior', sessionId);

    const brainResponse = await request(buildAskApp(requestLogger))
      .post('/brain')
      .send({
        mode: 'system_state',
        sessionId,
      });
    const directResponse = await request(buildDirectApp())
      .get('/system-state')
      .query({ sessionId });

    expect(brainResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    expect(brainResponse.body).toEqual(directResponse.body);
    expect(brainResponse.body.generatedAt).toBe(fixedNow.toISOString());

    expect(brainResponse.headers).toMatchObject({
      deprecation: 'true',
      sunset: 'Wed, 01 Jul 2026 00:00:00 GMT',
      'x-ask-route-mode': 'compat',
      'x-canonical-route': '/gpt/{gptId}',
      'x-route-deprecated': 'true',
    });
    expect(brainResponse.headers['x-response-bytes']).toBeTruthy();
    expect(directResponse.headers['x-route-deprecated']).toBeUndefined();
    expect(directResponse.headers['x-response-bytes']).toBeUndefined();

    expect(requestLogger.info).toHaveBeenCalledWith(
      'ask.deprecated_route_used',
      expect.objectContaining({
        endpoint: '/brain',
        routeMode: 'compat',
      }),
    );
    expect(requestLogger.info).toHaveBeenCalledWith(
      'brain.system_state.response',
      expect.objectContaining({
        truncated: false,
      }),
    );

    await flushPromptDebugTracePersistenceForTest();
    const persistedEvents = (await fsp.readFile(storagePath, 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(persistedEvents).toEqual([
      expect.objectContaining({
        requestId: 'reusable-audit-system-state-request',
        stage: 'ingress',
      }),
    ]);

    expect(updateAiExecutionContextMock).toHaveBeenCalledTimes(1);
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
    expect(validateAIRequestMock).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('preserves the different invalid-version status, body, and header behavior', async () => {
    const sessionId = 'reusable-audit-system-state-invalid-version';
    const seeded = recordChatIntent('Seed an optimistic-lock mismatch', sessionId);
    const invalidUpdate = {
      mode: 'system_state',
      sessionId,
      expectedVersion: 0,
      patch: {
        status: 'active',
      },
    };

    const brainResponse = await request(buildAskApp(requestLogger))
      .post('/brain')
      .send(invalidUpdate);
    const directResponse = await request(buildDirectApp())
      .post('/system-state')
      .send(invalidUpdate);

    expect(brainResponse.status).toBe(400);
    expect(brainResponse.body).toEqual({
      error: 'SYSTEM_STATE_REQUEST_INVALID',
      details: ['Number must be greater than or equal to 1'],
    });
    expect(brainResponse.headers['x-route-deprecated']).toBe('true');
    expect(brainResponse.headers['x-response-bytes']).toBeTruthy();

    expect(directResponse.status).toBe(409);
    expect(directResponse.body).toEqual({
      ok: false,
      error: {
        code: 'SYSTEM_STATE_CONFLICT',
        message: 'system_state update conflict',
        details: {
          error: 'INTENT_VERSION_CONFLICT',
          currentVersion: seeded.version,
        },
      },
    });
    expect(directResponse.headers['x-route-deprecated']).toBeUndefined();
    expect(directResponse.headers['x-response-bytes']).toBeUndefined();

    await flushPromptDebugTracePersistenceForTest();
    expect(await fsp.readFile(storagePath, 'utf8')).toContain(
      '"requestId":"reusable-audit-system-state-request"',
    );
    expect(runTrinityWritingPipelineMock).not.toHaveBeenCalled();
    expect(validateAIRequestMock).not.toHaveBeenCalled();
  });
});
