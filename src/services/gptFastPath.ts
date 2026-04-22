import { callTextResponse } from '@arcanos/openai/responses';
import { getRequestAbortSignal, runWithRequestAbortTimeout } from '@arcanos/runtime';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { recordAiOperation } from '@platform/observability/appMetrics.js';
import { getDefaultModel } from '@services/openai/credentialProvider.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { generateMockResponse } from '@services/openai.js';
import type { GptFastPathDecision } from '@shared/gpt/gptFastPath.js';

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

const FAST_PATH_ROUTING_STAGE = 'GPT-FAST-PATH';
const FAST_PATH_SYSTEM_INSTRUCTIONS = [
  'You are ARCANOS fast-path prompt generation.',
  'Generate the requested prompt directly and concisely.',
  'Do not describe internal routing, queues, tools, memory, audits, or orchestration.',
  'Return only the user-facing prompt or prompt text requested by the caller.'
].join(' ');

const DEFAULT_FAST_PATH_TIMEOUT_MS = 8_000;
const MIN_FAST_PATH_TIMEOUT_MS = 500;
const MAX_FAST_PATH_TIMEOUT_MS = 20_000;

function readPositiveIntegerEnv(name: string, fallbackValue: number): number {
  const parsedValue = Number(process.env[name]);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.trunc(parsedValue)
    : fallbackValue;
}

export function resolveGptFastPathTimeoutMs(): number {
  const configuredTimeoutMs = readPositiveIntegerEnv(
    'GPT_FAST_PATH_TIMEOUT_MS',
    DEFAULT_FAST_PATH_TIMEOUT_MS
  );

  return Math.max(
    MIN_FAST_PATH_TIMEOUT_MS,
    Math.min(MAX_FAST_PATH_TIMEOUT_MS, configuredTimeoutMs)
  );
}

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

function buildMockFastPathEnvelope(input: ExecuteFastGptPromptInput, startedAtMs: number): FastGptPromptEnvelope {
  const createdAtMs = Date.now();
  const mockResult = generateMockResponse(input.prompt, 'gpt-fast-path') as unknown as Record<string, unknown>;
  return {
    ok: true,
    result: {
      ...mockResult,
      fastPath: {
        inline: true,
        queueBypassed: true,
        orchestrationBypassed: true,
        modelLatencyMs: 0,
        totalLatencyMs: createdAtMs - startedAtMs,
        timeoutMs: input.timeoutMs,
        mockResponse: true,
        bypassedSubsystems: [
          'queue',
          'worker_orchestration',
          'dag_planning',
          'memory_overlay',
          'research_overlay',
          'audit_overlay'
        ]
      }
    },
    routeDecision: {
      path: 'fast_path',
      reason: input.routeDecision.reason,
      queueBypassed: true,
      promptLength: input.routeDecision.promptLength,
      messageCount: input.routeDecision.messageCount,
      maxWords: input.routeDecision.maxWords
    },
    _route: {
      ...(input.requestId ? { requestId: input.requestId } : {}),
      gptId: input.gptId,
      module: 'GPT:FAST_PATH',
      action: 'query',
      route: 'fast_path',
      timestamp: new Date(createdAtMs).toISOString()
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
    input.logger?.warn?.('gpt.fast_path.mock_response', {
      gptId: input.gptId,
      requestId: input.requestId,
      reason: 'openai_client_unavailable'
    });
    return buildMockFastPathEnvelope(input, startedAtMs);
  }

  const model = getDefaultModel();
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
        maxWords: input.routeDecision.maxWords
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
