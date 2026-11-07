import { describe, expect, it } from '@jest/globals';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const game = 'The Legend of Zelda: Ocarina of Time';
const input = { game, mode: 'guide' as const, prompt: 'How do I get the shield from the tutorial area in Ocarina of Time?' };
const fetchedAt = new Date().toISOString();
function stored(text: string, title?: string): GamingStoredKnowledgeContext {
  const url = 'https://guides.example.org/stored-shield';
  return { context: '', sources: [{ sourceId: 'stored-overview', game, url, title, sourceType: 'supplied',
    origin: 'stored', fetchedAt, snippet: text }], evidence: [{ sourceId: 'stored-overview', revisionId: 'stored-revision',
    recordId: 'stored-guide-0', recordType: 'guide', publicUrl: url, text, lexicalScore: 1, combinedScore: 1,
    provenance: { fetchedAt } }] };
}

describe('stored passages cannot restore overview-only gameplay coverage', () => {
  it.each([
    [`In the game ${game}, this page lists a tutorial shield record.`, undefined],
    [`${game} gameplay guide In the game ${game}, this page lists a tutorial shield record.`, `${game} gameplay guide`],
    [`${game} gameplay guide In the game ${game}, this page lists a tutorial shield record.`, undefined]
  ])('rejects an actor-owned stored topic description without gameplay support: %s', (text, title) => {
    expect(assessGamingRequestCoverage(input, stored(text!, title)).coverageSatisfied).toBe(false);
    const assessment = assessGamingClearEvidence(input, stored(text!, title), { identityVerified: true });
    expect(assessment.gates.claimSupport).not.toBe('verified');
    expect(assessment.decision).not.toBe('accept');
  });

  it('preserves independently sufficient declarative gameplay evidence from storage', () => {
    const text = `In the game ${game}, the tutorial-area shield is the Deku Shield. `
      + 'The Deku Shield is sold to Child Link at Kokiri Shop in Kokiri Forest for 40 Rupees.';
    expect(assessGamingRequestCoverage(input, stored(text)).coverageSatisfied).toBe(true);
  });
});
