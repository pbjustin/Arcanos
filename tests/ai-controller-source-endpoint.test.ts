import { describe, expect, it, jest } from '@jest/globals';

type AIControllerModule = typeof import('../src/transport/http/controllers/aiController.js');

interface AIControllerHarness {
  module: AIControllerModule;
  runThroughBrainMock: jest.Mock;
  validateAIRequestMock: jest.Mock;
  handleAIErrorMock: jest.Mock;
}

/**
 * Load AI controller with isolated Trinity/request-handler mocks.
 *
 * Purpose: verify endpoint metadata is forwarded into Trinity run options.
 * Inputs/outputs: no inputs -> controller module + dependency mocks.
 * Edge cases: module cache reset prevents mock leakage across tests.
 */
async function loadAIControllerHarness(): Promise<AIControllerHarness> {
  jest.resetModules();

  const runThroughBrainMock = jest.fn(async () => ({
    result: 'ok',
    module: 'mock',
    meta: { id: 'mock-id', created: Date.now() },
    activeModel: 'mock',
    fallbackFlag: false,
    dryRun: false,
    fallbackSummary: {
      intakeFallbackUsed: false,
      gpt5FallbackUsed: false,
      finalFallbackUsed: false,
      fallbackReasons: []
    },
    auditSafe: {
      mode: true,
      overrideUsed: false,
      auditFlags: [],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: '',
      memoryEnhanced: false,
      maxRelevanceScore: 0,
      averageRelevanceScore: 0
    },
    taskLineage: {
      requestId: 'mock-request',
      logged: true
    }
  }));
  const validateAIRequestMock = jest.fn(() => ({
    client: {} as unknown,
    input: 'test prompt',
    body: {
      sessionId: 'session-123',
      overrideAuditSafe: 'override-token'
    }
  }));
  const handleAIErrorMock = jest.fn();

  jest.unstable_mockModule('@core/logic/trinity.js', () => ({
    runThroughBrain: runThroughBrainMock
  }));
  jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
    validateAIRequest: validateAIRequestMock,
    handleAIError: handleAIErrorMock
  }));
  jest.unstable_mockModule('@services/datasetHarvester.js', () => ({
    harvestDatasetsFromAudit: () => []
  }));

  const module = await import('../src/transport/http/controllers/aiController.js');
  return {
    module,
    runThroughBrainMock,
    validateAIRequestMock,
    handleAIErrorMock
  };
}

describe('AIController Trinity source endpoint forwarding', () => {
  it('passes endpointName into Trinity run options', async () => {
    const harness = await loadAIControllerHarness();

    const req = {} as any;
    const res = { json: jest.fn() } as any;

    await harness.module.AIController.processAIRequest(req, res, 'write');

    expect(harness.validateAIRequestMock).toHaveBeenCalledTimes(1);
    expect(harness.runThroughBrainMock).toHaveBeenCalledTimes(1);
    expect(harness.runThroughBrainMock).toHaveBeenCalledWith(
      expect.anything(),
      'test prompt',
      'session-123',
      'override-token',
      { sourceEndpoint: 'write' },
      expect.anything()
    );
    expect(harness.handleAIErrorMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
  });
});
