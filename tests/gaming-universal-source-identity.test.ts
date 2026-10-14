import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { canonicalizeGamingGameName } from '../src/services/gamingGameDetection.js';
import { gamingRegistrySourceGameMatchesRequest } from '../src/shared/gaming/gamingGameRegistry.js';
import { resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';
import { resolveGamingAcquiredIdentity } from '../src/shared/gaming/gamingAcquiredIdentity.js';

const url = 'https://synthetic-guide.example/universal';
const game = 'Copperwind Loom';
const guidance = 'Tune the chime lattice before crossing the bridge. Inspect the lumen spindle and preserve enough charge for the return route.';
function assess(text: string, requestedGame = game, title = 'Resonance Braiding', reviewed = false) {
  const policy = assessGamingSourcePolicy(url, requestedGame);
  return assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title, headings: title }, text: `${title}. ${text}` },
    { game: requestedGame, mode: 'guide', prompt: 'Explain resonance braiding and the chime lattice.' },
    reviewed ? { ...policy, authority: 'specialist', ruleId: 'synthetic-reviewed-source' } : policy);
}

describe('universal acquired game identity without catalog additions', () => {
  it('keeps four internal resolution states without changing the public assessment shape', () => {
    expect(resolveGamingAcquiredIdentity({ sourceGame: game, requestedGame: game })).toBe('IDENTITY_VERIFIED');
    expect(resolveGamingAcquiredIdentity({ sourceGame: 'CWL', requestedGame: 'CWL' })).toBe('IDENTITY_UNVERIFIED');
    expect(resolveGamingAcquiredIdentity({ sourceGame: 'Other Game', requestedGame: game })).toBe('IDENTITY_CONFLICT');
    expect(resolveGamingAcquiredIdentity({ sourceGame: '', requestedGame: game })).toBe('INSUFFICIENT_EVIDENCE');
  });
  it.each(['Resonance Braiding', 'Early Game', 'Heavy Gunner'])('uses independent exact unknown-game scope for %s', title => {
    expect(assess(`In ${game}, ${guidance}`, game, title)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('uses independently acquired typed ownership for a novel guide heading', () => {
    expect(assess(`Resonance Braiding is a mechanic in ${game}. ${guidance}`, game, 'Resonance Braiding guide'))
      .toMatchObject({ status: 'verified' });
  });

  it.each([
    `This ${game} guide is for a new traveller. ${guidance}`,
    `This guide explains resonance braiding in ${game} and gives intact steps for the lattice. ${guidance}`,
    `Game: ${game}. The ${game} controls on PC use the chime lattice. ${guidance}`
  ])('preserves affirmative source ownership expressed as natural guide prose: %s', prose => {
    expect(assess(prose, game, `${game} guide`).status).toBe('verified');
  });

  it.each(['Copperwind: Loom', 'Copperwind—Loom', 'Ｃｏｐｐｅｒｗｉｎｄ Ｌｏｏｍ'])('retains deterministic formatting equivalence for %s', spelling => {
    expect(assess(`In ${spelling}, ${guidance}`)).toMatchObject({ status: 'verified' });
  });

  it('matches a standalone sequel numeral without dropping the sequel', () => {
    expect(gamingRegistrySourceGameMatchesRequest('Copperwind Loom III', 'Copperwind Loom 3')).toBe(true);
    expect(gamingRegistrySourceGameMatchesRequest('Copperwind Loom III', 'Copperwind Loom')).toBe(false);
    expect(assess(`In Copperwind Loom III, ${guidance}`, 'Copperwind Loom 3')).toMatchObject({ status: 'verified' });
  });

  it.each(['Copperwind Loom Awakening', 'Copperwind Loom 2', 'Copperwind Loom Remastered'])('retains a distinct unknown family title %s', other => {
    expect(assess(`In ${game}, ${guidance} In the game ${other}, use a different route.`)).toMatchObject({ status: 'conflict' });
    expect(gamingRegistrySourceGameMatchesRequest(other, game)).toBe(false);
  });

  it.each(['Minecraft Starbound', 'Elden Ring Unknown Subtitle', 'Fallout 76 Reborn'])('never canonicalizes an unknown family title %s into a known parent', title => {
    expect(canonicalizeGamingGameName(title)).toBe(title);
  });

  it('does not turn an unfamiliar subtitle into affirmative evidence for the parent', () => {
    expect(assess(`Minecraft Moonbound offers the following route. ${guidance}`, 'Minecraft', 'Minecraft Moonbound guide').status)
      .not.toBe('verified');
    expect(assess(`In Minecraft Moonbound, ${guidance}`, 'Minecraft', 'Minecraft Moonbound guide').status)
      .not.toBe('verified');
    expect(assess(`In Minecraft, ${guidance} In Minecraft Moonbound, use a different route.`, 'Minecraft', 'Minecraft guide').status)
      .not.toBe('verified');
    for (const foreign of ['Minecraft Features', 'Minecraft Has Fallen']) {
      expect(assess(`In Minecraft, ${guidance} In ${foreign}, use a different route.`, 'Minecraft', 'Minecraft guide').status)
        .not.toBe('verified');
    }
  });

  it.each([
    `${game} is excluded from the scope of this article.`, `${game} is mentioned only as a comparison.`,
    `${game} is a game the reader asked about; this source never identifies its own game.`,
    `${game} features only as a comparison.`, `${game} has no relevance to this source.`
  ])('does not treat reference or exclusion prose as independent ownership: %s', reference => {
    expect(assess(`${reference} ${guidance}`, game, `${game} guide`).status).not.toBe('verified');
  });

  it.each([`${game} is played with chime lattices.`, `${game} is set in a landscape of chime lattices.`])
  ('retains affirmative game domain prose: %s', prose => {
    expect(assess(`${prose} ${guidance}`, game, `${game} guide`).status).toBe('verified');
  });

  it.each(['early', 'late', 'mid-game'])('supports bounded temporal acquired scope %s only with an independent Game declaration', period => {
    expect(assess(`Game: ${game}. In ${period} ${game}, ${guidance}`, game, `${game} guide`).status).toBe('verified');
    expect(assess(`Game: ${game}. Unlike in ${period} ${game}, ${guidance}`, game, `${game} guide`).status).not.toBe('verified');
    expect(assess(`In ${period} ${game}, ${guidance}`, game, `${game} guide`).status).not.toBe('verified');
  });

  it('does not use an affirmative sentence inside a whole multi-sentence quote as independent evidence', () => {
    expect(assess(`The article quotes: "A different introduction. ${game} features a chime lattice." ${guidance}`, game, `${game} guide`).status)
      .not.toBe('verified');
  });

  it.each(['Rust', 'Blood', 'CWL'])('requires explicit game context for ordinary-word/acronym identity %s', name => {
    expect(assess(`Use ${name} while tuning the equipment. ${guidance}`, name, `${name} guide`).status).not.toBe('verified');
    expect(assess(`In the game ${name}, ${guidance}`, name)).toMatchObject({ status: 'verified' });
  });

  it.each(['Heavy Weapons', 'Power Armor', 'Early Game', 'Samurai Build'])('does not promote the requested gameplay topic %s into a game without explicit acquired context', name => {
    expect(resolveGamingAcquiredIdentity({ sourceGame: name, requestedGame: name })).toBe('IDENTITY_UNVERIFIED');
    expect(assess(`In ${name}, ${guidance}`, name).status).not.toBe('verified');
    expect(assess(`In the game ${name}, ${guidance}`, name)).toMatchObject({ status: 'verified' });
  });

  it('never turns a whole quoted Unicode game declaration into affirmative evidence', () => {
    expect(assess(`The article quotes: "In the game 星海の旅路, ${guidance}"`, '星海の旅路').status).not.toBe('verified');
  });

  it.each([false, true])('never treats title-only scope as independent proof, reviewed association %s', reviewed => {
    expect(assess(guidance, game, `${game} guide`, reviewed).status).not.toBe('verified');
  });

  it('allows an explicitly acquired alias only with separate canonical game corroboration', () => {
    expect(assess(`The game ${game} is also known as CWL. In ${game}, ${guidance} In the game CWL, inspect the lattice.`))
      .toMatchObject({ status: 'verified' });
    expect(assess(`The game ${game} is also known as CWL. In the game CWL, ${guidance}`).status).not.toBe('verified');
    expect(assess(`The game ${game} is also known as CWL. In ${game}, ${guidance}`, 'CWL'))
      .toMatchObject({ status: 'verified' });
  });

  it('fails closed on conflicting acquired alias ownership', () => {
    expect(assess(`The game ${game} is also known as CWL. The game Copperwind Afterlight is also known as CWL. In ${game}, ${guidance}`)
      .status).not.toBe('verified');
  });

  it('preserves an unknown-game base-only request without choosing a missing catalog default', () => {
    expect(resolveGamingRequestEdition({ game, prompt: 'Explain the starting route in the base game without DLC.' })).toBe('base-game');
    expect(resolveGamingRequestEdition({ game, prompt: 'Explain the starting route.' })).toBeUndefined();
    expect(resolveGamingRequestEdition({ game, prompt: 'Explain the route, not without DLC.' })).toBeUndefined();
  });
});
