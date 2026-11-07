import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { selectGamingGameScopedDocument } from '../src/shared/gaming/gamingStructuralEvidence.js';

const url = 'https://synthetic.example/comparison-scope';
const games = ['Elden Ring', 'Fallout 76', 'Lantern Voyage'];
const frames = ['For comparison,', 'By comparison,', 'For comparison:', 'By comparison:'];
const independent = 'players inspect the practice gate and retain the practice marker before leaving the training area.';

/** Build independently acquired identity; every gameplay action is invented fixture material. */
function source(game: string, comparison: string, independentIdentity = true) {
  const title = `${game} walkthrough`;
  return { publicUrl: url, metadata: { title, headings: title },
    text: `${independentIdentity ? `In the game ${game}, ${independent} ` : ''}${comparison}` };
}

/** Assess the acquired source rather than accepting the player's requested title as proof. */
function identity(game: string, comparison: string, independentIdentity = true) {
  return assessGamingClearSourceIdentity(source(game, comparison, independentIdentity),
    { game, mode: 'guide', prompt: 'How do I inspect the practice gate?' }, assessGamingSourcePolicy(url, game));
}

describe('bounded comparison game-scope regressions', () => {
  it.each(frames.flatMap(frame => ['shop', 'world', 'menu'].map(surface =>
    `${frame} in Fallout 4, buy the practice token in the game ${surface}.`)))(
    'keeps an ordinary game surface inside its closed comparison: %s', comparison => {
      for (const game of games) {
        const original = source(game, comparison);
        const result = selectGamingGameScopedDocument(original, game);
        expect(result).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
        expect(result.document.text).not.toContain(comparison);
        expect(result.document.text).toContain(independent);
        expect(original.text).toContain(comparison);
        expect(identity(game, comparison)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
      }
    });

  it.each(frames)('also scopes an unfamiliar comparison game under %s', frame => {
    const comparison = `${frame} in Copper Vale, buy the practice token in the game shop.`;
    expect(selectGamingGameScopedDocument(source('Lantern Voyage', comparison), 'Lantern Voyage'))
      .toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
    expect(identity('Lantern Voyage', comparison)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(frames)('does not use comparison-only prose as independent identity or gameplay evidence: %s', frame => {
    const comparison = `${frame} in Fallout 4, buy the practice token in the game menu.`;
    const result = selectGamingGameScopedDocument(source('Elden Ring', comparison, false), 'Elden Ring');
    expect(result.document.text.trim()).toBe('');
    expect(result.document.text).not.toContain('practice token');
    expect(identity('Elden Ring', comparison, false)).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it.each(frames)('does not establish an unfamiliar requested game from a comparison naming that request: %s', frame => {
    const comparison = `${frame} in Lantern Voyage, buy the practice token in the game menu.`;
    const result = selectGamingGameScopedDocument(source('Lantern Voyage', comparison, false), 'Lantern Voyage');
    expect(result.document.text.trim()).toBe('');
    expect(identity('Lantern Voyage', comparison, false)).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it.each(['Shop', 'World', 'Menu', 'world conquest', 'Players Collect', 'players collect'])(
    'retains a title-like or unfamiliar nominal continuation rather than declaring it an ordinary surface: %s', name => {
      const comparison = `For comparison, in Fallout 4, buy a token, but in the game ${name}, collect another token.`;
      expect(selectGamingGameScopedDocument(source('Lantern Voyage', comparison), 'Lantern Voyage'))
        .toMatchObject({ status: 'unchanged', excludedReferenceCount: 0 });
      expect(identity('Lantern Voyage', comparison)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    });

  it.each([
    'For comparison, in Fallout 4, buy a token, but in Elden Ring, collect another token.',
    'For comparison: in Elden Ring, buy a token, but in Fallout 4, collect another token.',
    'By comparison, in Fallout 4, buy a token, but in the game Copper Vale, collect another token.',
    'By comparison: in Fallout 4, buy a token, but in Copper Vale guide, collect another token.',
    'For comparison, in Fallout 4, buy a token, but in the game "Shop", collect another token.',
    'For comparison: in Fallout 4, buy a token, but in "Elden Ring", collect another token.',
    'For comparison, in Fallout 4, buy a token, but in the game World of Warcraft, collect another token.'
  ])('retains an independently named second game instead of erasing a contradiction: %s', comparison => {
    expect(selectGamingGameScopedDocument(source('Lantern Voyage', comparison), 'Lantern Voyage'))
      .toMatchObject({ status: 'unchanged', excludedReferenceCount: 0 });
    expect(identity('Lantern Voyage', comparison)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(frames)('keeps a complete quoted clause local while preserving quoted game-name declarations: %s', frame => {
    const comparison = `${frame} in Fallout 4, the example says "in the game Copper Vale, buy another token".`;
    const result = selectGamingGameScopedDocument(source('Lantern Voyage', comparison), 'Lantern Voyage');
    expect(result).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
    expect(result.document.text).not.toContain('Copper Vale');
    expect(identity('Lantern Voyage', comparison)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    'For comparison, in Fallout 4, Game: Copper Vale.',
    'For comparison: in Minecraft Java, Edition: Bedrock.',
    'By comparison, in Fallout 4, this guide covers Copper Vale.',
    'By comparison: in Minecraft Java, this source requires Bedrock.'
  ])('does not project explicit source-global declarations: %s', comparison => {
    expect(selectGamingGameScopedDocument(source('Lantern Voyage', comparison), 'Lantern Voyage'))
      .toMatchObject({ status: 'unchanged', excludedReferenceCount: 0 });
  });

  it.each(frames)('retains an independent contradiction in the sentence after %s', frame => {
    const comparison = `${frame} in Fallout 4, buy the practice token in the game shop.`;
    const contradiction = 'In the game Copper Vale, collect a different practice token.';
    const result = selectGamingGameScopedDocument(source('Lantern Voyage', `${comparison} ${contradiction}`), 'Lantern Voyage');
    expect(result).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
    expect(result.document.text).toContain(contradiction);
    expect(identity('Lantern Voyage', `${comparison} ${contradiction}`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([
    'For comparison, in Fallout 4, buy the practice token in the game shop',
    'For comparison: in Fallout 4, buy the practice token in the game shop',
    `For comparison, in Fallout 4, ${'practice '.repeat(80)}buy a token in the game world.`,
    `For comparison: in Fallout 4, ${'practice '.repeat(80)}buy a token in the game world.`,
    'By comparison, in Fallout 4, an unfinished quote says "in the game Copper Vale.',
    'By comparison: in Fallout 4, an unfinished quote says "in the game Copper Vale.'
  ])('leaves truncated or over-budget scope inspectable rather than blessing a prefix: %s', comparison => {
    const original = source('Lantern Voyage', comparison);
    expect(selectGamingGameScopedDocument(original, 'Lantern Voyage'))
      .toMatchObject({ status: 'unchanged', excludedReferenceCount: 0, document: { text: original.text } });
    expect(identity('Lantern Voyage', comparison).status).not.toBe('verified');
  });
});
