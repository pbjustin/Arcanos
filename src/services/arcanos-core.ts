import { runThroughBrain } from '@core/logic/trinity.js';
import type { TrinityAnswerMode } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { generateMockResponse } from '@services/openai.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import type { ModuleDef } from './moduleLoader.js';

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

export const ArcanosCore: ModuleDef = {
  name: 'ARCANOS:CORE',
  description: 'Primary ARCANOS core assistant routed through the Trinity execution pipeline.',
  gptIds: ['arcanos-core', 'core'],
  defaultAction: 'query',
  defaultTimeoutMs: 60_000,
  actions: {
    async query(payload: unknown) {
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
        return generateMockResponse(prompt, 'gpt/arcanos-core');
      }

      return runThroughBrain(
        client,
        prompt,
        sessionId,
        overrideAuditSafe,
        {
          sourceEndpoint: 'gpt.arcanos-core.query',
          ...(answerMode ? { answerMode } : {}),
          ...(maxWords ? { maxWords } : {})
        },
        createRuntimeBudget()
      );
    }
  }
};

export default ArcanosCore;
