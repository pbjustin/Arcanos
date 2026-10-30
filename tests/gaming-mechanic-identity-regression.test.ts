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
// Independently authored structural fixtures, not publisher text or gameplay truth claims.
const guidance = 'In Elite Dangerous, commanders plan a system colonisation project before delivering construction supplies. Compare the requested supply quantities with cargo capacity, then make delivery trips until the construction manifest is complete.';
const assess = (title: string, prose: string, game = input.game, edition?: string) => assessGamingClearSourceIdentity({
  publicUrl: url, metadata: { title, headings: title }, text: `${title}\n${prose}`
}, { ...input, game, edition }, assessGamingSourcePolicy(url, game));

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
