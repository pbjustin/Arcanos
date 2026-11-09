import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');

const url = 'https://synthetic-adjunct.example/lantern';
const game = 'Elden Ring';
const prompt = 'Explain the lantern combat technique.';
const intro = 'Elden Ring has several combat techniques. Equip the lantern before leaving the training area and preserve enough stamina to dodge attacks.';
const textFor = (sentence: string, late = false) => `Elden Ring guide ${intro} ${late ? 'An ordinary training note. '.repeat(1_400) : ''}${sentence}`;
const identity = (sentence: string, late = false) => assessGamingClearSourceIdentity({ publicUrl: url,
  metadata: { title: 'Elden Ring guide', headings: 'Elden Ring guide' }, text: textFor(sentence, late) },
{ game, mode: 'guide', prompt }, assessGamingSourcePolicy(url, game), true);

beforeEach(() => { http.mockReset(); jest.spyOn(logger, 'info').mockImplementation(() => undefined); });

describe('established-game grammatical adjuncts and independent named scope', () => {
  it.each([
    ['Elite Dangerous', 'Establish a new colony in Elite Dangerous’ outer systems.'],
    ['Elden Ring', "Equip a katana in Elden Ring's open world."],
    ['Elden Ring', 'Stagger is useful in Elden Ring--most creatures are vulnerable to it.'],
    ['Elden Ring', 'Bleed is useful in Elden Ring--many enemies are susceptible to it and the extra burst can interrupt a long attack sequence while allowing the player to recover stamina before approaching another enemy in the training area.']
  ])('retains an independently named game before a possessive or parenthetical clause: %s', (namedGame, sentence) => {
    const publicUrl = 'https://synthetic-adjunct.example/colony';
    const document = { publicUrl, metadata: { title: `${namedGame} guide`, headings: `${namedGame} guide` },
      text: `${namedGame} guide ${namedGame} has several training procedures. Equip the lantern and preserve stamina before leaving the training area. ${sentence}` };
    expect(assessGamingClearSourceIdentity(document, { game: namedGame, mode: 'guide', prompt: 'Explain the training procedure.' },
      assessGamingSourcePolicy(publicUrl, namedGame), true)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    'In the game Elden Ring Has Fallen, equip the lantern.',
    "In the game Elden Ring's Ashen Fields, equip the lantern.",
    'In the game Elden Ring--many enemies are susceptible, equip the lantern.',
    "Equip the lantern in Elden Ring's Nightreign.",
    "Equip the lantern in Elden Ring's Shadow of the Erdtree.",
    'Equip the lantern in Elden Ring--Ashen Fields.',
    'Equip the lantern in the game Dark Souls--many enemies are susceptible to it.',
    'Game: Dark Souls. Equip the lantern in Elden Ring--many enemies are susceptible to it.'
  ])('does not use grammatical continuation to erase a named foreign or qualified scope: %s', sentence => {
    expect(identity(sentence).status).not.toBe('verified');
  });

  it.each([
    ['Elite Dangerous', 'Establish a colony in Elite Dangerous’ remastered edition.'],
    ['Elite Dangerous', 'Establish a colony in Elite Dangerous Horizons’ outer systems.'],
    ['Elden Ring', 'Equip the lantern in Elden Ring--remastered enemies are susceptible.'],
    ['Elden Ring', "Equip the lantern in Elden Ring's Ashen Fields."]
  ])('retains edition and unknown-title qualifiers after grammatical ownership: %s', (namedGame, sentence) => {
    const publicUrl = 'https://synthetic-adjunct.example/colony';
    const document = { publicUrl, metadata: { title: `${namedGame} guide`, headings: `${namedGame} guide` },
      text: `${namedGame} guide ${namedGame} has several training procedures. Equip the lantern and preserve stamina before leaving the training area. ${sentence}` };
    expect(assessGamingClearSourceIdentity(document, { game: namedGame, mode: 'guide', prompt: 'Explain the training procedure.' },
      assessGamingSourcePolicy(publicUrl, namedGame), true).status).not.toBe('verified');
  });

  it.each([
    'Use the lantern in the game for both close combat and ranged battles.',
    'The lantern can be upgraded in the game by collecting three amber fragments.',
    "The lantern can be upgraded in the game by completing Rowan's training quest.",
    'The lantern is useful in the game for both PvP and PvE.',
    'The lantern arrives late enough in the game that there is plenty of time to prepare.'
  ])('does not reinterpret an ordinary adjunct as a foreign game: %s', sentence => {
    expect(identity(sentence)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    'In the game For Honor, equip the lantern.',
    'In the game for honor, equip the lantern.',
    'In the game For Honor you can inspect the lantern.',
    'In the game for honor you can inspect the lantern.',
    'In the game For Both Heroes And Villains, equip the lantern.',
    'In the game for both heroes and villains, equip the lantern.',
    'In the game for both heroes and villains you can inspect the lantern.',
    'In the game By Collecting The Stars, equip the lantern.',
    'In the game by collecting the stars, equip the lantern.',
    'In the game by collecting the stars you can inspect the lantern.',
    'In the game by sleeping giants you can inspect the lantern.',
    'The lantern appears in the game For Both Heroes and Villains.',
    'In the game "for both heroes and villains", equip the lantern.',
    'In the game "by collecting the stars", equip the lantern.',
    'The lantern arrives late enough in the game that there is Diablo IV.',
    'In the game That There Is Light, equip the lantern.',
    'In the game that there is light, equip the lantern.',
    'Game: that there is light.',
    'In the game Diablo IV, equip the lantern.',
    'In the game Elden Ring Nightreign you can inspect the lantern.',
    'This guide covers For Both Heroes And Villains.',
    'This guide covers by collecting the stars.'
  ])('keeps independently named foreign scope binding: %s', sentence => {
    expect(identity(sentence)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([
    'In the game For Honor, equip the lantern.',
    'In the game by collecting the stars you can inspect the lantern.',
    'This guide covers For Both Heroes And Villains.'
  ])('keeps later foreign scope binding beyond the positive-anchor window: %s', sentence => {
    expect(textFor(sentence, true).indexOf(sentence)).toBeGreaterThan(32_000);
    expect(identity(sentence, true)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not turn a grammatical adjunct into independent game identity', () => {
    const input = { game: 'Aster Vale', mode: 'guide' as const, prompt };
    const document = { publicUrl: url, metadata: { title: 'Aster Vale guide', headings: 'Aster Vale guide' },
      text: 'Aster Vale guide Use the lantern in the game for both close combat and ranged battles.' };
    expect(assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(url, input.game), true))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it.each([
    'Use the lantern in the game for both close combat and ranged battles.',
    "The lantern can be upgraded in the game by completing Rowan's training quest.",
    'The lantern arrives late enough in the game that there is plenty of time to prepare.'
  ])('uses grammatical guide prose through protected acquisition and normal v2 source CLEAR: %s', async sentence => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Elden Ring guide</title><body><article><h1>Elden Ring guide</h1><p>${intro}</p><p>${sentence}</p></article></body></html>` });
    const result = await evaluateGamingHybridCandidates({ game, mode: 'guide', prompt,
      protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, { actorKey: 'synthetic-adjunct-reader' });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
    expect(result.accepted[0].sourceAssessment.gates.claimSupport).toBe('verified');
  });
});

describe('explicit spoiler-warning event coverage is not a game declaration', () => {
  const warning = "Chapter 2 spoiler warning: This guide covers Mira's awakening, Tovi's rescue, and the full Varn and Kestral encounters.";

  it.each([
    warning,
    "Spoiler warning: This guide covers Mira's rescue.",
    'Spoiler warning: This guide covers Mira’s awakening and Tovi’s rescue.'
  ])('retains independent game identity with an unquoted character-event warning: %s', sentence => {
    expect(identity(sentence)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([
    "This guide covers Mira's awakening.",
    "Spoiler note: This guide covers Mira's awakening.",
    "Spoiler warning: This guide is for Mira's awakening.",
    'Spoiler warning: This guide covers "Mira’s awakening".',
    'Spoiler warning: This guide covers "Aster Vale".',
    "Spoiler warning: This guide covers Aster Vale's awakening.",
    "Spoiler warning: This guide covers Mira's Awakening.",
    "Spoiler warning: This guide covers Minecraft's awakening.",
    "Spoiler warning: This guide covers Mira's remastered.",
    "Spoiler warning: This guide covers Mira's expansion.",
    "Spoiler warning: This guide covers Mira's rescue, Diablo IV.",
    'Spoiler warning: This guide covers Mira’s rescue, "Aster Vale".',
    "Spoiler warning: This guide covers Mira's rescue, and the full Aster Vale encounters.",
    "Spoiler warning: This guide covers Mira's rescue",
    `Spoiler warning: This guide covers Mira's rescue${', Tovi\'s awakening'.repeat(12)}.`,
    `${warning}\nGame: Diablo IV.`,
    'Spoiler warning: This guide covers Edition: remastered.',
    'Spoiler warning: This guide covers Platform: PlayStation 5.'
  ])('does not erase ordinary, named, quoted, or applicability scope: %s', sentence => {
    expect(identity(sentence).status).not.toBe('verified');
  });

  it.each([
    'In the game Diablo IV, equip the lantern.',
    'This guide covers For Both Heroes And Villains.',
    'Game: Diablo IV.'
  ])('keeps later full-source contradictions binding after a warning: %s', sentence => {
    const combined = `${warning} ${sentence}`;
    expect(textFor(combined, true).indexOf(sentence)).toBeGreaterThan(32_000);
    expect(identity(combined, true)).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('still requires independent game proof outside the warning', () => {
    const input = { game: 'Aster Vale', mode: 'guide' as const, prompt };
    const document = { publicUrl: url, metadata: { title: 'Aster Vale guide', headings: 'Aster Vale guide' },
      text: `Aster Vale guide\n${warning}` };
    expect(assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(url, input.game), true))
      .toMatchObject({ status: 'unknown', reasonCodes: ['GAME_IDENTITY_UNVERIFIED'] });
  });

  it('preserves the warning through protected acquisition and normal v2 source CLEAR', async () => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Elden Ring guide</title><body><article><h1>Elden Ring guide</h1><p>${intro}</p><p>${warning}</p></article></body></html>` });
    const result = await evaluateGamingHybridCandidates({ game, mode: 'guide', prompt,
      protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, { actorKey: 'synthetic-adjunct-reader' });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
    expect(result.accepted[0].sourceAssessment.gates.claimSupport).toBe('verified');
    expect(result.accepted[0].document.text).toContain(warning);
  });

  it.each([
    ['Game: Diablo IV.', 'GAME_MISMATCH'],
    ['Edition: Shadow of the Erdtree.', 'EDITION_CONFLICT'],
    ['Platform: PS5.', 'PLATFORM_MISMATCH'],
    ['No automated use of this source is permitted.', 'SOURCE_USE_RESTRICTED']
  ])('keeps acquired restrictions binding beside a warning: %s', async (restriction, code) => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Elden Ring guide</title><body><article><h1>Elden Ring guide</h1><p>${intro}</p><p>${warning}</p><p>${restriction}</p></article></body></html>` });
    const result = await evaluateGamingHybridCandidates({ game, mode: 'guide', prompt, platform: 'PC', edition: 'base-game',
      protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, { actorKey: 'synthetic-adjunct-reader' });
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toContain(code);
  });
});
