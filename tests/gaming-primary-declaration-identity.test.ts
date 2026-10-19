import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const url = 'https://identity-fixture.example/guide';
const title = 'Lantern Voyage guide';
const guidance = 'Inspect supplies and preserve stamina before entering the next area.';

function inspect(declaration: string) {
  return assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title, headings: title },
    text: `${title}. In the game Lantern Voyage, ${guidance} ${declaration}` },
  { game: 'Lantern Voyage', mode: 'guide', prompt: 'Explain the starting route and equipment.' },
  assessGamingSourcePolicy(url, 'Lantern Voyage'));
}

describe('primary acquired game declarations preserve complete nominal subjects', () => {
  it.each([
    'This guide covers it takes two.',
    'This article is about we were here.',
    'This document is for they are here.',
    'This guide covers copper harbor has fallen.',
    'This article is about It takes two.',
    'This source covers They are here.'
  ])('does not erase a foreign source-global declaration as gameplay prose: %s', declaration => {
    expect(inspect(declaration)).toMatchObject({ status: 'conflict', gameIdentityVerified: false,
      reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(['It Takes Two', 'We Were Here', 'They Are Here', 'Copper Harbor Has Fallen'])
  ('retains independently declared matching sentence-like title %s', game => {
    expect(assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title: `${game} guide` },
      text: `This guide covers ${game.toLowerCase()}. ${guidance}` },
    { game, mode: 'guide', prompt: 'Explain the starting route and equipment.' }, assessGamingSourcePolicy(url, game)))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['In the game you can inspect equipment.', 'In the game players preserve stamina.',
    'In the game Lantern Voyage you can inspect equipment.', 'This guide covers Lantern Voyage.'])
  ('keeps ordinary gameplay and matching source ownership eligible: %s', declaration => {
    expect(inspect(declaration)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });
});
