import BackstageBooker, { MatchInput, Wrestler } from './backstage/booker.js';

export const BackstageBookerModule = {
  name: 'BACKSTAGE:BOOKER',
  description: 'Behind-the-scenes pro wrestling booker for WWE/AEW with strict canon and logic.',
  gptIds: ['backstage-booker', 'backstage'],
  actions: {
    async bookEvent(payload: unknown) {
      const record = normalizePayloadRecord(payload);
      return BackstageBooker.bookEvent(record);
    },
    async updateRoster(payload: Wrestler[]) {
      return BackstageBooker.updateRoster(payload);
    },
    async trackStoryline(payload: unknown) {
      const record = normalizePayloadRecord(payload);
      return BackstageBooker.trackStoryline(record);
    },
    async simulateMatch(payload: { match: MatchInput; rosters: Wrestler[]; winProbModifier?: number }) {
      return BackstageBooker.simulateMatch(payload.match, payload.rosters, payload.winProbModifier ?? 0);
    },
    async generateBooking(payload: { prompt: string }) {
      return BackstageBooker.generateBooking(payload.prompt);
    },
    async saveStoryline(payload: { key: string; storyline: string }) {
      return BackstageBooker.saveStoryline(payload.key, payload.storyline);
    }
  }
};

function normalizePayloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be an object');
  }
  return payload as Record<string, unknown>;
}

export default BackstageBookerModule;
