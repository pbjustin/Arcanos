import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFetchAndClean = jest.fn();
const mockDiscoverGamingSources = jest.fn();
const mockClearGamingDiscoveryCache = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvBoolean = jest.fn();
const mockGetEnvIntegerAtLeast = jest.fn();
const mockGetEnvNumber = jest.fn();
const mockGetOptionalEnvIntegerAtLeast = jest.fn();

jest.unstable_mockModule('@shared/webFetcher.js', () => ({
  fetchAndClean: mockFetchAndClean
}));

jest.unstable_mockModule('@services/gamingSourceDiscovery.js', () => ({
  discoverGamingSources: mockDiscoverGamingSources,
  clearGamingDiscoveryCache: mockClearGamingDiscoveryCache,
  sanitizeGamingDiscoveryCandidateUrl: (url: string) => ({ url, rejected: false })
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvBoolean: mockGetEnvBoolean,
  getEnvIntegerAtLeast: mockGetEnvIntegerAtLeast,
  getEnvNumber: mockGetEnvNumber,
  getOptionalEnvIntegerAtLeast: mockGetOptionalEnvIntegerAtLeast
}));

const {
  buildGamingRagContext,
  clearGamingRagCache,
  isCitableGamingWebSource,
  isGamingFreshnessSensitive
} = await import('../src/services/gamingWebContext.js');

const TEST_ENV_KEYS = [
  'ARCANOS_GAMING_CURATED_SOURCES_JSON',
  'ARCANOS_GAMING_DISCOVERY_BUDGET_MS',
  'ARCANOS_GAMING_DISCOVERY_ENABLED',
  'ARCANOS_GAMING_DISCOVERY_MIN_EVIDENCE_QUALITY',
  'ARCANOS_GAMING_RAG_CHUNK_CHARS',
  'ARCANOS_GAMING_RAG_MAX_CHUNKS',
  'ARCANOS_GAMING_RAG_MAX_SOURCES',
  'ARCANOS_GAMING_WEB_CONTEXT_CHARS',
  'ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS',
  'ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS'
] as const;

type DiscoveryCandidate = {
  url: string;
  title: string;
  snippet: string;
  providerRank: number;
  provider: string;
  score: number;
  publishedAt?: string;
  updatedAt?: string;
  suggestedSourceType: 'official' | 'patch_notes' | 'wiki' | 'curated';
  stable: boolean;
  freshnessKnown: boolean;
  characteristics: {
    officialLikely: boolean;
    patchLikely: boolean;
    wikiLikely: boolean;
    guideLikely: boolean;
    articleLikely: boolean;
  };
};

function makeDiscoveredCandidate(
  url: string,
  providerRank = 1,
  suggestedSourceType: DiscoveryCandidate['suggestedSourceType'] = 'wiki'
): DiscoveryCandidate {
  return {
    url,
    title: 'Untrusted search title',
    snippet: 'Untrusted search description',
    providerRank,
    provider: 'integration-search-v1',
    score: Math.max(0.6, 0.95 - providerRank * 0.05),
    suggestedSourceType,
    stable: suggestedSourceType !== 'patch_notes',
    freshnessKnown: suggestedSourceType === 'patch_notes',
    characteristics: {
      officialLikely: suggestedSourceType === 'official' || suggestedSourceType === 'patch_notes',
      patchLikely: suggestedSourceType === 'patch_notes',
      wikiLikely: suggestedSourceType === 'wiki',
      guideLikely: suggestedSourceType === 'wiki' || suggestedSourceType === 'curated',
      articleLikely: true
    }
  };
}

function makeDiscoveryResult(params: {
  candidates?: DiscoveryCandidate[];
  failureReason?: string;
  searchResultCount?: number;
  rejectedCandidateCount?: number;
  cacheHit?: boolean;
} = {}) {
  const candidates = params.candidates ?? [];
  return {
    candidates,
    searchProvider: 'integration-search-v1',
    searchQueryHash: 'redacted-query-hash',
    searchQuerySummary: {
      charCount: 42,
      termCount: 6,
      freshnessPreference: 'stable'
    },
    searchResultCount: params.searchResultCount ?? candidates.length,
    candidateCount: candidates.length,
    rejectedCandidateCount: params.rejectedCandidateCount ?? 0,
    discoveryCacheHit: params.cacheHit ?? false,
    discoveryElapsedMs: 3,
    candidateRankingElapsedMs: 1,
    ...(params.failureReason ? { discoveryFailureReason: params.failureReason } : {})
  };
}

