import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const http = jest.fn();
const trinity = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline: trinity }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter: () => ({ client: {} }) }));
const { gamingAttributableClaimText } = await import('../src/shared/gaming/gamingRetrievalPolicy.js');
const { readGamingPrimaryGameDefinition } = await import('../src/shared/gaming/gamingAcquiredIdentity.js');
const { assessGamingRequestCoverage, assessGamingClearEvidence } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { classifyGamingDocumentQuality } = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { runGameplayPipeline } = await import('../src/services/gamingPipeline.js');

const url = 'https://guides.example.org/cr2-claim-identity';
const game = 'Amber Pilgrim';
function publish(text: string, title = 'Acquired mechanics notes') {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>${title}</title><article><h1>${title}</h1><p>${text}</p></article></html>` });
}
async function acquiredKnowledge(requestedGame: string): Promise<GamingStoredKnowledgeContext> {
  const document = await resolveGamingDocument(url);
  const fetchedAt = new Date().toISOString();
  return { context: document.text,
    sources: [{ sourceId: 'source', game: requestedGame, url, title: document.metadata.title,
      sourceType: 'supplied', origin: 'live', fetchedAt, snippet: document.text }],
    evidence: [{ sourceId: 'source', revisionId: 'revision', recordId: 'record', recordType: 'guide', publicUrl: url,
      text: document.text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt },
      ...(document.evidenceUnits?.length ? { evidenceUnits: document.evidenceUnits } : {}) }] };
}
beforeEach(() => { http.mockReset(); trinity.mockReset(); });

// Authored synthetic pages; only HTTP/DNS and the forbidden provider boundary
// are replaced. Protected acquisition, parsing, identity, CLEAR and candidates run.
describe('CodeRabbit round 2 acquired identity and attributable claims', () => {
  it('verifies a decimal primary game definition without a second identity anchor', async () => {
    const decimalGame = 'Kingdom Hearts HD 1.5 Remix';
    publish(`${decimalGame} is an action role-playing game. Use the copper lever to open the canal gate.`);
    const request = { game: decimalGame, mode: 'guide' as const, prompt: 'How do I open the canal gate?' };
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, decimalGame)).status).toBe('verified');
    expect(readGamingPrimaryGameDefinition(`${decimalGame} is an action role-playing game.`)).toBe(decimalGame);
    const result = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
      { actorKey: 'synthetic-cr2-decimal' });
    expect(result.accepted).toHaveLength(1);
    expect(assessGamingRequestCoverage(request, result.knowledge).coverageSatisfied).toBe(true);
  });

  it('retains a complete foreign decimal title as an acquired identity conflict', async () => {
    publish('Kingdom Hearts HD 2.5 Remix is an action role-playing game. Use the copper lever to open the canal gate.');
    const request = { game: 'Kingdom Hearts HD 1.5 Remix', mode: 'guide' as const, prompt: 'How do I open the canal gate?' };
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, request.game)))
      .toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('inspects negation after a decimal rather than stopping at its internal period', () => {
    expect(readGamingPrimaryGameDefinition('Kingdom Hearts HD 1.5 Remix is an action role-playing game, only a comparison reference here.')).toBeUndefined();
    expect(readGamingPrimaryGameDefinition('Read next: Kingdom Hearts HD 1.5 Remix is an action role-playing game.')).toBeUndefined();
  });

  it('keeps a registered-alias definition reference-only through acquired quality and hybrid admission', async () => {
    publish('Diablo IV is an action role-playing game.', 'Diablo 4 Wiki Guide');
    const request = { game: 'Diablo 4', mode: 'guide' as const, prompt: 'Explain the action role-playing game.' };
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, request.game)).status).toBe('verified');
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game: request.game,
      evidenceUnits: document.evidenceUnits, truncated: false, minUsefulTextChars: 120 })).not.toBe('complete');
    expect(gamingAttributableClaimText('Diablo IV is an action role-playing game.', request.game)).toBe('');
    const result = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
      { actorKey: 'synthetic-cr2-alias' });
    expect(result.accepted).toEqual([]);
    expect(assessGamingClearEvidence(request, await acquiredKnowledge(request.game), { identityVerified: true }).gates.claimSupport).toBe('unknown');
  });

  it('preserves a short acquired weight fact through candidate and selected coverage', async () => {
    publish(`In the game ${game}, the copper shield weighs seven units.`);
    const request = { game, mode: 'guide' as const, prompt: 'Explain copper shield weight.' };
    const result = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
      { actorKey: 'synthetic-cr2-weight' });
    expect(result.accepted).toHaveLength(1);
    expect(gamingAttributableClaimText('The copper shield weighs seven units.', game)).toBe('The copper shield weighs seven units.');
    expect(assessGamingRequestCoverage({ ...request, prompt: 'Explain the copper shield.' }, result.knowledge).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(request, result.knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });

  it('returns the gameplay continuation without identity or authorship words', async () => {
    const text = `${game} is an open-world role-playing game developed by Copper Studio, while blocking halves incoming damage.`;
    publish(text);
    const projected = gamingAttributableClaimText(text, game);
    expect(projected).toBe('blocking halves incoming damage.');
    const knowledge = await acquiredKnowledge(game);
    const metadataRequest = { game, mode: 'guide' as const, prompt: 'Explain Copper Studio.' };
    expect(assessGamingRequestCoverage(metadataRequest, knowledge).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(metadataRequest, knowledge, { identityVerified: true }).gates.claimSupport).toBe('unknown');
    const gameplayRequest = { ...metadataRequest, prompt: 'Explain blocking incoming damage.' };
    expect(assessGamingRequestCoverage(gameplayRequest, knowledge).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(gameplayRequest, knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });

  it('does not use acquired authorship terms as selected gameplay support', async () => {
    publish(`${game} is an open-world role-playing game developed by Copper Studio, while blocking halves incoming damage.`);
    const request = { game, mode: 'guide' as const, prompt: 'Explain Copper Studio.' };
    const knowledge = await acquiredKnowledge(game);
    expect(assessGamingRequestCoverage(request, knowledge).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(request, knowledge, { identityVerified: true }).gates.claimSupport).toBe('unknown');
    await runGameplayPipeline({ ...request, guideUrls: [], auditEnabled: false }, { knowledge, current: true, qualification: '' });
    expect(trinity).not.toHaveBeenCalled();
  });

  it.each([`${game} guide`, 'Tidal Prism Alignment guide'])(
    'preserves an acquired scoped procedure when stored selection omits nominal title metadata: %s', async title => {
    publish(`In the game ${game}, align the tidal prism with the eastern notch before rotating the relay. Preserve charge for the return crossing.`, title);
    const knowledge = await acquiredKnowledge(game);
    // The real stored formatter can omit generic display titles while retaining
    // the original acquired heading in the chunk body.
    for (const source of knowledge.sources) delete source.title;
    const request = { game, mode: 'guide' as const, prompt: 'Explain how to align the tidal prism and preserve charge.' };
    expect(assessGamingRequestCoverage(request, knowledge).coverageSatisfied).toBe(true);
    expect(assessGamingClearEvidence(request, knowledge, { identityVerified: true }).gates.claimSupport).toBe('verified');
  });

  it('does not open gameplay generation for an unfetched linked walkthrough instruction', async () => {
    publish(`In the game ${game}, read the <a href="/unfetched-walkthrough">copper shield walkthrough</a> for acquisition details.`);
    const request = { game, mode: 'guide' as const, prompt: 'How do I obtain the copper shield?' };
    const knowledge = await acquiredKnowledge(game);
    expect(assessGamingRequestCoverage(request, knowledge).coverageSatisfied).toBe(false);
    expect(assessGamingClearEvidence(request, knowledge, { identityVerified: true }).gates.claimSupport).toBe('unknown');
    const result = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
      { actorKey: 'synthetic-cr2-navigation' });
    expect(result.accepted).toEqual([]);
    await runGameplayPipeline({ ...request, guideUrls: [], auditEnabled: false }, { knowledge, current: true, qualification: '' });
    expect(trinity).not.toHaveBeenCalled();
    expect(http.mock.calls.every(([target]) => new URL(String(target)).pathname === new URL(url).pathname)).toBe(true);
  });

  it('preserves a prohibition around an acquired parenthetical game scope', async () => {
    const text = `Do not, in the game ${game}, equip the copper shield.`;
    publish(text, `${game} guide`);
    const document = await resolveGamingDocument(url);
    const projected = gamingAttributableClaimText(document.text, game, document.metadata);
    expect(projected).toMatch(/^Do not,?\s+equip the copper shield\./u);
    expect(projected).not.toMatch(/^equip\b/iu);
  });

  it('preserves both procedural clauses around an acquired game scope', async () => {
    publish(`Use the lever in the game ${game}, then cross the bridge.`, `${game} guide`);
    const document = await resolveGamingDocument(url);
    const projected = gamingAttributableClaimText(document.text, game, document.metadata);
    expect(projected).toContain('Use the lever');
    expect(projected).toContain('then cross the bridge.');
  });

  it.each(['Read the etched plaque to unlock the canal gate.', 'Follow the copper trail to reach the canal bridge.',
    'Do not equip the copper shield before crossing the canal.', 'The copper shield does not block fire damage.',
    'The walkthrough gate costs seven tokens.', 'Blocking halves incoming damage.'])(
    'preserves genuine gameplay and its negation in returned claim text: %s', text => {
      expect(gamingAttributableClaimText(text, game)).toBe(text);
    });

  it('does not count nominal weight labels or a declared sequel as the requested game', async () => {
    expect(gamingAttributableClaimText('Copper shield weight and copper shield locations.', game)).toBe('');
    publish('In the game Diablo III, collect the copper shield before opening the canal gate.');
    const request = { game: 'Diablo 4', mode: 'guide' as const, prompt: 'How do I open the canal gate?' };
    const document = await resolveGamingDocument(url);
    expect(assessGamingClearSourceIdentity(document, request, assessGamingSourcePolicy(url, request.game)).status).toBe('conflict');
  });
});
