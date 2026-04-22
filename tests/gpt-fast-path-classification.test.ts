import { describe, expect, it } from '@jest/globals';

import {
  classifyGptFastPathRequest,
  hasPromptGenerationIntent,
  resolveGptFastPathModel,
} from '../src/shared/gpt/gptFastPath.js';

const BASE_ENV = {
  GPT_FAST_PATH_ENABLED: 'true',
  GPT_FAST_PATH_MAX_PROMPT_CHARS: '900',
  GPT_FAST_PATH_MAX_MESSAGE_COUNT: '3',
  GPT_FAST_PATH_MAX_WORDS: '350',
  GPT_FAST_PATH_TIMEOUT_MS: '8000',
  GPT_FAST_PATH_GPT_ALLOWLIST: '',
} as NodeJS.ProcessEnv;

describe('GPT fast-path classification', () => {
  it('recognizes simple prompt-generation requests as fast-path eligible', () => {
    const decision = classifyGptFastPathRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'Generate a prompt for a launch email.',
      },
      promptText: 'Generate a prompt for a launch email.',
      requestedAction: null,
      routeTimeoutProfile: 'default',
      env: BASE_ENV,
    });

    expect(decision).toMatchObject({
      path: 'fast_path',
      eligible: true,
      reason: 'simple_prompt_generation',
      queueBypassed: true,
      promptGenerationIntent: true,
      timeoutMs: 8000,
    });
  });

  it('keeps explicit query actions on the async bridge even when fast mode is requested', () => {
    const asyncDecision = classifyGptFastPathRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        prompt: 'Generate a prompt for a launch email.',
      },
      promptText: 'Generate a prompt for a launch email.',
      requestedAction: 'query',
      routeTimeoutProfile: 'default',
      env: BASE_ENV,
    });

    const explicitFastDecision = classifyGptFastPathRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query',
        prompt: 'Generate a prompt for a launch email.',
        executionMode: 'fast',
      },
      promptText: 'Generate a prompt for a launch email.',
      requestedAction: 'query',
      routeTimeoutProfile: 'default',
      explicitMode: 'fast',
      env: BASE_ENV,
    });

    expect(asyncDecision).toMatchObject({
      path: 'orchestrated_path',
      reason: 'explicit_action_preserves_async_bridge',
      queueBypassed: false,
    });
    expect(explicitFastDecision).toMatchObject({
      path: 'orchestrated_path',
      reason: 'explicit_action_preserves_async_bridge',
      queueBypassed: false,
    });
  });

  it('does not let explicit fast mode bypass prompt-generation intent', () => {
    const decision = classifyGptFastPathRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: 'Analyze this deployment timeout.',
        executionMode: 'fast',
      },
      promptText: 'Analyze this deployment timeout.',
      requestedAction: null,
      routeTimeoutProfile: 'default',
      explicitMode: 'fast',
      env: BASE_ENV,
    });

    expect(decision).toMatchObject({
      path: 'orchestrated_path',
      reason: 'no_prompt_generation_intent',
      queueBypassed: false,
      explicitMode: 'fast',
    });
  });

  it('routes complex or durable requests to the orchestrated path', () => {
    const cases = [
      {
        name: 'large prompt',
        body: { prompt: `Generate a prompt. ${'x'.repeat(901)}` },
        promptText: `Generate a prompt. ${'x'.repeat(901)}`,
        requestedAction: null,
        expectedReason: 'prompt_too_large',
      },
      {
        name: 'non-empty payload',
        body: {
          prompt: 'Generate a prompt for a launch email.',
          payload: { audience: 'operators' },
        },
        promptText: 'Generate a prompt for a launch email.',
        requestedAction: null,
        expectedReason: 'explicit_payload_requires_module_dispatch',
      },
      {
        name: 'invalid payload shape',
        body: {
          prompt: 'Generate a prompt for a launch email.',
          payload: 'operators',
        },
        promptText: 'Generate a prompt for a launch email.',
        requestedAction: null,
        expectedReason: 'invalid_payload_shape_requires_module_dispatch',
      },
      {
        name: 'DAG cue',
        body: {
          prompt: 'Generate a prompt for a launch email.',
        },
        promptText: 'Generate a prompt for a launch email.',
        requestedAction: null,
        routeTimeoutProfile: 'dag_execution' as const,
        expectedReason: 'dag_execution_intent',
      },
      {
        name: 'explicit idempotency',
        body: {
          prompt: 'Generate a prompt for a launch email.',
        },
        promptText: 'Generate a prompt for a launch email.',
        requestedAction: null,
        hasExplicitIdempotencyKey: true,
        expectedReason: 'idempotency_requires_durable_job',
      },
    ];

    for (const testCase of cases) {
      const decision = classifyGptFastPathRequest({
        gptId: 'arcanos-core',
        body: testCase.body,
        promptText: testCase.promptText,
        requestedAction: testCase.requestedAction,
        routeTimeoutProfile: testCase.routeTimeoutProfile ?? 'default',
        hasExplicitIdempotencyKey: testCase.hasExplicitIdempotencyKey,
        env: BASE_ENV,
      });

      expect(decision).toMatchObject({
        path: 'orchestrated_path',
        reason: testCase.expectedReason,
        queueBypassed: false,
      });
    }
  });

  it('honors disable and allowlist configuration', () => {
    expect(classifyGptFastPathRequest({
      gptId: 'arcanos-core',
      body: { prompt: 'Generate a prompt for a launch email.' },
      promptText: 'Generate a prompt for a launch email.',
      requestedAction: null,
      routeTimeoutProfile: 'default',
      env: {
        ...BASE_ENV,
        GPT_FAST_PATH_ENABLED: 'false',
      },
    })).toMatchObject({
      path: 'orchestrated_path',
      reason: 'fast_path_disabled',
    });

    expect(classifyGptFastPathRequest({
      gptId: 'backstage-booker',
      body: { prompt: 'Generate a prompt for a launch email.' },
      promptText: 'Generate a prompt for a launch email.',
      requestedAction: null,
      routeTimeoutProfile: 'default',
      env: {
        ...BASE_ENV,
        GPT_FAST_PATH_GPT_ALLOWLIST: 'arcanos-core',
      },
    })).toMatchObject({
      path: 'orchestrated_path',
      reason: 'gpt_not_fast_path_allowlisted',
    });
  });

  it('keeps intent detection explicit and tuneable', () => {
    expect(hasPromptGenerationIntent('Generate a prompt for a landing page.')).toBe(true);
    expect(hasPromptGenerationIntent('Turn this product brief into a prompt.')).toBe(true);
    expect(hasPromptGenerationIntent('Generate a launch email.')).toBe(false);
    expect(hasPromptGenerationIntent('Analyze this deployment timeout.')).toBe(false);
  });

  it('resolves the inline timeout once as part of the route decision', () => {
    expect(classifyGptFastPathRequest({
      gptId: 'arcanos-core',
      body: { prompt: 'Generate a prompt for a launch email.' },
      promptText: 'Generate a prompt for a launch email.',
      requestedAction: null,
      routeTimeoutProfile: 'default',
      env: {
        ...BASE_ENV,
        GPT_FAST_PATH_TIMEOUT_MS: '25000',
      },
    })).toMatchObject({
      path: 'fast_path',
      timeoutMs: 20000,
    });
  });

  it('uses a lightweight fast-path model by default and allows an explicit override', () => {
    expect(resolveGptFastPathModel({} as NodeJS.ProcessEnv)).toBe('gpt-4.1-mini');
    expect(resolveGptFastPathModel({
      GPT_FAST_PATH_MODEL: 'gpt-fast-test',
    } as NodeJS.ProcessEnv)).toBe('gpt-fast-test');
  });
});
