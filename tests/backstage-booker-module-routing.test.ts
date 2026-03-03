import { describe, expect, it } from '@jest/globals';
import BackstageBookerModule from '../src/services/backstage-booker.js';

describe('BackstageBookerModule GPT routing defaults', () => {
  it("exposes a 'query' action for default GPT dispatch", () => {
    expect(BackstageBookerModule.actions).toHaveProperty('query');
  });

  it('rejects query requests without a text prompt', async () => {
    await expect(BackstageBookerModule.actions.query({})).rejects.toThrow(
      'BACKSTAGE:BOOKER query requires a text prompt.'
    );
  });
});
