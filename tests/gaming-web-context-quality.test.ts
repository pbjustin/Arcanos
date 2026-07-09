import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFetchAndClean = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvBoolean = jest.fn();
const mockGetEnvIntegerAtLeast = jest.fn();
const mockGetEnvNumber = jest.fn();
const mockGetOptionalEnvIntegerAtLeast = jest.fn();

jest.unstable_mockModule('@shared/webFetcher.js', () => ({
  fetchAndClean: mockFetchAndClean
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvBoolean: mockGetEnvBoolean,
  getEnvIntegerAtLeast: mockGetEnvIntegerAtLeast,
  getEnvNumber: mockGetEnvNumber,
  getOptionalEnvIntegerAtLeast: mockGetOptionalEnvIntegerAtLeast
}));

const { buildGamingRagContext, clearGamingRagCache } = await import('../src/services/gamingWebContext.js');

const TEST_ENV_KEYS = [
  'ARCANOS_GAMING_CURATED_SOURCES_JSON',
  'ARCANOS_GAMING_RAG_CHUNK_CHARS',
  'ARCANOS_GAMING_RAG_ENABLED',
  'ARCANOS_GAMING_RAG_MAX_CHUNKS',
  'ARCANOS_GAMING_RAG_MAX_SOURCES',
  'ARCANOS_GAMING_WEB_CONTEXT_CHARS',
  'ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS',
  'ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS'
] as const;

