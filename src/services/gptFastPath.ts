import { getRequestAbortSignal, runWithRequestAbortTimeout } from '@arcanos/runtime';

import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import type { TrinityResult } from '@core/logic/trinity.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { recordAiOperation } from '@platform/observability/appMetrics.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { type GptFastPathDecision } from '@shared/gpt/gptFastPath.js';

export interface ExecuteFastGptPromptInput {
  gptId: string;
  prompt: string;
  requestId?: string;
  timeoutMs: number;
  routeDecision: GptFastPathDecision;
  parentSignal?: AbortSignal;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export interface FastGptPromptEnvelope {
  ok: true;
  result: Record<string, unknown>;
  routeDecision: {
    path: 'fast_path';
    reason: string;
    queueBypassed: true;
    promptLength: number;
    messageCount: number;
    maxWords: number | null;
    timeoutMs: number;
  };
  _route: {
    requestId?: string;
    gptId: string;
    module: 'GPT:FAST_PATH';
    action: 'query';
    route: 'fast_path';
    timestamp: string;
  };
}

export interface ExecuteDirectGptActionInput {
  gptId: string;
  prompt: string;
  requestId?: string;
  action: 'query_and_wait';
  timeoutMs: number;
  parentSignal?: AbortSignal;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export interface DirectGptActionEnvelope {
  ok: true;
  result: Record<string, unknown>;
  directAction: {
    inline: true;
    queueBypassed: true;
    orchestrationBypassed: false;
    action: 'query_and_wait';
    timeoutMs: number;
    modelLatencyMs: number;
    totalLatencyMs: number;
  };
  _route: {
    requestId?: string;
    gptId: string;
    module: 'GPT:DIRECT_ACTION';
    action: 'query_and_wait';
    route: 'direct_action';
    timestamp: string;
  };
}

function normalizeUsage(result: TrinityResult): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} {
  const tokens = result.meta.tokens;
  if (!tokens) {
    return {};
  }

  return {
    promptTokens: tokens.prompt_tokens,
    completionTokens: tokens.completion_tokens,
    totalTokens: tokens.total_tokens
  };
}

function decorateFastPathResult(
  result: TrinityResult,
  input: ExecuteFastGptPromptInput,
  totalLatencyMs: number
): Record<string, unknown> {
  return {
    ...result,
    fastPath: {
      inline: true,
      queueBypassed: true,
      trinityRequired: true,
      orchestrationBypassed: false,
      totalLatencyMs,
      timeoutMs: input.timeoutMs
    }
  };
}

function decorateDirectActionResult(
  result: TrinityResult,
  input: ExecuteDirectGptActionInput,
  totalLatencyMs: number
): Record<string, unknown> {
  return {
    ...result,
    directAction: {
      inline: true,
      queueBypassed: true,
      trinityRequired: true,
      orchestrationBypassed: false,
      action: input.action,
      modelLatencyMs: totalLatencyMs,
      totalLatencyMs,
      timeoutMs: input.timeoutMs
    }
  };
}

/**
 * Execute one simple GPT prompt-generation request through the Trinity facade.
 * This keeps the low-latency HTTP lane, but Trinity remains mandatory for generation.
 */
export async function executeFastGptPrompt(
  input: ExecuteFastGptPromptInput
): Promise<FastGptPromptEnvelope> {
  const startedAtMs = Date.now();
  const { client } = getOpenAIClientOrAdapter();

  if (!client) {
    input.logger?.warn?.('gpt.fast_path.client_unavailable', {
      gptId: input.gptId,
      requestId: input.requestId,
      reason: 'openai_client_unavailable'
    });
    throw new Error('OpenAI client unavailable for GPT fast path.');
  }

  try {
    const trinityResult = await runWithRequestAbortTimeout(
      {
        timeoutMs: input.timeoutMs,
        requestId: input.requestId,
        parentSignal: input.parentSignal ?? getRequestAbortSignal(),
        abortMessage: `GPT fast path Trinity timeout after ${input.timeoutMs}ms`
      },
      () => runTrinityWritingPipeline({
        input: {
          prompt: input.prompt,
          gptId: input.gptId,
          moduleId: 'GPT:FAST_PATH',
          sourceEndpoint: 'gpt.fast_path',
          requestedAction: 'query',
          body: {
            prompt: input.prompt,
            gptId: input.gptId,
            action: 'query',
            executionMode: 'fast'
          },
          outputLimit: input.routeDecision.maxWords ?? undefined,
          executionMode: 'request'
        },
        context: {
          client,
          requestId: input.requestId,
          runtimeBudget: createRuntimeBudget(),
          runOptions: {
            requestedVerbosity: 'minimal',
            answerMode: 'direct',
            ...(input.routeDecision.maxWords
              ? { maxWords: input.routeDecision.maxWords }
              : {}),
            strictUserVisibleOutput: true,
            watchdogModelTimeoutMs: input.timeoutMs
          }
        }
      })
    );

    const totalLatencyMs = Date.now() - startedAtMs;
    recordAiOperation({
      provider: 'openai',
      operation: 'trinity.pipeline',
      sourceType: 'gpt_fast_path',
      sourceName: input.gptId,
      model: trinityResult.activeModel,
      outcome: 'ok',
      durationMs: totalLatencyMs,
      ...normalizeUsage(trinityResult)
    });

    return {
      ok: true,
      result: decorateFastPathResult(trinityResult, input, totalLatencyMs),
      routeDecision: {
        path: 'fast_path',
        reason: input.routeDecision.reason,
        queueBypassed: true,
        promptLength: input.routeDecision.promptLength,
        messageCount: input.routeDecision.messageCount,
        maxWords: input.routeDecision.maxWords,
        timeoutMs: input.timeoutMs
      },
      _route: {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        gptId: input.gptId,
        module: 'GPT:FAST_PATH',
        action: 'query',
        route: 'fast_path',
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    recordAiOperation({
      provider: 'openai',
      operation: 'trinity.pipeline',
      sourceType: 'gpt_fast_path',
      sourceName: input.gptId,
      outcome: 'error',
      durationMs: Date.now() - startedAtMs
    });
    input.logger?.warn?.('gpt.fast_path.error', {
      gptId: input.gptId,
      requestId: input.requestId,
      durationMs: Date.now() - startedAtMs,
      timeoutMs: input.timeoutMs,
      error: resolveErrorMessage(error)
    });
    throw error;
  }
}

/**
 * Execute a GPT Action query_and_wait request through Trinity without queueing.
 */
export async function executeDirectGptAction(
  input: ExecuteDirectGptActionInput
): Promise<DirectGptActionEnvelope> {
  const startedAtMs = Date.now();
  const { client } = getOpenAIClientOrAdapter();

  if (!client) {
    input.logger?.warn?.('gpt.direct_action.client_unavailable', {
      gptId: input.gptId,
      requestId: input.requestId,
      action: input.action,
      reason: 'openai_client_unavailable'
    });
    throw new Error('OpenAI client unavailable for GPT direct action.');
  }

  try {
    const trinityResult = await runWithRequestAbortTimeout(
      {
        timeoutMs: input.timeoutMs,
        requestId: input.requestId,
        parentSignal: input.parentSignal ?? getRequestAbortSignal(),
        abortMessage: `GPT direct action Trinity timeout after ${input.timeoutMs}ms`
      },
      () => runTrinityWritingPipeline({
        input: {
          prompt: input.prompt,
          gptId: input.gptId,
          moduleId: 'GPT:DIRECT_ACTION',
          sourceEndpoint: 'gpt.direct_action',
          requestedAction: input.action,
          body: {
            prompt: input.prompt,
            gptId: input.gptId,
            action: input.action
          },
          executionMode: 'request'
        },
        context: {
          client,
          requestId: input.requestId,
          runtimeBudget: createRuntimeBudget(),
          runOptions: {
            requestedVerbosity: 'minimal',
            answerMode: 'direct',
            strictUserVisibleOutput: true,
            watchdogModelTimeoutMs: input.timeoutMs
          }
        }
      })
    );

    const totalLatencyMs = Date.now() - startedAtMs;
    recordAiOperation({
      provider: 'openai',
      operation: 'trinity.pipeline',
      sourceType: 'gpt_direct_action',
      sourceName: input.gptId,
      model: trinityResult.activeModel,
      outcome: 'ok',
      durationMs: totalLatencyMs,
      ...normalizeUsage(trinityResult)
    });

    return {
      ok: true,
      result: decorateDirectActionResult(trinityResult, input, totalLatencyMs),
      directAction: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: false,
        action: input.action,
        timeoutMs: input.timeoutMs,
        modelLatencyMs: totalLatencyMs,
        totalLatencyMs
      },
      _route: {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        gptId: input.gptId,
        module: 'GPT:DIRECT_ACTION',
        action: input.action,
        route: 'direct_action',
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    recordAiOperation({
      provider: 'openai',
      operation: 'trinity.pipeline',
      sourceType: 'gpt_direct_action',
      sourceName: input.gptId,
      outcome: 'error',
      durationMs: Date.now() - startedAtMs
    });
    input.logger?.error?.('gpt.direct_action.failed', {
      gptId: input.gptId,
      requestId: input.requestId,
      action: input.action,
      timeoutMs: input.timeoutMs,
      error: resolveErrorMessage(error)
    });
    throw error;
  }
}
