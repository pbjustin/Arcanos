import { resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';

const scope = (prompt: string) => resolveGamingRequestEdition({ game: 'Elden Ring', prompt });

describe('generic DLC necessity questions are answered from acquired evidence', () => {
  test.each([
    'Is DLC required to obtain the Uchigatana?',
    'Is DLC needed to obtain Uchigatana?',
    'Is DLC necessary to obtain the weapon?'
  ])('allows ordinary base-game evidence for %s', question => {
    expect(scope(question)).toBe('base-game');
  });
  test.each([
    'Is DLC required to obtain the Uchigatana? Recommend a DLC build.',
    'Is DLC needed to obtain DLC weapons?',
    'Is DLC necessary to obtain the weapon or expansion gear?',
    'Is DLC essential for obtaining the Uchigatana?',
    'Is DLC required to access the area?'
  ])('does not remove positive or unrecognized expansion intent from %s', question => {
    expect(scope(question)).toBeUndefined();
  });
  test('keeps a named expansion question strict', () => {
    expect(scope('Is DLC required to obtain the weapon in Shadow of the Erdtree?')).toBe('shadow of the erdtree');
  });
  test('keeps mixed base-game and named expansion scope unresolved', () => {
    expect(scope('Is DLC required to obtain this base-game weapon and Shadow of the Erdtree gear?')).toBeUndefined();
  });
  test('preserves the explicit DLC-free scope decision', () => {
    expect(scope('Is DLC required to obtain the Uchigatana? Recommend a build without DLC.')).toBe('base-game');
  });
});
