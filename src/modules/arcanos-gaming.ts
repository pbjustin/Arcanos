import { runGaming } from '../services/gaming.js';

export const ArcanosGaming = {
  name: 'ARCANOS:GAMING',
  description: 'Nintendo-style hotline advisor for game strategies, hints, and walkthroughs.',
  gptIds: ['arcanos-gaming', 'gaming'],
  actions: {
    async query(payload: any) {
      return runGaming(payload?.prompt || payload, payload?.url);
    },
  },
};

export default ArcanosGaming;
