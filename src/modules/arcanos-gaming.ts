import { runGaming } from '../services/gaming.js';

export const ArcanosGaming = {
  name: 'ARCANOS:GAMING',
  description: 'Nintendo-style hotline advisor for game strategies, hints, and walkthroughs.',
  gptIds: ['arcanos-gaming', 'gaming'],
  actions: {
    async query(payload: any) {
      const prompt = payload?.prompt || payload;
      const urls = payload?.urls || payload?.guideUrls;
      return runGaming(prompt, payload?.url, Array.isArray(urls) ? urls : []);
    },
  },
};

export default ArcanosGaming;
