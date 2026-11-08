import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const url = 'https://guides.example.org/independent-source-restriction';
const input = { game: 'Amber Pilgrim', mode: 'guide' as const, protocolVersion: 'gaming-hybrid-v2' as const,
  prompt: 'Where is the copper shield?', candidates: [{ url }] };

beforeEach(() => { http.mockReset(); });

describe('independent source-use review before layout omission', () => {
  it.each([
    '<footer>No automated use.</footer>',
    '<footer><span>No auto</span><span>mated use.</span></footer>',
    '<footer>No autom&#97;ted use.</footer>'
  ])('retains the visible restriction before a footer is excluded: %s', async restriction => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data:
      '<html><title>Amber Pilgrim guide</title><body><main><article><h1>Amber Pilgrim guide</h1>'
      + '<p>In Amber Pilgrim, the copper shield is sold by the gate merchant for ten coins. '
      + 'Collect ten coins before buying the copper shield and equip it before crossing the bridge.</p>'
      + '</article></main>' + restriction + '</body></html>' });
    const document = await resolveGamingDocument(url);
    expect(document.sourceUseRestricted).toBe(true);
    const result = await evaluateGamingHybridCandidates(input, { actorKey: 'independent-source-use-review' });
    expect(result.accepted).toHaveLength(0);
    expect(result.decisions[0].reasonCodes).toContain('SOURCE_USE_RESTRICTED');
  });
});
