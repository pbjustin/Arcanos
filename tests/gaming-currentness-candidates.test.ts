import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const mockHttp = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { assessGamingSourcePolicy, evaluateGamingFreshness, extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { GAMING_CURRENTNESS_ADAPTER_VERSION, combineGamingCurrentnessEvidence } = await import('../src/shared/gaming/gamingCurrentnessAdapters.js');
const { GamingDocumentAcquisitionError } = await import('../src/shared/gaming/gamingSourceAcquisitionCore.js');
import type { GamingReviewedSourceRule } from '../src/shared/gaming/gamingFreshnessCore.js';
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const contractVersion = 'gaming-hybrid-v1';
const game = 'Star Wars: The Old Republic';
const context = { actorKey: 'synthetic-currentness-conflict', requestId: 'currentness-conflict-test' };
const guideUrl = 'https://guides.example.org/swtor-mage';
const indexUrl = 'https://swtor.com/patchnotes';
const conflictingUrl = 'https://www.swtor.com/patchnotes';
const effective = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const releaseDate = `${effective.slice(5, 7)}/${effective.slice(8, 10)}/${effective.slice(0, 4)}`;
function documents(conflictScope = 'Platforms: all. Regions: all.', alias = false) {
  let indexFetches = 0;
  mockHttp.mockImplementation(async (url: string, options: any) => {
    const guide = new URL(String(url)).pathname === '/swtor-mage';
    if (alias && options.headers.Host === 'www.swtor.com') return { status: 302, headers: { location: indexUrl }, data: '' };
    const conflict = alias ? !guide && ++indexFetches > 1 : options.headers.Host === 'www.swtor.com';
    return { headers: { 'content-type': 'text/html' }, data: `<html><title>${game} ${guide ? 'mage build guide' : 'patch notes'}</title><body><article>
      Game: ${game}. ${guide ? 'Patch: 2.1.' : `Patch notes listing. ${releaseDate} - Game Update 2.1. ${conflict ? `${releaseDate} - Game Update 2.2.` : ''}`}
      Effective from: ${effective}. ${conflict ? conflictScope : 'Platforms: all. Regions: all.'}
      ${guide ? `${game} offers a good mage build using intelligence, vigor, a sorcery staff and safe ranged spells. This mage build describes equipment and progression for the current patch.`
        : `${game} provides this official release listing to establish the applicable game update. Patch notes identify update authority and do not recommend a mage build.`}
      </article></body></html>` };
  });
}
describe('scoped rejected official contradictions survive candidate evaluation', () => {
  it.each([
    { conflictScope: 'Platforms: all. Regions: all.', request: {}, conflicting: true, alias: false },
    { conflictScope: 'Platforms: PC. Regions: all.', request: { platform: 'PlayStation 5' }, conflicting: false, alias: false },
    { conflictScope: 'Platforms: all. Regions: EU.', request: { region: 'NA' }, conflicting: false, alias: false },
    { conflictScope: 'Platforms: all. Regions: all.', request: {}, conflicting: true, alias: true },
  ])('preserves only the applicable official veto: $conflictScope, alias $alias', async ({ conflictScope, request, conflicting, alias }) => {
    documents(conflictScope, alias);
    expect(extractGamingFreshnessMetadata(await resolveGamingDocument(guideUrl, 10_000), { game }).game).toBe(game);
    const generate = jest.fn(async (_input: unknown, prepared: any) => ({ ok: true, route: 'gaming', mode: 'build',
      data: { response: 'Use the verified mage guide with its patch qualification. [1]', sources: prepared.knowledge.sources,
        grounding: { groundingStatus: 'grounded' } } } as any));
    const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], sourceKnown: false }), generate });
    const first = await workflow.query({ contractVersion, idempotencyKey: 'conflict-query-operation', game, mode: 'build',
      question: 'What is a good mage build now?', ...request }, context);
    const found = await workflow.candidates({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'conflict-guide-operation',
      candidates: [{ url: guideUrl }] }, context);
    expect(found.body.nextAction).toBe('verify_currentness');
    const result = await workflow.candidates({ contractVersion, workflowId: first.body.workflowId, idempotencyKey: 'conflict-index-operation',
      discoveryType: 'currentness_verification', candidates: [{ url: indexUrl }, { url: conflictingUrl }] }, context);
    expect(result.body.candidates?.[1].decision).toBe('rejected');
    if (alias) expect(result.body.candidates?.[1].url).toBe(indexUrl);
    if (conflicting) {
      expect(result.body).toMatchObject({ nextAction: 'stop', freshnessStatus: 'conflicting', evidenceSelected: false });
      expect(generate).not.toHaveBeenCalled();
    } else {
      expect(result.body.state).toBe('answer_ready');
      expect(generate).toHaveBeenCalledTimes(1);
    }
  });
  it('does not treat frontend publisher claims or an unreviewed path as currentness authority', async () => {
    documents();
    const result = await evaluateGamingHybridCandidates({ game, prompt: 'What is a good mage build now?', mode: 'build',
      discoveryType: 'currentness_verification', candidates: [{ url: guideUrl, claimedPublisher: 'official' }] }, context);
    expect(result.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED'] }]);
    expect(result.accepted).toHaveLength(0);
  });
});

