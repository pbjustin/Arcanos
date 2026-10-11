import { describe, expect, it } from '@jest/globals';
import { extractGamingDocumentEvidence } from '../src/services/gamingDocumentEvidence.js';
import { selectStoredGamingEvidence, formatStoredGamingEvidence, type GamingStoredEvidenceRecord } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import { assessGamingClearEvidence } from '../src/shared/gaming/gamingClearEvidence.js';
import { createGamingClearAssessment, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { extractGamingFreshnessMetadata, GAMING_FRESHNESS_POLICY_VERSION } from '../src/shared/gaming/gamingFreshnessCore.js';

const url = 'https://guides.example.org/mixed-game-statistics';
const input = { game: 'Portal 2', edition: 'base-game', mode: 'guide' as const, prompt: 'What is Practice Blade damage?' };
const limits = { chunkChars: 2_000, maxChunks: 6, maxSources: 3, maxContextChars: 8_000, structuredEvidenceChars: 8_000 };

function record(game: string, scope = 'base-game', applicability?: { label: string; value: string }, item = 'Practice Blade'): GamingStoredEvidenceRecord {
  const body = '<article><h1>Portal 2 statistics guide</h1><table><caption>Independently scoped synthetic statistics</caption>'
    + `<tr><th>Game</th><th>Item</th><th>Stat</th><th>Value</th><th>Unit</th><th>Scope</th>${applicability ? `<th>${applicability.label}</th>` : ''}</tr>`
    + `<tr><td>${game}</td><td>${item}</td><td>Damage</td><td>77</td><td>points</td><td>${scope}</td>${applicability ? `<td>${applicability.value}</td>` : ''}</tr></table></article>`;
  const units = extractGamingDocumentEvidence({ body, contentType: 'text/html', sourceUrl: url }).units;
  const text = units.map(unit => unit.text).join('\n');
  return { gameName: input.game, recordId: 'stored-row', recordType: 'guide', title: 'Portal 2 statistics guide',
    searchText: text, normalized: { text, evidenceUnits: units }, sourceId: 'stored-source', publicUrl: url,
    sourceType: 'supplied', revisionId: 'stored-revision', fetchedAt: new Date('2026-10-10T12:00:00Z'),
    publishedAt: null, provenance: {}, relevance: 1 };
}

describe('generic stored source scope after durable ingestion', () => {
  it('does not select a foreign local gameplay row under the inherited requested source catalog identity', () => {
    const selected = selectStoredGamingEvidence([record('Hades')], input, limits);
    const knowledge = formatStoredGamingEvidence(selected, input, limits);
    expect(selected).toEqual([]);
    expect(assessGamingClearEvidence(input, knowledge).decision).toBe('reject');
  });

  it('retains a requested-game row under the same stored catalog identity', () => {
    expect(selectStoredGamingEvidence([record(input.game)], input, limits)).toHaveLength(1);
  });

  it('uses the same scope fence for an unknown requested game', () => {
    const game = 'Lantern Vale';
    expect(selectStoredGamingEvidence([{ ...record('Hades'), gameName: game }], { ...input, game }, limits)).toEqual([]);
    expect(selectStoredGamingEvidence([{ ...record(game), gameName: game }], { ...input, game }, limits)).toHaveLength(1);
  });

  it('keeps a contradictory global Game metadata record terminal in a mixed stored chunk', () => {
    const requested = record(input.game);
    const metadata = extractGamingDocumentEvidence({ body: '<dl><dt>Game</dt><dd>Hades</dd></dl>',
      contentType: 'text/html', sourceUrl: url }).units;
    const text = `${requested.normalized.text}\n${metadata.map(unit => unit.text).join('\n')}`;
    const evidenceUnits = [...requested.normalized.evidenceUnits as any[], ...metadata];
    expect(selectStoredGamingEvidence([{ ...requested, normalized: { text, evidenceUnits } }], input, limits)).toEqual([]);
  });

  it('does not select a DLC-only local row under inherited base-game source scope', () => {
    const stored = record(input.game, 'DLC');
    stored.provenance.edition = 'base-game';
    expect(selectStoredGamingEvidence([stored], input, limits)).toEqual([]);
  });

  it('retains acquired base scope when the request omits its edition', () => {
    const stored = record(input.game, 'DLC');
    stored.provenance.hybridFreshness = { edition: 'base-game' };
    expect(selectStoredGamingEvidence([stored], { ...input, edition: undefined }, limits)).toEqual([]);
    const requested = record(input.game);
    requested.provenance.hybridFreshness = { edition: 'base-game' };
    expect(selectStoredGamingEvidence([requested], { ...input, edition: undefined }, limits)).toHaveLength(1);
  });

  it.each(['Hades', input.game])('projects a complete unrelated %s record out of a historical mixed chunk', game => {
    const requested = record(input.game);
    const other = record(game, game === input.game ? 'DLC' : 'base-game');
    const text = `${requested.normalized.text}\n${other.normalized.text}`;
    const evidenceUnits = [...requested.normalized.evidenceUnits as any[], ...other.normalized.evidenceUnits as any[]];
    const stored = { ...requested, searchText: text, normalized: { text, evidenceUnits } };
    const selected = selectStoredGamingEvidence([stored], input, limits);
    expect(selected).toHaveLength(1);
    expect(selected[0].evidence.evidenceUnits).toHaveLength(1);
    expect(selected[0].evidence.evidenceUnits?.[0]).toEqual((requested.normalized.evidenceUnits as any[])[0]);
    expect(stored.normalized.evidenceUnits).toHaveLength(2);
  });

  it('keeps malformed foreign structural scope conservative without falling back to prose', () => {
    const stored = record('Hades');
    const units = stored.normalized.evidenceUnits as any[];
    units[0] = { ...units[0], integrity: { status: 'partial', reasons: ['incomplete_record'] } };
    expect(selectStoredGamingEvidence([stored], input, limits)).toEqual([]);
  });

  it('does not silently discard a malformed global declaration before projecting a mixed chunk', () => {
    const requested = record(input.game);
    const metadata = extractGamingDocumentEvidence({ body: '<dl><dt>Game</dt><dd>Hades</dd></dl>',
      contentType: 'text/html', sourceUrl: url }).units;
    metadata[0] = { ...metadata[0], provenance: { ...metadata[0].provenance, sourceUrl: 'https://unrelated.example/guide' } };
    const text = `${requested.normalized.text}\n${metadata.map(unit => unit.text).join('\n')}`;
    const evidenceUnits = [...requested.normalized.evidenceUnits as any[], ...metadata];
    expect(selectStoredGamingEvidence([{ ...requested, normalized: { text, evidenceUnits } }], input, limits)).toEqual([]);
  });

  it.each([
    { label: 'Platform', value: 'PS5', requested: { platform: 'PC' }, accepted: false },
    { label: 'Platform', value: 'PS5', requested: { platform: 'PS5' }, accepted: true },
    { label: 'Platform', value: 'PlayStation 5', requested: { platform: 'PS5' }, accepted: true },
    { label: 'Platform', value: 'all', requested: { platform: 'PC' }, accepted: true },
    { label: 'Platform', value: 'PC,', requested: { platform: 'PC' }, accepted: false },
    { label: 'Region', value: 'EU', requested: { region: 'US' }, accepted: false },
    { label: 'Region', value: 'EU', requested: { region: 'eu' }, accepted: true },
    { label: 'Region', value: 'all', requested: { region: 'US' }, accepted: true },
    { label: 'Region', value: 'EU,', requested: { region: 'EU' }, accepted: false }
  ])('retains requested applicability only for intact compatible local restrictions: $label=$value/$requested', restriction => {
    const selected = selectStoredGamingEvidence([record(input.game, 'base-game', restriction)], { ...input, ...restriction.requested }, limits);
    expect(selected).toHaveLength(restriction.accepted ? 1 : 0);
  });

  it('retains global platform metadata outside an independently scoped base-game row', () => {
    const requested = record(input.game);
    const metadata = extractGamingDocumentEvidence({ body: '<dl><dt>Platform</dt><dd>PS5</dd></dl>',
      contentType: 'text/html', sourceUrl: url }).units;
    const text = `${requested.normalized.text}\n${metadata.map(unit => unit.text).join('\n')}`;
    const evidenceUnits = [...requested.normalized.evidenceUnits as any[], ...metadata];
    expect(selectStoredGamingEvidence([{ ...requested, normalized: { text, evidenceUnits } }], { ...input, platform: 'PC' }, limits)).toEqual([]);
  });

  it.each(['Hades', input.game])('does not turn an excluded %s row into requested platform restrictions', game => {
    const requested = record(input.game, 'base-game', { label: 'Platform', value: 'PC' });
    const other = record(game, game === input.game ? 'DLC' : 'base-game', { label: 'Platform', value: 'PS5' });
    const text = `${requested.normalized.text}\n${other.normalized.text}`;
    const evidenceUnits = [...requested.normalized.evidenceUnits as any[], ...other.normalized.evidenceUnits as any[]];
    const selected = selectStoredGamingEvidence([{ ...requested, normalized: { text, evidenceUnits } }], { ...input, platform: 'PC' }, limits);
    expect(selected).toHaveLength(1);
    expect(selected[0].evidence.evidenceUnits).toHaveLength(1);
  });

  it.each([
    { label: 'Platform', value: 'PS5', prompt: 'Practice Blade controls', matching: { platform: 'PS5' } },
    { label: 'Region', value: 'EU', prompt: 'Practice Blade regional damage', matching: { region: 'EU' } }
  ])('cannot verify missing material $label scope from an unrelated inherited catalog label', restriction => {
    const stored = record(input.game, 'base-game', restriction, 'Practice Blade controls regional');
    const request = { ...input, prompt: restriction.prompt };
    const selected = selectStoredGamingEvidence([stored], request, limits);
    expect(selected).toHaveLength(1);
    expect(assessGamingClearEvidence(request, formatStoredGamingEvidence(selected, request, limits)))
      .toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
    expect(selectStoredGamingEvidence([stored], { ...input, prompt: restriction.prompt, ...restriction.matching }, limits)).toHaveLength(1);
  });

  it('retains legacy context but withholds CLEAR acceptance when whole-source restrictions are unavailable', () => {
    const selected = selectStoredGamingEvidence([record(input.game)], input, limits);
    expect(selected).toHaveLength(1);
    expect(assessGamingClearEvidence(input, formatStoredGamingEvidence(selected, input, limits)))
      .toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
  });

  it.each([false, true])('retains bounded acquired uncertainty without granting CLEAR acceptance or reusing older hybrid scope: %s', hybrid => {
    const stored = record(input.game);
    const document = { publicUrl: url, text: `${'A synthetic route follows the copper gate. '.repeat(850)}\nPlatform: PS5\n${stored.normalized.text}`,
      evidenceUnits: stored.normalized.evidenceUnits as any[] };
    const applicability = extractGamingFreshnessMetadata(document, input, stored.fetchedAt, []);
    expect(applicability.metadataUnverified).toBe(true);
    expect(applicability.metadataConflict).toBeUndefined();
    stored.contentHash = gamingClearHash(document);
    stored.provenance.acquiredApplicability = { extractorVersion: GAMING_FRESHNESS_POLICY_VERSION,
      contentHash: stored.contentHash, game: applicability.game, metadataUnverified: true };
    if (hybrid) {
      const dimension = { status: 'evaluated' as const, score: 4.5, reasonCodes: ['SYNTHETIC_PRIOR_ASSESSMENT'],
        evidenceRefs: ['stored-source'], unresolvedFacts: [] };
      stored.provenance.approvedContentHash = stored.contentHash;
      stored.clearSourceAssessment = createGamingClearAssessment({ profile: 'source', questionProfile: 'walkthrough', sourceRole: 'gameplay_guide',
        subjectId: 'stored-source', subjectHash: stored.contentHash, contextFingerprint: gamingClearHash(input), evidenceRefs: ['stored-source'],
        gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'not_applicable', provenance: 'verified', security: 'verified' },
        dimensions: { clarity: dimension, leverage: dimension, efficiency: dimension, alignment: dimension, resilience: dimension } });
      stored.provenance.hybridFreshness = extractGamingFreshnessMetadata({ publicUrl: url, text: stored.normalized.text as string,
        evidenceUnits: stored.normalized.evidenceUnits as any[] }, input, stored.fetchedAt, []);
    }
    const selected = selectStoredGamingEvidence([stored], input, limits);
    expect(selected).toHaveLength(1);
    const knowledge = formatStoredGamingEvidence(selected, input, limits);
    expect(knowledge.context).toContain('Practice Blade');
    expect(knowledge.sources[0].freshnessMetadata).toMatchObject({ metadataUnverified: true });
    expect(assessGamingClearEvidence(input, knowledge)).toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
  });

  it.each([
    { contentHash: 'b'.repeat(64) }, { edition: ['base-game'] }, { edition: 'x'.repeat(121) },
    { metadataConflict: 'false' }, { platforms: [''] }, { authority: 'official' }, { verifiedAt: new Date().toISOString() }
  ])('does not promote malformed or unbound acquired applicability: %j', invalid => {
    const stored = record(input.game);
    stored.contentHash = 'a'.repeat(64);
    stored.provenance.acquiredApplicability = { extractorVersion: 'gaming-hybrid-freshness-v1',
      contentHash: stored.contentHash, game: input.game, ...invalid };
    const selected = selectStoredGamingEvidence([stored], input, limits);
    expect(selected).toHaveLength(1);
    expect(assessGamingClearEvidence(input, formatStoredGamingEvidence(selected, input, limits)))
      .toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
  });

  it.each([{}, { game: input.game, id: 'stored-source' }, { game: input.game, id: 'stored-source',
    policyVersion: 'gaming-hybrid-source-policy-v2', metadataUnverified: false }])
  ('does not let incomplete or unbound hybrid metadata replace missing whole-source applicability: %j', hybridFreshness => {
    const stored = record(input.game);
    stored.provenance.hybridFreshness = hybridFreshness;
    const selected = selectStoredGamingEvidence([stored], input, limits);
    expect(assessGamingClearEvidence(input, formatStoredGamingEvidence(selected, input, limits)))
      .toMatchObject({ decision: 'clarify', gates: { compatibility: 'unknown' } });
  });
});
