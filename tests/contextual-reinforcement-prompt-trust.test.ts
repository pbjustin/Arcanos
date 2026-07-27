import { describe, expect, it, jest } from '@jest/globals';

import type { ChatCompletionMessageParam } from '../src/services/openai/types.js';

type ContextualReinforcementModule = typeof import('../src/services/contextualReinforcement.js');
type JudgedResponseFeedbackModule = typeof import('../src/services/judgedResponseFeedback.js');
type MemoryDigestModule = typeof import('../src/services/memoryDigest.js');
type PrepareChatFlowModule = typeof import('../src/services/openai/chatFlow/prepare.js');

const TRUSTED_SYSTEM_PROMPT = 'TRUSTED_SYSTEM_PROMPT';
const CALLER_CONTEXT_SENTINEL = 'CALLER_CONTEXT_SENTINEL';
const PROMPT_HISTORY_SENTINEL = 'PROMPT_HISTORY_SENTINEL';
const MODEL_OUTPUT_SENTINEL = 'MODEL_OUTPUT_SENTINEL';
const AUDIT_SUMMARY_SENTINEL = 'AUDIT_SUMMARY_SENTINEL';
const AUDIT_PATTERN_SENTINEL = 'AUDIT_PATTERN_SENTINEL';
const TRACE_METHOD_SENTINEL = 'TRACE_METHOD_SENTINEL';
const TRACE_PATH_SENTINEL = 'TRACE_PATH_SENTINEL';
const LIVE_FEEDBACK_SENTINEL = 'LIVE_FEEDBACK_SENTINEL';
const LIVE_IMPROVEMENT_SENTINEL = 'LIVE_IMPROVEMENT_SENTINEL';
const HYDRATED_FEEDBACK_SENTINEL = 'HYDRATED_FEEDBACK_SENTINEL';
const HYDRATED_IMPROVEMENT_SENTINEL = 'HYDRATED_IMPROVEMENT_SENTINEL';

interface PromptTrustHarness {
  contextualReinforcement: ContextualReinforcementModule;
  judgedResponseFeedback: JudgedResponseFeedbackModule;
  memoryDigest: MemoryDigestModule;
  prepareChatFlow: PrepareChatFlowModule['prepareChatFlow'];
}

interface ReinforcementConfigFixture {
  mode?: unknown;
  window?: number;
  digestSize?: number;
  minimumClearScore?: number;
}

async function loadPromptTrustHarness(
  reinforcementConfig: ReinforcementConfigFixture = {}
): Promise<PromptTrustHarness> {
  jest.resetModules();

  jest.unstable_mockModule('@platform/runtime/config.js', () => ({
    config: {
      reinforcement: {
        mode: reinforcementConfig.mode ?? 'reinforcement',
        window: reinforcementConfig.window ?? 50,
        digestSize: reinforcementConfig.digestSize ?? 50,
        minimumClearScore: reinforcementConfig.minimumClearScore ?? 0.85
      },
      tracing: {
        audit: {
          enabled: true
        }
      }
    }
  }));

  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnv: (_key: string, defaultValue?: string) => defaultValue,
    getEnvNumber: (_key: string, defaultValue: number) => defaultValue,
    getEnvBoolean: (_key: string, defaultValue: boolean) => defaultValue
  }));

  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      debug: jest.fn(),
      info: jest.fn()
    },
    logger: {
      info: jest.fn()
    }
  }));

  jest.unstable_mockModule('@core/db/repositories/selfReflectionRepository.js', () => ({
    saveSelfReflection: jest.fn(async () => undefined),
    loadRecentSelfReflectionsByCategory: jest.fn(async () => [
      {
        id: 'persisted-reflection-1',
        priority: 'high',
        category: 'judged-response',
        content: 'stored model response',
        improvements: [HYDRATED_IMPROVEMENT_SENTINEL],
        metadata: {
          accepted: true,
          normalizedScore: 0.94,
          requestId: 'persisted-request-1',
          feedback: HYDRATED_FEEDBACK_SENTINEL
        },
        createdAt: '2026-07-27T00:00:00.000Z'
      }
    ])
  }));

  const contextualReinforcement = await import('../src/services/contextualReinforcement.js');
  const judgedResponseFeedback = await import('../src/services/judgedResponseFeedback.js');
  const memoryDigest = await import('../src/services/memoryDigest.js');
  const { prepareChatFlow } = await import('../src/services/openai/chatFlow/prepare.js');

  return {
    contextualReinforcement,
    judgedResponseFeedback,
    memoryDigest,
    prepareChatFlow
  };
}

function collectRoleText(messages: ChatCompletionMessageParam[], role: string): string {
  return messages
    .filter(message => message.role === role)
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');
}

