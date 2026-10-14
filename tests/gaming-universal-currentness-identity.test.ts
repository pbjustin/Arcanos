import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { resolveGamingDocument, isResolvedGamingDocumentIdentityVerified } = await import('../src/services/gamingDocumentResolution.js');
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy, extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');

const GAME = 'Elden Ring';
const INDEX = 'https://en.bandainamcoent.eu/elden-ring/elden-ring/news';
const ARTICLE = 'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-110-hotfix';
const input = { game: GAME, mode: 'guide' as const, prompt: 'Explain the patch notes.' };
const title = 'Elden Ring – Patch Notes Version 1.10';
const articleHtml = (extra = '', platform = 'Steam') => `<html><head><title>${title}</title></head><body><main><article>`
  + `<h1>${title}</h1><p>Targeted Platforms</p><p>${platform}</p><p>App Ver. 1.10</p><p>Regulation Ver. 1.10.1</p>`
  + '<p>Online play requires the player to apply this update. Further updates will be distributed in the future.</p>'
  + `<h2>Bug Fixes</h2><p>Corrected a display issue in the equipment screen.</p>${extra}</article></main></body></html>`;
const indexHtml = (extra = '', href = ARTICLE) => '<html><head><title>ELDEN RING news | Synthetic publisher</title></head><body><main>'
  + '<h1>Latest News on ELDEN RING.</h1><div class="search__section"><h2 id="patch-notes">Patch Notes (1)</h2>'
  + `<ul class="cards-list"><li><a href="${href}"><h3>${title}</h3><time>08/09/2026</time></a></li></ul></div>`
  + `${extra}</main></body></html>`;

async function inspect(url: string, html: string, requestedGame = GAME) {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: html });
  const document = await resolveGamingDocument(url, 1_000_000, { documentPurpose: 'durable' });
  expect(isResolvedGamingDocumentIdentityVerified(document, url)).toBe(true);
  const request = { ...input, game: requestedGame };
  const policy = assessGamingSourcePolicy(url, requestedGame);
  return { document, policy, freshness: extractGamingFreshnessMetadata(document, request),
    identity: assessGamingClearSourceIdentity(document, request, policy) };
}

