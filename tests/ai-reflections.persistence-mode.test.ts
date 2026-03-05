import { describe, expect, it, jest } from '@jest/globals';

type AIReflectionsModule = typeof import('../src/services/ai-reflections.js');

interface AIReflectionsHarness {
  module: AIReflectionsModule;
  callOpenAIMock: jest.Mock;
  saveSelfReflectionMock: jest.Mock;
}

/**
 * Load ai-reflections module with isolated persistence and OpenAI mocks.
 *
 * Purpose: verify persistence gating behavior for stateless vs stateful patch generation.
 * Inputs/outputs: none -> imported module plus dependency mocks.
 * Edge cases: resets module cache between tests to avoid shared env/config state.
 */
async function loadAIReflectionsHarness(): Promise<AIReflectionsHarness> {
  jest.resetModules();

  const callOpenAIMock = jest.fn(async () => ({
    output: 'Mock reflection output',
    cached: false,
    model: 'gpt-test-model'
  }));
  const saveSelfReflectionMock = jest.fn(async () => undefined);

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    callOpenAI: callOpenAIMock,
    getDefaultModel: () => 'gpt-test-model'
  }));
  jest.unstable_mockModule('@core/db/repositories/selfReflectionRepository.js', () => ({
    saveSelfReflection: saveSelfReflectionMock
  }));
  jest.unstable_mockModule('@platform/runtime/aiReflectionTemplates.js', () => ({
    AI_REFLECTION_DEFAULT_SYSTEM_PROMPT: 'test-system-prompt',
    buildReflectionPrompt: () => 'test-reflection-prompt',
    buildDefaultPatchContent: () => 'default-fallback-content',
    buildFallbackPatchContent: () => 'error-fallback-content'
  }));
  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnv: (_key: string) => undefined,
    getEnvNumber: (_key: string, fallback: number) => fallback
  }));

  const module = await import('../src/services/ai-reflections.js');
  return {
    module,
    callOpenAIMock,
    saveSelfReflectionMock
  };
}

describe('ai-reflections persistence mode', () => {
  it('does not persist reflections in stateless mode', async () => {
    const harness = await loadAIReflectionsHarness();

    await harness.module.buildPatchSet({
      useMemory: false,
      useCache: false,
      category: 'stateless-test'
    });

    expect(harness.callOpenAIMock).toHaveBeenCalledTimes(1);
    expect(harness.saveSelfReflectionMock).not.toHaveBeenCalled();
  });

  it('persists reflections in stateful mode', async () => {
    const harness = await loadAIReflectionsHarness();

    await harness.module.buildPatchSet({
      useMemory: true,
      useCache: false,
      category: 'stateful-test'
    });

    expect(harness.callOpenAIMock).toHaveBeenCalledTimes(1);
    expect(harness.saveSelfReflectionMock).toHaveBeenCalledTimes(1);
  });
});
