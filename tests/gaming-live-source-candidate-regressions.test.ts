import { describe, expect, it } from '@jest/globals';
import { selectGamingHybridEvidence } from '../src/services/gamingHybridCandidates.js';
import { assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import type { GamingStoredKnowledgeContext, GamingStoredKnowledgeInput } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

// Synthetic accepted passages test selection and citation binding. They are not
// publisher copies or proof of acquisition, currentness, or provider generation.
const fetchedAt = new Date().toISOString();
const request: GamingStoredKnowledgeInput = {
  game: 'Elden Ring', edition: 'base-game', platform: 'PC', mode: 'guide', class: 'Samurai',
  prompt: 'Explain Uchigatana bleed setup; Vigor allocation through level 50; Smithing Stones upgrade route.'
};
const passages = [
  'In Elden Ring base-game solo PvE, the Samurai Uchigatana bleed setup uses the starting katana. Bleed buildup requires repeated hits and only applies when the enemy is vulnerable to bleed.',
  'For Elden Ring base-game Samurai solo PvE, Vigor allocation through level 50 prioritizes survival before increasing Dexterity. These allocation recommendations assume the starting Uchigatana requirements are already met.',
  'The Elden Ring base-game Smithing Stones upgrade route starts in Limgrave tunnels. Use ordinary Smithing Stones for the starting Uchigatana; this route does not require Shadow of the Erdtree access.'
];

function knowledge(texts = passages): GamingStoredKnowledgeContext {
  const sources = texts.map((text, index) => ({ sourceId: `samurai-candidate-${index}`, game: request.game,
    edition: request.edition, url: `https://guides.example.org/elden-ring/samurai-${index}`, sourceType: 'supplied',
    origin: 'live' as const, fetchedAt, snippet: text }));
  return { context: '', sources, evidence: texts.map((text, index) => ({ sourceId: sources[index].sourceId,
    revisionId: `samurai-revision-${index}`, recordId: `samurai-record-${index}`, recordType: 'guide',
    publicUrl: sources[index].url, text, lexicalScore: 1, combinedScore: 1,
    headingPath: ['Elden Ring', 'Base-game Samurai solo PvE'],
    provenance: { fetchedAt, resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', resolutionStrategy: 'article' } })) };
}

describe('live Samurai accepted-pool evidence regression boundaries', () => {
  it('combines complementary Samurai bleed topics while retaining every passage qualification and citation identity', () => {
    for (const passage of passages) {
      expect(assessGamingRequestCoverage(request, knowledge([passage])).coverageSatisfied).toBe(false);
    }
    const original = knowledge();
    const selected = selectGamingHybridEvidence(request, original);
    expect(selected).toMatchObject({ coverageSatisfied: true, missingCoverage: [], materialConflict: false });
    expect([...selected.selectedCandidateIds].sort()).toEqual(original.sources.map(source => source.sourceId).sort());
    expect([...selected.selectedEvidenceIds].sort()).toEqual(original.evidence!.map(chunk => chunk.recordId).sort());
    expect(selected.knowledge.evidence).toHaveLength(original.evidence!.length);
    for (const chunk of selected.knowledge.evidence!) {
      expect(chunk).toEqual(original.evidence!.find(acquired => acquired.recordId === chunk.recordId));
    }
    expect(selected.requirementSupport.map(support => support.candidateIds)).toEqual(
      original.sources.map(source => [source.sourceId]));
    expect(selected.requirementSupport.map(support => support.evidenceIds)).toEqual(
      original.evidence!.map(chunk => [chunk.recordId]));
    for (const chunk of selected.knowledge.evidence!) {
      expect(selected.knowledge.sources.find(source => source.sourceId === chunk.sourceId)?.url).toBe(chunk.publicUrl);
      expect(selected.knowledge.context).toContain(chunk.text);
      expect(chunk.provenance.fetchedAt).toBe(fetchedAt);
    }
    expect(selected.knowledge.context.length).toBeLessThanOrEqual(12_000);
  });

  it('inspects relevant late Samurai evidence before compacting the full accepted document pool', () => {
    const background = passages[0];
    const original = knowledge([...Array<string>(30).fill(background), passages[1], passages[2]]);
    const source = original.sources[0];
    original.sources = [source];
    for (const chunk of original.evidence!) Object.assign(chunk, {
      sourceId: source.sourceId, publicUrl: source.url, revisionId: 'samurai-full-document-revision'
    });
    const selected = selectGamingHybridEvidence(request, original);
    expect(selected).toMatchObject({ coverageSatisfied: true, missingCoverage: [], materialConflict: false });
    expect(selected.selectedEvidenceIds).toContain('samurai-record-30');
    expect(selected.selectedEvidenceIds).toContain('samurai-record-31');
    expect(selected.knowledge.evidence).toHaveLength(3);
    expect(selected.knowledge.sources).toEqual([source]);
    expect(selected.knowledge.evidence!.every(chunk => chunk.revisionId === 'samurai-full-document-revision')).toBe(true);
    expect(selected.knowledge.context).toContain(passages[1]);
    expect(selected.knowledge.context).toContain(passages[2]);
    expect(selected.knowledge.context.length).toBeLessThanOrEqual(12_000);
  });

  it.each(['missing-source', 'different-public-url', 'invalid-fetch-provenance'] as const)(
    'does not let %s establish Samurai topic coverage', defect => {
      const original = knowledge();
      const chunk = original.evidence![2];
      if (defect === 'missing-source') chunk.sourceId = 'unbound-source';
      if (defect === 'different-public-url') chunk.publicUrl = 'https://unrelated.example.org/copied-guide';
      if (defect === 'invalid-fetch-provenance') chunk.provenance.fetchedAt = '';
      const selected = selectGamingHybridEvidence(request, original);
      expect(selected.coverageSatisfied).toBe(false);
      expect(selected.requirementSupport[2].evidenceIds).toEqual([]);
      expect(selected.selectedEvidenceIds).not.toContain(chunk.recordId);
    });
});
