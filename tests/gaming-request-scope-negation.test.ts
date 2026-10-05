import { resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';

const scope = (prompt: string) => resolveGamingRequestEdition({ game: 'Elden Ring', prompt });

describe('explicit base-game and negative expansion request scope', () => {
  test.each([
    'Recommend a base game Samurai build without DLC.',
    'Recommend a Samurai build without DLC.',
    'No DLC Samurai build, please.',
    'Recommend a Samurai build excluding expansion content.',
    'Recommend a Samurai build without Shadow of the Erdtree.',
    'Recommend a base-game Samurai build.'
  ])('safely selects base-game scope for %s', question => {
    expect(scope(question)).toBe('base-game');
  });
  test.each([
    'Recommend a DLC Samurai build.',
    'Recommend a Samurai build with DLCs.',
    'Recommend a Samurai build, not without DLC.',
    'Recommend an expansion build.',
    'Recommend a base game Samurai build with DLC gear.',
    'Recommend a base game Samurai build and Shadow of the Erdtree gear.',
    'Recommend a Samurai build without DLC, plus Shadow of the Erdtree gear.',
    'Recommend a Samurai build without DLC, then include expansion gear.',
    'Do not use Shadow of the Erdtree gear. Recommend a Samurai build.',
    'Do not include any Shadow of the Erdtree gear. Recommend a Samurai build.',
    "Don't use Shadow of the Erdtree gear. Recommend a Samurai build.",
    'Never use Shadow of the Erdtree gear. Recommend a Samurai build.',
    'Recommend a Samurai build not for Shadow of the Erdtree.',
    'Do not use "Shadow of the Erdtree" gear. Recommend a Samurai build.',
    'Recommend a Samurai build not without Shadow of the Erdtree.',
    "I don't own Shadow of the Erdtree. Recommend a Samurai build.",
    'Do not use Shadow of the Erdtree gear, but include Shadow of the Erdtree skills.'
  ])('retains material expansion ambiguity for %s', question => {
    expect(scope(question)).toBeUndefined();
  });
  test('preserves explicitly named positive expansion scope', () => {
    expect(scope('Recommend a Samurai build for Shadow of the Erdtree.')).toBe('shadow of the erdtree');
    expect(scope('Recommend a Samurai build with Shadow of the Erdtree gear.')).toBe('shadow of the erdtree');
    expect(scope('Recommend a Samurai build for "Shadow of the Erdtree".')).toBe('shadow of the erdtree');
  });
  test('leaves unrecognized DLC necessity language unresolved', () => {
    expect(scope('Is DLC essential for obtaining Uchigatana?')).toBeUndefined();
  });
});
