import { describe, expect, it } from '@jest/globals';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { gamingApplicabilityAssertionContext, readGamingRegistryEditionScope } from '../src/shared/gaming/gamingGameRegistry.js';

const publicUrl = 'https://guides.example.org/comparison-fixture';
function identity(reference: string, game = 'Fallout 76') {
  const title = `${game} walkthrough`;
  return assessGamingClearSourceIdentity({ publicUrl, metadata: { title, headings: title },
    text: `${title}. In the game ${game}, players collect the practice token at the marked gate and inspect the practice route. ${reference}` },
  { game, mode: 'guide', prompt: 'How do I collect the practice token?' }, assessGamingSourcePolicy(publicUrl, game));
}

describe('comparison framing in acquired identity and edition parsers', () => {
  it.each(['shop', 'world', 'menu'])('retains acquired identity for ordinary in-the-game %s locations', place => {
    expect(identity(`Buy the practice token in the game ${place}.`))
      .toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['For comparison', 'By comparison'])('keeps %s colon references local in the direct edition parser', frame => {
    const comparison = `${frame}: in Minecraft Bedrock, the practice mechanic differs.`;
    expect(gamingApplicabilityAssertionContext(comparison, comparison.indexOf('in Minecraft')))
      .toEqual({ reference: true, complete: true });
    expect(readGamingRegistryEditionScope({ text: comparison }, 'Minecraft')).toMatchObject({ status: 'none' });
    expect(readGamingRegistryEditionScope({ text: `Edition: Java. ${comparison}` }, 'Minecraft'))
      .toMatchObject({ status: 'verified', edition: 'Java' });
  });

  it.each(['For comparison:', 'By comparison:'])('retains global edition declarations after %s', frame => {
    expect(readGamingRegistryEditionScope({ text: `Edition: Java. ${frame} in Minecraft Java, Edition: Bedrock.` }, 'Minecraft'))
      .toMatchObject({ status: 'conflict' });
    expect(readGamingRegistryEditionScope({ text: `Edition: Java. ${frame} in Minecraft Java, this page requires Bedrock.` }, 'Minecraft'))
      .toMatchObject({ status: 'conflict', exclusive: true });
  });

  it.each([
    'For comparison: in Minecraft Bedrock',
    'By comparison: in Minecraft Bedrock, the mechanic',
    `For comparison: ${'in Minecraft Bedrock, '.padEnd(511, 'x')}.x`,
    `By comparison: in Minecraft Bedrock, ${'practice '.repeat(70)}the mechanic differs.`
  ])('does not verify an incomplete or over-budget edition comparison: %s', comparison => {
    expect(readGamingRegistryEditionScope({ text: `Edition: Java. ${comparison}` }, 'Minecraft').status).not.toBe('verified');
  });

  it.each(['Elden Ring', 'Copper Vale', '"Copper Vale"'])('retains independently named game %s after a colon comparison', game => {
    expect(identity(`For comparison: in Fallout 4, the exercise differs. In the game ${game}, collect the practice token.`))
      .toMatchObject({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'] });
  });
});
