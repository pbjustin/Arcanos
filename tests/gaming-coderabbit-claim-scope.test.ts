import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { gamingAttributableClaimText, buildGamingRequestRequirements } = await import('../src/shared/gaming/gamingRetrievalPolicy.js');
const { assessGamingRequestCoverage, assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { classifyGamingDocumentQuality } = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const game = 'Amber Pilgrim';
const url = 'https://guides.example.org/coderabbit-claim-scope';
const title = `${game} Wiki Guide`;
const definition = `${game} is an open-world role-playing game.`;
const gameplay = `In the game ${game}, collect the practice token before unlocking the practice route.`;
const request = { game, mode: 'guide' as const, prompt: 'How do I unlock the practice route?' };
function publish(text: string) {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${title}</title><article><h1>${title}</h1><p>${text}</p></article></html>` });
}
function knowledge(texts: string[]): GamingStoredKnowledgeContext {
  const fetchedAt = '2026-11-07T12:00:00.000Z';
  return { context: texts.join('\n'), sources: texts.map((text, index) => ({ game, sourceId: `source-${index}`,
    url: `${url}/${index}`, sourceType: 'supplied', fetchedAt, snippet: text })),
  evidence: texts.map((text, index) => ({ sourceId: `source-${index}`, revisionId: `revision-${index}`,
    recordId: `record-${index}`, recordType: 'guide', publicUrl: `${url}/${index}`, text,
    lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt } })) };
}
beforeEach(() => { http.mockReset(); });

describe('CodeRabbit acquired claim and scope regressions (authored synthetic fixtures)', () => {
  it('normalizes every requested topic while preserving the original currentness requirement', () => {
    const input = { game, mode: 'build' as const,
      prompt: 'Recommend a good weapon configuration and stat allocation on the current patch.' };
    const original = { ...input };
    const selected = knowledge(['Weapon configuration uses a copper blade and a round shield.',
      'Stat allocation prioritizes vigor before raising dexterity.']);
    expect(buildGamingRequestRequirements(input)).toEqual([
      { requirement: 'weapon configuration', terms: ['weapon', 'configuration'] },
      { requirement: 'stat allocation', terms: ['stat', 'allocation'] }
    ]);
    expect(assessGamingRequestCoverage(input, selected)).toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    const assessment = assessGamingClearEvidence(input, selected, { identityVerified: true });
    expect(assessment.gates).toMatchObject({ claimSupport: 'verified', freshness: 'unknown' });
    expect(assessment.decision).not.toBe('accept');
    expect(input).toEqual(original);
    expect(assessGamingRequestCoverage(input, knowledge([selected.evidence![0].text])).coverageSatisfied).toBe(false);
  });

  it('retains an explicit patch-changes question as its own factual requirement', () => {
    const input = { game, mode: 'guide' as const, prompt: 'Explain current patch changes and stamina recovery.' };
    expect(buildGamingRequestRequirements(input)[0].terms).toEqual(expect.arrayContaining(['patch', 'changes']));
    expect(assessGamingRequestCoverage(input, knowledge(['Stamina recovery restores charge while resting.'])).coverageSatisfied).toBe(false);
  });

  it('rejects a foreign guide scope even when an imperative follows its complete title', async () => {
    publish(`${definition} ${gameplay} In Crystal Odyssey guide unlock the practice route.`);
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
    const result = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
      { actorKey: 'synthetic-coderabbit-scope' });
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toContain('GAME_MISMATCH');
  });

  it('retains concatenated local navigation without inventing a foreign guide scope', async () => {
    publish(`${definition} ${gameplay} Browse entries in the Full Walkthrough Practice Chapter Alpha Walkthrough.`);
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, game)).status).toBe('verified');
  });

  it('retains a requested-game guide scope followed by an imperative', async () => {
    publish(`${definition} ${gameplay} In ${game} guide unlock the practice route.`);
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, game)).status).toBe('verified');
  });

  it.each(['Blocking halves incoming damage.', 'Parrying staggers nearby enemies.'])(
    'retains an attributable declarative mechanic: %s', async fact => {
      expect(gamingAttributableClaimText(fact, game)).toBe(fact);
      const input = { ...request, prompt: fact.startsWith('Blocking') ? 'Explain blocking damage.' : 'Explain parrying enemies.' };
      publish(`${definition} ${fact}`);
      const result = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
        { actorKey: 'synthetic-coderabbit-factual' });
      expect(result.accepted).toHaveLength(1);
      expect(assessGamingClearEvidence(input, result.knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
    }
  );

  it.each([
    `${game} is an open-world role-playing game developed by Copper Studio.`,
    `${game} is an open-world role-playing game developed by Copper Studio and published by Lantern Works.`,
    `${game} is an open-world role-playing game. It was developed by Copper Studio and published by Lantern Works.`
  ])('does not treat acquired game identity and authorship metadata as gameplay: %s', async text => {
    expect(gamingAttributableClaimText(text, game)).toBe('');
    publish(text);
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, game)).status).toBe('verified');
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game,
      evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).not.toBe('complete');
    expect(assessGamingClearEvidence({ ...request, prompt: 'Explain Copper Studio.' }, knowledge([text]),
      { identityVerified: true }).gates.claimSupport).toBe('unknown');
  });

  it('retains gameplay beside metadata even within the same sentence', () => {
    const text = `${game} is an open-world role-playing game developed by Copper Studio, while blocking halves incoming damage.`;
    expect(gamingAttributableClaimText(text, game)).toContain('blocking halves incoming damage');
  });

  it.each(['About the game', 'About the game.', 'Overview of the game', 'Details about the game'])(
    'keeps a nominal section label out of gameplay claim support: %s', label => {
      expect(gamingAttributableClaimText(label, game)).toBe('');
      expect(classifyGamingDocumentQuality({ cleanedText: `${definition}\n${label}`, game, truncated: false,
        minUsefulTextChars: 120 })).not.toBe('complete');
    }
  );

  it('does not infer gameplay from a nominal heading in a protected acquired wiki', async () => {
    publish(`${definition}</p><p>About the game`);
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, game)).status).toBe('verified');
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game,
      evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).not.toBe('complete');
    expect(assessGamingClearEvidence({ ...request, prompt: 'Explain the game.' }, knowledge([`${definition}\nAbout the game`]),
      { identityVerified: true }).gates.claimSupport).toBe('unknown');
  });

  it('keeps a parser-owned About heading before identity and authorship metadata non-authoritative', async () => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data:
      `<html><title>${title}</title><article><h1>${title}</h1><h2>About the game</h2>`
      + `<p>${game} is an open-world role-playing game developed by Copper Studio.</p></article></html>` });
    const document = await resolveGamingDocument(url);
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game,
      evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).not.toBe('complete');
    expect(assessGamingClearEvidence({ ...request, prompt: 'Explain Copper Studio.' }, knowledge([document.text]),
      { identityVerified: true }).gates.claimSupport).toBe('unknown');
  });

  it.each(['Align the tidal prism before crossing the channel.', 'Use the shield to block incoming attacks.',
    'The copper blade costs seven tokens.', 'The copper blade is beneath the training bridge.'])(
    'preserves an independently intelligible gameplay clause: %s', fact => {
      expect(gamingAttributableClaimText(fact, game)).toBe(fact);
    }
  );
});
