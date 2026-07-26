import { describe, expect, it } from '@jest/globals';

import {
  classifyGptRouteExecution,
  type GptExecutionMode,
  type GptRouteExecutionPolicyInput,
} from '../src/routes/_core/gptRouteExecutionPolicy.js';
import { GPT_QUERY_ACTION } from '../src/shared/gpt/gptJobResult.js';

const BASE_INPUT: GptRouteExecutionPolicyInput = {
  explicitExecutionMode: null,
  requestedAction: null,
  promptPresent: true,
  promptLength: 24,
  messageCount: 2,
  answerMode: null,
  maxWords: null,
  heavyPrompt: false,
  directModuleQuery: false,
  coreGpt: false,
  coreQueryAsyncDefault: false,
};

function expectPlan(
  overrides: Partial<GptRouteExecutionPolicyInput>,
  expected: {
    mode: GptExecutionMode;
    reason: string;
    heavyPrompt: boolean;
  }
): void {
  expect(classifyGptRouteExecution({
    ...BASE_INPUT,
    ...overrides,
  })).toEqual({
    mode: expected.mode,
    reason: expected.reason,
    promptLength: overrides.promptLength ?? BASE_INPUT.promptLength,
    messageCount: overrides.messageCount ?? BASE_INPUT.messageCount,
    answerMode: overrides.answerMode ?? BASE_INPUT.answerMode,
    maxWords: overrides.maxWords ?? BASE_INPUT.maxWords,
    heavyPrompt: expected.heavyPrompt,
  });
}

describe('GPT route execution policy', () => {
  it.each([
    ['async', 'explicit_async_request'],
    ['sync', 'explicit_sync_request'],
  ] as const)('gives explicit %s mode first precedence', (mode, reason) => {
    expectPlan({
      explicitExecutionMode: mode,
      requestedAction: 'diagnostics',
      promptPresent: false,
      heavyPrompt: true,
      coreQueryAsyncDefault: true,
    }, {
      mode,
      reason,
      heavyPrompt: true,
    });
  });

  it('forces diagnostics to synchronous execution', () => {
    expectPlan({
      requestedAction: 'diagnostics',
      heavyPrompt: true,
      coreQueryAsyncDefault: true,
    }, {
      mode: 'sync',
      reason: 'diagnostics_request',
      heavyPrompt: false,
    });
  });

  it.each([null, GPT_QUERY_ACTION])(
    'keeps a missing-prompt %s request on validation',
    (requestedAction) => {
      expectPlan({
        requestedAction,
        promptPresent: false,
        heavyPrompt: true,
        coreQueryAsyncDefault: true,
      }, {
        mode: 'sync',
        reason: 'missing_prompt_validation',
        heavyPrompt: false,
      });
    }
  );

  it('does not apply query prompt validation to another explicit action', () => {
    expectPlan({
      requestedAction: 'health',
      promptPresent: false,
    }, {
      mode: 'sync',
      reason: 'default_sync_path',
      heavyPrompt: false,
    });
  });

  it('keeps direct-module query actions synchronous', () => {
    expectPlan({
      requestedAction: GPT_QUERY_ACTION,
      directModuleQuery: true,
      coreGpt: true,
      coreQueryAsyncDefault: true,
      heavyPrompt: true,
    }, {
      mode: 'sync',
      reason: 'explicit_module_query_action',
      heavyPrompt: false,
    });
  });

  it('uses the configured async default for explicit core query actions', () => {
    expectPlan({
      requestedAction: GPT_QUERY_ACTION,
      coreGpt: true,
      coreQueryAsyncDefault: true,
      heavyPrompt: true,
    }, {
      mode: 'async',
      reason: 'explicit_query_action',
      heavyPrompt: true,
    });
  });

  it('keeps explicit core query actions synchronous when the default is disabled', () => {
    expectPlan({
      requestedAction: GPT_QUERY_ACTION,
      coreGpt: true,
      heavyPrompt: true,
    }, {
      mode: 'sync',
      reason: 'explicit_core_query_action',
      heavyPrompt: false,
    });
  });

  it('routes explicit non-core query actions asynchronously', () => {
    expectPlan({
      requestedAction: GPT_QUERY_ACTION,
      heavyPrompt: false,
    }, {
      mode: 'async',
      reason: 'explicit_query_action',
      heavyPrompt: false,
    });
  });

  it('defaults an unlabelled core query to async and marks it heavy', () => {
    expectPlan({
      coreGpt: true,
      coreQueryAsyncDefault: true,
      heavyPrompt: false,
    }, {
      mode: 'async',
      reason: 'core_query_async_default',
      heavyPrompt: true,
    });
  });

  it('routes a heavy ordinary request asynchronously', () => {
    expectPlan({
      heavyPrompt: true,
      answerMode: 'audit',
      maxWords: 900,
    }, {
      mode: 'async',
      reason: 'heavy_prompt_auto_async',
      heavyPrompt: true,
    });
  });

  it('keeps an ordinary request synchronous', () => {
    expectPlan({}, {
      mode: 'sync',
      reason: 'default_sync_path',
      heavyPrompt: false,
    });
  });
});
