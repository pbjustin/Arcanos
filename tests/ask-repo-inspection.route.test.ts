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
const shouldInspectRepoPromptMock = jest.fn();
const isVerificationQuestionMock = jest.fn();
const collectRepoInspectionEvidenceMock = jest.fn();
const buildRepoInspectionAnswerMock = jest.fn();

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: validateAIRequestMock,
  handleAIError: handleAIErrorMock,
  logRequestFeedback: logRequestFeedbackMock
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunThroughBrain
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

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  shouldInspectRepoPrompt: shouldInspectRepoPromptMock,
  isVerificationQuestion: isVerificationQuestionMock,
  collectRepoInspectionEvidence: collectRepoInspectionEvidenceMock,
  buildRepoInspectionAnswer: buildRepoInspectionAnswerMock
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

describe('/ask repo inspection routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ASK_ROUTE_MODE = 'compat';
    validateAIRequestMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      input: 'Is my CLI implemented?',
      body: {}
    });
    tryDispatchDaemonToolsMock.mockResolvedValue(null);
    tryDispatchDagToolsMock.mockResolvedValue(null);
    tryDispatchWorkerToolsMock.mockResolvedValue(null);
    detectCognitiveDomainMock.mockReturnValue({ domain: 'code', confidence: 0.95 });
    gptFallbackClassifierMock.mockResolvedValue('code');
    mockTryExecutePromptRouteShortcut.mockResolvedValue(null);
    shouldInspectRepoPromptMock.mockReturnValue(false);
    isVerificationQuestionMock.mockReturnValue(false);
    mockRunThroughBrain.mockResolvedValue({
      result: 'implemented',
      module: 'trinity',
      meta: { id: 'resp-1', created: Date.now() },
      activeModel: 'gpt-5',
      fallbackFlag: false,
      routingStages: ['ARCANOS-INTAKE:gpt-4o', 'GPT5-REASONING:gpt-5', 'ARCANOS-FINAL:gpt-4o'],
      gpt5Used: true,
      gpt5Model: 'gpt-5',
      dryRun: false
    });
  });

  it('returns a deterministic repo inspection answer before Trinity when evidence is available', async () => {
    const repoEvidence = {
      tree: {
        toolId: 'repo.listTree',
        ok: true,
        data: { items: ['packages/cli/src', 'packages/protocol/schemas/v1'], truncated: false }
      },
      status: {
        toolId: 'repo.getStatus',
        ok: true,
        data: { status: ' M src/routes/ask/index.ts' }
      },
      log: {
        toolId: 'repo.getLog',
        ok: true,
        data: { log: 'abc123 feat: wire repo evidence' }
      },
      searches: [
        {
          toolId: 'repo.search',
          ok: true,
          data: { query: 'tool.invoke', matches: 'src tool.invoke', truncated: false }
        }
      ]
    };

    shouldInspectRepoPromptMock.mockReturnValue(true);
    collectRepoInspectionEvidenceMock.mockResolvedValue(repoEvidence);
    buildRepoInspectionAnswerMock.mockReturnValue('CLI implementation is present.');

    const response = await request(buildApp()).post('/brain').send({
      prompt: 'Is my CLI implemented?',
      sessionId: 'repo-inspection-session'
    });

    expect(response.status).toBe(200);
    expect(shouldInspectRepoPromptMock).toHaveBeenCalledWith('Is my CLI implemented?');
    expect(collectRepoInspectionEvidenceMock).toHaveBeenCalledWith('Is my CLI implemented?');
    expect(buildRepoInspectionAnswerMock).toHaveBeenCalledWith('Is my CLI implemented?', repoEvidence);
    expect(response.body.result).toBe('CLI implementation is present.');
    expect(response.body.module).toBe('repo-inspection');
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });

  it('fails closed for verification prompts when repo inspection produces no usable evidence', async () => {
    shouldInspectRepoPromptMock.mockReturnValue(true);
    isVerificationQuestionMock.mockReturnValue(true);
    collectRepoInspectionEvidenceMock.mockResolvedValue({
      tree: { toolId: 'repo.listTree', ok: false, error: 'transport offline' },
      status: { toolId: 'repo.getStatus', ok: false, error: 'transport offline' },
      log: { toolId: 'repo.getLog', ok: false, error: 'transport offline' },
      searches: [
        { toolId: 'repo.search', ok: false, error: 'transport offline' }
      ]
    });

    const response = await request(buildApp()).post('/brain').send({
      prompt: 'Is my CLI implemented?',
      sessionId: 'repo-inspection-session'
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: 'REPO_EVIDENCE_REQUIRED',
        message: 'Cannot verify implementation without repo inspection.'
      }
    });
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });
});
