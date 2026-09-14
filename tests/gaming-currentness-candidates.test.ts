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
const { extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
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