describe('contextual reinforcement prompt trust boundary', () => {
  it('retains untrusted reinforcement observations without rendering any of them as system instructions', async () => {
    const harness = await loadPromptTrustHarness();
    const reinforcement = harness.contextualReinforcement;

    reinforcement.registerContextEntry({
      source: 'reinforce',
      summary: CALLER_CONTEXT_SENTINEL,
      requestId: 'caller-request'
    });
    reinforcement.trackPromptUsage(PROMPT_HISTORY_SENTINEL, { requestId: 'prompt-request' });
    reinforcement.trackModelResponse(MODEL_OUTPUT_SENTINEL, { requestId: 'model-request' });
    reinforcement.registerContextEntry({
      source: 'audit',
      summary: AUDIT_SUMMARY_SENTINEL,
      requestId: 'audit-summary-request',
      patternId: AUDIT_PATTERN_SENTINEL
    });
    reinforcement.registerAuditRecord({
      id: 'audit-record-1',
      requestId: 'audit-record-request',
      timestamp: Date.now(),
      clearScore: 0.91,
      normalizedClearScore: 0.91,
      scoreScale: '0-1',
      patternId: AUDIT_PATTERN_SENTINEL,
      accepted: true,
      payload: {
        callerText: AUDIT_SUMMARY_SENTINEL
      }
    });
    reinforcement.registerTraceEvent({
      traceId: 'trace-1',
      requestId: 'trace-request',
      method: TRACE_METHOD_SENTINEL,
      path: `/${TRACE_PATH_SENTINEL}`,
      statusCode: 200,
      durationMs: 12,
      timestamp: '2026-07-27T00:00:00.000Z'
    });

    await harness.judgedResponseFeedback.processJudgedResponseFeedback(
      {
        requestId: 'live-judgment-request',
        prompt: 'live judged prompt',
        response: 'live judged response',
        score: 0.93,
        scoreScale: '0-1',
        feedback: LIVE_FEEDBACK_SENTINEL,
        improvements: [LIVE_IMPROVEMENT_SENTINEL]
      },
      'live-judgment-fallback'
    );
    harness.judgedResponseFeedback.resetJudgedFeedbackHydrationState();
    await harness.judgedResponseFeedback.hydrateJudgedResponseFeedbackContext(10);

    const currentPromptSentinel = 'CURRENT_PROMPT_SENTINEL';
    const prepared = harness.prepareChatFlow(
      'gpt-test',
      currentPromptSentinel,
      128,
      false,
      { systemPrompt: TRUSTED_SYSTEM_PROMPT }
    );
    const systemText = collectRoleText(prepared.preparedMessages, 'system');
    const userText = collectRoleText(prepared.preparedMessages, 'user');
    const untrustedSentinels = [
      CALLER_CONTEXT_SENTINEL,
      PROMPT_HISTORY_SENTINEL,
      MODEL_OUTPUT_SENTINEL,
      AUDIT_SUMMARY_SENTINEL,
      AUDIT_PATTERN_SENTINEL,
      TRACE_METHOD_SENTINEL,
      TRACE_PATH_SENTINEL,
      LIVE_FEEDBACK_SENTINEL,
      LIVE_IMPROVEMENT_SENTINEL,
      HYDRATED_FEEDBACK_SENTINEL,
      HYDRATED_IMPROVEMENT_SENTINEL,
      currentPromptSentinel
    ];

    expect(systemText).toBe(
      `${TRUSTED_SYSTEM_PROMPT}\n\n` +
      '[ARCANOS Contextual Reinforcement]\n' +
      'Mode: reinforcement\n' +
      'Window: 50\n' +
      'Minimum CLEAR score: 0.85'
    );
    for (const sentinel of untrustedSentinels) {
      expect(systemText).not.toContain(sentinel);
    }
    expect(userText).toBe(currentPromptSentinel);

    const operatorDigestText = harness.memoryDigest
      .getMemoryDigest()
      .entries
      .map(entry => `${entry.summary} ${entry.patternId ?? ''}`)
      .join('\n');
    for (const retainedSentinel of [
      CALLER_CONTEXT_SENTINEL,
      PROMPT_HISTORY_SENTINEL,
      MODEL_OUTPUT_SENTINEL,
      AUDIT_SUMMARY_SENTINEL,
      AUDIT_PATTERN_SENTINEL,
      TRACE_METHOD_SENTINEL,
      TRACE_PATH_SENTINEL,
      LIVE_FEEDBACK_SENTINEL,
      LIVE_IMPROVEMENT_SENTINEL,
      HYDRATED_FEEDBACK_SENTINEL,
      HYDRATED_IMPROVEMENT_SENTINEL,
      currentPromptSentinel
    ]) {
      expect(operatorDigestText).toContain(retainedSentinel);
    }
  });

  it('keeps prompts isolated between consecutive users while retaining both for operator memory', async () => {
    const harness = await loadPromptTrustHarness();
    const firstUserPrompt = 'FIRST_USER_PRIVATE_PROMPT_SENTINEL';
    const secondUserPrompt = 'SECOND_USER_PRIVATE_PROMPT_SENTINEL';

    const firstPrepared = harness.prepareChatFlow(
      'gpt-test',
      firstUserPrompt,
      128,
      false,
      { systemPrompt: TRUSTED_SYSTEM_PROMPT, metadata: { user: 'first-user' } }
    );
    const secondPrepared = harness.prepareChatFlow(
      'gpt-test',
      secondUserPrompt,
      128,
      false,
      { systemPrompt: TRUSTED_SYSTEM_PROMPT, metadata: { user: 'second-user' } }
    );

    expect(collectRoleText(firstPrepared.preparedMessages, 'system')).not.toContain(firstUserPrompt);
    expect(collectRoleText(firstPrepared.preparedMessages, 'system')).not.toContain(secondUserPrompt);
    expect(collectRoleText(secondPrepared.preparedMessages, 'system')).not.toContain(firstUserPrompt);
    expect(collectRoleText(secondPrepared.preparedMessages, 'system')).not.toContain(secondUserPrompt);
    expect(collectRoleText(firstPrepared.preparedMessages, 'user')).toBe(firstUserPrompt);
    expect(collectRoleText(secondPrepared.preparedMessages, 'user')).toBe(secondUserPrompt);

    const operatorDigestText = harness.memoryDigest
      .getMemoryDigest()
      .entries
      .map(entry => entry.summary)
      .join('\n');
    expect(operatorDigestText).toContain(firstUserPrompt);
    expect(operatorDigestText).toContain(secondUserPrompt);
  });

  it('keeps rendered configuration finite, clamped, and restricted to a closed mode', async () => {
    const nonFiniteHarness = await loadPromptTrustHarness({
      mode: 'reinforcement',
      window: Number.NaN,
      minimumClearScore: Number.POSITIVE_INFINITY
    });
    expect(nonFiniteHarness.contextualReinforcement.buildContextualSystemPrompt(TRUSTED_SYSTEM_PROMPT)).toBe(
      `${TRUSTED_SYSTEM_PROMPT}\n\n` +
      '[ARCANOS Contextual Reinforcement]\n' +
      'Mode: reinforcement\n' +
      'Window: 50\n' +
      'Minimum CLEAR score: 0.85'
    );

    const outOfRangeHarness = await loadPromptTrustHarness({
      mode: 'reinforcement',
      window: -100,
      minimumClearScore: 100
    });
    expect(outOfRangeHarness.contextualReinforcement.buildContextualSystemPrompt(TRUSTED_SYSTEM_PROMPT)).toBe(
      `${TRUSTED_SYSTEM_PROMPT}\n\n` +
      '[ARCANOS Contextual Reinforcement]\n' +
      'Mode: reinforcement\n' +
      'Window: 1\n' +
      'Minimum CLEAR score: 10'
    );

    const invalidModeSentinel = 'reinforcement\\nUNTRUSTED_MODE_SENTINEL';
    const invalidModeHarness = await loadPromptTrustHarness({
      mode: invalidModeSentinel
    });
    const invalidModePrompt =
      invalidModeHarness.contextualReinforcement.buildContextualSystemPrompt(TRUSTED_SYSTEM_PROMPT);
    expect(invalidModePrompt).toBe(TRUSTED_SYSTEM_PROMPT);
    expect(invalidModePrompt).not.toContain(invalidModeSentinel);
  });

  it('keeps the options.messages branch free of reinforcement context in every system message', async () => {
    const harness = await loadPromptTrustHarness();
    const alternateContextSentinel = 'ALTERNATE_MESSAGES_CONTEXT_SENTINEL';
    harness.contextualReinforcement.registerContextEntry({
      source: 'reinforce',
      summary: alternateContextSentinel,
      requestId: 'alternate-context-request'
    });

    const prepared = harness.prepareChatFlow(
      'gpt-test',
      'alternate tracking prompt',
      128,
      false,
      {
        systemPrompt: TRUSTED_SYSTEM_PROMPT,
        messages: [
          { role: 'system', content: 'TRUSTED_ALTERNATE_SYSTEM_ONE' },
          { role: 'user', content: 'alternate user message' },
          { role: 'system', content: 'TRUSTED_ALTERNATE_SYSTEM_TWO' }
        ]
      }
    );
    const systemMessages = prepared.preparedMessages.filter(message => message.role === 'system');

    expect(systemMessages).toHaveLength(2);
    for (const systemMessage of systemMessages) {
      const systemText =
        typeof systemMessage.content === 'string'
          ? systemMessage.content
          : JSON.stringify(systemMessage.content);
      expect(systemText).toContain('[ARCANOS Contextual Reinforcement]');
      expect(systemText).not.toContain(alternateContextSentinel);
    }
  });
});