const NAVIGATION_TEXT = [
  'Menu.',
  'Games.',
  'News.',
  'Guides.',
  'Builds.',
  'Weapons.',
  'Armor.',
  'Talismans.',
  'Skills.',
  'Bosses.',
  'Locations.',
  'Quests.',
  'Walkthrough.',
  'Sign In.',
  'Subscribe.',
  'Privacy Policy.',
  'Advertisement.',
  'Community Navigation.'
].join(' ');

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('gaming RAG snippet quality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }

    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '200';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '8';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '5000';

    mockGetEnv.mockImplementation((key: string, defaultValue?: string) => process.env[key] ?? defaultValue);
    mockGetEnvBoolean.mockReturnValue(false);
    mockGetEnvNumber.mockImplementation((_key: string, defaultValue: number) => defaultValue);
    mockGetEnvIntegerAtLeast.mockImplementation((key: string, defaultValue: number, minValue: number) => {
      const rawValue = process.env[key];
      if (rawValue === undefined) {
        return defaultValue;
      }
      const parsed = Number.parseInt(rawValue, 10);
      return Number.isFinite(parsed) && parsed >= minValue ? parsed : defaultValue;
    });
    mockGetOptionalEnvIntegerAtLeast.mockImplementation((key: string, minValue: number) => {
      const rawValue = process.env[key];
      if (rawValue === undefined) {
        return undefined;
      }
      const parsed = Number.parseInt(rawValue, 10);
      return Number.isFinite(parsed) && parsed >= minValue ? parsed : undefined;
    });
    mockFetchAndClean.mockResolvedValue('Readable guide evidence about a boss route and safe progression.');
    clearGamingRagCache();
  });

  it('keeps the best Fextralife article evidence instead of a lower-ranked navigation chunk', async () => {
    mockFetchAndClean.mockResolvedValue([
      NAVIGATION_TEXT,
      'After leaving the Elden Ring tutorial, activate the First Step grace, visit the Church of Elleh, then follow the road toward Gatefront Ruins before approaching Stormveil.'
    ].join(' '));

    const result = await buildGamingRagContext({
      mode: 'guide',
      game: 'Elden Ring',
      prompt: 'Where do I go first in Elden Ring after leaving the tutorial?',
      guideUrl: 'https://eldenring.wiki.fextralife.com/Game+Progress+Route',
      guideUrls: []
    });

    const routeSource = result.sources.find((source) => source.url.endsWith('/Game+Progress+Route'));
    const routeFetch = mockFetchAndClean.mock.calls.find(([url]) =>
      url === 'https://eldenring.wiki.fextralife.com/Game+Progress+Route'
    );
    expect(routeSource?.snippet).toContain('Gatefront Ruins');
    expect(routeSource?.snippet).not.toMatch(/sign in|privacy policy|community navigation/i);
    expect(routeFetch?.[2]).toEqual(expect.objectContaining({
      includeLinks: false,
      preferredContentSelectors: expect.arrayContaining(['#wiki-content-block', 'main', 'article']),
      removeSelectors: expect.arrayContaining(['nav', '[hidden]', "[role='dialog']", '.wiki-menu-2-left', '.left-side-menu-container', '.side-bar-right'])
    }));
    expect(routeFetch?.[2]?.removeSelectors).not.toContain('.fex-main-sidebar-container');
    expect(routeFetch?.[2]?.removeSelectors).not.toContain("[class*='sidebar']");
  });

  it('prefers official Bandai Namco patch changes over site chrome', async () => {
    mockFetchAndClean.mockResolvedValue([
      `${NAVIGATION_TEXT} Patch Notes.`,
      'Elden Ring patch version 1.16.1 changed balance behavior and fixed several weapon skill interactions that affected current builds.'
    ].join(' '));

    const result = await buildGamingRagContext({
      mode: 'meta',
      game: 'Elden Ring',
      prompt: 'What changed for Elden Ring builds in the latest patch?',
      guideUrls: []
    });

    const officialSource = result.sources.find((source) => source.url.includes('bandainamcoent.eu'));
    const officialFetch = mockFetchAndClean.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('bandainamcoent.eu')
    );
    expect(officialSource?.snippet).toContain('version 1.16.1 changed balance behavior');
    expect(officialSource?.snippet).not.toMatch(/sign in|privacy policy|community navigation/i);
    expect(officialFetch?.[2]).toEqual(expect.objectContaining({
      includeLinks: false,
      preferredContentSelectors: expect.arrayContaining(['.article__edito-content', 'main', 'article']),
      removeSelectors: expect.arrayContaining(['nav', '.article__sidebar'])
    }));
  });

  it('prefers bleed-specific evidence over unrelated build-adjacent patch text', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) => {
      if (url.endsWith('/Hemorrhage')) {
        return 'Hemorrhage inflicts blood loss after bleed buildup fills the meter; Arcane scaling and fast multi-hit weapons make the status reliable for an Elden Ring bleed build.';
      }
      if (url.includes('bandainamcoent.eu')) {
        return 'Patch version 1.16.1 fixed an unrelated weapon skill interaction and updated online regulation files.';
      }
      return 'General Elden Ring status and build reference material.';
    });

    const result = await buildGamingRagContext({
      mode: 'build',
      game: 'Elden Ring',
      prompt: 'Make me a bleed build for Elden Ring.',
      guideUrls: []
    });

    expect(result.sources).toContainEqual(expect.objectContaining({
      url: 'https://eldenring.wiki.fextralife.com/Hemorrhage',
      snippet: expect.stringMatching(/Arcane scaling.*multi-hit weapons/i)
    }));
    expect(result.sources.find((source) => source.url.includes('bandainamcoent.eu'))?.snippet).toBe(
      'Relevant source retrieved, but readable article text was limited.'
    );
  });

  it('prefers Icy Veins Frost Mage guide content over navigation lists', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) => {
      if (url.includes('icy-veins.com')) {
        return [
          NAVIGATION_TEXT,
          'Frost Mage remains viable when its talents and rotation match the encounter; prioritize Shatter windows, cooldown alignment, and current patch tuning.'
        ].join(' ');
      }
      return 'Frost Mage overview: current talents, damage profile, and rotation determine raid viability.';
    });

    const result = await buildGamingRagContext({
      mode: 'guide',
      game: 'World of Warcraft',
      prompt: 'Is Frost Mage still viable this patch?',
      guideUrls: []
    });

    const icyVeinsSource = result.sources.find((source) => source.url.includes('icy-veins.com'));
    const icyVeinsFetch = mockFetchAndClean.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('icy-veins.com')
    );
    expect(icyVeinsSource?.snippet).toContain('Shatter windows');
    expect(icyVeinsSource?.snippet).not.toMatch(/sign in|privacy policy|community navigation/i);
    expect(icyVeinsFetch?.[2]).toEqual(expect.objectContaining({
      includeLinks: false,
      preferredContentSelectors: expect.arrayContaining(['.left-column-content', 'main', 'article']),
      removeSelectors: expect.arrayContaining(['nav', '.content-toc'])
    }));
  });

  it('does not expose unrelated Blizzard news prose as Frost Mage patch evidence', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) => {
      if (url.includes('worldofwarcraft.blizzard.com')) {
        return 'Warcraft Short Story: The Bitter Truth follows a new character journey through an unrelated narrative chapter.';
      }
      if (url.includes('icy-veins.com')) {
        return 'Frost Mage patch evidence: current tuning keeps the specialization viable with the recommended talents and Shatter rotation.';
      }
      return 'Frost Mage class evidence covers current talents, rotation, damage profile, and raid viability.';
    });

    const result = await buildGamingRagContext({
      mode: 'meta',
      game: 'World of Warcraft',
      prompt: 'Is Frost Mage still viable this patch?',
      guideUrls: []
    });

    const blizzardSource = result.sources.find((source) => source.url.includes('worldofwarcraft.blizzard.com'));
    const blizzardFetch = mockFetchAndClean.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('worldofwarcraft.blizzard.com')
    );
    const icyVeinsSource = result.sources.find((source) => source.url.includes('icy-veins.com'));
    expect(
      !blizzardSource
      || blizzardSource.snippet === 'Relevant source retrieved, but readable article text was limited.'
    ).toBe(true);
    expect(blizzardFetch?.[2]).toEqual(expect.objectContaining({
      preferredContentSelectors: expect.arrayContaining(['.NewsBlog-content', '#main']),
      preferredContentTerms: expect.arrayContaining(['frost mage', 'patch', 'hotfix'])
    }));
    expect(blizzardFetch?.[2]?.preferredContentSelectors?.[0]).toBe('.NewsBlog-content');
    expect(icyVeinsSource?.snippet).toContain('current tuning keeps the specialization viable');
  });

  it('keeps generic extraction support for an unknown supplied guide domain', async () => {
    const url = 'https://guides.example.net/elden-ring-opening-route';
    mockFetchAndClean.mockResolvedValue(
      'Community route evidence: unlock the nearby grace, collect the map fragment, and upgrade the weapon before the first major boss.'
    );

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Use this supplied guide for the opening route.',
      guideUrl: url,
      guideUrls: []
    });

    expect(mockFetchAndClean).toHaveBeenCalledWith(
      url,
      5000,
      expect.objectContaining({
        signal: expect.any(Object),
        timeoutMs: expect.any(Number),
        includeLinks: false,
        preferredContentSelectors: expect.arrayContaining(['main', 'article'])
      })
    );
    const genericFetch = mockFetchAndClean.mock.calls.find(([fetchedUrl]) => fetchedUrl === url);
    expect(genericFetch?.[2]?.preferredContentSelectors).not.toContain('#wiki-content-block');
    expect(genericFetch?.[2]?.preferredContentSelectors).not.toContain('.article__edito-content');
    expect(genericFetch?.[2]?.preferredContentSelectors).not.toContain('.left-column-content');
    expect(result.sources).toEqual([
      {
        url,
        snippet: 'Community route evidence: unlock the nearby grace, collect the map fragment, and upgrade the weapon before the first major boss.'
      }
    ]);
  });

  it('deduplicates repeated chunks so repeated page chrome cannot dominate context', async () => {
    const repeated = 'Elden Ring menu route directory lists bosses, weapons, builds, locations, and quests for every wiki category.';
    mockFetchAndClean.mockResolvedValue([
      repeated,
      repeated,
      repeated,
      'Opening route evidence: after the tutorial, activate the First Step grace and continue north to the Church of Elleh.'
    ].join(' '));

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Where should I go after the tutorial?',
      guideUrl: 'https://example.com/repeated-guide',
      guideUrls: []
    });

    expect(countOccurrences(result.context, repeated)).toBeLessThanOrEqual(1);
    expect(result.sources[0]?.snippet).toContain('First Step grace');
  });

  it('bounds every public source snippet independently of the configured chunk size', async () => {
    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '1600';
    mockFetchAndClean.mockResolvedValue(
      `Bleed build evidence recommends Arcane, Vigor, a fast weapon, and an upgraded bleed affinity because ${'measured damage and reliable status buildup '.repeat(32)}.`
    );

    const result = await buildGamingRagContext({
      mode: 'build',
      game: 'Test Game',
      prompt: 'Make me a bleed build for Elden Ring.',
      guideUrl: 'https://example.com/long-bleed-build',
      guideUrls: []
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.snippet?.length).toBeLessThanOrEqual(600);
    expect(result.sources[0]?.snippet).toMatch(/bleed build evidence/i);
  });

  it('uses a safe fallback snippet when retrieved text is only page chrome', async () => {
    mockFetchAndClean.mockResolvedValue(
      'Menu. Sign In. Subscribe. Cookie Settings. Privacy Policy. Terms of Use. Advertisement. Footer. Newsletter. Community Navigation.'
    );

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Use this supplied guide.',
      guideUrl: 'https://example.com/chrome-only',
      guideUrls: []
    });

    expect(result.sources).toEqual([
      {
        url: 'https://example.com/chrome-only',
        snippet: 'Relevant source retrieved, but readable article text was limited.'
      }
    ]);
    expect(result.context).not.toMatch(/cookie settings|privacy policy|community navigation/i);
  });

  it('keeps context citation numbers contiguous and mapped to public sources after dedupe', async () => {
    mockFetchAndClean.mockImplementation(async (url: string) =>
      url.endsWith('/one')
        ? 'First route evidence: activate a grace and collect the map before fighting the boss.'
        : 'Second route evidence: upgrade the weapon and flasks before entering the legacy dungeon.'
    );

    const result = await buildGamingRagContext({
      mode: 'guide',
      game: 'Elden Ring',
      prompt: 'Compare these opening route guides.',
      guideUrl: 'https://example.com/one',
      guideUrls: ['https://example.com/one', 'https://example.com/two']
    });

    const citationNumbers = Array.from(result.context.matchAll(/\[Source (\d+)\]/g), (match) => Number(match[1]));
    expect(new Set(citationNumbers)).toEqual(new Set(result.sources.map((_source, index) => index + 1)));
    citationNumbers.forEach((citationNumber) => {
      expect(citationNumber).toBeGreaterThanOrEqual(1);
      expect(citationNumber).toBeLessThanOrEqual(result.sources.length);
    });
    result.sources.forEach((source, index) => {
      expect(result.context).toContain(`[Source ${index + 1}] ${source.url}`);
    });
  });

  it('degrades to an attributable source error when retrieval fails', async () => {
    mockFetchAndClean.mockRejectedValue(new Error('network unavailable'));

    const result = await buildGamingRagContext({
      mode: 'guide',
      prompt: 'Use the supplied guide.',
      guideUrl: 'https://example.com/unreachable',
      guideUrls: []
    });

    expect(result.context).toBe('');
    expect(result.sources).toEqual([
      { url: 'https://example.com/unreachable', error: 'network unavailable' }
    ]);
    expect(result.clear.robustFallback).toBe(true);
  });
});
