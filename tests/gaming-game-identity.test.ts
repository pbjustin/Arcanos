import { normalizeGamingGameIdentity, resolveGamingGuideIdentity } from '../src/shared/gaming/gamingGameIdentity.js';

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
