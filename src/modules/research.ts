import { ResearchResult } from '../services/research.js';
import { connectResearchBridge, ResearchHubRequest } from '../services/researchHub.js';

export { researchTopic } from '../services/research.js';
export { connectResearchBridge, observeResearchEvents } from '../services/researchHub.js';

const bridge = connectResearchBridge('ARCANOS:RESEARCH');

function normalizePayload(payload: { topic?: string; urls?: string[]; metadata?: Record<string, unknown> }) {
  const topic = payload?.topic?.trim();
  if (!topic) {
    throw new Error('Research queries require a topic');
  }

  const urls = Array.isArray(payload?.urls)
    ? payload.urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    : [];
  if (payload?.urls && !Array.isArray(payload.urls)) {
    throw new Error('URLs must be provided as an array');
  }

  const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;

  const normalized: ResearchHubRequest = { topic, urls, metadata };
  return normalized;
}

export const ArcanosResearch = {
  name: 'ARCANOS:RESEARCH',
  description:
    'Multi-source research module that fetches URLs, summarizes them with the fine-tuned ARCANOS model, and stores reusable briefs.',
  gptIds: ['arcanos-research', 'research'],
  actions: {
    async query(payload: { topic?: string; urls?: string[]; metadata?: Record<string, unknown> }): Promise<ResearchResult> {
      const normalized = normalizePayload(payload);
      return bridge.requestResearch(normalized);
    }
  }
};

export default ArcanosResearch;
