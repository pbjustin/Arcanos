import { describe, expect, it } from '@jest/globals';
import { GAMING_GAME_REGISTRY, validateGamingGameRegistry, resolveGamingRegistryGame,
  detectGamingRegistryAlias, normalizeGamingRegistryEdition, gamingRegistrySourceGameMatchesRequest,
  gamingRegistryDistinctScopeQualifier, gamingRegistryRelatedScopeNames, readGamingRegistryEditionScope,
  gamingApplicabilityAssertionText } from '../src/shared/gaming/gamingGameRegistry.js';
import { extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';

describe('plural possession preserves applicability inspection', () => {
  it.each([
    'Establish a colony in Elite Dangerous’ galactic legacy.',
    "Establish a colony in Elite Dangerous' galactic legacy.",
    'In this guide we’ll explain how to settle in Elite Dangerous’ outer systems.',
    'Equip the lantern in Dark Souls’ open world.'
  ])('does not mistake ordinary nominal possession for an open quotation: %s', text => {
    expect(gamingApplicabilityAssertionText(text, 'Elite Dangerous')).toEqual({ text, complete: true });
  });

  it.each([
    "In 'Elite Dangerous’ galactic legacy.",
    'In “Elite Dangerous’ galactic legacy.',
    'In Elite Dangerous’ “galactic legacy.',
    'Game: Elite Dangerous’ galactic legacy.',
    'This guide covers Elite Dangerous’ galactic legacy.',
    'In the game Elite Dangerous’ galactic legacy.',
    'In Elite Dangerous’ Remastered Edition.',
    'In Elite Dangerous’',
    'In Elite Dangerous ’ galactic legacy.',
    'In Elite Dangerous’’ galactic legacy.',
    "In Elite Dangerous’ outer systems; Platforms: 'PS5.",
    'In Elite Dangerous’ outer systems; Edition: “Legacy.'
  ])('keeps explicit declarations and malformed or unclosed quotations uncertain: %s', text => {
    expect(gamingApplicabilityAssertionText(text, 'Elite Dangerous').complete).toBe(false);
  });

  it('preserves source-global platform and edition fields after nominal possession', () => {
    const text = 'Establish a colony in Elite Dangerous’ outer systems. Platforms: PS5. Edition: Legacy.';
    const freshness = extractGamingFreshnessMetadata({ publicUrl: 'https://synthetic.example/colony', text,
      metadata: { title: 'Elite Dangerous colony guide' } }, { game: 'Elite Dangerous', platform: 'PC' });
    expect(freshness).toMatchObject({ platforms: ['PS5'], edition: 'Legacy' });
    expect(freshness.metadataUnverified).not.toBe(true);
    expect(gamingApplicabilityAssertionText(text, 'Elite Dangerous').text).toBe(text);
  });

  it('continues treating complete quoted gameplay and restrictions as references', () => {
    const text = 'The source quotes: “In Elite Dangerous’ outer systems. Platforms: PS5.”';
    const freshness = extractGamingFreshnessMetadata({ publicUrl: 'https://synthetic.example/colony', text,
      metadata: { title: 'Elite Dangerous colony guide' } }, { game: 'Elite Dangerous', platform: 'PC' });
    expect(gamingApplicabilityAssertionText(text, 'Elite Dangerous').complete).toBe(true);
    expect(freshness.platforms).toBeUndefined();
  });
});

describe('versioned game recognition is independent of acquired proof', () => {
  it('keeps stable identifiers, edition relationships and provenance in reviewed data', () => {
    expect(GAMING_GAME_REGISTRY.version).toBe('gaming-game-registry/v1');
    expect(GAMING_GAME_REGISTRY.revision).toBeTruthy();
    expect(resolveGamingRegistryGame('Diablo IV')?.id).toBe('diablo-4');
    expect(resolveGamingRegistryGame('World of Warcraft')?.provenance.references.length).toBeGreaterThan(0);
    expect(Object.isFrozen(GAMING_GAME_REGISTRY.games)).toBe(true);
  });
  it('selects the longest acquired leading title without collapsing relatives', () => {
    expect(detectGamingRegistryAlias('Elden Ring Nightreign guide', true)?.name).toBe('Elden Ring Nightreign');
    expect(detectGamingRegistryAlias('Minecraft Dungeons guide', true)?.name).toBe('Minecraft Dungeons');
    expect(gamingRegistrySourceGameMatchesRequest('Minecraft Dungeons', 'Minecraft')).toBe(false);
    expect(gamingRegistrySourceGameMatchesRequest('Elden Ring Nightreign', 'Elden Ring')).toBe(false);
    expect(gamingRegistrySourceGameMatchesRequest('Elden Ring Shadow of the Erdtree', 'Elden Ring')).toBe(false);
  });
  it('recognizes configured editions without deriving a requested edition or source trust', () => {
    expect(normalizeGamingRegistryEdition('Minecraft', 'Java Edition')).toBe('Java');
    expect(gamingRegistrySourceGameMatchesRequest('Minecraft Java Edition', 'Minecraft')).toBe(true);
    expect(gamingRegistrySourceGameMatchesRequest('Minecraft Java Edition Dungeons', 'Minecraft')).toBe(false);
    expect(gamingRegistryDistinctScopeQualifier('Minecraft', 'story-mode-guide')).toBe(true);
    expect(gamingRegistryDistinctScopeQualifier('Elden Ring', 'shadow-of-the-erdtree-guide')).toBe(true);
    expect(normalizeGamingRegistryEdition('Minecraft', 'Java Edition unsupported')).toBeUndefined();
  });
  it('uses related-title data for direct scope qualifiers without inventing relations', () => {
    expect(gamingRegistryRelatedScopeNames('Minecraft')).toEqual(expect.arrayContaining(['Minecraft Dungeons', 'Dungeons', 'Minecraft Story Mode', 'Story Mode']));
    expect(gamingRegistryRelatedScopeNames('Elden Ring')).toEqual(expect.arrayContaining(['Elden Ring Nightreign', 'Nightreign']));
    expect(gamingRegistryRelatedScopeNames('Lantern Vale')).toEqual([]);
    expect(gamingRegistryRelatedScopeNames('Portal 2')).toEqual([]);
  });
  it.each(['Lantern Vale', 'Orbit Orchard'])('leaves unknown title %s unregistered', title => {
    expect(resolveGamingRegistryGame(title)).toBeUndefined();
    expect(detectGamingRegistryAlias(`${title} guide`)).toBeUndefined();
    expect(gamingRegistrySourceGameMatchesRequest(title, title)).toBe(true);
    expect(readGamingRegistryEditionScope({ text: `Game: ${title}.` }, title)).toEqual({ status: 'none', exclusive: false });
  });
  it('does not erase edition contradictions or quote/reference qualifiers', () => {
    expect(readGamingRegistryEditionScope({ text: 'Edition: Java. Edition: Bedrock.' }, 'Minecraft').status).toBe('conflict');
    expect(readGamingRegistryEditionScope({ text: 'Unlike in Minecraft Java, this discussion is historical.' }, 'Minecraft').status).toBe('none');
    expect(readGamingRegistryEditionScope({ text: 'In Minecraft Java, use the acquired crafting recipe.' }, 'Minecraft'))
      .toMatchObject({ status: 'verified', edition: 'Java' });
  });
});

describe('registry config is bounded reviewed literals', () => {
  it('rejects ambiguous aliases, executable fields and unsafe provenance', () => {
    const first = GAMING_GAME_REGISTRY.games[0];
    expect(() => validateGamingGameRegistry({ ...GAMING_GAME_REGISTRY,
      games: [first, { ...first, id: 'duplicate', name: 'Different', aliases: [first.name] }] })).toThrow();
    expect(() => validateGamingGameRegistry({ ...GAMING_GAME_REGISTRY, execute: 'grant authority' })).toThrow();
    expect(() => validateGamingGameRegistry({ ...GAMING_GAME_REGISTRY,
      games: [{ ...first, provenance: { ...first.provenance, references: ['secret\ntext'] } }] })).toThrow();
  });
  it('supports an unrelated configured game with the same generic edition algorithm', () => {
    const configured = validateGamingGameRegistry({ version: 'gaming-game-registry/v1', revision: 'test-v1', games: [{
      id: 'configured-workshop-v1', name: 'Synthetic Workshop', aliases: ['Workshop Alpha'], related: [], platforms: ['PC'],
      editions: [{ id: 'desktop', name: 'Desktop', kind: 'edition', aliases: ['Desktop Edition'], platforms: ['PC'] },
        { id: 'handheld', name: 'Handheld', kind: 'edition', aliases: ['Handheld Edition'], platforms: ['Switch'] }],
      provenance: { reviewedAt: '2026-10-10', references: ['tests/gaming-game-registry.test.ts'] }
    }] });
    expect(resolveGamingRegistryGame('configured-workshop-v1', configured)?.name).toBe('Synthetic Workshop');
    expect(normalizeGamingRegistryEdition('Workshop Alpha', 'Desktop Edition', configured)).toBe('Desktop');
    expect(readGamingRegistryEditionScope({ text: 'In Synthetic Workshop Desktop, use the acquired recipe.' },
      'Workshop Alpha', configured)).toMatchObject({ status: 'verified', edition: 'Desktop' });
    expect(gamingRegistrySourceGameMatchesRequest('Synthetic Workshop Handheld', 'Workshop Alpha', configured)).toBe(true);
  });
});
