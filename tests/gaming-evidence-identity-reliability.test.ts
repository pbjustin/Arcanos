import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { readGamingRegistryEditionScope } from '../src/shared/gaming/gamingGameRegistry.js';
import { selectGamingGameScopedDocument } from '../src/shared/gaming/gamingStructuralEvidence.js';

const url = 'https://guides.example.org/synthetic-route';
// Invented exercise mechanics test identity, not the gameplay facts of these games.
const passage = 'players collect the practice token at the marked gate, inspect the practice route, '
  + 'and keep the practice token until the exercise ends.';
/** Assess synthetic acquired scope while keeping real game names separate from invented mechanics. */
function assess(game: string, reference = '', sourceGame = game, edition?: string) {
  const title = `${sourceGame} walkthrough`;
  return assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title, headings: title },
    text: `${title}. In the game ${sourceGame}, ${passage} ${reference}` },
  { game, edition, mode: 'guide', prompt: 'How do I collect the practice token at the marked gate?' },
  assessGamingSourcePolicy(url, game));
}

const games = ['The Legend of Zelda: Ocarina of Time', 'Elden Ring', 'Fallout 76',
  'Elite Dangerous', 'The Witcher 3', 'Lantern Voyage'] as const;

describe('independent acquired identity with bounded local comparisons', () => {
  it.each(games)('verifies independent %s identity across registered and unregistered games', game => {
    expect(assess(game)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    ['The Legend of Zelda: Ocarina of Time', 'Buy the practice shield at the shop in Kokiri Forest for 40 Rupees.'],
    ['Fallout 76', 'Buy the practice equipment at the market in Amber Woods for 25 tokens.'],
    ['Elite Dangerous', 'Find the practice beacon in Amber Sector for the survey route.'],
    ['Lantern Voyage', 'Buy the practice token in Copper Village for 17 coins.']
  ])('does not infer a new game from a location and price in %s', (game, location) => {
    expect(assess(game, location)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    'Buy the practice item in Fallout 4 for 25 tokens.',
    'In the game Copper Vale, buy the practice item for 25 tokens.',
    'This guide covers Copper Vale. Buy the practice item for 25 tokens.',
    'In Copper Vale guide, buy the practice item for 25 tokens.',
    'In Lantern Voyage Remake, buy the practice item for 25 tokens.'
  ])('retains a separately acquired wrong-game scope beside a price: %s', reference => {
    expect(assess('Lantern Voyage', reference)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each(games)('keeps a comma-framed unrelated comparison local for %s', game => {
    expect(assess(game, 'For comparison, in Fallout 4, the invented exercise uses a different practice token.'))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['For comparison', 'By comparison'])('does not use %s as independent source identity', frame => {
    const game = 'Fallout 76';
    const title = `${game} walkthrough`;
    expect(assessGamingClearSourceIdentity({ publicUrl: url, metadata: { title, headings: title },
      text: `${title}. ${frame}, in the game ${game}, ${passage}` },
    { game, mode: 'guide', prompt: 'How do I collect the practice token?' }, assessGamingSourcePolicy(url, game)))
      .toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it.each([
    'For comparison, in Fallout 4, the exercise differs. In the game Copper Vale, collect the practice token.',
    'For comparison, in Fallout 4, the exercise differs. This guide covers Copper Vale.',
    'For comparison, in Fallout 4, the exercise differs. Game: Copper Vale.',
    'For comparison, the exercise differs; in the game Copper Vale, collect the practice token.',
    'For comparison, the exercise differs, but in the game Copper Vale, collect the practice token.',
    'For comparison, in Fallout 4, the exercise differs, but in the game Copper Vale, collect the practice token.',
    'For comparison, in Fallout 4, this guide covers Copper Vale.',
    'For comparison, in Fallout 4, Game: Copper Vale.',
    'Unlike in Fallout 4, in the game Copper Vale, collect the practice token.'
  ])('retains a genuine acquired contradiction after a comparison: %s', reference => {
    expect(assess('Fallout 76', reference)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('excludes local comparison gameplay from claim support while retaining the acquired document', () => {
    const comparison = 'For comparison, in Fallout 4, collect an unrelated comparison reward.';
    const doc = { publicUrl: url, text: `In Fallout 76, ${passage} ${comparison}` };
    const projected = selectGamingGameScopedDocument(doc, 'Fallout 76');
    expect(projected).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
    expect(projected.document.text).toContain(passage);
    expect(projected.document.text).not.toContain('comparison reward');
    expect(doc.text).toContain(comparison);
  });

  it.each([
    'For comparison, in Fallout 4, collect the practice token',
    `For comparison, in Fallout 4, ${'practice '.repeat(70)}collect the token.`
  ])('retains incomplete or over-budget comparisons for conservative inspection', comparison => {
    expect(selectGamingGameScopedDocument({ publicUrl: url, text: comparison }, 'Fallout 76'))
      .toMatchObject({ status: 'unchanged', excludedReferenceCount: 0, document: { text: comparison } });
    expect(assess('Fallout 76', comparison)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([
    ['The Legend of Zelda: Ocarina of Time', 'The Legend of Zelda: Ocarina of Time Remake'],
    ['The Legend of Zelda: Ocarina of Time Remake', 'The Legend of Zelda: Ocarina of Time'],
    ['Elden Ring', 'Elden Ring Nightreign'],
    ['Fallout 76', 'Fallout 4'],
    ['Lantern Voyage', 'Lantern Voyage Remastered'],
    ['Lantern Voyage', 'Lantern Voyage II']
  ])('does not merge requested %s with acquired %s', (game, sourceGame) => {
    expect(assess(game, '', sourceGame)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('keeps affirmative expansion applicability blocking for a base-game request', () => {
    expect(assess('Elden Ring', 'In Elden Ring Shadow of the Erdtree, collect the practice token.', 'Elden Ring', 'base-game'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('verifies an explicitly matching complete remake identity without assuming original compatibility', () => {
    const game = 'The Legend of Zelda: Ocarina of Time Remake';
    expect(assess(game)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('keeps an unverified requested edition unresolved', () => {
    expect(assess('Lantern Voyage', '', 'Lantern Voyage', 'Console Edition'))
      .toMatchObject({ status: 'unknown', reasonCodes: ['EDITION_UNVERIFIED'], gameIdentityVerified: true });
  });

  it('does not use a comma-framed platform-edition comparison to establish or contradict applicability', () => {
    const comparison = 'For comparison, in Minecraft Bedrock, the invented exercise differs.';
    expect(readGamingRegistryEditionScope({ text: comparison }, 'Minecraft')).toMatchObject({ status: 'none' });
    expect(readGamingRegistryEditionScope({ text: `Edition: Java. ${comparison}` }, 'Minecraft'))
      .toMatchObject({ status: 'verified', edition: 'Java' });
    expect(readGamingRegistryEditionScope({ text: `${comparison} Edition: Bedrock. Edition: Java.` }, 'Minecraft'))
      .toMatchObject({ status: 'conflict' });
  });

  it.each([
    'For comparison, in Minecraft Bedrock',
    'By comparison, in Minecraft Bedrock, this exercise',
    `For comparison, ${'in Minecraft Bedrock, '.padEnd(511, 'x')}.x`,
    `For comparison, in Minecraft Bedrock, ${'practice '.repeat(70)}the exercise differs.`
  ])('keeps incomplete or over-budget comparison edition inspection unresolved: %s', comparison => {
    expect(readGamingRegistryEditionScope({ text: `Edition: Java. ${comparison}` }, 'Minecraft').status)
      .not.toBe('verified');
  });

  it.each(['For comparison, Edition: Bedrock.', 'For comparison, in Minecraft Java, Edition: Bedrock.',
    'Historically, in Minecraft Java, Edition: Bedrock.',
    'Related article: Minecraft Java, Edition: Bedrock.'])(
    'retains explicit source-global edition declarations within a reference: %s', comparison => {
      const document = { publicUrl: url, text: `Edition: Java. ${comparison}` };
      const projected = selectGamingGameScopedDocument(document, 'Minecraft');
      expect(projected.document.text).toContain('Edition: Bedrock.');
      expect(projected.excludedReferenceCount).toBe(0);
      expect(readGamingRegistryEditionScope(projected.document, 'Minecraft'))
        .toMatchObject({ status: 'conflict' });
      expect(assess('Minecraft', comparison, 'Minecraft', 'Java'))
        .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
    });

  it.each(['this page requires Bedrock', 'this guide only works in Bedrock', 'this source only works on Bedrock'])(
    'retains an unquoted source-global requirement inside a comparison: %s', requirement => {
      const document = { publicUrl: url, text: `Edition: Java. For comparison, in Minecraft Java, ${requirement}.` };
      expect(readGamingRegistryEditionScope(document, 'Minecraft')).toMatchObject({ status: 'conflict', exclusive: true });
      const projected = selectGamingGameScopedDocument(document, 'Minecraft');
      expect(projected).toMatchObject({ status: 'unchanged', excludedReferenceCount: 0 });
      expect(readGamingRegistryEditionScope(projected.document, 'Minecraft')).toMatchObject({ status: 'conflict', exclusive: true });
    });

  it('retains an explicit source-global needs requirement without inferring a new game', () => {
    const document = { publicUrl: url, text: 'For comparison, in Minecraft Java, this article needs Bedrock.' };
    expect(selectGamingGameScopedDocument(document, 'Minecraft'))
      .toMatchObject({ status: 'unchanged', excludedReferenceCount: 0, document });
  });

  it.each(['this local mechanic requires Bedrock', 'the quoted source says "this page requires Bedrock"'])(
    'keeps a local mechanic or whole-quoted source requirement within its comparison: %s', requirement => {
      const document = { publicUrl: url, text: `Edition: Java. For comparison, in Minecraft Java, ${requirement}.` };
      const projected = selectGamingGameScopedDocument(document, 'Minecraft');
      expect(projected).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
      expect(projected.document.text).not.toContain(requirement);
      expect(readGamingRegistryEditionScope(projected.document, 'Minecraft'))
        .toMatchObject({ status: 'verified', edition: 'Java' });
    });

  it.each(['For comparison, in Fallout 4, collect the practice token in Diamond City.',
    'By comparison, in Fallout 4, collect the practice token in Amber Village near the river.'])(
    'excludes a complete local comparison containing a gameplay location: %s', comparison => {
      const document = { publicUrl: url, text: `In Fallout 76, ${passage} ${comparison}` };
      const projected = selectGamingGameScopedDocument(document, 'Fallout 76');
      expect(projected).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
      expect(projected.document.text).not.toContain(comparison);
      expect(assess('Fallout 76', comparison)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    });

  it.each(['For comparison, in Fallout 4, collect a token, but in Fallout 76, collect another token.',
    'For comparison, in Fallout 4, collect a token, but in the game Copper Vale, collect another token.',
    'For comparison, in Fallout 4, collect a token, but in Copper Vale guide, collect another token.'])(
    'retains a genuinely independent second game scope inside a comparison: %s', comparison => {
      const projected = selectGamingGameScopedDocument({ publicUrl: url, text: comparison }, 'Lantern Voyage');
      expect(projected).toMatchObject({ status: 'unchanged', excludedReferenceCount: 0 });
      expect(assess('Lantern Voyage', comparison)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    });
});
