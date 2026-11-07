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

  it.each(['gameplay guide', 'guide', 'walkthrough'])('recognizes only an exact generic game %s heading when retained metadata is absent', heading => {
    expect(isGamingDocumentOverviewOnly(`${game} ${heading} ${description}`, undefined, game)).toBe(true);
    expect(isGamingDocumentOverviewOnly(`${game} ${heading} shield costs 40 Rupees. ${description}`, undefined, game)).toBe(false);
    expect(isGamingDocumentOverviewOnly(`Copper Vale ${heading} ${description}`, undefined, game)).toBe(false);
    expect(isGamingDocumentOverviewOnly(`${game} ${heading}book ${description}`, undefined, game)).toBe(false);
  });

  it.each([
    'The Deku Shield is sold to Child Link at Kokiri Shop for 40 Rupees',
    'The crimson shield deflects projectiles'
  ])('preserves acquired gameplay facts in a heading before a pure overview: %s', heading => {
    const evidence = `${heading} ${description}`;
    const acquiredMetadata = { title: heading, headings: heading };
    expect(isGamingDocumentOverviewOnly(evidence, acquiredMetadata, game)).toBe(false);
    expect(classifyGamingDocumentQuality({ cleanedText: evidence, metadata: acquiredMetadata, game,
      truncated: false, minUsefulTextChars: 120 })).toBe('complete');
  });

  it.each([
    'This page lists tutorial shield records.',
    'This article indexes tutorial shield records.',
    'This guide catalogues tutorial shield records.',
    'This page provides an overview of tutorial shield acquisition.',
    'This article describes tutorial shield acquisition.',
    'This guide covers tutorial shield locations.',
    'This article explains how to acquire the tutorial shield.',
    'This page provides information about tutorial shield acquisition.',
    'This guide contains an overview of the shield locations.',
    'The following section describes the tutorial shield acquisition.',
    'This article provides an overview of tutorial shield acquisition. This page indexes tutorial shield records.'
  ])('recognizes varied wording that supplies only a subject, without a gameplay claim: %s', descriptionOnly => {
    const overview = `${title} In the game ${game}, ${descriptionOnly.charAt(0).toLowerCase()}${descriptionOnly.slice(1)}`;
    expect(isGamingDocumentOverviewOnly(overview, metadata, game)).toBe(true);
    expect(classifyGamingDocumentQuality({ cleanedText: overview, metadata, game, truncated: false, minUsefulTextChars: 120 }))
      .toBe('metadata-only');
  });

  it.each([
    'This page describes the shield price as 40 Rupees.',
    'This guide covers shield locations in Kokiri Forest.',
    'This page provides an overview of shield acquisition, but the shield is sold only to Child Link.',
    'This article describes shield acquisition when the shop opens.',
    'This page provides an overview: the shield is sold at Kokiri Shop for 40 Rupees.',
    'This page explains that the shield costs 40 Rupees at Kokiri Shop.',
    'This page explains that the shield is sold at Kokiri Shop.',
    'This article describes shield acquisition at Kokiri Shop location.',
    'This guide covers shield acquisition after the training gate opens.',
    'This article describes shield acquisition without the practice token.',
    'This article describes shield acquisition requiring the practice token.',
    'This article explains how to buy the shield for forty Rupees.',
    'This guide contains an overview of shield locations near Kokiri Shop.',
    'This page provides information about shield acquisition only after training.',
    'This article describes shield acquisition. The shield is sold at Kokiri Shop.',
    'This page describes the shield deflecting projectiles.',
    'This page covers the gate glowing red.',
    'This article explains how to acquire the shield deflecting projectiles.',
    'This article explains how to reach the gate glowing red.'
  ])('preserves values and qualifications within the varied description wording: %s', fact => {
    expect(isGamingDocumentOverviewOnly(`${title} ${fact}`, metadata, game)).toBe(false);
  });

  it.each([
    'This article describes tutorial shield acquisition',
    'This article describes tutorial shield acquisition. This page provides',
    'This article describes the complete detailed beginner tutorial shield acquisition location price qualification reference overview.'
  ])('keeps unfinished and over-budget descriptions conservative: %s', fragment => {
    expect(isGamingDocumentOverviewOnly(`${title} ${fragment}`, metadata, game)).toBe(false);
  });
});
