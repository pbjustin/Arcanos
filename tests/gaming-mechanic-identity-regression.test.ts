import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));

const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');

const url = 'https://guides.example.org/independent-colonisation-guide';
const input = { game: 'Elite Dangerous', mode: 'guide' as const, prompt: 'Explain system colonisation planning and supply delivery.' };
const gtaArticleUrl = 'https://guides.example.org/gta-iv-cousins-bellic';
// Independently authored structural fixtures, not publisher text or gameplay truth claims.
const guidance = 'In Elite Dangerous, commanders plan a system colonisation project before delivering construction supplies. Compare the requested supply quantities with cargo capacity, then make delivery trips until the construction manifest is complete.';
const assess = (title: string, prose: string, game = input.game, edition?: string) => assessGamingClearSourceIdentity({
  publicUrl: url, metadata: { title, headings: title }, text: `${title}\n${prose}`
}, { ...input, game, edition }, assessGamingSourcePolicy(url, game));
const assessGtaArticleLead = (lead: string, articleScopeAssertions?: string[], retainedText = '') => assessGamingClearSourceIdentity({
  publicUrl: gtaArticleUrl,
  metadata: { title: 'GTA IV - The Cousins Bellic - Story Mission Guide', headings: 'The Cousins Bellic',
    articleScope: { label: 'GTA IV - Story Mission Guide', heading: 'The Cousins Bellic', lead },
    ...(articleScopeAssertions ? { articleScopeAssertions } : {}) },
  text: ['The Cousins Bellic', lead, retainedText].filter(Boolean).join('\n')
}, { game: 'Grand Theft Auto IV', mode: 'guide', prompt: 'What happens in the opening mission?' },
assessGamingSourcePolicy(gtaArticleUrl, 'Grand Theft Auto IV'), true);