function guideEvidence(game: string, topic: string): string {
  return `${game} ${topic} guide evidence explains a reliable route with concrete preparation steps. `
    + `Players should gather the required supplies, confirm the nearby landmark, and save before starting the ${topic} sequence. `
    + `The final section describes common mistakes and a safe recovery path for the same ${game} objective.`;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'guide' as const,
    game: 'Caves of Qud',
    prompt: 'Find a Caves of Qud early progression guide with safe route details.',
    guideUrl: undefined,
    guideUrls: [],
    ...overrides
  };
}

describe('Gaming RAG discovery integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }

    process.env.ARCANOS_GAMING_DISCOVERY_ENABLED = 'true';
    process.env.ARCANOS_GAMING_DISCOVERY_BUDGET_MS = '5000';
    process.env.ARCANOS_GAMING_DISCOVERY_MIN_EVIDENCE_QUALITY = '0.45';
    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '320';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '8';
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '4';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '5000';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS = '500';

    mockGetEnv.mockImplementation((key: string, defaultValue?: string) => process.env[key] ?? defaultValue);
    mockGetEnvBoolean.mockImplementation((key: string, defaultValue: boolean) => {
      const rawValue = process.env[key];
      return rawValue === undefined
        ? defaultValue
        : !['0', 'false', 'no', 'off'].includes(rawValue.trim().toLowerCase());
    });
    mockGetEnvNumber.mockImplementation((key: string, defaultValue: number) => {
      const parsed = Number(process.env[key]);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    });
    mockGetEnvIntegerAtLeast.mockImplementation((key: string, defaultValue: number, minValue: number) => {
      const parsed = Number.parseInt(process.env[key] ?? '', 10);
      return Number.isFinite(parsed) && parsed >= minValue ? parsed : defaultValue;
    });
    mockGetOptionalEnvIntegerAtLeast.mockImplementation((key: string, minValue: number) => {
      const parsed = Number.parseInt(process.env[key] ?? '', 10);
      return Number.isFinite(parsed) && parsed >= minValue ? parsed : undefined;
    });
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({ failureReason: 'DISCOVERY_NO_RESULTS' }));
    mockFetchAndClean.mockResolvedValue(guideEvidence('Caves of Qud', 'early progression'));
    clearGamingRagCache();
    mockClearGamingDiscoveryCache.mockClear();
  });

  afterAll(() => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('discovers, fetches, accepts, and cites a source when no supplied or curated source exists', async () => {
    const discoveredUrl = 'https://independent-guides.example/caves-of-qud/early-progression-guide';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [makeDiscoveredCandidate(discoveredUrl)]
    }));

    const result = await buildGamingRagContext(baseInput());

    expect(mockDiscoverGamingSources).toHaveBeenCalledWith(expect.objectContaining({
      game: 'Caves of Qud',
      mode: 'guide'
    }));
    expect(mockFetchAndClean).toHaveBeenCalledWith(discoveredUrl, expect.any(Number), expect.any(Object));
    expect(result.discoveryTriggered).toBe(true);
    expect(result.discoveryReason).toBe('DISCOVERY_NO_SOURCE_CANDIDATES');
    expect(result.acceptedSourceCount).toBe(1);
    expect(result.sources).toEqual([
      expect.objectContaining({ url: discoveredUrl, snippet: expect.any(String) })
    ]);
    expect(isCitableGamingWebSource(result.sources[0])).toBe(true);
    expect(result.context).toContain(`[Source 1] ${discoveredUrl}`);
  });

  it('treats a bare semantic version as freshness-sensitive discovery', async () => {
    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Look up a beginner guide for Palworld 1.0.'
    }));

    expect(mockDiscoverGamingSources).toHaveBeenCalledWith(expect.objectContaining({
      game: 'Palworld',
      mode: 'guide',
      patchSensitive: true
    }));
    expect(result.retrievalReason).toBe('patch_or_meta_sensitive');
    expect(result.currentEvidenceAvailable).toBe(false);
  });

  it('treats a parenthesized semantic version as freshness-sensitive without a known game', () => {
    expect(isGamingFreshnessSensitive(baseInput({
      game: undefined,
      prompt: 'Use the supplied article for this guide request (1.0).'
    }))).toBe(true);
  });

  it.each([
    'How do I beat the boss in under 3.5 minutes?',
    'What is the strategy for a 99.9% success rate?',
    'Connect to 192.168.1.1 for Palworld matchmaking.',
    'Palworld 2.0 kilograms is the download estimate.',
    'Palworld was released on 7.11.26.',
  ])('does not treat a general decimal as freshness-sensitive: %s', (prompt) => {
    expect(isGamingFreshnessSensitive(baseInput({
      game: 'Palworld',
      prompt,
    }))).toBe(false);
  });

  it('accepts a validated supplied semantic-version article as current evidence', async () => {
    const suppliedUrl = 'https://palworld-guides.example/palworld-1-0-beginner-guide';
    mockFetchAndClean.mockResolvedValue(
      'Palworld 1.0 beginner guide evidence explains a current progression route with preparation and combat steps. '
      + 'Players should gather supplies, confirm the nearby landmark, and save before starting the Palworld objective.'
    );

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Use this Palworld 1.0 article as a guide source.',
      guideUrl: suppliedUrl
    }));

    expect(mockDiscoverGamingSources).not.toHaveBeenCalled();
    expect(result.currentEvidenceAvailable).toBe(true);
    expect(result.sources).toEqual([
      expect.objectContaining({ url: suppliedUrl, snippet: expect.any(String) })
    ]);
  });

  it('accepts an exact requested version followed by sentence-ending punctuation', async () => {
    const suppliedUrl = 'https://palworld-guides.example/palworld-1-0-beginner-guide';
    mockFetchAndClean.mockResolvedValue(
      'Palworld beginner guide evidence explains a current progression route with preparation and combat steps. '
      + 'Players should gather supplies, confirm the nearby landmark, and save before starting the objective. '
      + 'This guidance applies to Palworld version 1.0.'
    );

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Use this Palworld 1.0 article as a current guide source.',
      guideUrl: suppliedUrl
    }));

    expect(result.currentEvidenceAvailable).toBe(true);
  });

  it('does not accept a longer patch as an exact requested version', async () => {
    const suppliedUrl = 'https://palworld-guides.example/palworld-1-0-1-beginner-guide';
    mockFetchAndClean.mockResolvedValue(
      'Palworld beginner guide evidence explains a current progression route with preparation and combat steps. '
      + 'Players should gather supplies, confirm the nearby landmark, and save before starting the objective. '
      + 'This guidance applies to Palworld version 1.0.1.'
    );

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Use this Palworld 1.0 article as a current guide source.',
      guideUrl: suppliedUrl
    }));

    expect(result.currentEvidenceAvailable).toBe(false);
  });

  it('does not treat a different semantic version as current evidence', async () => {
    const suppliedUrl = 'https://palworld-guides.example/palworld-1-0-beginner-guide';
    mockFetchAndClean.mockResolvedValue(
      'Palworld 0.9 beginner guide evidence explains a progression route with preparation and combat steps. '
      + 'Players should gather supplies, confirm the nearby landmark, and save before starting the Palworld objective.'
    );

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Use this Palworld 1.0 article as a current guide source.',
      guideUrl: suppliedUrl
    }));

    expect(mockDiscoverGamingSources).toHaveBeenCalledWith(expect.objectContaining({
      game: 'Palworld',
      patchSensitive: true
    }));
    expect(result.currentEvidenceAvailable).toBe(false);
    expect(result.sources).toEqual([{
      url: suppliedUrl,
      error: 'Source did not match the requested game or version.'
    }]);
  });

  it('requires every explicitly requested version across eligible citable chunks', async () => {
    const olderUrl = 'https://palworld-guides.example/palworld-0-9-guide';
    const currentUrl = 'https://palworld-guides.example/palworld-1-0-guide';
    mockFetchAndClean.mockImplementation(async (url: string) => url === olderUrl
      ? guideEvidence('Palworld version 0.9', 'progression route')
      : guideEvidence('Palworld version 1.0', 'progression route'));

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Compare Palworld version 0.9 with Palworld version 1.0.',
      guideUrls: [olderUrl, currentUrl]
    }));

    expect(result.currentEvidenceAvailable).toBe(true);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: olderUrl, snippet: expect.any(String) }),
      expect.objectContaining({ url: currentUrl, snippet: expect.any(String) })
    ]));
  });

  it('does not satisfy a multi-version request with evidence for only the first version', async () => {
    const suppliedUrl = 'https://palworld-guides.example/palworld-0-9-guide';
    mockFetchAndClean.mockResolvedValue(guideEvidence('Palworld version 0.9', 'progression route'));

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Compare versions 0.9 and 1.0 for Palworld.',
      guideUrl: suppliedUrl
    }));

    expect(result.currentEvidenceAvailable).toBe(false);
    expect(mockDiscoverGamingSources).toHaveBeenCalledWith(expect.objectContaining({
      game: 'Palworld',
      patchSensitive: true
    }));
  });

  it('does not treat stale official evidence as current without a requested version', async () => {
    const staleOfficialUrl = 'https://official-palworld.example/guides/beginner';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [{
        ...makeDiscoveredCandidate(staleOfficialUrl, 1, 'official'),
        updatedAt: '2020-01-01T00:00:00.000Z'
      }]
    }));
    mockFetchAndClean.mockResolvedValue(
      'Palworld current beginner guide evidence explains a progression route with preparation and combat steps. '
      + 'Players should gather supplies, confirm the nearby landmark, and save before starting the Palworld objective.'
    );

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Look up a current beginner guide for Palworld.'
    }));

    expect(result.sources).toEqual([
      expect.objectContaining({ url: staleOfficialUrl, snippet: expect.any(String) })
    ]);
    expect(result.currentEvidenceAvailable).toBe(false);
  });

  it('accepts recently dated current evidence when no version is requested', async () => {
    const currentOfficialUrl = 'https://official-palworld.example/guides/current-beginner';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [{
        ...makeDiscoveredCandidate(currentOfficialUrl, 1, 'official'),
        updatedAt: new Date().toISOString()
      }]
    }));
    mockFetchAndClean.mockResolvedValue(
      'Palworld current beginner guide evidence explains a progression route with preparation and combat steps. '
      + 'Players should gather supplies, confirm the nearby landmark, and save before starting the Palworld objective.'
    );

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Look up a current beginner guide for Palworld.'
    }));

    expect(result.sources).toEqual([
      expect.objectContaining({ url: currentOfficialUrl, snippet: expect.any(String) })
    ]);
    expect(result.currentEvidenceAvailable).toBe(true);
  });

  it('skips discovery when a supplied source already provides high-quality evidence', async () => {
    const suppliedUrl = 'https://community-guides.example/caves-of-qud/early-progression-guide';
    mockFetchAndClean.mockResolvedValue(guideEvidence('Caves of Qud', 'early progression'));

    const result = await buildGamingRagContext(baseInput({ guideUrl: suppliedUrl }));

    expect(mockDiscoverGamingSources).not.toHaveBeenCalled();
    expect(result.discoveryTriggered).toBe(false);
    expect(result.discoveryReason).toBe('DISCOVERY_NOT_NEEDED');
    expect(result.sources).toEqual([
      expect.objectContaining({ url: suppliedUrl, snippet: expect.any(String) })
    ]);
  });

  it('does not fetch curated candidates after sufficient supplied evidence', async () => {
    const suppliedUrl = 'https://supplied.example/caves-of-qud/progression-guide';
    const curatedUrl = 'https://curated.example/caves-of-qud/progression-guide';
    process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON = JSON.stringify([{
      url: curatedUrl,
      game: 'Caves of Qud',
      modes: ['guide'],
      topics: ['progression'],
      stable: true
    }]);

    const result = await buildGamingRagContext(baseInput({ guideUrl: suppliedUrl }));

    expect(result.sources[0]?.url).toBe(suppliedUrl);
    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
    expect(mockFetchAndClean).not.toHaveBeenCalledWith(curatedUrl, expect.anything(), expect.anything());
    expect(mockDiscoverGamingSources).not.toHaveBeenCalled();
  });

  it('falls through to curated evidence when the supplied page is for a different game', async () => {
    process.env.ARCANOS_GAMING_DISCOVERY_ENABLED = 'false';
    const suppliedUrl = 'https://supplied.example/wrong-game-guide';
    const curatedUrl = 'https://curated.example/caves-of-qud/progression-guide';
    process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON = JSON.stringify([{
      url: curatedUrl,
      game: 'Caves of Qud',
      modes: ['guide'],
      topics: ['progression'],
      stable: true
    }]);
    mockFetchAndClean.mockImplementation(async (url: string, _maxChars: number, options: {
      onExtraction?: (metrics: Record<string, unknown>) => void;
    }) => {
      const wrongGame = url === suppliedUrl;
      options.onExtraction?.({
        strategy: 'article',
        rawTextLength: 300,
        cleanedTextLength: 240,
        documentTitle: wrongGame ? 'Elden Ring beginner guide' : 'Caves of Qud progression guide',
        headingText: wrongGame ? 'Elden Ring route' : 'Caves of Qud route'
      });
      return wrongGame
        ? guideEvidence('Elden Ring', 'beginner route')
        : guideEvidence('Caves of Qud', 'early progression');
    });

    const result = await buildGamingRagContext(baseInput({ guideUrl: suppliedUrl }));

    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
    expect(result.sources[0]).toEqual(expect.objectContaining({ url: curatedUrl }));
    expect(isCitableGamingWebSource(result.sources[0])).toBe(true);
    expect(mockDiscoverGamingSources).not.toHaveBeenCalled();
  });

  it('rejects a supplied wrong-game article identified only by its body introduction', async () => {
    process.env.ARCANOS_GAMING_DISCOVERY_ENABLED = 'false';
    const suppliedUrl = 'https://supplied.example/article-without-metadata';
    mockFetchAndClean.mockResolvedValue(guideEvidence('Elden Ring', 'beginner guide route'));

    const result = await buildGamingRagContext(baseInput({
      game: 'Factorio',
      prompt: 'Use this source for a Factorio progression guide.',
      guideUrl: suppliedUrl
    }));

    expect(result.sources).toEqual([{
      url: suppliedUrl,
      error: 'Source did not match the requested game or version.'
    }]);
    expect(result.context).not.toContain('Elden Ring');
    expect(result.sources.some(isCitableGamingWebSource)).toBe(false);
  });

  it('orders final capped sources by chunk rank after low-quality supplied evidence triggers discovery', async () => {
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '1';
    process.env.ARCANOS_GAMING_DISCOVERY_MIN_EVIDENCE_QUALITY = '0.99';
    const suppliedUrl = 'https://generic.example/guide';
    const discoveredUrl = 'https://qud-official.example/caves-of-qud/early-progression-guide';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [makeDiscoveredCandidate(discoveredUrl, 1, 'patch_notes')]
    }));
    mockFetchAndClean.mockImplementation(async (url: string) => url === suppliedUrl
      ? 'Players can progress safely. Upgrade gear before difficult encounters.'
      : guideEvidence('Caves of Qud', 'early progression route equipment combat'));

    const result = await buildGamingRagContext(baseInput({ guideUrl: suppliedUrl }));

    expect(result.discoveryTriggered).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.url).toBe(discoveredUrl);
    expect(result.context).toContain(`[Source 1] ${discoveredUrl}`);
  });

  it('recovers from a malformed supplied URL through bounded discovery', async () => {
    const discoveredUrl = 'https://qud-walkthroughs.example/games/caves-of-qud/progression-guide';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [makeDiscoveredCandidate(discoveredUrl)]
    }));

    const result = await buildGamingRagContext(baseInput({ guideUrl: 'not-a-valid-url' }));

    expect(result.discoveryTriggered).toBe(true);
    expect(result.discoveryReason).toBe('DISCOVERY_SUPPLIED_SOURCE_FAILED');
    expect(result.sources).toEqual([
      expect.objectContaining({ url: discoveredUrl, snippet: expect.any(String) }),
      { url: 'invalid-source', error: 'Malformed or unsupported source URL.' }
    ]);
    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);
  });

  it.each([
    'DISCOVERY_PROVIDER_TIMEOUT',
    'DISCOVERY_PROVIDER_ERROR',
    'DISCOVERY_NO_RESULTS'
  ])('degrades source-free for %s without public 5xx or generation markers', async (failureReason) => {
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({ failureReason }));

    const result = await buildGamingRagContext(baseInput());
    const publicPayload = JSON.stringify({ context: result.context, sources: result.sources });

    expect(result.discoveryTriggered).toBe(true);
    expect(result.discoveryFailureReason).toBe(failureReason);
    expect(result.sources).toEqual([]);
    expect(result.context).toBe('');
    expect(result.clear.robustFallback).toBe(true);
    expect(publicPayload).not.toMatch(/GENERATION_(?:TIMEOUT|INCOMPLETE)|INTEGRITY|\b5\d\d\b/i);
  });

  it('keeps failed and search-only discovered candidates out of public sources', async () => {
    const acceptedUrl = 'https://qud-community.example/games/caves-of-qud/accepted-guide';
    const failedUrl = 'https://failed-guides.example/games/caves-of-qud/unreachable-guide';
    const searchOnlyUrl = 'https://search-only.example/games/caves-of-qud/not-fetched';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [
        makeDiscoveredCandidate(acceptedUrl, 1),
        makeDiscoveredCandidate(failedUrl, 2)
      ],
      searchResultCount: 3,
      rejectedCandidateCount: 1
    }));
    mockFetchAndClean.mockImplementation(async (url: string) => {
      if (url === failedUrl) {
        throw new Error('source unavailable');
      }
      return guideEvidence('Caves of Qud', 'early progression');
    });

    const result = await buildGamingRagContext(baseInput());

    expect(result.searchResultCount).toBe(3);
    expect(result.fetchedCandidateCount).toBe(2);
    expect(result.sources).toEqual([
      expect.objectContaining({ url: acceptedUrl, snippet: expect.any(String) })
    ]);
    expect(result.sources).not.toContainEqual(expect.objectContaining({ url: failedUrl }));
    expect(result.sources).not.toContainEqual(expect.objectContaining({ url: searchOnlyUrl }));
    expect(mockFetchAndClean).not.toHaveBeenCalledWith(searchOnlyUrl, expect.anything(), expect.anything());
  });

  it('keeps a safe supplied-source error after accepted discovered evidence', async () => {
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '2';
    const suppliedUrl = 'https://medium.example/palworld-1-0-guide';
    const discoveredUrl = 'https://palworld.example/news/palworld-1-0-guide';
    const secondDiscoveredUrl = 'https://palworld-community.example/guides/palworld-1-0';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [
        makeDiscoveredCandidate(discoveredUrl, 1, 'patch_notes'),
        makeDiscoveredCandidate(secondDiscoveredUrl, 2, 'patch_notes')
      ]
    }));
    mockFetchAndClean.mockImplementation(async (url: string) => {
      if (url === suppliedUrl) {
        throw Object.assign(new Error('secret upstream forbidden response'), {
          response: { status: 403 }
        });
      }
      return guideEvidence('Palworld', '1.0 current progression');
    });

    const result = await buildGamingRagContext(baseInput({
      game: 'Palworld',
      prompt: 'Use this Palworld 1.0 article as a guide source.',
      guideUrl: suppliedUrl
    }));

    expect(result.sources).toEqual([
      expect.objectContaining({ url: discoveredUrl, snippet: expect.any(String) }),
      { url: suppliedUrl, error: 'Source access was blocked.' }
    ]);
    expect(result.context).toContain(`[Source 1] ${discoveredUrl}`);
    expect(result.context).not.toContain('[Source 2]');
    expect(result.sources).not.toContainEqual(expect.objectContaining({ url: secondDiscoveredUrl }));
    expect(result.currentEvidenceAvailable).toBe(true);
  });

  it('does not cite a fetched discovered page that fails to corroborate the requested game', async () => {
    const unrelatedUrl = 'https://unrelated.example/games/caves-of-qud/progression-guide';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [makeDiscoveredCandidate(unrelatedUrl)]
    }));
    mockFetchAndClean.mockResolvedValue(
      'A generic progression guide explains a route, equipment upgrades, combat preparation, and safe recovery steps.'
    );

    const result = await buildGamingRagContext(baseInput());

    expect(result.acceptedSourceCount).toBe(0);
    expect(result.sources.every((source) => !isCitableGamingWebSource(source))).toBe(true);
    expect(result.context).not.toMatch(/\[Source \d+\][\s\S]*generic progression guide/i);
  });

  it('keeps error-only public sources within the configured cap', async () => {
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '1';
    process.env.ARCANOS_GAMING_CURATED_SOURCES_JSON = JSON.stringify([{
      url: 'https://failed-curated.example/caves-of-qud/progression-guide',
      game: 'Caves of Qud',
      modes: ['guide'],
      topics: ['progression']
    }]);
    mockFetchAndClean.mockRejectedValue(new Error('source unavailable'));

    const result = await buildGamingRagContext(baseInput({ guideUrl: 'not-a-valid-url' }));

    expect(result.sources).toHaveLength(1);
    expect(result.publicSourceCount).toBe(1);
    expect(result.sources[0]?.error).toBeDefined();
  });

  it('enforces the public source cap while keeping context numbering contiguous', async () => {
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '2';
    const urls = [
      'https://guide-one.example/games/caves-of-qud/early-route-guide',
      'https://guide-two.example/games/caves-of-qud/early-route-guide',
      'https://guide-three.example/games/caves-of-qud/early-route-guide'
    ];
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: urls.map((url, index) => makeDiscoveredCandidate(url, index + 1))
    }));
    mockFetchAndClean.mockImplementation(async (url: string) =>
      guideEvidence('Caves of Qud', `early route ${urls.indexOf(url) + 1}`)
    );

    const result = await buildGamingRagContext(baseInput());
    const citationNumbers = Array.from(
      result.context.matchAll(/\[Source (\d+)\]/g),
      (match) => Number(match[1])
    );

    expect(result.sources).toHaveLength(2);
    expect(result.publicSourceCount).toBe(2);
    expect(new Set(citationNumbers)).toEqual(new Set([1, 2]));
    expect(result.context).not.toContain('[Source 3]');
    result.sources.forEach((source, index) => {
      expect(result.context).toContain(`[Source ${index + 1}] ${source.url}`);
    });
  });

  it('clears both discovery and fetched-document caches through the existing RAG clear method', async () => {
    const discoveredUrl = 'https://cacheable-qud.example/games/caves-of-qud/progression-guide';
    mockDiscoverGamingSources.mockResolvedValue(makeDiscoveryResult({
      candidates: [makeDiscoveredCandidate(discoveredUrl)]
    }));

    await buildGamingRagContext(baseInput());
    await buildGamingRagContext(baseInput());
    expect(mockFetchAndClean).toHaveBeenCalledTimes(1);

    clearGamingRagCache();
    expect(mockClearGamingDiscoveryCache).toHaveBeenCalledTimes(1);

    await buildGamingRagContext(baseInput());
    expect(mockFetchAndClean).toHaveBeenCalledTimes(2);
  });

  it('skips discovery when no game can be identified', async () => {
    const result = await buildGamingRagContext(baseInput({
      game: undefined,
      prompt: 'Explain what I should do next.'
    }));

    expect(mockDiscoverGamingSources).not.toHaveBeenCalled();
    expect(result.detectedGame).toBeUndefined();
    expect(result.gameDetectionConfidence).toBe(0);
    expect(result.discoveryTriggered).toBe(false);
    expect(result.discoveryReason).toBe('DISCOVERY_MISSING_GAME');
  });

  it('skips discovery when URL-only game detection remains below the confidence threshold', async () => {
    const lowConfidenceUrl = 'https://mystery-portal.example/guide/boss';
    mockFetchAndClean.mockRejectedValue(new Error('source unavailable'));

    const result = await buildGamingRagContext(baseInput({
      game: undefined,
      prompt: 'Use the supplied guide for this request.',
      guideUrl: lowConfidenceUrl
    }));

    expect(mockDiscoverGamingSources).not.toHaveBeenCalled();
    expect(result.detectedGame).toBeUndefined();
    expect(result.gameDetectionConfidence).toBeGreaterThan(0);
    expect(result.gameDetectionConfidence).toBeLessThan(0.7);
    expect(result.discoveryTriggered).toBe(false);
    expect(result.discoveryReason).toBe('DISCOVERY_MISSING_GAME');
  });
});
