import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import type { GamingHybridDependencies } from '../src/services/gamingHybridKnowledge.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const requestContext = { actorKey: 'corroboration-fixture-actor', requestId: 'corroboration-fixture-request' };
const contractVersion = 'gaming-hybrid-v2';
const urls = ['https://news.blizzard.com/copper-staff', 'https://www.bungie.net/copper-staff'];
const pages = new Map<string, string>();
function html(heading: string, description = 'Measured staff damage against the tutorial practice target.'): string {
  return `<html><title>Copper Vale equipment guide</title><body><article><h1>Copper Vale equipment guide</h1><p>Game: Copper Vale. Platforms: PC. Edition: Base game.</p><p>In Copper Vale, this guide reports the Copper Staff damage statistic value. Read the equipment requirements before choosing a weapon for this route.</p><section><h2>${heading}</h2><table><tr><th>Game</th><th>Item</th><th>Stat</th><th>Value</th><th>Unit</th><th>Scope</th><th>Description</th></tr><tr><td>Copper Vale</td><td>Copper Staff</td><td>damage</td><td>20</td><td>HP</td><td>base-game</td><td>${description}</td></tr></table></section></article></body></html>`;
}
beforeEach(() => {
  http.mockReset(); pages.clear();
  jest.spyOn(logger, 'info').mockImplementation(() => {});
  http.mockImplementation(async (url: string, options?: { headers?: { Host?: string } }) => {
    const target = new URL(url);
    if (options?.headers?.Host) target.host = options.headers.Host;
    return { status: 200, headers: { 'content-type': 'text/html' }, data: pages.get(target.toString()) ?? '' };
  });
});
afterEach(() => { jest.restoreAllMocks(); });

async function run(urlsToSubmit: string[], required = false, hints = {}) {
  let prepared: GamingStoredKnowledgeContext | undefined;
  const generate = jest.fn<GamingHybridDependencies['generate']>().mockImplementation(async (_input, evidence) => {
    prepared = evidence.knowledge;
    // This fixture proves the handoff and stops before any provider or answer audit.
    throw new Error('Sealed corroboration handoff fixture');
  });
  const ingest = jest.fn<GamingHybridDependencies['ingest']>();
  const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], evidence: [] }),
    generate, ingest, now: Date.now });
  const question = `What is the Copper Staff damage statistic value?${required ? ` ${urlsToSubmit.join(' ')}` : ''}`;
  const queried = await workflow.query({ contractVersion, game: 'Copper Vale', edition: 'base-game', platform: 'PC',
    question, mode: 'guide', storagePolicy: 'transient_only', idempotencyKey: 'corroboration-fixture-query' }, requestContext);
  expect(queried.body.nextAction).toBe('search');
  const submitted = await workflow.candidates({ contractVersion, workflowId: queried.body.workflowId,
    expectedRevision: queried.body.revision, idempotencyKey: 'corroboration-fixture-candidates',
    candidates: urlsToSubmit.map(url => ({ url, ...hints })) }, requestContext);
  if (generate.mock.calls.length !== 1) throw new Error(JSON.stringify({ reason: submitted.body.reason,
    candidates: submitted.body.candidates?.map(candidate => candidate.reasonCodes), missing: submitted.body.missingCoverage,
    selectedCount: submitted.body.selectedCandidateIds?.length, gapStatus: submitted.body.gapAssessmentStatus }));
  expect(ingest).not.toHaveBeenCalled();
  expect(submitted.body.answer).toBeUndefined();
  return prepared!;
}

describe('v2 selected-evidence corroboration handoff', () => {
  it('uses acquired identity, applicability and reviewed source families through the real candidate path', async () => {
    pages.set(urls[0], html('Copper Vale staff damage report'));
    pages.set(urls[1], html('Copper Vale equipment statistics', 'Field notes record damage before adding equipment bonuses.'));
    const knowledge = await run(urls, true, { claimedGame: 'Unrelated Game', claimedPublisher: 'Unreviewed Publisher' });
    expect(knowledge.sources).toHaveLength(2);
    expect(knowledge.claimCorroboration?.claims).toContainEqual(expect.objectContaining({
      status: 'independently_corroborated', reviewedIndependentFamilyCount: 2
    }));
    expect(knowledge.sources.every(source => source.clearSourceAssessment?.gates.identity === 'verified')).toBe(true);
  });

  it('copied fields with different publication headings stay single-source through the real candidate path', async () => {
    pages.set(urls[0], html('Copper Vale staff damage report'));
    pages.set(urls[1], html('Copper Vale equipment statistics'));
    const knowledge = await run(urls, true);
    expect(knowledge.sources).toHaveLength(2);
    expect(knowledge.claimCorroboration?.claims).toContainEqual(expect.objectContaining({
      status: 'single_source', reviewedIndependentFamilyCount: 1
    }));
    expect(knowledge.claimCorroboration?.reasonCodes).toContain('DUPLICATED_CLAIM_REPORTS');
  });

  it('computes reports from the selected set after the normal minimal-source selection', async () => {
    pages.set(urls[0], html('Copper Vale staff damage report'));
    pages.set(urls[1], html('Copper Vale equipment statistics'));
    const knowledge = await run(urls);
    expect(knowledge.sources).toHaveLength(1);
    expect(knowledge.claimCorroboration?.claims.every(claim => claim.status === 'single_source')).toBe(true);
    const selected = new Set(knowledge.sources.map(source => source.sourceId));
    expect(knowledge.claimCorroboration?.claims.every(claim => claim.sourceIds.every(id => selected.has(id)))).toBe(true);
  });

  it('frontend publisher claims never give an unknown hostname independence credit', async () => {
    const unknown = 'https://unreviewed.example/copper-staff';
    pages.set(unknown, html('Copper Vale staff damage report'));
    const knowledge = await run([unknown], false, { claimedPublisher: 'Microsoft Gaming', claimedGame: 'Copper Vale' });
    expect(knowledge.claimCorroboration?.claims).toContainEqual(expect.objectContaining({ status: 'single_source',
      reviewedIndependentFamilyCount: 0 }));
  });
});
