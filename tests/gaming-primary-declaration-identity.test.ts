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

  it.each([
    'Players like fighting in the game Diablo IV before collecting equipment.',
    'Players like exploring in the game Copperwind Afterlight before returning to town.',
    'Players like playing in Diablo IV before collecting equipment.'
  ])('retains affirmative foreign-game ownership after a preference verb: %s', declaration => {
    expect(inspect(declaration)).toMatchObject({ status: 'conflict', gameIdentityVerified: false,
      reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([
    'Like in Diablo IV, this route requires checking equipment.',
    'Like combat in Diablo IV, this route requires checking equipment.',
    'Just like fighting in the game Diablo IV, this route requires checking equipment.',
    'Much like combat in Diablo IV, this route requires checking equipment.',
    'Unlike combat in Diablo IV, this route starts with the available equipment.',
    'Compared to equipment progression in Diablo IV, this route has fewer upgrades.',
    'Players like fighting in the game Lantern Voyage.'
  ])('preserves local comparisons and affirmative matching game scope: %s', declaration => {
    expect(inspect(declaration)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('does not extend a like comparison across a later affirmative foreign-game clause', () => {
    expect(inspect('Like combat in Lantern Voyage, in the game Diablo IV you can inspect equipment.'))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([-1, 0, 1])('does not infer a leading comparison from the bounded prefix at offset %s', offset => {
    const preference = 'like fighting';
    const prefix = `Players ${preference}${' '.repeat(512 - preference.length + offset)}`;
    expect(inspect(`${prefix}in the game Diablo IV.`))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'] });
  });
});