beforeEach(() => {
  http.mockReset();
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('reviewed official currentness ownership from real acquired adapter input', () => {
  it('accepts the exact reviewed index DOM while preserving its required companion state', async () => {
    const { document, policy, freshness, identity } = await inspect(INDEX, indexHtml());
    expect(document.currentnessDocument).toMatchObject({ ruleId: 'elden-ring-update-index',
      adapterId: 'article-index-v1', status: 'complete', rawContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(policy).toMatchObject({ authority: 'official', ruleId: 'elden-ring-update-index', currentness: 'current_index' });
    expect(freshness.currentnessMetadata).toMatchObject({ status: 'incomplete', requiredArticlePatch: '1.10',
      requiredArticleUrl: ARTICLE, reasons: ['OFFICIAL_PATCH_ARTICLE_REQUIRED', 'HOTFIX_BUILD_CHECK_REQUIRED'] });
    expect(freshness.currentBuild).toBeUndefined();
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('accepts an independently parsed article release without claiming it establishes the latest update', async () => {
    const { document, freshness, identity } = await inspect(ARTICLE, articleHtml());
    expect(document.currentnessDocument).toMatchObject({ ruleId: 'elden-ring-news', adapterId: 'patch-article-v1',
      status: 'complete', platformText: 'Steam' });
    expect(freshness.currentnessMetadata).toMatchObject({ status: 'incomplete', patch: '1.10', build: '1.10.1',
      releaseActive: true, reasons: ['ARTICLE_IS_NOT_CURRENT_INDEX'] });
    expect(freshness.currentPatch).toBeUndefined();
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each([INDEX, ARTICLE])('does not grant ownership from a reviewed URL and title alone: %s', async url => {
    const pageTitle = url === INDEX ? 'ELDEN RING news' : title;
    const { freshness, identity } = await inspect(url, `<html><title>${pageTitle}</title><body><main>`
      + `<h1>${pageTitle}</h1><p>Read the update information and review the available notes.</p></main></body></html>`);
    expect(freshness.currentnessMetadata?.status).not.toBe('verified');
    expect(identity.status).not.toBe('verified');
  });

  it.each([['index', indexHtml()], ['article', articleHtml()]])
  ('does not let an unreviewed copied %s layout acquire official ownership', async (_kind, body) => {
    const { document, policy, identity } = await inspect('https://guides.example.org/copied-official-layout', body);
    expect(policy.authority).toBe('unreviewed');
    expect(document.currentnessDocument).toBeUndefined();
    expect(identity.status).not.toBe('verified');
  });

  it.each([['index', INDEX, indexHtml], ['article', ARTICLE, articleHtml]] as const)
  ('keeps an acquired wrong-game declaration terminal despite valid %s layout', async (_kind, url, page) => {
    const { identity } = await inspect(url, page('<p>In the game Fallout 4, use unrelated equipment.</p>'));
    expect(identity).toMatchObject({ status: 'conflict', gameIdentityVerified: false, reasonCodes: ['GAME_MISMATCH'] });
  });

  it.each([['index', INDEX, indexHtml], ['article', ARTICLE, articleHtml]] as const)
  ('preserves an explicit expansion conflict despite valid %s adapter input', async (_kind, url, page) => {
    const { identity } = await inspect(url, page('<p>Edition: Shadow of the Erdtree.</p>'));
    expect(identity).toMatchObject({ status: 'conflict', reasonCodes: ['EDITION_CONFLICT'] });
  });

  it('does not accept a current-index card pointing outside its reviewed article destination', async () => {
    const { document, freshness, identity } = await inspect(INDEX, indexHtml('', 'https://guides.example.org/forged-companion'));
    expect(document.currentnessDocument?.status).toBe('incomplete');
    expect(freshness.currentnessMetadata?.reasons).not.toEqual(['OFFICIAL_PATCH_ARTICLE_REQUIRED', 'HOTFIX_BUILD_CHECK_REQUIRED']);
    expect(identity.status).not.toBe('verified');
  });

  it('does not accept a hidden official index layout as independent ownership', async () => {
    const { document, identity } = await inspect(INDEX, indexHtml().replace('<main>', '<main hidden>'));
    expect(document.currentnessDocument?.status).toBe('incomplete');
    expect(identity.status).not.toBe('verified');
  });

  it('withholds adapter ownership when acquired article and title versions conflict', async () => {
    const { freshness, identity } = await inspect(ARTICLE, articleHtml().replace('App Ver. 1.10', 'App Ver. 1.9'));
    expect(freshness.currentnessMetadata?.status).toBe('conflicting');
    expect(identity.status).not.toBe('verified');
  });

  it('does not grant release ownership while the article says activation is only scheduled', async () => {
    const { freshness, identity } = await inspect(ARTICLE, articleHtml('<p>This update is scheduled for tomorrow.</p>'));
    expect(freshness.currentnessMetadata).toMatchObject({ status: 'incomplete', releaseActive: false,
      reasons: ['ARTICLE_IS_NOT_CURRENT_INDEX', 'OFFICIAL_RELEASE_ACTIVATION_REQUIRED'] });
    expect(identity.status).not.toBe('verified');
  });

  it.each(['Steam (rollout starts tomorrow)', 'Steam / Unknown Console', 'Steam in EU only'])
  ('withholds unsupported article scope: %s', async platform => {
    const { freshness, identity } = await inspect(ARTICLE, articleHtml('', platform));
    expect(freshness.currentnessMetadata?.reasons).toContain('OFFICIAL_ARTICLE_PLATFORM_SCOPE_REQUIRED');
    expect(identity.status).not.toBe('verified');
  });

  it('does not lend another requested game the reviewed Elden Ring adapter proof', async () => {
    const { policy, identity } = await inspect(INDEX, indexHtml(), 'Elden Ring Nightreign');
    expect(policy.authority).toBe('unreviewed');
    expect(identity.status).not.toBe('verified');
  });
});