describe('required official companion acquisition shares the currentness operation budget', () => {
  const syntheticGame = 'Prism Siege';
  const officialIndex = 'https://prism.test/updates/current';
  const officialArticle = 'https://prism.test/updates/release-241';
  const rules: GamingReviewedSourceRule[] = [
    { id: 'prism-current', game: syntheticGame, hosts: ['prism.test'], path: '/updates/current', pathMatch: 'exact',
      category: 'official_updates', currentness: 'current_index', durableAllowed: false, autoStoreAllowed: false,
      metadataAdapter: 'labeled-v1', currentnessArticleRuleIds: ['prism-release'] },
    { id: 'prism-release', game: syntheticGame, hosts: ['prism.test'], path: '/updates/', pathMatch: 'prefix',
      category: 'official_updates', currentness: 'article', durableAllowed: true, autoStoreAllowed: false },
    { id: 'prism-status', game: syntheticGame, hosts: ['prism.test'], path: '/status', pathMatch: 'exact',
      category: 'official_status', currentness: 'live_status', durableAllowed: false, autoStoreAllowed: false },
    { id: 'prism-status-secondary', game: syntheticGame, hosts: ['prism.test'], path: '/status-secondary', pathMatch: 'exact',
      category: 'official_status', currentness: 'live_status', durableAllowed: false, autoStoreAllowed: false }
  ];
  function setup(requiredUrl = officialArticle, requiredRules = ['prism-release']) {
    mockHttp.mockImplementation(async (url: string) => {
      const index = new URL(String(url)).pathname === '/updates/current';
      return { headers: { 'content-type': 'text/html' }, data: `<html><title>${syntheticGame} ${index ? 'current update index' : 'release notes'}</title><body><article>
        Game: ${syntheticGame}. ${index ? 'Current patch: 2.4.1. Current build: Hotfix-B.' : 'Patch: 2.4.1. Build: Hotfix-B.'}
        Effective from: ${effective}. Platforms: all. Regions: all.
        These official ${syntheticGame} release notes describe the current update, applicable equipment changes, and the release available for online play.
        </article></body></html>` };
    });
    const resolveDocument = jest.fn(resolveGamingDocument);
    const sourcePolicy = (url: string, scopedGame: string) => assessGamingSourcePolicy(url, scopedGame, rules);
    const extractFreshness: typeof extractGamingFreshnessMetadata = (document, input, now) => {
      const freshness = extractGamingFreshnessMetadata(document, input, now, rules);
      if (freshness.currentness === 'current_index') freshness.currentnessMetadata = {
        ...freshness.currentnessMetadata!, status: 'incomplete', reasons: ['OFFICIAL_PATCH_ARTICLE_REQUIRED'],
        requiredArticlePatch: freshness.currentPatch, requiredArticleUrl: requiredUrl, requiredArticleRuleIds: requiredRules
      };
      if (freshness.currentness === 'article') freshness.currentnessMetadata = {
        game: syntheticGame, ruleId: freshness.ruleId!, adapterId: 'labeled-v1', adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION,
        status: 'incomplete', reasons: ['ARTICLE_IS_NOT_CURRENT_INDEX'], verifiedAt: freshness.verifiedAt!, evidenceRefs: [], releaseActive: true
      };
      return freshness;
    };
    const evaluate = (urls: string[], overrides: Record<string, unknown> = {}) => evaluateGamingHybridCandidates({
      game: syntheticGame, prompt: 'What is a good build now?', mode: 'build', discoveryType: 'currentness_verification',
      candidates: urls.map(url => ({ url })), ...overrides
    }, context, { resolveDocument, sourcePolicy, extractFreshness });
    return { evaluate, resolveDocument };
  }
  it('acquires a generic adapter-declared article without a game-specific branch or another caller operation', async () => {
    const { evaluate, resolveDocument } = setup();
    const result = await evaluate([officialIndex]);
    expect(result.accepted.map(item => item.publicUrl)).toEqual([officialIndex, officialArticle]);
    expect(result.decisions[1]).toMatchObject({ submittedIndex: 0, origin: 'required_official_article' });
    expect(resolveDocument).toHaveBeenCalledTimes(2);
    const options = resolveDocument.mock.calls.map(call => call[2]!);
    expect(options[0].deadlineAt).toBe(options[1].deadlineAt);
    expect(result.accepted[0].freshness.currentnessMetadata).toMatchObject({
      adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION, status: 'incomplete'
    });
    expect(combineGamingCurrentnessEvidence(result.accepted.map(item => item.freshness), new Date())[0].currentnessMetadata?.status).toBe('verified');
  });
  it('does not refetch a required article already present in the caller candidate list', async () => {
    const { evaluate, resolveDocument } = setup();
    const result = await evaluate([officialIndex, officialArticle]);
    expect(resolveDocument).toHaveBeenCalledTimes(2);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.every(item => !item.origin)).toBe(true);
  });
  it('reserves the three-document cap for submitted candidates without adding a fourth fetch', async () => {
    const { evaluate, resolveDocument } = setup();
    const result = await evaluate([officialIndex, 'https://prism.test/updates/other-a', 'https://prism.test/updates/other-b']);
    expect(resolveDocument).toHaveBeenCalledTimes(3);
    expect(result.decisions).toHaveLength(3);
    expect(result.accepted.some(item => item.publicUrl === officialArticle)).toBe(false);
  });
  it.each([
    ['https://unreviewed.test/current', ['prism-release']],
    ['https://swtor.com/patchnotes', ['swtor-patch-index']],
    [officialArticle, ['unrelated-release-rule']],
    ['http://prism.test/updates/release-241', ['prism-release']]
  ])('does not follow an unsupported authority relationship: %s', async (url, ruleIds) => {
    const { evaluate, resolveDocument } = setup(url as string, ruleIds as string[]);
    const result = await evaluate([officialIndex]);
    expect(resolveDocument).toHaveBeenCalledTimes(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness.currentnessMetadata?.status).toBe('incomplete');
  });
  it.each([
    { change: 'Game: Another Game.', expected: 'GAME_MISMATCH', from: `Game: ${syntheticGame}.` },
    { change: 'Platforms: PS5.', expected: 'PLATFORM_MISMATCH', from: 'Platforms: all.' }
  ])('rejects an acquired required article outside the requested scope: $expected', async ({ change, expected, from }) => {
    const { evaluate } = setup();
    const documentResponse = mockHttp.getMockImplementation()!;
    mockHttp.mockImplementation(async (...args: unknown[]) => {
      const response = await documentResponse(...args) as { data: string };
      if (new URL(String(args[0])).pathname !== '/updates/current') response.data = response.data.replace(from, change);
      return response;
    });
    const result = await evaluate([officialIndex], { platform: 'PC' });
    expect(result.decisions[1]).toMatchObject({ origin: 'required_official_article', decision: 'rejected', reasonCodes: [expected] });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness.currentnessMetadata?.status).toBe('incomplete');
  });
  it.each([
    { destination: `${officialArticle}-redirected`, rejected: false },
    { destination: 'https://unreviewed.test/article', rejected: true }
  ])('preserves exact required article linkage across redirect to $destination', async ({ destination, rejected }) => {
    const { evaluate } = setup();
    const documentResponse = mockHttp.getMockImplementation()!;
    mockHttp.mockImplementation(async (...args: unknown[]) => new URL(String(args[0])).pathname === '/updates/release-241'
      ? { status: 302, headers: { location: destination }, data: '' } : documentResponse(...args));
    const result = await evaluate([officialIndex]);
    if (rejected) expect(result.decisions[1]).toMatchObject({ origin: 'required_official_article', decision: 'rejected', reasonCodes: ['REDIRECT_NOT_ALLOWED'] });
    else expect(result.accepted[1].publicUrl).toBe(destination);
    expect(combineGamingCurrentnessEvidence(result.accepted.map(item => item.freshness), new Date())[0].currentnessMetadata?.status).toBe('incomplete');
  });
  it.each([
    new GamingDocumentAcquisitionError('SOURCE_INACCESSIBLE', 'transport', 'HTTP_RESPONSE_UNUSABLE', 0, 403),
    new GamingDocumentAcquisitionError('SOURCE_FETCH_FAILED', 'transport', 'DECODED_LIMIT')
  ])('retains an unverified index and explicit rejection when its required article acquisition fails', async error => {
    const { evaluate, resolveDocument } = setup();
    resolveDocument.mockImplementation(async (...args) => {
      if (args[0] === officialArticle) throw error;
      return resolveGamingDocument(...args);
    });
    const result = await evaluate([officialIndex]);
    expect(result.decisions[1]).toMatchObject({ origin: 'required_official_article', decision: 'rejected', reasonCodes: [error.code] });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].freshness.currentnessMetadata?.status).toBe('incomplete');
  });
  it('does not add another acquisition window after the shared deadline expires', async () => {
    const { evaluate, resolveDocument } = setup();
    const actualNow = Date.now.bind(Date);
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => actualNow() + offset);
    resolveDocument.mockImplementation(async (...args) => {
      const document = await resolveGamingDocument(...args);
      offset = 12_001;
      return document;
    });
    const result = await evaluate([officialIndex]);
    expect(resolveDocument).toHaveBeenCalledTimes(1);
    expect(result.decisions[1]).toMatchObject({ origin: 'required_official_article', decision: 'rejected', reasonCodes: ['FETCH_BUDGET_EXHAUSTED'] });
  });
  it('permits a reviewed live-status source under its own role without granting index authority', async () => {
    const { evaluate } = setup();
    mockHttp.mockResolvedValue({ headers: { 'content-type': 'text/html' }, data: `<html><title>${syntheticGame} server status</title><body><article>
      Game: ${syntheticGame}. Source updated at: ${new Date().toISOString()}. Platforms: all. Regions: all.
      The official ${syntheticGame} live server status reports online availability and service conditions for players connecting now.
      </article></body></html>` });
    const result = await evaluate(['https://prism.test/status'], { prompt: 'Are the servers down now?', mode: 'guide' });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourcePolicy).toMatchObject({ authority: 'official', currentness: 'live_status', autoStoreAllowed: false });
  });
  it.each([
    { scope: 'Platforms: all. Regions: all.', request: {}, conflicting: true },
    { scope: 'Platforms: PS5. Regions: all.', request: { platform: 'PC' }, conflicting: false },
    { scope: 'Platforms: all. Regions: NA.', request: { region: 'EU' }, conflicting: false }
  ])('retains only an applicable contradictory official live status: $scope', async ({ scope, request, conflicting }) => {
    const { evaluate } = setup();
    mockHttp.mockImplementation(async (url: string) => {
      const conflict = new URL(String(url)).pathname === '/status-secondary';
      return { headers: { 'content-type': 'text/html' }, data: `<html><title>${syntheticGame} server status</title><body><article>
        Game: ${syntheticGame}. Source updated at: ${new Date().toISOString()}.
        ${conflict ? `${scope} Patch: 2.4.1. Patch: 2.4.2.` : 'Platforms: all. Regions: all.'}
        The official ${syntheticGame} live server status reports online availability and service conditions for players connecting now.
        </article></body></html>` };
    });
    const prompt = 'Are the servers down now?';
    const result = await evaluate(['https://prism.test/status', 'https://prism.test/status-secondary'], { prompt, mode: 'guide', ...request });
    expect(result.decisions[1].decision).toBe('rejected');
    expect(result.currentnessEvidence?.length ?? 0).toBe(conflicting ? 1 : 0);
    const freshness = evaluateGamingFreshness({ question: prompt, game: syntheticGame, ...request,
      evidence: [...result.accepted.map(item => item.freshness), ...(result.currentnessEvidence ?? [])], now: new Date() });
    expect(freshness.status).toBe(conflicting ? 'conflicting' : 'current');
    expect(freshness.usable).toBe(!conflicting);
  });
});
