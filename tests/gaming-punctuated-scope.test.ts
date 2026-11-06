import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { selectGamingGameScopedDocument } from '../src/shared/gaming/gamingStructuralEvidence.js';

const publicUrl = 'https://guides.example.org/punctuated-title';
const passage = 'prepare for the first boss by equipping a suitable weapon and assigning a healing item before leaving the lantern checkpoint.';
function identity(game: string, text: string) {
  return assessGamingClearSourceIdentity({ publicUrl, text, metadata: { title: `${game} walkthrough` } },
    { game, mode: 'guide', prompt: 'How do I prepare for the first boss?' }, assessGamingSourcePolicy(publicUrl, game));
}

describe('internal title punctuation is not a scope sentence boundary', () => {
  it.each(['Kingdom Hearts HD 1.5 Remix', 'Lantern Voyage 1.5'])('retains exact independently acquired %s identity', game => {
    expect(identity(game, `In the game ${game}, ${passage}`)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(identity(game, `This guide covers ${game}. In the game ${game}, ${passage}`))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['For comparison,', 'For comparison:', 'By comparison:'])('excludes the whole bounded decimal-title reference after %s', frame => {
    const game = 'Fallout 76';
    const reference = `${frame} in Kingdom Hearts HD 1.5 Remix, the practice mechanic differs.`;
    const document = { publicUrl, text: `In the game ${game}, ${passage} ${reference}` };
    const scoped = selectGamingGameScopedDocument(document, game);
    expect(scoped).toMatchObject({ status: 'projected', excludedReferenceCount: 1 });
    expect(scoped.document.text).not.toContain('Kingdom Hearts');
    expect(identity(game, document.text)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('retains a real independently named decimal game contradiction', () => {
    expect(identity('Fallout 76', `In the game Fallout 76, ${passage} In the game Kingdom Hearts HD 1.5 Remix, ${passage}`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('accepts a plain-text guide only with independently acquired full named-game scope', () => {
    const game = 'Kingdom Hearts HD 1.5 Remix';
    const assess = (text: string) => assessGamingClearSourceIdentity({ publicUrl, text, metadata: {} },
      { game, mode: 'guide', prompt: 'How do I prepare for the first boss?' }, assessGamingSourcePolicy(publicUrl, game));
    expect(assess(`In the game ${game}, ${passage}`)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(assess(passage).gameIdentityVerified).toBe(false);
    expect(assess(`For comparison: in the game ${game}, ${passage}`).gameIdentityVerified).toBe(false);
    expect(assess(`In the game ${game}, ${passage} In the game Copper Vale, collect the token.`))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not manufacture a sentence boundary at the acquired subject scan edge', () => {
    const game = 'Kingdom Hearts HD 1.5 Remix';
    const suffix = 'Hearts HD 1.5 Remix.';
    const subject = `Kingdom${' '.repeat(160 - 'Kingdom'.length - suffix.length)}${suffix}`;
    expect(subject).toHaveLength(160);
    expect(identity(game, `In the game ${subject}x, ${passage}`).gameIdentityVerified).toBe(false);
  });

  it.each([
    'For comparison: in Kingdom Hearts HD 1.5 Remix, the exercise',
    `For comparison: in Kingdom Hearts HD 1.5 Remix, ${'practice '.repeat(70)}the mechanic differs.`
  ])('keeps an incomplete or over-budget decimal reference inspectable: %s', reference => {
    const document = { publicUrl, text: `In the game Fallout 76, ${passage} ${reference}` };
    expect(selectGamingGameScopedDocument(document, 'Fallout 76').excludedReferenceCount).toBe(0);
    expect(identity('Fallout 76', document.text).gameIdentityVerified).toBe(false);
  });
});
