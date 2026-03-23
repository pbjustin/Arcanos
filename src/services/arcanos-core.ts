import { runThroughBrain } from '@core/logic/trinity.js';
import type { TrinityAnswerMode } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { generateMockResponse } from '@services/openai.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import type { ModuleDef } from './moduleLoader.js';
import { executeSystemStateRequest } from './systemState.js';
import { getRequestAbortSignal, getRequestRemainingMs, runWithRequestAbortTimeout } from '@arcanos/runtime';

type ArcanosCoreQueryPayload = {
  prompt?: string;
  message?: string;
  query?: string;
  text?: string;
  content?: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  answerMode?: string;
  max_words?: number;
  maxWords?: number;
};

function extractPrompt(payload: ArcanosCoreQueryPayload): string {
  for (const candidate of [
    payload.prompt,
    payload.message,
    payload.query,
    payload.text,
    payload.content
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  throw new Error('Prompt is required');
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeAnswerMode(value: unknown): TrinityAnswerMode | undefined {
  if (value !== 'direct' && value !== 'explained' && value !== 'audit' && value !== 'debug') {
    return undefined;
  }

  return value;
}

function resolveCoreHandlerTimeoutMs(): number {
  const configuredTimeoutMs = Number.parseInt(process.env.ARCANOS_CORE_HANDLER_TIMEOUT_MS ?? '', 10);
  const normalizedConfiguredTimeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.trunc(configuredTimeoutMs)
      : Number.MAX_SAFE_INTEGER;
  const remainingRequestMs = getRequestRemainingMs();

  if (remainingRequestMs === null) {
    return normalizedConfiguredTimeoutMs === Number.MAX_SAFE_INTEGER ? 60_000 : normalizedConfiguredTimeoutMs;
  }

  return normalizedConfiguredTimeoutMs === Number.MAX_SAFE_INTEGER
    ? remainingRequestMs
    : Math.max(1, Math.min(normalizedConfiguredTimeoutMs, remainingRequestMs));
}

export const ArcanosCore: ModuleDef = {
  name: 'ARCANOS:CORE',
  description: 'Primary ARCANOS core assistant routed through the Trinity execution pipeline.',
  gptIds: ['arcanos-core', 'core', 'arcanos-daemon'],
  defaultAction: 'query',
  defaultTimeoutMs: 60_000,
  actions: {
    async query(payload: unknown) {
      const startedAt = Date.now();
      const normalizedPayload =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as ArcanosCoreQueryPayload)
          : {};
      const prompt = extractPrompt(normalizedPayload);
      const sessionId =
        typeof normalizedPayload.sessionId === 'string' && normalizedPayload.sessionId.trim().length > 0
          ? normalizedPayload.sessionId.trim()
          : undefined;
      const overrideAuditSafe =
        typeof normalizedPayload.overrideAuditSafe === 'string' && normalizedPayload.overrideAuditSafe.trim().length > 0
          ? normalizedPayload.overrideAuditSafe.trim()
          : undefined;
      const answerMode = normalizeAnswerMode(
        typeof normalizedPayload.answerMode === 'string' ? normalizedPayload.answerMode.trim() : undefined
      );
      const maxWords =
        normalizePositiveInteger(normalizedPayload.maxWords) ??
        normalizePositiveInteger(normalizedPayload.max_words);
      const { client } = getOpenAIClientOrAdapter();

      if (!client) {
        logger.info('[core] handler.mock_response', {
          module: 'ARCANOS:CORE',
          durationMs: Date.now() - startedAt
        });
        return generateMockResponse(prompt, 'gpt/arcanos-core');
      }

      const handlerTimeoutMs = resolveCoreHandlerTimeoutMs();
      const runtimeBudget = createRuntimeBudget();
      logger.info('[core] handler.start', {
        module: 'ARCANOS:CORE',
        sourceEndpoint: 'gpt.arcanos-core.query',
        promptLength: prompt.length,
        sessionId,
        timeoutMs: handlerTimeoutMs
      });

      try {
        logger.info('[core] before trinity.query', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: 'gpt.arcanos-core.query'
        });
        const result = await runWithRequestAbortTimeout(
          {
            timeoutMs: handlerTimeoutMs,
            parentSignal: getRequestAbortSignal(),
            abortMessage: `ARCANOS:CORE handler timed out after ${handlerTimeoutMs}ms`
          },
          () =>
            runThroughBrain(
              client,
              prompt,
              sessionId,
              overrideAuditSafe,
              {
                sourceEndpoint: 'gpt.arcanos-core.query',
                ...(answerMode ? { answerMode } : {}),
                ...(maxWords ? { maxWords } : {})
              },
              runtimeBudget
            )
        );
        logger.info('[core] after trinity.query', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: 'gpt.arcanos-core.query',
          durationMs: Date.now() - startedAt
        });
        logger.info('[core] returning result', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: 'gpt.arcanos-core.query',
          durationMs: Date.now() - startedAt
        });
        return result;
      } catch (error) {
        logger.error('[core] handler.error', {
          module: 'ARCANOS:CORE',
          sourceEndpoint: 'gpt.arcanos-core.query',
          durationMs: Date.now() - startedAt,
          error: String((error as Error)?.message ?? error)
        });
        throw error;
      }
    },
    async system_state(payload: unknown) {
      return executeSystemStateRequest(payload);
    }
  }
};

export default ArcanosCore;
