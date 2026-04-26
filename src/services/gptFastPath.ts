import { callTextResponse } from '@arcanos/openai/responses';
import { getRequestAbortSignal, runWithRequestAbortTimeout } from '@arcanos/runtime';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { recordAiOperation } from '@platform/observability/appMetrics.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import {
  resolveGptFastPathModel,
  type GptFastPathDecision
} from '@shared/gpt/gptFastPath.js';

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
    orchestrationBypassed: true;
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

const FAST_PATH_ROUTING_STAGE = 'GPT-FAST-PATH';
const FAST_PATH_SYSTEM_INSTRUCTIONS = [
  'You are ARCANOS fast-path prompt generation.',
  'Generate the requested prompt directly and concisely.',
  'Do not describe internal routing, queues, tools, memory, audits, or orchestration.',
  'Return only the user-facing prompt or prompt text requested by the caller.'
].join(' ');
const DIRECT_ACTION_ROUTING_STAGE = 'GPT-DIRECT-ACTION';
const DIRECT_ACTION_SYSTEM_INSTRUCTIONS = [
  'You are ARCANOS direct GPT Action execution.',
  'Answer the caller request directly and concretely.',
  'Do not describe internal routing, queues, tools, memory, audits, or orchestration.',
  'Return only the final user-facing result.'
].join(' ');

function readUsageNumber(usage: unknown, key: string): number {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return 0;
  }

  const value = (usage as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function normalizeUsage(usage: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens =
    readUsageNumber(usage, 'input_tokens') ||
    readUsageNumber(usage, 'prompt_tokens');
  const completionTokens =
    readUsageNumber(usage, 'output_tokens') ||
    readUsageNumber(usage, 'completion_tokens');
  const totalTokens =
    readUsageNumber(usage, 'total_tokens') ||
    promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens
  };
}

function buildFastPathResult(input: {
  prompt: string;
  outputText: string;
  model: string;
  requestId?: string;
  responseId?: string | null;
  createdAtMs: number;
  modelLatencyMs: number;
  totalLatencyMs: number;
  timeoutMs: number;
  usage: unknown;
}): Record<string, unknown> {
  const usage = normalizeUsage(input.usage);
  const requestId =
    input.requestId?.trim() ||
    input.responseId?.trim() ||
    `gpt-fast-path-${input.createdAtMs}`;

  return {
    result: input.outputText,
    module: 'fast_path',
    meta: {
      id: requestId,
      created: input.createdAtMs,
      tokens: usage
    },
    activeModel: input.model,
    fallbackFlag: false,
    gpt5Used: false,
    routingStages: [FAST_PATH_ROUTING_STAGE],
    auditSafe: {
      mode: false,
      overrideUsed: false,
      auditFlags: ['FAST_PATH_MINIMAL_PIPELINE'],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: 'Bypassed for GPT fast path.',
      memoryEnhanced: false
    },
    taskLineage: {
      requestId,
      logged: false
    },
    fastPath: {
      inline: true,
      queueBypassed: true,
      orchestrationBypassed: true,
      modelLatencyMs: input.modelLatencyMs,
      totalLatencyMs: input.totalLatencyMs,
      timeoutMs: input.timeoutMs,
      bypassedSubsystems: [
        'queue',
        'worker_orchestration',
        'dag_planning',
        'memory_overlay',
        'research_overlay',
        'audit_overlay'
      ]
    }
  };
}

function buildDirectActionResult(input: {
  outputText: string;
  model: string;
  requestId?: string;
  responseId?: string | null;
  createdAtMs: number;
  modelLatencyMs: number;
  totalLatencyMs: number;
  timeoutMs: number;
  usage: unknown;
}): Record<string, unknown> {
  const usage = normalizeUsage(input.usage);
  const requestId =
    input.requestId?.trim() ||
    input.responseId?.trim() ||
    `gpt-direct-action-${input.createdAtMs}`;

  return {
    result: input.outputText,
    module: 'direct_action',
    meta: {
      id: requestId,
      created: input.createdAtMs,
      tokens: usage
    },
    activeModel: input.model,
    fallbackFlag: false,
    routingStages: [DIRECT_ACTION_ROUTING_STAGE],
    auditSafe: {
      mode: false,
      overrideUsed: false,
      auditFlags: ['DIRECT_ACTION_MINIMAL_PIPELINE'],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: 'Bypassed for GPT direct action.',
      memoryEnhanced: false
    },
    taskLineage: {
      requestId,
      logged: false
    },
    directAction: {
      inline: true,
      queueBypassed: true,
      orchestrationBypassed: true,
      modelLatencyMs: input.modelLatencyMs,
      totalLatencyMs: input.totalLatencyMs,
      timeoutMs: input.timeoutMs,
      bypassedSubsystems: [
        'queue',
        'worker_orchestration',
        'dag_planning',
        'trinity_intake',
        'trinity_reasoning',
        'trinity_clear_audit',
        'trinity_reflection',
        'trinity_final',
        'memory_overlay',
        'research_overlay',
        'audit_overlay'
      ]
    }
  };
}

