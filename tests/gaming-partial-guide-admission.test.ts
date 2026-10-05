import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { buildGamingRetrievalTerms, gamingTermCoverage } from '../src/shared/gaming/gamingRetrievalPolicy.js';

const fetch = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(fetch) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates, selectGamingHybridAcceptedEvidence, selectGamingHybridEvidence } = await import('../src/services/gamingHybridCandidates.js');
const { assessGamingRequestCoverage } = await import('../src/shared/gaming/gamingClearEvidence.js');
const actor = { actorKey: 'partial-guide-test', workflowId: 'partial-guide-workflow', requestId: 'partial-guide-request' };
const request = { game: 'Elden Ring', mode: 'build' as const,
  prompt: 'Create an early-game Samurai katana build focusing on survivability dexterity endurance equipment progression upgrades combat tactics',
  protocolVersion: 'gaming-hybrid-v2' };
const blade = 'In Elden Ring, Samurai start with an Uchigatana katana. Use its Unsheathe skill during an enemy recovery window, and keep enough stamina for a dodge after striking. This starting blade can remain equipped while exploring the opening area.';
const stats = 'In Elden Ring, survivability improves when Vigor is increased before offensive attributes. Raise dexterity to satisfy equipped armament requirements and endurance for a comfortable medium roll. Equipment progression prioritizes upgrades with Smithing Stones before spreading attribute points too widely.';
async function acquire(texts: string[], options: { game?: string; protocolVersion?: string; bodyHtml?: string } = {}) {
  const game = options.game ?? request.game;
  fetch.mockImplementation(async (url: string) => ({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${game} guide</title><body><article><p>${texts[Number(url.slice(-1))].replaceAll('Elden Ring', game)}</p>${options.bodyHtml ?? ''}</article></body></html>` }));
  return evaluateGamingHybridCandidates({ ...request, ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    candidates: texts.map((_text, index) => ({ url: `https://guides.example.org/partial-${index}` })) }, actor);
}

describe('relevant partial source admission and aggregate sufficiency', () => {
  it('admits a usable blade contribution below the full-question lexical floor', async () => {
    expect(gamingTermCoverage(blade, buildGamingRetrievalTerms(request).focusTerms)).toBeLessThan(0.25);
    const acquired = await acquire([blade]);
    expect(acquired.accepted).toHaveLength(1);
    expect(acquired.decisions[0].reasonCodes).toContain('VALIDATED_RELEVANT_CONTENT');
    expect(acquired.accepted[0].evidenceRecords).toHaveLength(1);
    const retained = selectGamingHybridAcceptedEvidence(request, acquired.accepted, actor);
    expect(retained.evidence).toHaveLength(1);
    expect(assessGamingRequestCoverage(request, retained).coverageSatisfied).toBe(false);
    expect(selectGamingHybridEvidence(request, retained).coverageSatisfied).toBe(false);
  });
  it('combines complementary admitted blade and stat evidence before declaring coverage sufficient', async () => {
    const acquired = await acquire([blade, stats]);
    expect(acquired.accepted).toHaveLength(2);
    const retained = selectGamingHybridAcceptedEvidence(request, acquired.accepted, actor);
    expect(retained.evidence).toHaveLength(2);
    expect(assessGamingRequestCoverage(request, retained).coverageSatisfied).toBe(true);
    expect(selectGamingHybridEvidence(request, retained)).toMatchObject({ coverageSatisfied: true,
      selectedCandidateIds: expect.arrayContaining(acquired.accepted.map(item => item.candidateId)) });
  });
  it('admits an intact weapon record missing the skill dimension without inventing a complete build tuple', async () => {
    const acquired = await acquire([blade], { bodyHtml: '<table><tr><th>Build</th><th>Item</th><th>Scope</th><th>Description</th></tr><tr><td>Samurai</td><td>Uchigatana katana</td><td>base-game</td><td>Retain the starting blade and preserve stamina before striking.</td></tr></table>' });
    expect(acquired.accepted).toHaveLength(1);
    expect(acquired.accepted[0].sourceAssessment.blockingFindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'STRUCTURAL_CLAIM_FIELDS_MISSING' })]));
    const retained = selectGamingHybridAcceptedEvidence(request, acquired.accepted, actor);
    expect(retained.evidence?.flatMap(chunk => chunk.evidenceUnits ?? [])).toHaveLength(1);
    expect(assessGamingRequestCoverage(request, retained).coverageSatisfied).toBe(false);
  });
  it('rejects unrelated same-game advice and explicit wrong-game material', async () => {
    const irrelevant = await acquire(['In Elden Ring, map markers identify a nearby cave and checkpoint. Inspect the cave map before following the path to the gate. These navigation instructions describe map symbols and nearby sites of grace.']);
    expect(irrelevant.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['QUESTION_COVERAGE_INSUFFICIENT'] }]);
    const wrong = await acquire([blade], { game: 'Diablo 4' });
    expect(wrong.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['GAME_MISMATCH'] }]);
  });
  it('preserves the legacy v1 single-source admission floor', async () => {
    const acquired = await acquire([blade], { protocolVersion: 'gaming-hybrid-v1' });
    expect(acquired.accepted).toEqual([]);
    expect(acquired.decisions[0].reasonCodes).toEqual(['QUESTION_COVERAGE_INSUFFICIENT']);
  });
});
