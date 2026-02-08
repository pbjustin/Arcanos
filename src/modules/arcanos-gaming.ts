import { runGaming } from '../services/gaming.js';
import { extractTextPrompt, normalizeStringList } from '../utils/payloadNormalization.js';
import { withHRC } from './hrcWrapper.js';

export const ArcanosGaming = {
  name: 'ARCANOS:GAMING',
  description: 'Nintendo-style hotline advisor for game strategies, hints, and walkthroughs.',
  gptIds: ['arcanos-gaming', 'gaming'],
  actions: {
    async query(payload: unknown) {
      const prompt = extractTextPrompt(payload);

      //audit Assumption: query requires prompt text
      if (!prompt) {
        throw new Error('ARCANOS:GAMING query requires a text prompt.');
      }

      const guideUrl = getPayloadString(payload, 'url');

      const normalizedGuides = normalizeStringList(
        getPayloadValue(payload, 'urls'),
        getPayloadValue(payload, 'guideUrls')
      );

      const result = await runGaming(prompt, guideUrl, normalizedGuides);
      return withHRC(result, r => r.gaming_response ?? '');
    },
  },
};

export default ArcanosGaming;

function getPayloadValue(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

function getPayloadString(payload: unknown, key: string): string | undefined {
  const value = getPayloadValue(payload, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
