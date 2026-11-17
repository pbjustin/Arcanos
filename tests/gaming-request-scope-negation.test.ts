import { gamingEditionEvidenceMatchesRequest, gamingRequestTargetsExtraContent, resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';

const scope = (prompt: string) => resolveGamingRequestEdition({ game: 'Elden Ring', prompt });

describe('explicit base-game and negative expansion request scope', () => {
  test.each([
    'Recommend a base game Samurai build without DLC.',
    'Recommend a Samurai build without DLC.',
    'No DLC Samurai build, please.',
    'Recommend a Samurai build excluding expansion content.',
    'Recommend a Samurai build. Do not include any DLC gear.',
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

  test.each(['Elden Ring', 'Unregistered Test Game'])('preserves an explicit base-only restriction for %s', game => {
    const input = { game, prompt: 'How do Samurai katana attacks work? Do not include anything outside the base game.' };
    const edition = resolveGamingRequestEdition(input);
    expect(edition).toBe('base-game');
    expect(gamingRequestTargetsExtraContent(input)).toBe(false);
    expect(gamingEditionEvidenceMatchesRequest('base-game', edition, input)).toBe(true);
  });

  test.each(['Explain DLC katana attacks.', 'Explain expansion katana attacks.', 'Explain katana attacks outside the base game.'])
  ('requires edition verification for %s', prompt => {
    const input = { game: 'Elden Ring', prompt };
    const edition = resolveGamingRequestEdition(input);
    expect(edition).toBeUndefined();
    expect(gamingRequestTargetsExtraContent(input)).toBe(true);
    expect(gamingEditionEvidenceMatchesRequest(undefined, edition, input)).toBe(false);
  });

  test.each([
    'Recommend a Samurai build without DLC.',
    'No expansion gear, please.',
    'Recommend a Samurai build. Do not include any DLC gear.',
    'The supplied guide is titled "DLC Katana Attacks". How do Samurai katana attacks work?',
    'How do Samurai katana attacks work? Guide: https://guides.example.org/dlc/katana',
    'Is DLC required to obtain Uchigatana?',
    'Is DLC needed to obtain Uchigatana?',
    'Is DLC necessary to obtain Uchigatana?',
    'Explain katana attacks in the Shadow of the Erdtree DLC.'
  ])('keeps generic extra-content intent inactive for %s', prompt => {
    expect(gamingRequestTargetsExtraContent({ game: 'Elden Ring', prompt })).toBe(false);
  });

  test('keeps an affirmative extra-content clause separate from an earlier negative restriction', () => {
    const input = { game: 'Elden Ring', prompt: 'Do not spoil the ending, but explain katana attacks outside the base game.' };
    expect(resolveGamingRequestEdition(input)).toBeUndefined();
    expect(gamingRequestTargetsExtraContent(input)).toBe(true);
  });

  test.each([
    'The supplied guide says it covers the base game, but explain DLC combat.',
    'The supplied guide says it covers the base game, but please explain DLC combat.',
    'The supplied guide says it covers the base game, but can you explain DLC combat?',
    'The supplied guide says it covers the base game, but what about DLC combat?',
    "The supplied guide says it covers the base game, but I'd like DLC combat advice.",
    'The supplied guide says it covers the base game, but I’d like DLC combat advice.',
    'The supplied guide says it covers the base game, but now explain DLC combat.'
  ])('preserves an independent DLC request following a source description for %s', prompt => {
    const input = { game: 'Elden Ring', prompt };
    const edition = resolveGamingRequestEdition(input);
    expect(edition).toBeUndefined();
    expect(gamingRequestTargetsExtraContent(input)).toBe(true);
    expect(gamingEditionEvidenceMatchesRequest(undefined, edition, input)).toBe(false);
    expect(gamingEditionEvidenceMatchesRequest('base-game', edition, input)).toBe(false);
  });

  test.each([
    'The supplied guide says it covers the base game, but also includes DLC combat. Explain combat.',
    'The supplied guide is titled "The Base Game, but Explain DLC Combat". Explain combat.',
    'The supplied guide is titled "The Base Game, but What About DLC Combat?" Explain combat.',
    'The supplied guide is titled "The Base Game, but Explain DLC Combat." Explain combat.'
  ])('does not take attributed contrasts as independent requests for %s', prompt => {
    expect(gamingRequestTargetsExtraContent({ game: 'Xenoblade Chronicles 2', prompt })).toBe(false);
  });

  test.each(['or', 'and'])('keeps both coordinated exclusions joined by %s out of extra-content intent', conjunction => {
    const input = { game: 'Xenoblade Chronicles 2', prompt: `Explain combat without DLC ${conjunction} expansions.` };
    const edition = resolveGamingRequestEdition(input);
    expect(edition).toBe('base-game');
    expect(gamingRequestTargetsExtraContent(input)).toBe(false);
    expect(gamingEditionEvidenceMatchesRequest(undefined, edition, input)).toBe(true);
  });

  test.each([
    'Explain combat without DLC or expansions, but include DLC combat tips.',
    'Explain combat without DLC and expansions and then include DLC combat tips.',
    'Explain combat, not without DLC or expansions.'
  ])('keeps a renewed or unexcluded DLC request for %s', prompt => {
    const input = { game: 'Xenoblade Chronicles 2', prompt };
    const edition = resolveGamingRequestEdition(input);
    expect(edition).toBeUndefined();
    expect(gamingRequestTargetsExtraContent(input)).toBe(true);
    expect(gamingEditionEvidenceMatchesRequest(undefined, edition, input)).toBe(false);
  });
});
