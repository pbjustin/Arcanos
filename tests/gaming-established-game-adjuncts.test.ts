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
