import { runGaming } from '../services/gaming.js';
import { extractTextPrompt, normalizeStringList } from '../utils/payloadNormalization.js';

export const ArcanosGaming = {
  name: 'ARCANOS:GAMING',
  description: 'Nintendo-style hotline advisor for game strategies, hints, and walkthroughs.',
  gptIds: ['arcanos-gaming', 'gaming'],
  actions: {
    async query(payload: any) {
      const prompt = extractTextPrompt(payload);

      if (!prompt) {
        throw new Error('ARCANOS:GAMING query requires a text prompt.');
      }

      const guideUrl = typeof payload?.url === 'string' && payload.url.trim() ? payload.url.trim() : undefined;

      const normalizedGuides = normalizeStringList(payload?.urls, payload?.guideUrls);

      return runGaming(prompt, guideUrl, normalizedGuides);
    },
  },
};

export default ArcanosGaming;