describe('independently acquired game and mechanic ownership', () => {
  it('accepts ordinary game-qualified mechanic metadata with independent game prose', () => {
    expect(assess('Elite Dangerous System Colonisation guide', guidance))
      .toMatchObject({ status: 'verified' });
  });

  it('accepts a full game and mechanic declaration with exact independently typed ownership', () => {
    const title = 'Elite Dangerous System Colonisation guide';
    const prose = `This guide covers Elite Dangerous System Colonisation. System Colonisation is a mechanic in Elite Dangerous. ${guidance}`;
    expect(assess(title, prose)).toMatchObject({ status: 'verified' });
  });

  it('retains reviewed ownership under a second registered game and its alias', () => {
    const title = 'XC2 Driver Arts guide';
    const prose = 'This guide covers XC2 Driver Arts. Driver Arts is a mechanic in Xenoblade Chronicles 2. '
      + 'In Xenoblade Chronicles 2, land auto-attacks while fighting alongside Pyra to charge Rex’s Driver Arts.';
    expect(assess(title, prose, 'Xenoblade Chronicles 2')).toMatchObject({ status: 'verified' });
    expect(assess(title, prose, 'Elden Ring')).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('accepts an unfamiliar game-qualified topic without a production game exception', () => {
    const title = 'Copper Vale Orchard Restoration guide';
    const prose = 'This guide covers Copper Vale Orchard Restoration. Orchard Restoration is a mechanic in Copper Vale. In Copper Vale, players restore the orchard by delivering supplies and monitoring the project manifest.';
    expect(assess(title, prose, 'Copper Vale')).toMatchObject({ status: 'verified' });
  });

  it('checks the edition-qualified prefix when the base prefix has no acquired topic definition', () => {
    expect(assess('Lantern Voyage Remake System Colonisation guide',
      'This guide covers Lantern Voyage Remake System Colonisation. System Colonisation is a mechanic in Lantern Voyage. In Lantern Voyage, players deliver construction supplies.',
      'Lantern Voyage', 'Remake')).toMatchObject({ status: 'verified' });
  });

  const editionTitle = 'Lantern Voyage Remake System Colonisation guide';
  const editionProse = (early: string, late = 'Remake System Colonisation is a mechanic in Lantern Voyage.') =>
    `This guide covers Lantern Voyage Remake System Colonisation. ${early} In Lantern Voyage, players deliver construction supplies. ${'The cargo manifest remains available for project planning. '.repeat(600)} ${late}`;

  it('retains early edition-qualified ownership when another matching prefix has only late proof', () => {
    const prose = editionProse('System Colonisation is a mechanic in Lantern Voyage.');
    const text = `${editionTitle}\n${prose}`;
    expect(text.indexOf('System Colonisation is a mechanic')).toBeLessThan(32_000);
    expect(text.indexOf('Remake System Colonisation is a mechanic')).toBeGreaterThan(32_000);
    expect(assess(editionTitle, prose, 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'verified' });
  });

  it('does not use matching scopes outside the positive proof window as independent ownership', () => {
    expect(assess(editionTitle, editionProse(''), 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('retains foreign ownership across matching prefix collections', () => {
    expect(assess(editionTitle, editionProse('System Colonisation is a mechanic in Fallout 4.'), 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([
    'System Colonisation is a mechanic in Lantern Voyage. System Colonisation is a mechanic in Copper Vale.',
    'System Colonisation is a mechanic in Copper Vale.',
  ])('inspects contradictory ownership after the proof window across matching scopes: %s', contradiction => {
    expect(assess(editionTitle, editionProse('System Colonisation is a mechanic in Lantern Voyage.', contradiction), 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([
    ['System Colonisation is a mechanic in Lantern Voyage.', 'Remake System Colonisation is a mechanic in Copper Vale.'],
    ['Remake System Colonisation is a mechanic in Lantern Voyage.', 'System Colonisation is a mechanic in Copper Vale.'],
  ])('requires matching ownership from every prefix collection: %s / %s', (early, late) => {
    expect(assess(editionTitle, editionProse(early, late), 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it.each([undefined, 'Deluxe'])('rejects an unrequested or incompatible edition despite early mechanic ownership: %s', edition => {
    expect(assess(editionTitle, editionProse('System Colonisation is a mechanic in Lantern Voyage.'), 'Lantern Voyage', edition))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('preserves direct full-nominal-scope precedence over valid early suffix ownership', () => {
    expect(assess(editionTitle, editionProse('System Colonisation is a mechanic in Lantern Voyage.',
      'Lantern Voyage Remake System Colonisation is a mechanic in Lantern Voyage.'), 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('does not override foreign full-nominal ownership with a valid suffix', () => {
    expect(assess(editionTitle, editionProse('System Colonisation is a mechanic in Lantern Voyage.',
      'Lantern Voyage Remake System Colonisation is a mechanic in Copper Vale.'), 'Lantern Voyage', 'Remake'))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('does not let an edition-qualified prefix supply absent mechanic ownership', () => {
    expect(assess('Lantern Voyage Remake System Colonisation guide',
      'This guide covers Lantern Voyage Remake System Colonisation. In Lantern Voyage, players deliver construction supplies.',
      'Lantern Voyage', 'Remake')).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('retains foreign mechanic ownership despite a matching edition-qualified prefix', () => {
    expect(assess('Lantern Voyage Remake System Colonisation guide',
      'This guide covers Lantern Voyage Remake System Colonisation. System Colonisation is a mechanic in Fallout 4. In Lantern Voyage, players deliver construction supplies.',
      'Lantern Voyage', 'Remake')).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not reinterpret an unrequested remake as the requested edition', () => {
    expect(assess('Lantern Voyage Remake System Colonisation guide',
      'This guide covers Lantern Voyage Remake System Colonisation. System Colonisation is a mechanic in Lantern Voyage. In Lantern Voyage, players deliver construction supplies.',
      'Lantern Voyage', 'Deluxe')).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('accepts a generic mechanic heading with independently named game ownership', () => {
    expect(assess('System Colonisation guide', `In the game Elite Dangerous, commanders plan a system colonisation project. ${guidance}`))
      .toMatchObject({ status: 'verified' });
  });

  it.each([
    ['Xenoblade Chronicles 2 Blade Combos guide', 'Blade Combos is a mechanic in Xenoblade Chronicles 2. Rex can execute a Blade Combo by chaining elemental Blade Specials.', 'Xenoblade Chronicles 2'],
    ['Elite Dangerous Supercruise Assist guide', 'Supercruise Assist is a mechanic in Elite Dangerous. A pilot selects the destination and enables the Supercruise Assist module on the navigation panel.', 'Elite Dangerous'],
    ['GTA IV Jamaican Heat mission guide', 'Jamaican Heat is a mission in Grand Theft Auto IV. Niko picks up Little Jacob and covers him during the meeting.', 'Grand Theft Auto IV'],
  ])('preserves exact acquired ownership for the independently authored topic %s', (title, prose, game) => {
    expect(assess(title, prose, game)).toMatchObject({ status: 'verified' });
  });

  it.each([
    ['Xenoblade Chronicles 2 Blade Combos guide', 'Blade Combos is a mechanic in Elite Dangerous. Rex can execute a Blade Combo by chaining elemental Blade Specials.', 'Xenoblade Chronicles 2', 'conflict'],
    ['Elite Dangerous Supercruise Assist guide', 'Supercruise Assist is a mechanic in Copper Vale. A pilot selects the destination and enables the module.', 'Elite Dangerous', 'unknown'],
    ['GTA IV Jamaican Heat mission guide', 'Jamaican Heat is a mission in Grand Theft Auto V. Niko picks up Little Jacob and covers him during the meeting.', 'Grand Theft Auto IV', 'conflict'],
  ])('keeps conflicting acquired topic ownership fail-closed for %s', (title, prose, game, status) => {
    expect(assess(title, prose, game)).toMatchObject({ status });
  });

  it('accepts an affirmative registered actor within an acquired subject group', () => {
    expect(assessGtaArticleLead('Niko and his fellow immigrants climb off the Platipus ship in Liberty City with Roman.'))
      .toMatchObject({ status: 'verified', reasonCodes: ['ACQUIRED_ARTICLE_SCOPE_IDENTITY'] });
  });

  it('accepts the full registered Niko Bellic name as the action actor', () => {
    expect(assessGtaArticleLead('Niko Bellic and his fellow immigrants climb off the Platipus ship in Liberty City with Roman.'))
      .toMatchObject({ status: 'verified', reasonCodes: ['ACQUIRED_ARTICLE_SCOPE_IDENTITY'] });
  });

  it.each([
    ['an uncertain planned scene', 'The expected scene has Niko climb off the boat in Liberty City with Roman.'],
    ['a planned event', 'The plan says Niko climbs off the boat in Liberty City with Roman.'],
    ['a prospective event', 'Niko is expected to climb off the boat in Liberty City with Roman.'],
    ['a different actor', 'Niko and Roman wait in Liberty City while a sailor climbs off the boat.'],
    ['a coordinated different actor', 'Roman waits in Liberty City with Niko and watches a sailor climb off the boat.'],
  ])('does not corroborate a registered guide topic from %s', (_reason, lead) => {
    expect(assessGtaArticleLead(lead)).toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('treats omitted whole-article contradictory game scope as negative-only evidence', () => {
    expect(assessGtaArticleLead(
      'Niko and his fellow immigrants climb off the Platipus ship in Liberty City with Roman.',
      ['In Grand Theft Auto V, this guide covers a related mission.']))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not use an omitted article assertion as positive gameplay identity proof', () => {
    expect(assessGtaArticleLead('The opening mission is discussed in this overview.',
      ['In Grand Theft Auto IV, this guide covers The Cousins Bellic.']))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('keeps an omitted author-authored contradiction even when the selected prose quotes the same words', () => {
    const assertion = 'In Grand Theft Auto V, this guide covers a related mission.';
    expect(assessGtaArticleLead('Niko and his fellow immigrants climb off the Platipus ship in Liberty City with Roman.',
      [assertion], `\"${assertion}\"`)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not classify an arbitrary article topic clause as a foreign game', () => {
    expect(assessGtaArticleLead('Niko and his fellow immigrants climb off the Platipus ship in Liberty City with Roman.',
      ['This guide covers Kokiri Forest sells the Deku Shield for 40 Rupees.']))
      .toMatchObject({ status: 'verified' });
  });

  it('requires exact acquired mechanic ownership for an ambiguous family suffix', () => {
    expect(assess('Elite Dangerous System Colonisation guide', `This guide covers Elite Dangerous System Colonisation. ${guidance}`))
      .toMatchObject({ status: 'unknown', diagnostic: { ruleId: 'gaming.identity.family_scope_unverified' } });
  });

  it.each([
    'Orbital Planning is a mechanic in Elite Dangerous.',
    'System Colonisation is not a mechanic in Elite Dangerous.',
    '"System Colonisation is a mechanic in Elite Dangerous."',
    `${'The cargo manifest remains available for project planning. '.repeat(600)} System Colonisation is a mechanic in Elite Dangerous.`,
  ])('retains family ambiguity when the definition is unrelated, negated, quoted or outside the proof window', definition => {
    expect(assess('Elite Dangerous System Colonisation guide', `This guide covers Elite Dangerous System Colonisation. ${guidance} ${definition}`))
      .toMatchObject({ status: 'unknown', diagnostic: { ruleId: 'gaming.identity.family_scope_unverified' } });
  });

  it('preserves conservative registered-family ambiguity for an unfamiliar mechanic suffix', () => {
    expect(assess('Minecraft Orchard Restoration guide', 'This guide covers Minecraft Orchard Restoration. Orchard Restoration is a mechanic in Minecraft. In Minecraft, players restore the orchard by delivering supplies.', 'Minecraft'))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('retains explicit sequel qualifiers despite an acquired mechanic definition', () => {
    expect(assess('Elite Dangerous II System Colonisation guide', `This guide covers Elite Dangerous II System Colonisation. II System Colonisation is a mechanic in Elite Dangerous. ${guidance}`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('retains registered expansion qualifiers despite an acquired mechanic definition', () => {
    expect(assess('Elden Ring Shadow of the Erdtree Orchard Restoration guide', 'This guide covers Elden Ring Shadow of the Erdtree Orchard Restoration. Shadow of the Erdtree Orchard Restoration is a mechanic in Elden Ring. In Elden Ring, players deliver supplies to the orchard.', 'Elden Ring'))
      .toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('does not infer game ownership from a generic mechanic heading alone', () => {
    expect(assess('System Colonisation guide', guidance.replace('In Elite Dangerous, ', '')))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('retains wrong-game declarations even beside matching mechanic ownership', () => {
    expect(assess('Elite Dangerous System Colonisation guide', `This guide covers Elite Dangerous System Colonisation. System Colonisation is a mechanic in Elite Dangerous. In the game Copper Vale, players deliver supplies. ${guidance}`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('retains a contradictory ownership definition for the same mechanic', () => {
    expect(assess('Elite Dangerous System Colonisation guide', `System Colonisation is a mechanic in Elite Dangerous. System Colonisation is a mechanic in Copper Vale. ${guidance}`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not promote quoted mechanic ownership to affirmative evidence', () => {
    expect(assess('Elite Dangerous System Colonisation guide', `This guide covers Elite Dangerous System Colonisation. "System Colonisation is a mechanic in Elite Dangerous." ${guidance}`))
      .toMatchObject({ status: 'unknown' });
  });

  it('cannot reinterpret an explicitly named different game as a mechanic', () => {
    expect(assess('Elite Dangerous System Colonisation guide', `In the game Elite Dangerous System Colonisation, players deliver supplies. System Colonisation is a mechanic in Elite Dangerous. ${guidance}`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('preserves valid HTML article prose and its independent mechanic definition through acquisition', async () => {
    const title = 'Elite Dangerous System Colonisation guide';
    fetch.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>${title}</title><body><article><h1>${title}</h1><p>This guide covers Elite Dangerous System Colonisation.</p><p>System Colonisation is a mechanic in Elite Dangerous.</p><p>${guidance}</p></article></body></html>` });
    const document = await resolveGamingDocument(url);
    expect(document.text).toContain('System Colonisation is a mechanic in Elite Dangerous.');
    expect(document.text).toContain(guidance);
    expect(document.metadata).toMatchObject({ title, headings: title });
    expect(assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(url, input.game)))
      .toMatchObject({ status: 'verified' });
  });
});
