import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { gamingClearIntactSourceText } = await import('../src/shared/gaming/gamingClearSource.js');
const { hasGamingActionableProse } = await import('../src/services/gamingDocumentExtraction.js');

// Authored synthetic acquisition fixtures, not publisher captures or real Portal mechanics.
const sourceUrl = 'https://guides.example.org/short-copper-shield';
const request = { game: 'Portal 2', edition: 'base-game', mode: 'guide' as const,
  prompt: 'How do I use the shield?', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url: sourceUrl }] };
const body = (game = 'Portal 2', advice = 'Portal 2 has skills. Use the shield skill to block attacks before advancing.') =>
  `<title>${game}</title><article><p>Edition: base-game.</p><p>${advice}</p></article>`;
beforeEach(() => { http.mockReset(); });
const respond = (html: string) => http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: html });

describe('short intact prose through protected acquisition and CLEAR', () => {
  it('admits a complete, independently game-scoped action without padding the guide', async () => {
    respond(body());
    const document = await resolveGamingDocument(sourceUrl);
    expect(document.text.length).toBeLessThan(120);
    expect(document.metrics).toMatchObject({ truncated: false, instructionFiltered: false });
    expect({ text: gamingClearIntactSourceText(document), actionable: hasGamingActionableProse(gamingClearIntactSourceText(document)) })
      .toMatchObject({ actionable: true });
    const result = await evaluateGamingHybridCandidates(request, { actorKey: 'synthetic-short-guide-reader' });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceAssessment.gates.identity).toBe('verified');
    expect(result.accepted[0].sourceAssessment.gates.claimSupport).toBe('verified');
    expect(result.knowledge.evidence?.some(chunk => chunk.text.includes('block attacks'))).toBe(true);
  });

  it('keeps short labels and navigation from becoming gameplay evidence', async () => {
    respond(body('Portal 2', 'Copper shield guide. Combat tips. Equipment overview.'));
    const result = await evaluateGamingHybridCandidates(request, { actorKey: 'synthetic-short-guide-reader' });
    expect(result.accepted).toEqual([]);
    expect(result.knowledge.evidence ?? []).toEqual([]);
  });

  it('preserves source-use restrictions even on otherwise complete short prose', async () => {
    respond(body() + '<footer>No automated use.</footer>');
    const result = await evaluateGamingHybridCandidates(request, { actorKey: 'synthetic-short-guide-reader' });
    expect(result.decisions[0].reasonCodes).toContain('SOURCE_USE_RESTRICTED');
    expect(result.accepted).toEqual([]);
  });
});
