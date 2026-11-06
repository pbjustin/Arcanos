import { describe, expect, it } from '@jest/globals';
import { classifyGamingDocumentQuality, isGamingDocumentOverviewOnly } from '../src/shared/gaming/gamingDocumentIngestionCore.js';

const game = 'The Legend of Zelda: Ocarina of Time';
const title = `${game} gameplay guide`;
const description = `In the game ${game}, this page lists a tutorial shield record.`;
const text = `${title} ${description}`;
const metadata = { title, headings: title };

describe('overview-only prose cannot stand in for gameplay evidence', () => {
  it('recognizes the independently acquired HTTP fixture as metadata-only', () => {
    expect(isGamingDocumentOverviewOnly(text, metadata, game)).toBe(true);
    expect(classifyGamingDocumentQuality({ cleanedText: text, metadata, game, truncated: false, minUsefulTextChars: 120 }))
      .toBe('metadata-only');
  });

  it('uses the longest acquired heading without consuming a partial word', () => {
    expect(isGamingDocumentOverviewOnly(text, { title: game, headings: title }, game)).toBe(true);
    expect(isGamingDocumentOverviewOnly(`Guidebook ${description}`, { title: 'Guide' }, game)).toBe(false);
  });

  it.each(['Lantern Voyage', 'Elite Dangerous'])('recognizes short and differently titled %s overview chunks independently of the size gate', name => {
    const heading = `${name} shield records`;
    const overview = `${heading} In the game ${name}, this page lists a shield record.`;
    expect(isGamingDocumentOverviewOnly(overview, { title: name, headings: heading }, name)).toBe(true);
  });

  it.each([
    'The Deku Shield is sold to Child Link at Kokiri Shop in Kokiri Forest for 40 Rupees.',
    'The marked gate opens when the two training switches are active.',
    'The practice token is inside the blue chest beside the village gate.',
    'Collect the practice token before opening the blue gate to preserve the training route.'
  ])('preserves a complete independent fact or action: %s', fact => {
    const evidence = `${text} ${fact}`;
    expect(isGamingDocumentOverviewOnly(evidence, metadata, game)).toBe(false);
    expect(classifyGamingDocumentQuality({ cleanedText: evidence, metadata, game, truncated: false, minUsefulTextChars: 120 }))
      .toBe('complete');
  });

  it.each([
    'This page lists a shield record at Kokiri Shop for 40 Rupees.',
    'This page lists a shield record, but the shield is available only to Child Link.',
    'This page describes how the shield blocks projectiles.',
    'This guide covers the route through Kokiri Forest.',
    'This page lists a shield record when the shop opens.',
    'This page lists a shield record'
  ])('does not discard material facts, qualifications, general descriptions or unfinished text: %s', prose => {
    expect(isGamingDocumentOverviewOnly(`${title} ${prose}`, metadata, game)).toBe(false);
  });

  it.each([
    `In the game ${game} the shield costs 40 Rupees, this guide lists a shield record.`,
    `In ${game} players buy the shield for 40 Rupees, this guide lists a shield record.`
  ])('preserves a material fact in the same sentence before the page description: %s', fact => {
    expect(isGamingDocumentOverviewOnly(`${title} ${fact}`, metadata, game)).toBe(false);
    expect(classifyGamingDocumentQuality({ cleanedText: `${title} ${fact}`, metadata, game,
      truncated: false, minUsefulTextChars: 120 })).toBe('complete');
  });

  it('does not use an arbitrary unrecognized game prelude as metadata context', () => {
    expect(isGamingDocumentOverviewOnly(text, metadata)).toBe(false);
    expect(isGamingDocumentOverviewOnly(text, metadata, 'Copper Vale')).toBe(false);
  });
});
