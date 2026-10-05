import { gamingEditionIdentitiesMatch, normalizeGamingEditionIdentity, normalizeGamingGameIdentity, resolveGamingGuideIdentity, resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';

describe('conservative edition normalization', () => {
  test.each(['Base game', 'base game', 'base-game', ' BASE GAME '])('canonicalizes the explicit base-game alias %s', edition => {
    expect(normalizeGamingEditionIdentity(edition)).toBe('base-game');
    expect(gamingEditionIdentitiesMatch(edition, 'base-game')).toBe(true);
  });

  test.each(['base', 'base/game', 'base_game', 'base.game', 'base-game DLC', 'not base game', 'Base game and Shadow of the Erdtree'])(
    'does not promote arbitrary or conflicting text %s to the base game', edition => {
      expect(normalizeGamingEditionIdentity(edition)).not.toBe('base-game');
      expect(gamingEditionIdentitiesMatch(edition, 'Base game')).toBe(false);
    });

  test('unknown editions retain conservative formatting equivalence and meaningful punctuation', () => {
    expect(normalizeGamingEditionIdentity(' Ｒｅｆｏｒｇｅｄ  Edition ')).toBe('reforged edition');
    expect(gamingEditionIdentitiesMatch('Reforged Edition', 'reforged-edition')).toBe(false);
    expect(gamingEditionIdentitiesMatch(undefined, 'Base game')).toBe(false);
    expect(gamingEditionIdentitiesMatch('', '')).toBe(false);
    expect(gamingEditionIdentitiesMatch(' ', ' ')).toBe(false);
  });
});

describe('stored game identity formatting', () => {
  test('an explicit edition narrows identity without repeating an existing title suffix', () => {
    expect(resolveGamingGuideIdentity('Lantern Vale', 'Remake')).toBe('lantern-vale-remake');
    expect(resolveGamingGuideIdentity('Lantern Vale: Remake', 'Remake')).toBe('lantern-vale-remake');
    expect(resolveGamingGuideIdentity('Original Sin', 'Original')).toBe('original-sin-original');
    expect(resolveGamingGuideIdentity('Lantern Vale Remake', 'Original')).toBe('lantern-vale-remake-original');
  });
  test.each([
    ['Lantern™ Voyage®: Remastered – 1.5', 'Lantern Voyage Remastered 1.5'],
    ['Pilot’s Oath - PC Edition', "Pilot's Oath: PC Edition"],
    ['Ａｓｈｂｏｕｎｄ Arena — II', 'Ashbound Arena II'],
    ['AETHER CAFÉ™: II', 'Aether Café II']
  ])('matches harmless title formatting %s', (left, right) => {
    expect(normalizeGamingGameIdentity(left)).toBe(normalizeGamingGameIdentity(right));
  });

  test.each([
    ['Lantern Voyage I', 'Lantern Voyage II'],
    ['Lantern Voyage', 'Lantern Voyage Remake'],
    ['Lantern Voyage', 'Lantern Voyage Expansion'],
    ['Orbital Workshop PC Edition', 'Orbital Workshop Console Edition'],
    ['Orbital Workshop 1.5', 'Orbital Workshop 15'],
    ['Orbital Workshop 1.5', 'Orbital Workshop 1.6'],
    ['Lantern Voyage', 'Lantern Voyage HD 1.5 Remix'],
    ['Ashbound Arena+', 'Ashbound Arena']
  ])('does not merge meaningful identities %s and %s', (left, right) => {
    expect(normalizeGamingGameIdentity(left)).not.toBe(normalizeGamingGameIdentity(right));
  });
});


describe('request edition display identity', () => {
  test.each([
    'The submitted guide is titled "Elden Ring Shadow of the Erdtree". How do Samurai katana attacks work?',
    "The cited source is about 'Shadow of the Erdtree'. How do Samurai katana attacks work?",
    'This guide covers Shadow of the Erdtree. How do Samurai katana attacks work?'
  ])('does not infer player expansion scope from an attributed source description: %s', prompt => {
    expect(resolveGamingRequestEdition({ game: 'Elden Ring', prompt })).toBe('base-game');
  });
  test.each([
    'How do Samurai katana attacks work in "Shadow of the Erdtree"?',
    'The submitted guide is titled "Elden Ring Samurai guide". Recommend a build for "Shadow of the Erdtree".'
  ])('preserves an affirmative quoted expansion request: %s', prompt => {
    expect(resolveGamingRequestEdition({ game: 'Elden Ring', prompt })).toBe('shadow of the erdtree');
  });
  test('preserves explicit edition precedence over an attributed source description', () => {
    expect(resolveGamingRequestEdition({ game: 'Elden Ring', edition: 'Shadow of the Erdtree',
      prompt: 'The submitted guide is titled "Elden Ring Base game". How do Samurai attacks work?' })).toBe('Shadow of the Erdtree');
  });
  test.each(['Remastered', 'Shadow of the Erdtree', 'Reforged Edition'])('preserves explicit non-base edition display label %s', edition => {
    expect(resolveGamingRequestEdition({ game: 'Amber Pilgrim', edition })).toBe(edition);
    expect(gamingEditionIdentitiesMatch(resolveGamingRequestEdition({ game: 'Amber Pilgrim', edition }), edition.toLowerCase())).toBe(true);
  });
  test.each(['Base game', 'base game', 'base-game', ' BASE GAME '])('continues normalizing closed base-game alias %s', edition => {
    expect(resolveGamingRequestEdition({ game: 'Amber Pilgrim', edition })).toBe('base-game');
  });
});
