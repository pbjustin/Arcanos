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
const collectRepoImplementationEvidenceMock = jest.fn();
const buildRepoInspectionPromptMock = jest.fn();

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

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  shouldInspectRepoPrompt: shouldInspectRepoPromptMock,
  collectRepoImplementationEvidence: collectRepoImplementationEvidenceMock,
  buildRepoInspectionPrompt: buildRepoInspectionPromptMock
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

  it('injects repo evidence into the Trinity prompt for implementation questions', async () => {
    const repoEvidence = {
      status: 'implemented',
      checks: [{ name: 'repo_tools', status: 'pass' }],
      evidence: {
        rootPath: 'C:\\pbjustin\\Arcanos',
        filesFound: ['packages/cli/src'],
        commandsDetected: ['tool.invoke'],
        repoToolsDetected: ['repo.listTree']
      }
    };

    shouldInspectRepoPromptMock.mockReturnValue(true);
    collectRepoImplementationEvidenceMock.mockResolvedValue(repoEvidence);
    buildRepoInspectionPromptMock.mockReturnValue('repo-evidence:Is my CLI implemented?');

    const response = await request(buildApp()).post('/ask').send({
      prompt: 'Is my CLI implemented?',
      sessionId: 'repo-inspection-session'
    });

    expect(response.status).toBe(200);
    expect(shouldInspectRepoPromptMock).toHaveBeenCalledWith('Is my CLI implemented?');
    expect(collectRepoImplementationEvidenceMock).toHaveBeenCalledTimes(1);
    expect(buildRepoInspectionPromptMock).toHaveBeenCalledWith('Is my CLI implemented?', repoEvidence);
    expect(mockRunThroughBrain).toHaveBeenCalledWith(
      expect.anything(),
      'repo-evidence:Is my CLI implemented?',
      'repo-inspection-session',
      undefined,
      expect.objectContaining({
        cognitiveDomain: 'code',
        sourceEndpoint: 'ask'
      }),
      expect.anything()
    );
  });
});
