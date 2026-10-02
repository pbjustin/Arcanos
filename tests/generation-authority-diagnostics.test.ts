import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const authority = 'ft:gpt-4.1:synthetic:diagnostics-authority';
const authorityKeys = [
  'FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL',
  'RAILWAY_OPENAI_MODEL', 'RAILWAY_FINETUNED_MODEL_ID', 'RAILWAY_FINE_TUNED_MODEL_ID',
  'RAILWAY_AI_MODEL', 'RAILWAY_RAILWAY_OPENAI_MODEL'
];
const originalEnv = process.env;
let syntheticFetch: ReturnType<typeof jest.fn<typeof fetch>>;

function responseRecorder() {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();
  const setHeader = jest.fn();
  return { status, json, setHeader, response: { status, json, setHeader } as unknown as Response };
}

beforeEach(async () => {
  jest.resetModules();
  process.env = { ...originalEnv };
  // Blank sentinels prevent dotenv from restoring a local authority on import.
  authorityKeys.forEach(key => { process.env[key] = ''; });
  process.env.OPENAI_API_KEY = 'synthetic-diagnostics-test-key';
  process.env.ALLOW_ALL_GPTS = 'false';
  process.env.TRUSTED_GPT_IDS = 'synthetic-operator';
  for (const key of [
    'ARCANOS_AUTOMATION_SECRET', 'ARCANOS_AUTOMATION_HEADER',
    'FINE_TUNED_AUTOMATION_GPT_ID', 'FINETUNED_AUTOMATION_GPT_ID'
  ]) process.env[key] = '';
  // Keep the resolver and SDK real; no unexpected import or call can use network.
  syntheticFetch = jest.fn<typeof fetch>(async () => {
    throw new Error('Unexpected synthetic diagnostics transport');
  });
  jest.spyOn(globalThis, 'fetch').mockImplementation(syntheticFetch);
  const safetyRuntime = await import('../src/services/safety/runtimeState/index.js');
  // Prompt imports may pin their configured hash; fixture only that disk-write sink.
  jest.unstable_mockModule('../src/services/safety/runtimeState.js', () => ({
    ...safetyRuntime, setTrustedHash: jest.fn()
  }));
  // The status implementation is real; only its unrelated memory read is a fixture.
  jest.unstable_mockModule('../src/services/memory/context.js', () => ({
    getMemoryContext: () => ({
      relevantEntries: [], contextSummary: 'Synthetic memory context',
      memoryPrompt: 'Synthetic memory context', accessLog: []
    })
  }));
});

