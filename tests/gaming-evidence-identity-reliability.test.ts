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

describe('corroborating scoped GTA IV mission evidence', () => {
  const game = 'Grand Theft Auto IV';
  const heading = 'The Cousins Bellic';
  const label = 'GTA IV - Story Mission Guide';
  const lead = 'After Niko steps off the boat in Liberty City, Roman hands him the keys.';
  const action = 'Follow the yellow GPS route and drive to the apartment.';

  function assessMission(options: { title?: string; label?: string; scopeHeading?: string; lead?: string; scope?: boolean; scopedLead?: string; scoped?: boolean } = {}) {
    const document = {
      publicUrl: 'https://guides.example.org/grand-theft-auto-iv/the-cousins-bellic',
      metadata: { title: options.title ?? heading, headings: heading,
        ...(options.scope === false ? {} : { articleScope: { heading: options.scopeHeading ?? heading, label: options.label ?? label,
          lead: options.scopedLead ?? options.lead ?? lead } }) },
      text: `${heading} ${options.lead ?? lead} ${action}`
    };
    return assessGamingClearSourceIdentity(document,
      { game, mode: 'guide', prompt: 'What should I do next?' }, assessGamingSourcePolicy(document.publicUrl, game), options.scoped !== false);
  }

  it('binds a retained mission heading, scoped alias and contextual opening sentence', () => {
    expect(assessMission())
      .toMatchObject({ status: 'verified', gameIdentityVerified: true, reasonCodes: ['ACQUIRED_ARTICLE_SCOPE_IDENTITY'] });
  });

  it.each([
    { scope: false, title: 'GTA IV - The Cousins Bellic - Story Mission Guide' },
    { scoped: false, title: 'GTA IV - The Cousins Bellic - Story Mission Guide' },
    { scopeHeading: 'An unrelated mission' },
    { scopedLead: 'An opening statement with no game information.' },
    { lead: `${'Observe the training area. '.repeat(90)}${lead}`, scopedLead: lead },
    { lead: 'Niko, Roman, Liberty City.' },
    { lead: 'A poster shows Niko and Roman near Liberty City.' },
    { lead: 'Niko and Roman are two real musicians from Liberty City.' },
    { lead: 'If Niko and Roman arrive in Liberty City by boat, players could ask them for directions.' },
    { lead: 'Just like Niko and Roman near Liberty City, your spaceship has a green compass.' },
    { lead: '“Niko meets Roman near Liberty City.' },
    { label: 'GTA - Story Mission Guide' },
    { lead: 'Niko steps off the boat and an unnamed driver picks him up.' },
    { lead: 'Niko is on a boat. Liberty City is a location. Roman is a character.' },
    { lead: 'For comparison, Niko arrives in Liberty City and meets Roman.' },
    { lead: '“Niko steps off the boat in Liberty City and meets Roman.”' },
    { lead: 'Niko arrives in Liberty City but never meets Roman.' }
  ])('rejects uncorroborated or incidental evidence: %j', options => {
    expect(assessMission(options)).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it.each(['GTA VI', 'GTA Vice City', 'GTA IV: The Lost and Damned'])('withholds an unrecognized or narrower article label %s', other => {
    expect(assessMission({ label: `${other} - Story Mission Guide`, lead: `In the game Grand Theft Auto IV, ${lead}` }))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it.each(['GTA III', 'GTA V', 'GTA V - PS5'])('keeps an affirmative %s article scope contradictory even with all GTA IV entities', wrongGame => {
    expect(assessMission({ label: `${wrongGame} - Story Mission Guide`, title: 'GTA IV - The Cousins Bellic' }))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    expect(assessMission({ lead: `${lead} In the game ${wrongGame.split(' - ')[0]}, drive to the start point.` }))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
});

describe('scoped article corroboration across games', () => {
  const fixtures = [
    { game: 'Grand Theft Auto IV', heading: 'The Cousins Bellic',
      lead: 'After Niko steps off the boat in Liberty City, Roman hands him the keys.',
      unrelatedObject: 'Niko climbs off the roof next to a ship in Liberty City, where Roman meets him.',
      incidental: 'Niko, Roman, and Liberty City appear on a poster showing someone stepping off the boat.' },
    { game: 'Elden Ring', heading: 'Church of Elleh',
      lead: 'At the Church of Elleh, use Smithing Stones at the Smithing Table to strengthen your weapon.',
      unrelatedObject: 'Use the blue lever near Smithing Stones at the Smithing Table in the Church of Elleh.',
      incidental: 'A gallery caption shows the Church of Elleh, the Smithing Table, and Smithing Stones.' },
    { game: 'Xenoblade Chronicles 2', heading: 'Driver Arts',
      lead: "Use auto-attacks with Pyra to recharge Rex's Driver Arts while fighting in range.",
      unrelatedObject: 'Rex and Pyra recharge the lantern near the Driver Arts display after auto-attacks.',
      incidental: 'The glossary lists Rex, Pyra, auto-attacks, and Driver Arts.' },
    { game: 'Elite Dangerous', heading: 'System Colonisation',
      lead: 'Open the System Colonisation Contact in station services and select an unpopulated star system on the Galaxy Map.',
      unrelatedObject: 'Use the System Colonisation Contact from station services on the Galaxy Map to select a tab beside a system.',
      incidental: 'The wiki index lists the System Colonisation Contact, station services, and the Galaxy Map.' }
  ];

  function assessScoped(fixture: typeof fixtures[number], lead: string, labelGame = fixture.game) {
    return assessGamingClearSourceIdentity({
      publicUrl: url,
      metadata: { title: fixture.heading, headings: fixture.heading,
        articleScope: { heading: fixture.heading, label: `${labelGame} - Gameplay Guide`, lead } },
      text: `${fixture.heading} ${lead}`
    }, { game: fixture.game, mode: 'guide', prompt: 'How do I use this mechanic?' },
    assessGamingSourcePolicy(url, fixture.game), true);
  }

  it.each(fixtures)('uses one rule to verify an attributable $game mechanic', fixture => {
    expect(assessScoped(fixture, fixture.lead))
      .toMatchObject({ status: 'verified', reasonCodes: ['ACQUIRED_ARTICLE_SCOPE_IDENTITY'] });
  });

  it('accepts a different wording of a reviewed gameplay relationship', () => {
    expect(assessScoped(fixtures[0], 'Niko arrives in Liberty City by boat, and Roman waits on the pier.'))
      .toMatchObject({ status: 'verified', reasonCodes: ['ACQUIRED_ARTICLE_SCOPE_IDENTITY'] });
  });

  it.each([
    "Niko doesn't get off the boat in Liberty City, where Roman waits.",
    'Roman may arrive by boat in Liberty City, where Niko waits.'
  ])('rejects a negated or uncertain identity claim: %s', lead => {
    expect(assessScoped(fixtures[0], lead)).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it('requires the action and every entity in the same affirmative claim', () => {
    for (const lead of [
      'Use Smithing Stones to reinforce your weapon; the Smithing Table stands in the Church of Elleh.',
      "Don't use Smithing Stones at the Smithing Table in the Church of Elleh.",
      'Never use Smithing Stones at the Smithing Table in the Church of Elleh.'
    ]) expect(assessScoped(fixtures[1], lead)).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it.each(fixtures)('withholds $game references, quoted gameplay, and evidence from another game', fixture => {
    const foreign = fixtures.find(other => other.game !== fixture.game)!;
    for (const lead of [fixture.incidental, fixture.unrelatedObject, `"${fixture.lead}"`, `For comparison, ${fixture.lead}`, foreign.lead]) {
      expect(assessScoped(fixture, lead)).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
    }
    expect(assessScoped(fixture, fixture.lead, foreign.game)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });
});
