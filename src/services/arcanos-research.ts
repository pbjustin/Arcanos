import type { ModuleDef } from './moduleLoader.js';
import { requestResearchViaHub } from './researchHub.js';

interface ArcanosResearchPayload {
  topic?: string;
  prompt?: string;
  message?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
  urls?: unknown;
  metadata?: unknown;
}

const ArcanosResearch: ModuleDef = {
  name: 'ARCANOS:RESEARCH',
  description: 'Research orchestration module backed by the shared research bridge.',
  gptIds: ['arcanos-research', 'research'],
  defaultTimeoutMs: 60000,
  actions: {
    async run(payload: unknown) {
      const normalizedPayload = normalizeResearchPayload(payload);
      const topic = extractResearchTopic(normalizedPayload);

      if (!topic) {
        throw new Error('ARCANOS:RESEARCH run requires a topic or prompt.');
      }

      return requestResearchViaHub('ARCANOS:RESEARCH', {
        topic,
        urls: normalizeResearchUrls(normalizedPayload.urls),
        metadata: normalizeResearchMetadata(normalizedPayload.metadata)
      });
    }
  }
};

export default ArcanosResearch;

function normalizeResearchPayload(payload: unknown): ArcanosResearchPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return typeof payload === 'string' ? { topic: payload } : {};
  }

  return payload as ArcanosResearchPayload;
}

function extractResearchTopic(payload: ArcanosResearchPayload): string {
  for (const candidate of [
    payload.topic,
    payload.prompt,
    payload.message,
    payload.userInput,
    payload.content,
    payload.text,
    payload.query
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return '';
}

function normalizeResearchUrls(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const urls = value.filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  ).map((candidate) => candidate.trim());

  return urls.length > 0 ? urls : undefined;
}

function normalizeResearchMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
