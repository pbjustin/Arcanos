import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { hasGamingAffirmativeIdentityProse, resolveGamingAcquiredIdentity } from '../src/shared/gaming/gamingAcquiredIdentity.js';
import { gamingRegistrySourceGameMatchesRequest, resolveGamingRegistryGame } from '../src/shared/gaming/gamingGameRegistry.js';

const url = 'https://independent-fixture.example/guide';
const prose = 'Align the tessellated sail with the visible current, then turn the prism dial until the ribbon settles. '
  + 'Reserve one quiet interval before repeating the alignment and recheck the visible current before crossing.';
function inspect(game: string, body: string, title = 'Tessellated Sail Alignment') {
  return assessGamingClearSourceIdentity({ publicUrl: url, text: `${title}. ${body}`, metadata: { title, headings: title } },
    { game, prompt: 'Explain tessellated sail alignment and prism dial timing.', mode: 'guide' }, assessGamingSourcePolicy(url, game));
}

describe('independent unknown-title identity and conflict review', () => {
  it.each(['Silver Harbor', 'Silver Harbor Nights', 'Journey', 'Velvet Circuit III: The Glass Horizon', '雪の記憶'])
  ('validates previously unregistered %s from explicit acquired game prose', game => {
    expect(resolveGamingRegistryGame(game)).toBeUndefined();
    expect(inspect(game, `In the game ${game}, ${prose}`)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([['Silver Harbor', 'Silver Harbor Nights'], ['Silver Harbor Nights', 'Silver Harbor'],
    ['Velvet Circuit III: The Glass Horizon', 'Velvet Circuit IV: The Glass Horizon'],
    ['Elden Ring', 'Elden Ring Nightreign'], ['Fallout 76', 'Fallout: New Vegas']])
  ('rejects independently acquired %s versus %s with overlapping topic terms', (requested, acquired) => {
    expect(inspect(requested, `In the game ${acquired}, ${prose}`, `${requested} guide`))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false });
  });

  it.each(['Heavy Gunner', 'Power Armor', 'Early Game', 'Farming', 'Starting Equipment', 'Boss Strategy', 'Crafting', 'Exploration'])
  ('does not let heading %s supply independent game proof', heading => {
    expect(inspect('Silver Harbor', prose, heading).status).not.toBe('verified');
    expect(inspect('Silver Harbor', `In the game Silver Harbor, ${prose}`, heading))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['Tidal Prism Alignment guide', 'Steering a Tessellated Sail guide', 'Ribbon Phase Unfolding walkthrough'])
  ('keeps previously unfamiliar topic heading %s separate from independently acquired game identity', heading => {
    expect(inspect('Silver Harbor', `In the game Silver Harbor, ${prose}`, heading))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(inspect('Silver Harbor', prose, heading).status).not.toBe('verified');
    expect(inspect('Silver Harbor', `In the game Silver Harbor, ${prose} In the game Tidal Prism Alignment, follow a different current.`, heading))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false });
  });

  it('retains independently acquired known-family title contradictions under an explicit requested scope', () => {
    expect(inspect('Fallout 76', `In the game Fallout 76, ${prose}`, 'Fallout 4 guide'))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false });
  });

  it.each([['Velvet Circuit III: The Glass Horizon', 'Velvet Circuit 3: The Glass Horizon'],
    ['Velvet Circuit 3: The Glass Horizon', 'Velvet Circuit III: The Glass Horizon']])
  ('retains independently proven numeral equivalence with a subtitle: %s / %s', (requested, acquired) => {
    expect(gamingRegistrySourceGameMatchesRequest(acquired, requested)).toBe(true);
    expect(resolveGamingAcquiredIdentity({ sourceGame: acquired, requestedGame: requested, explicitGameContext: true }))
      .toBe('IDENTITY_VERIFIED');
    expect(inspect(requested, `In the game ${acquired}, ${prose}`)).toMatchObject({ status: 'verified' });
    expect(inspect(requested, `In the game ${acquired}, ${prose}`, `${acquired} guide`)).toMatchObject({ status: 'verified' });
  });

  it.each([['V Rising', '5 Rising'], ['Velvet Circuit III: The Glass Horizon', 'Velvet Circuit 3: The Silver Horizon'],
    ['Velvet Circuit III: The Glass Horizon', 'Velvet Circuit 3: The Glass Horizon Remake']])
  ('preserves meaningful title distinctions %s / %s', (left, right) => {
    expect(gamingRegistrySourceGameMatchesRequest(left, right)).toBe(false);
  });

  it.each([
    'Silver Harbor features only a comparison to an unrelated game.',
    'Silver Harbor has merely a reference in a reader request.',
    'Silver Harbor offers nothing but a quoted comparison.',
    'Silver Harbor features no gameplay covered by this article.'
  ])('does not treat exclusion/reference subject prose as affirmative game ownership: %s', reference => {
    expect(inspect('Silver Harbor', `${reference} ${prose}`, 'Silver Harbor guide').status).not.toBe('verified');
    expect(hasGamingAffirmativeIdentityProse(reference, 'Silver Harbor')).toBe(false);
  });

  it.each(['Silver Harbor features a tessellated sail.', 'Silver Harbor uses a prism dial to orient the sail.'])
  ('preserves affirmative acquired ownership for %s', affirmative => {
    expect(hasGamingAffirmativeIdentityProse(affirmative, 'Silver Harbor')).toBe(true);
    expect(inspect('Silver Harbor', `${affirmative} ${prose}`, 'Silver Harbor guide').status).toBe('verified');
  });
});
