import { researchTopic, ResearchResult } from '../services/research.js';

export { researchTopic };

export const ArcanosResearch = {
  name: 'ARCANOS:RESEARCH',
  description:
    'Multi-source research module that fetches URLs, summarizes them with the fine-tuned ARCANOS model, and stores reusable briefs.',
  gptIds: ['arcanos-research', 'research'],
  actions: {
    async query(payload: { topic?: string; urls?: string[] }): Promise<ResearchResult> {
      const topic = payload?.topic?.trim();
      const urls = Array.isArray(payload?.urls) ? payload.urls : [];
      if (!topic) {
        throw new Error('Research queries require a topic');
      }
      if (payload?.urls && !Array.isArray(payload.urls)) {
        throw new Error('URLs must be provided as an array');
      }
      return researchTopic(topic, urls);
    }
  }
};

export default ArcanosResearch;
