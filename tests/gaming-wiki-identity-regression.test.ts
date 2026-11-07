import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingWikiIdentityFixture as fixture } from './fixtures/gaming-wiki-identity.js';
import { createHash } from 'node:crypto';

const http = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { resolveGamingDocument, isResolvedGamingDocumentIdentityVerified } = await import('../src/services/gamingDocumentResolution.js');
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { selectGamingGameScopedDocument, assessGamingStructuralUsability } = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { normalizeGamingComparableIdentity } = await import('../src/shared/gaming/gamingGameRegistry.js');
const { classifyGamingDocumentQuality } = await import('../src/shared/gaming/gamingDocumentIngestionCore.js');
const input = { game: fixture.game, mode: 'guide' as const, prompt: 'How do I unlock the practice route?' };

function publish(prose: string, title = fixture.title) {
  http.mockImplementation(async (_target: string, options: any) => {
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'stream' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('Cookie');
    return { status: 200, headers: { 'content-type': 'text/html' }, data: fixture.html(prose, title) };
  });
}
async function acquireIdentity(prose: string, title = fixture.title, game = fixture.game) {
  publish(prose, title);
  const document = await resolveGamingDocument(fixture.url);
  return { document, identity: assessGamingClearSourceIdentity(document, { ...input, game }, assessGamingSourcePolicy(fixture.url, game)) };
}
beforeEach(() => { http.mockReset(); jest.spyOn(logger, 'info').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

describe('wiki identity and gameplay eligibility through protected acquisition (synthetic)', () => {
  it('establishes wiki landing-page identity from an independently acquired game definition', async () => {
    const { document, identity } = await acquireIdentity(`${fixture.definition} ${fixture.catalog}`);
    expect(document.metadata.title).toBe(fixture.title);
    expect(document.text).not.toContain('Fallout 4');
    expect(document.text).not.toContain('Edition: Bedrock');
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('uses the same primary wiki definition rule for an unregistered game', async () => {
    const game = 'Amber Pilgrim';
    const { identity } = await acquireIdentity(`${game} is an open-world role-playing game. ${fixture.catalog}`,
      `${game} Wiki Guide`, game);
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('keeps inline identity prose intact when the parser appends an equal metadata record', async () => {
    const game = 'Platinum Frontier';
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data:
      `<html><title>${game} Wiki</title><main><h1>${game}</h1><p>Game: ${game}. Edition: base game.</p>`
      + '<p>Platinum catalog overview. Welcome to the community wiki catalog. Browse the index of locations, items and walkthrough chapters. '
      + 'This landing page contains reference links for readers to choose an individual article; it does not explain gameplay steps or item acquisition.</p>'
      + '<a href="https://synthetic-guides.example.org/unacquired">Platinum walkthrough</a></main></html>' });
    const document = await resolveGamingDocument(fixture.url);
    expect(document.text).toContain(`Game: ${game}. Edition: base game.`);
    expect(document.evidenceUnits?.some(unit => unit.text === `Game: ${game}`)).toBe(true);
    expect(classifyGamingDocumentQuality({ cleanedText: document.text, metadata: document.metadata, game,
      truncated: false, minUsefulTextChars: 120, evidenceUnits: document.evidenceUnits })).toBe('metadata-only');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('keeps a landing-page catalog ineligible for gameplay generation and never acquires its links', async () => {
    publish(`${fixture.definition} ${fixture.catalog}`);
    const result = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2',
      candidates: [{ url: fixture.url }] }, { actorKey: 'synthetic-wiki-identity' });
    expect(result.accepted).toEqual([]);
    expect(result.knowledge.sources).toEqual([]);
    expect(result.evaluations[0].stages.identity.status).toBe('passed');
    expect(result.evaluations[0].stages.extraction).toMatchObject({ status: 'passed', reasonCode: 'EXTRACTION_INTACT' });
    expect(result.evaluations[0].stages.relevance).toMatchObject({ status: 'rejected', reasonCode: 'INSUFFICIENT_GAMEPLAY_EVIDENCE',
      diagnostic: { failureClass: 'gameplay_quality' } });
    expect(result.evaluations[0].stages.generation.status).toBe('not_run');
    expect(result.decisions[0].reasonCodes).toEqual(['INSUFFICIENT_GAMEPLAY_EVIDENCE']);
    expect(result.decisions[0].reasonCodes).not.toContain('GAME_MISMATCH');
    expect(result.decisions[0].reasonCodes).not.toContain('GAME_IDENTITY_UNVERIFIED');
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('keeps a complete explicitly labeled related-guide reference local', async () => {
    const { document, identity } = await acquireIdentity(`${fixture.gameplay} ${fixture.localReference}`);
    expect(document.text).toContain(fixture.localReference);
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    const selected = selectGamingGameScopedDocument(document, fixture.game);
    expect(selected.document.text).not.toContain('unrelated comparison reward');
    expect(document.text).toContain('unrelated comparison reward');
  });

  it.each(['Fallout 4', 'Xenoblade Chronicles X: Definitive Edition'])('retains an affirmative primary game definition conflict for %s', async other => {
    const { identity } = await acquireIdentity(`${other} is an action role-playing game. ${fixture.catalog}`);
    expect(identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not use a compared or quoted game definition as acquired primary identity', async () => {
    for (const prose of [`For comparison, ${fixture.definition}`, `The quoted source says "${fixture.definition}".`,
      `${fixture.game} is an action game the reader asked about.`]) {
      expect((await acquireIdentity(`${prose} ${fixture.catalog}`)).identity)
        .toMatchObject({ status: 'unknown', gameIdentityVerified: false });
    }
  });

  it('retains a genuine source-wide declaration inside a related-guide frame', async () => {
    const { identity } = await acquireIdentity(`${fixture.gameplay} Related guide: This guide covers Fallout 4.`);
    expect(identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('does not turn concatenated walkthrough navigation after an implicit in-clause into a new game', async () => {
    // Original synthetic navigation, shaped by the current read's parser
    // failure category. This is not copied IGN text or a historical body.
    const navigation = '</p><p>Browse entries in the Full Walkthrough</p><ul>'
      + Array.from({ length: 8 }, (_, index) => `<li><a href="/chapter-${index}">Practice Chapter ${index} Walkthrough</a></li>`).join('')
      + '</ul><p>';
    const { identity } = await acquireIdentity(`${fixture.gameplay} ${navigation}`);
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it('isolates a parser-bound local linked topic while retaining the original acquisition', async () => {
    const local = `Players can consult separate indexes in ${fixture.game} - <a href="/harbor-notes">Harbor Notes</a>.`;
    const { document, identity } = await acquireIdentity(`${fixture.gameplay}</p><p>${local}`);
    const referenceText = `Players can consult separate indexes in ${fixture.game} - Harbor Notes.`;
    expect(document.metadata.localTopicReferences).toHaveLength(1);
    expect(document.text).toContain(referenceText);
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    const projected = selectGamingGameScopedDocument(document, fixture.game).document.text;
    expect(projected).not.toContain(`in ${fixture.game} - Harbor Notes`);
    expect(projected).toContain('Players can consult separate indexes');
    expect(isResolvedGamingDocumentIdentityVerified(document, fixture.url)).toBe(true);
    const legacyMetadata = { title: document.metadata.title, headings: document.metadata.headings };
    expect(assessGamingClearSourceIdentity({ ...document, metadata: legacyMetadata }, input,
      assessGamingSourcePolicy(fixture.url, fixture.game)).status).toBe('unknown');
    document.metadata.localTopicReferences![0].contentHash = '0'.repeat(64);
    expect(isResolvedGamingDocumentIdentityVerified(document, fixture.url)).toBe(false);
    expect(assessGamingClearSourceIdentity(document, input, assessGamingSourcePolicy(fixture.url, fixture.game)).status).toBe('unknown');
  });

  it('does not establish primary ownership from the linked topic alone', async () => {
    const { identity } = await acquireIdentity(`Players consult references in ${fixture.game} - <a href="/harbor-notes">Harbor Notes</a>. ${fixture.catalog}`);
    expect(identity).toMatchObject({ status: 'unknown', gameIdentityVerified: false });
  });

  it.each(['before', 'after'])('retains independent wrong-game assertions %s a linked topic in the same paragraph', async position => {
    const local = `Players consult references in ${fixture.game} - <a href="/harbor-notes">Harbor Notes</a>.`;
    const conflict = 'In the game Fallout 4, players inspect the wrong-game practice token.';
    const paragraph = position === 'before' ? `${conflict} ${local}` : `${local} ${conflict}`;
    const { document, identity } = await acquireIdentity(`${fixture.gameplay}</p><p>${paragraph}`);
    expect(selectGamingGameScopedDocument(document, fixture.game).document.text).toContain(conflict);
    expect(identity).toMatchObject({ status: 'conflict', reasonCodes: ['GAME_MISMATCH'] });
  });

  it('deduplicates alias-equivalent spans and rejects overlaps without deleting later contradictions', async () => {
    const game = 'Diablo 4';
    const local = `Players consult references in ${game} - <a href="/harbor-notes">Harbor Notes</a>.`;
    const conflict = 'In the game Fallout 4, players inspect the wrong-game practice token.';
    const { document } = await acquireIdentity(`In the game ${game}, players inspect the practice token.</p><p>${local} ${conflict}`, `${game} Wiki Guide`, game);
    const reference = document.metadata.localTopicReferences![0];
    expect(reference).toBeDefined();
    document.metadata.localTopicReferences!.push({ ...reference, gameHash: createHash('sha256')
      .update(normalizeGamingComparableIdentity('Diablo IV')).digest('hex') });
    const projected = selectGamingGameScopedDocument(document, game);
    expect(projected.excludedReferenceCount).toBe(1);
    expect(projected.document.text).toContain(conflict);
    const overlapping = { ...reference, start: reference.start + 1, length: reference.length - 1,
      contentHash: createHash('sha256').update(document.text.slice(reference.start + 1, reference.start + reference.length)).digest('hex') };
    document.metadata.localTopicReferences!.push(overlapping);
    expect(selectGamingGameScopedDocument(document, game).document.text).toBe(document.text);
  });

  it.each([
    `In the game ${fixture.game} - <a href="/moonbound">Moonbound</a>, inspect the route.`,
    `This guide covers ${fixture.game} - <a href="/moonbound">Moonbound</a>.`,
    `Game: ${fixture.game} - <a href="/moonbound">Moonbound</a>.`,
    `The source requires ${fixture.game} - <a href="/moonbound">Moonbound</a>.`,
    `Players consult references in ${fixture.game} - <a href="/edition">Definitive Edition</a>.`
    , `In ${fixture.game} - <a href="/moonbound">Moonbound</a>, use the wrong-game practice weapon to collect a reward.`
  ])('preserves named scope, metadata, requirements and edition qualifiers: %s', async local => {
    const { document, identity } = await acquireIdentity(`${fixture.gameplay}</p><p>${local}`);
    expect(document.metadata.localTopicReferences ?? []).toEqual([]);
    expect(document.text).toContain(local.replace(/<[^>]+>/gu, ''));
    if (!local.startsWith('The source requires')) expect(identity.status).not.toBe('verified');
  });

  it('accepts independently established gameplay identity without treating linked articles as acquired', async () => {
    const { identity } = await acquireIdentity(fixture.gameplay);
    expect(identity).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('keeps complete Game and Edition metadata records separate from usable gameplay records', async () => {
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data:
      `<html><title>${fixture.title}</title><article><h1>${fixture.title}</h1><p>${fixture.definition} ${fixture.catalog}</p>`
      + `<dl><dt>Game</dt><dd>${fixture.game}</dd><dt>Edition</dt><dd>base-game</dd><dt>Patch</dt><dd>1.0</dd></dl></article></html>` });
    const document = await resolveGamingDocument(fixture.url);
    expect(document.evidenceUnits?.length).toBeGreaterThan(0);
    expect(document.evidenceUnits?.every(unit => unit.integrity.status === 'complete')).toBe(true);
    expect(assessGamingStructuralUsability({ units: document.evidenceUnits, ...input }))
      .toMatchObject({ hasIntactUsableUnit: false, claimSupported: false, usableUnitIds: [], supportingUnitIds: [] });
  });
});
