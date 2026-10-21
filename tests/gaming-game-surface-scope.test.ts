import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const url = 'https://identity-fixture.example/game-surface';
function inspect(game: string, sentence: string) {
  const title = `${game} guide`;
  return assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title, headings: title },
    text: `${title}. In the game ${game}, inspect supplies and preserve stamina before entering the next area. ${sentence}` },
  { game, mode: 'guide', prompt: 'Explain the starting route and equipment.' }, assessGamingSourcePolicy(url, game));
}

describe('game-owned interfaces do not declare another game', () => {
  it.each(['Elden Ring', 'Lantern Voyage'])('retains a game-console player action for %s', game => {
    expect(inspect(game, 'You must execute the following command in the game console to inspect your party.'))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['menu to select your equipment', 'chat to coordinate your party', 'interface to review your inventory'])
  ('retains an independently scoped game-owned %s', surface => {
    expect(inspect('Lantern Voyage', `Use the options in the game ${surface}.`))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    'In the game Minecraft, inspect your party.',
    'In the game Lantern Vale, inspect your party.',
    'In the game lantern vale, inspect your party.',
    'In the game Console, inspect your party.',
    'In the game "console to inspect your party", collect the starting equipment.',
    'This guide covers console to inspect your party.'
  ])('preserves explicit foreign game ownership: %s', sentence => {
    expect(inspect('Lantern Voyage', sentence)).toMatchObject({ status: 'conflict', gameIdentityVerified: false,
      reasonCodes: ['GAME_MISMATCH'] });
  });
});