/**
 * Execute one simple GPT prompt-generation request through the minimal inline path.
 * This path intentionally uses the shared OpenAI client but skips queue creation, worker
 * orchestration, DAG planning, memory overlays, research overlays, and audit overlays.
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

  const model = resolveGptFastPathModel();
  const parentSignal = input.parentSignal ?? getRequestAbortSignal();
  let modelLatencyMs = 0;

  try {
    const { response, outputText } = await runWithRequestAbortTimeout(
      {
        timeoutMs: input.timeoutMs,
        requestId: input.requestId,
        parentSignal,
        abortMessage: `GPT fast path timeout after ${input.timeoutMs}ms`
      },
      async () => {
        const modelStartedAtMs = Date.now();
        const activeSignal = getRequestAbortSignal() ?? parentSignal;
        const result = await callTextResponse(
          client,
          {
            model,
            instructions: FAST_PATH_SYSTEM_INSTRUCTIONS,
            input: input.prompt,
            store: false
          },
          { signal: activeSignal }
        );
        modelLatencyMs = Date.now() - modelStartedAtMs;
        return result;
      }
    );
    const normalizedOutputText = outputText.trim();
    if (!normalizedOutputText) {
      throw new Error('GPT fast path returned empty output.');
    }

    const totalLatencyMs = Date.now() - startedAtMs;
    recordAiOperation({
      provider: 'openai',
      operation: 'responses.create',
      sourceType: 'gpt_fast_path',
      sourceName: input.gptId,
      model,
      outcome: 'ok',
      durationMs: modelLatencyMs,
      promptTokens: normalizeUsage(response.usage).prompt_tokens,
      completionTokens: normalizeUsage(response.usage).completion_tokens,
      totalTokens: normalizeUsage(response.usage).total_tokens
    });

    return {
      ok: true,
      result: buildFastPathResult({
        prompt: input.prompt,
        outputText: normalizedOutputText,
        model,
        requestId: input.requestId,
        responseId: typeof response.id === 'string' ? response.id : null,
        createdAtMs: Date.now(),
        modelLatencyMs,
        totalLatencyMs,
        timeoutMs: input.timeoutMs,
        usage: response.usage
      }),
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
      operation: 'responses.create',
      sourceType: 'gpt_fast_path',
      sourceName: input.gptId,
      model,
      outcome: 'error',
      durationMs: modelLatencyMs
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
 * Execute a GPT Action query_and_wait request through the minimal synchronous lane.
 * This path intentionally returns provider failures and timeout failures as errors
 * instead of routing through Trinity's degraded/static fallback machinery.
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

  const model = resolveGptFastPathModel();
  const parentSignal = input.parentSignal ?? getRequestAbortSignal();
  let modelLatencyMs = 0;

  try {
    const { response, outputText } = await runWithRequestAbortTimeout(
      {
        timeoutMs: input.timeoutMs,
        requestId: input.requestId,
        parentSignal,
        abortMessage: `GPT direct action timeout after ${input.timeoutMs}ms`
      },
      async () => {
        const modelStartedAtMs = Date.now();
        const activeSignal = getRequestAbortSignal() ?? parentSignal;
        const result = await callTextResponse(
          client,
          {
            model,
            instructions: DIRECT_ACTION_SYSTEM_INSTRUCTIONS,
            input: input.prompt,
            store: false
          },
          { signal: activeSignal }
        );
        modelLatencyMs = Date.now() - modelStartedAtMs;
        return result;
      }
    );
    const normalizedOutputText = outputText.trim();
    if (!normalizedOutputText) {
      throw new Error('GPT direct action returned empty output.');
    }

    const totalLatencyMs = Date.now() - startedAtMs;
    recordAiOperation({
      provider: 'openai',
      operation: 'responses.create',
      sourceType: 'gpt_direct_action',
      sourceName: input.gptId,
      model,
      outcome: 'ok',
      durationMs: modelLatencyMs,
      promptTokens: normalizeUsage(response.usage).prompt_tokens,
      completionTokens: normalizeUsage(response.usage).completion_tokens,
      totalTokens: normalizeUsage(response.usage).total_tokens
    });

    return {
      ok: true,
      result: buildDirectActionResult({
        outputText: normalizedOutputText,
        model,
        requestId: input.requestId,
        responseId: typeof response.id === 'string' ? response.id : null,
        createdAtMs: Date.now(),
        modelLatencyMs,
        totalLatencyMs,
        timeoutMs: input.timeoutMs,
        usage: response.usage
      }),
      directAction: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: true,
        action: input.action,
        timeoutMs: input.timeoutMs,
        modelLatencyMs,
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
      operation: 'responses.create',
      sourceType: 'gpt_direct_action',
      sourceName: input.gptId,
      model,
      outcome: 'error',
      durationMs: modelLatencyMs
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
