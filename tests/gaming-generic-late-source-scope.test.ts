import { describe, expect, it, jest } from '@jest/globals';
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
const { assessGamingClearSourceIdentity } = await import('../src/shared/gaming/gamingClearSource.js');
const { assessGamingSourcePolicy } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const url = 'https://guides.example.org/late-scope-review';
const game = 'Lantern Vale';
const prose = `In ${game}, movement timing depends on reading the next safe opening before committing to an action. `
  + 'Practice movement timing by observing a full cycle, keeping enough resources to recover, and choosing a short action during a safe opening. '
  + 'For movement timing, stop after one controlled action, observe the next cue, and repeat the practice until the response is consistent.';
const filler = '<p>Observe the cue, plan the recovery, and choose one careful movement timing action.</p>';
const article = (content: string, requestedGame = game) => `<html><title>${requestedGame} movement timing guide</title><body><main><article>`
  + `<h1>${requestedGame} movement timing guide</h1><p>Edition: Base game.</p><p>Platforms: PC.</p><p>${prose.replaceAll(game, requestedGame)}</p>${content}</article></main></body></html>`;

describe('generic late acquired source identity scope', () => {
  it.each([
    ['early primary declaration', 0, '<p>This guide covers Orbit Orchard.</p>', false],
    ['early game label', 0, '<p>Game: Orbit Orchard.</p>', false],
    ['early prose-only game label', 0, '<p>Acquired subject notice. Game: Orbit Orchard.</p>', false],
    ['late primary declaration', 550, '<p>This guide covers Orbit Orchard.</p>', false],
    ['late game label', 550, '<p>Game: Orbit Orchard.</p>', false],
    ['late prose-only game label', 550, '<p>Acquired subject notice. Game: Orbit Orchard.</p>', false],
    ['late primary gameplay heading', 150, '<h2>Orbit Orchard guide: movement timing</h2>', false],
    ['late quoted primary name', 550, '<p>This guide covers "Orbit Orchard".</p>', false],
    ['late quoted-name gameplay heading', 150, '<h2>"Orbit Orchard" guide: movement timing</h2>', false],
    ['late quoted-name Game label', 550, "<p>Acquired subject notice. Game: 'Orbit Orchard'.</p>", false],
    ['late valid comparison', 550, '<p>Unlike in Orbit Orchard, this movement timing example retains the current game scope.</p>', true],
    ['late valid quoted declaration', 550, '<p>"This guide covers Orbit Orchard."</p>', true],
    ['late valid quoted Game label', 550, '<p>The source quotes: "An earlier field was recorded; Game: Orbit Orchard."</p>', true],
    ['late valid quoted gameplay heading', 150, '<p>"Orbit Orchard guide: movement timing differs."</p>', true],
    ['late valid negation', 550, '<p>This guide is not for Orbit Orchard.</p>', true],
    ['late valid recommendation', 150, '<p>Related article: Orbit Orchard guide: movement timing differs.</p>', true],
    ['large valid article control', 550, '<p>Continue practicing movement timing carefully.</p>', true]
  ])('%s', async (label, repeats, declaration, valid) => {
    const body = article(filler.repeat(repeats as number) + declaration);
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: body });
    const acquired = await resolveGamingDocument(url, 1_000_000, { documentPurpose: 'durable' });
    const result = await evaluateGamingHybridCandidates({ game, edition: 'Base game', platform: 'PC', mode: 'guide',
      prompt: 'How do I use movement timing?', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
    { actorKey: 'late-scope-security-review', workflowId: '30000000-0000-4000-8000-000000000001',
      requestId: 'req_1234_latescopereview', traceId: 'a'.repeat(32) });
    console.info('GENERIC_LATE_SCOPE_OBSERVATION', JSON.stringify({ label, requestedGame: game,
      chars: acquired.text.length, declarationOffset: acquired.text.indexOf('Orbit Orchard'),
      truncated: acquired.metrics.truncated, extractedRecords: acquired.evidenceUnits?.length ?? 0,
      accepted: result.accepted.length, selectedEvidence: result.knowledge.evidence?.length ?? 0,
      reasonCodes: result.decisions.flatMap(decision => decision.reasonCodes),
      identity: result.evaluations[0].stages.identity }));
    expect(result.accepted).toHaveLength(valid ? 1 : 0);
    if (!valid) expect(result.decisions[0].reasonCodes).toEqual(['GAME_MISMATCH']);
  });

  it.each([['Portal 2', 'Hades'], ['Hades', 'Portal 2'], ['Orbit Orchard', 'Lantern Vale']])
  ('rejects a late %s contradiction through the same production path', async (requestedGame, foreignGame) => {
    const body = article('<p>This guide covers only expansion content.</p>' + filler.repeat(550)
      + `<p>This guide covers ${foreignGame}.</p>`, requestedGame);
    http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: body });
    const result = await evaluateGamingHybridCandidates({ game: requestedGame, edition: 'Base game', platform: 'PC', mode: 'guide',
      prompt: 'How do I use movement timing?', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
    { actorKey: 'late-scope-security-review', workflowId: '30000000-0000-4000-8000-000000000001' });
    expect(result.accepted).toEqual([]);
    expect(result.decisions[0].reasonCodes).toEqual(['GAME_MISMATCH']);
    expect(result.evaluations[0].stages.identity.status).toBe('rejected');
    expect(result.evaluations[0].stages.applicability.status).toBe('not_run');
  });

  it.each(['affirmative subjects', 'quoted names', 'instruction headings', 'game labels'])
  ('keeps excessive %s unverified rather than accept an uninspected suffix', kind => {
    const repeated = kind === 'affirmative subjects' ? `In ${game}, observe movement timing. `
      : kind === 'quoted names' ? `A quoted name is "${game}". `
      : kind === 'instruction headings' ? `${game} guide: observe movement timing. ` : `Game: ${game}. `;
    const text = `${game} movement timing guide. ${prose} ${repeated.repeat(12_000)}`;
    const startedAt = performance.now();
    const identity = assessGamingClearSourceIdentity({ publicUrl: url, text, metadata: { title: `${game} movement timing guide` } },
      { game, edition: 'Base game', mode: 'guide', prompt: 'How do I use movement timing?' }, assessGamingSourcePolicy(url, game));
    const elapsedMs = performance.now() - startedAt;
    console.info('GENERIC_SCOPE_BUDGET_OBSERVATION', JSON.stringify({ kind, chars: text.length, elapsedMs, identity }));
    expect(identity).toMatchObject({ status: 'unknown', gameIdentityVerified: false, reasonCodes: ['GAME_IDENTITY_UNVERIFIED'],
      diagnostic: { ruleId: 'gaming.identity.source_scope_scan_incomplete' } });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it.each([['Lantern Vale', 'Orbit Orchard'], ['Portal 2', 'Hades']])
  ('keeps a complete quoted Game declaration incidental for %s', (requestedGame, foreignGame) => {
    const text = `${requestedGame} movement timing guide. ${prose.replaceAll(game, requestedGame)} `
      + `The source quotes: "\nGame: ${foreignGame}.\n"`;
    expect(assessGamingClearSourceIdentity({ publicUrl: url, text, metadata: { title: `${requestedGame} movement timing guide` } },
      { game: requestedGame, edition: 'Base game', mode: 'guide', prompt: 'How do I use movement timing?' },
      assessGamingSourcePolicy(url, requestedGame))).toMatchObject({ status: 'verified', gameIdentityVerified: true });
  });

  it.each(['Lantern Vale', 'Portal 2'])('keeps a clipped explicit %s declaration unverified', requestedGame => {
    const text = `${requestedGame} movement timing guide. ${prose.replaceAll(game, requestedGame)} `
      + `This guide covers ${requestedGame} ${'unreviewed '.repeat(25)}2.`;
    expect(assessGamingClearSourceIdentity({ publicUrl: url, text, metadata: { title: `${requestedGame} movement timing guide` } },
      { game: requestedGame, edition: 'Base game', mode: 'guide', prompt: 'How do I use movement timing?' },
      assessGamingSourcePolicy(url, requestedGame))).toMatchObject({ status: 'unknown', gameIdentityVerified: false,
      diagnostic: { ruleId: 'gaming.identity.source_scope_scan_incomplete' } });
  });

  it('keeps the existing acquired topic proof boundary before removing Game labels', () => {
    const requestedGame = 'Portal 2';
    const title = 'Combat guide';
    const text = `${title}. ${`Game: ${requestedGame}. `.repeat(1_000)}${'Observe recovery timing. '.repeat(750)}`
      + `In ${requestedGame}, observe movement timing.`;
    expect(text.indexOf(`In ${requestedGame}`)).toBeGreaterThan(32_000);
    expect(assessGamingClearSourceIdentity({ publicUrl: url, text, metadata: { title } },
      { game: requestedGame, edition: 'Base game', mode: 'guide', prompt: 'How do I use movement timing?' },
      assessGamingSourcePolicy(url, requestedGame))).toMatchObject({ status: 'unknown', gameIdentityVerified: false,
      diagnostic: { ruleId: 'gaming.identity.independent_anchor_required' } });
  });
});