afterEach(async () => {
  const { resetOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js');
  resetOpenAIAdapter();
  process.env = originalEnv;
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('generation authority does not gate non-generative diagnostics', () => {
  it.each([
    ['absent', undefined],
    ['invalid', 'gpt-6.1-sol']
  ] as const)('imports real routes and reports %s authority without invoking a provider', async (_state, configured) => {
    if (configured !== undefined) process.env.AI_MODEL = configured;
    const { configureBackendUnifiedOpenAIClient } = await import('../src/core/init-openai.js');
    configureBackendUnifiedOpenAIClient();
    const { getConfirmGateConfiguration } = await import('../src/transport/http/middleware/confirmGate.js');
    const { getOpenAIStatus } = await import('../src/transport/http/controllers/openaiController.js');
    const recorder = responseRecorder();

    getOpenAIStatus({} as Request, recorder.response);

    expect(recorder.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ok',
      openai: expect.objectContaining({
        defaultModel: configured ?? '',
        fallbackModel: configured ?? '',
        gpt5Model: 'gpt-6.1-sol'
      })
    }));
    expect(getConfirmGateConfiguration()).toMatchObject({
      allowAllGpts: false, requiresHeader: true, trustedGptIds: ['synthetic-operator']
    });
    const { getOrchestrationShellStatus } = await import('../src/services/orchestrationShell.js');
    await expect(getOrchestrationShellStatus()).resolves.toMatchObject({
      model: configured ?? '', memoryEntries: 0
    });
    const {
      buildPredictiveHealingAIProviderStatusSnapshot, resetPredictiveHealingStateForTests
    } = await import('../src/services/selfImprove/predictiveHealingService.js');
    resetPredictiveHealingStateForTests();
    expect(buildPredictiveHealingAIProviderStatusSnapshot()).toMatchObject({
      model: configured ?? '', reachable: null, authenticated: null, completionHealthy: null
    });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('retains configured fine-tune trust entries and requires approval for trusted metadata alone', async () => {
    process.env.FINETUNED_MODEL_ID = authority;
    process.env.FINE_TUNED_AUTOMATION_GPT_ID = 'ft:synthetic:automation';
    const { confirmGate, getConfirmGateConfiguration } = await import('../src/transport/http/middleware/confirmGate.js');
    const trustedIds = getConfirmGateConfiguration().trustedGptIds;
    expect(trustedIds).toEqual(['synthetic-operator', 'ft:synthetic:automation', authority]);
    expect(trustedIds.filter(id => id === authority)).toHaveLength(1);

    const next = jest.fn();
    const request = {
      method: 'POST', path: '/api/protected', headers: {}, body: { gptId: authority }
    } as unknown as Request;
    const blocked = responseRecorder();
    confirmGate(request, blocked.response, next);
    expect(blocked.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    const approvedRequest = { ...request, headers: { 'x-confirmed': 'yes' } } as Request;
    const approved = responseRecorder();
    confirmGate(approvedRequest, approved.response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(approvedRequest.confirmationContext).toMatchObject({
      confirmationStatus: 'confirmed', manualConfirmation: true, isTrustedGpt: true
    });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it.each(['routine', 'escalation'] as const)('builds a provider-free %s dry-run preview without final authority', async finalLane => {
    const { buildDryRunPreview } = await import('../src/core/logic/trinityStages.js');
    const capabilityFlags = {
      canBrowse: false, canVerifyProvidedData: false, canVerifyLiveData: false,
      canConfirmExternalState: false, canPersistData: false, canCallBackend: false
    };

    expect(buildDryRunPreview(
      'synthetic-diagnostics', 'Synthetic prompt', 'Synthetic prompt',
      capabilityFlags, [], 0, false, 'Synthetic diagnostic', finalLane
    )).toMatchObject({
      intakeModelCandidate: 'gpt-6-luna', gpt5ModelCandidate: 'gpt-6.1-sol',
      finalModelCandidate: '',
      routingPlan: ['ARCANOS-INTAKE:gpt-6-luna', 'GPT5-REASONING:gpt-6.1-sol', 'ARCANOS-FINAL:']
    });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it('returns a healthy heuristic auto-heal plan without final authority or a provider call', async () => {
    const { buildAutoHealPlan } = await import('../src/services/autoHealService.js');
    await expect(buildAutoHealPlan({
      timestamp: '2026-10-01T00:00:00.000Z', workersDirectory: 'synthetic',
      totalWorkers: 0, availableWorkers: 0, workers: [],
      arcanosWorkers: {
        enabled: false, count: 0, model: '', status: 'disabled',
        runtime: {
          enabled: false, model: '', configuredCount: 0, started: false,
          activeListeners: 0, workerIds: [], totalDispatched: 0
        }
      },
      system: { model: '', environment: 'test' }
    })).resolves.toMatchObject({
      planId: 'heuristic', severity: 'ok', recommendedAction: 'monitor', fallbackModel: ''
    });
    expect(syntheticFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['invalid', 'gpt-6.1-sol']
  ] as const)('keeps actual generation fail-closed for %s authority before transport', async (_state, configured) => {
    if (configured !== undefined) process.env.AI_MODEL = configured;
    const { getOpenAIAdapter } = await import('../src/core/adapters/openai.adapter.js');
    const adapter = getOpenAIAdapter({
      apiKey: 'synthetic-diagnostics-test-key', baseURL: 'https://synthetic.invalid/v1',
      maxRetries: 0, fetch: syntheticFetch
    });
    const { createSingleChatCompletion, createChatCompletionWithFallback } = await import('../src/services/openai/chatFallbacks.js');
    const { callOpenAI, createCentralizedCompletion } = await import('../src/services/openai/chatFlow/index.js');
    const { runResponse } = await import('../src/lib/runResponse.js');
    const { createResponses } = await import('../src/services/openaiClient.js');
    const messages = [{ role: 'user' as const, content: 'Synthetic generation request' }];
    const expectedFailure = { code: 'FINAL_AUTHORITY_UNAVAILABLE' };

    await expect(createSingleChatCompletion(adapter, { messages })).rejects.toMatchObject(expectedFailure);
    await expect(createChatCompletionWithFallback(adapter, { messages })).rejects.toMatchObject(expectedFailure);
    await expect(callOpenAI(authority, 'Synthetic generation request', 100, false)).rejects.toMatchObject(expectedFailure);
    await expect(createCentralizedCompletion(messages)).rejects.toMatchObject(expectedFailure);
    await expect(runResponse({ input: 'Synthetic generation request' })).rejects.toMatchObject(expectedFailure);
    await expect(createResponses({ model: authority, input: 'Synthetic generation request' })).rejects.toMatchObject(expectedFailure);
    expect(syntheticFetch).not.toHaveBeenCalled();
  });
});
