import { runGaming } from '../services/gaming.js';

export const ArcanosGaming = {
  name: 'ARCANOS:GAMING',
  description: 'Nintendo-style hotline advisor for game strategies, hints, and walkthroughs.',
  gptIds: ['arcanos-gaming', 'gaming'],
  actions: {
    async query(payload: any) {
      const prompt =
        payload?.prompt ||
        payload?.message ||
        payload?.text ||
        payload?.content ||
        payload?.query ||
        payload;

      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('ARCANOS:GAMING query requires a text prompt.');
      }

      const guideUrl = typeof payload?.url === 'string' && payload.url.trim() ? payload.url.trim() : undefined;

      const extraGuidesRaw = [payload?.urls, payload?.guideUrls];
      const guideUrls: string[] = [];

      for (const raw of extraGuidesRaw) {
        if (typeof raw === 'string' && raw.trim()) {
          guideUrls.push(raw.trim());
        } else if (Array.isArray(raw)) {
          for (const entry of raw) {
            if (typeof entry === 'string' && entry.trim()) {
              guideUrls.push(entry.trim());
            }
          }
        }
      }

      const normalizedGuides = Array.from(new Set(guideUrls));

      return runGaming(prompt.trim(), guideUrl, normalizedGuides);
    },
  },
};

export default ArcanosGaming;
