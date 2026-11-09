import { describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { assessGamingClearEvidence, assessGamingRequestCoverage } from '../src/shared/gaming/gamingClearEvidence.js';
import { buildStoredGamingLexicalQuery, selectStoredGamingEvidence, formatStoredGamingEvidence } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import { GAMING_LEXICAL_BENCHMARK_BASE_SHA, GAMING_LEXICAL_BENCHMARK_DATE, GAMING_LEXICAL_BENCHMARK_VERSION, gamingLexicalBenchmarkCases, gamingLexicalBenchmarkRecords } from './testUtils/gamingLexicalBenchmarkFixtures.js';

const limits = { chunkChars: 2_000, maxChunks: 6, maxSources: 3, maxContextChars: 8_000, structuredEvidenceChars: 8_000 };
const resolvePatch = (record: { recordId: string }) => record.recordId === 'old-patch' ? '1.1' : '1.2';

function evaluate() {
  return gamingLexicalBenchmarkCases.map(fixture => {
    const records = fixture.recordIds ? gamingLexicalBenchmarkRecords.filter(record => fixture.recordIds!.includes(record.recordId))
      : gamingLexicalBenchmarkRecords.filter(record => !['foreign-edition', 'foreign-platform', 'old-patch'].includes(record.recordId));
    const selected = selectStoredGamingEvidence(records, fixture.input, limits, resolvePatch, assessGamingRequestCoverage);
    const knowledge = formatStoredGamingEvidence(selected, fixture.input, limits);
    const ids = selected.map(candidate => candidate.evidence.recordId);
    const hit = ids.filter(id => fixture.relevantIds.includes(id)).length;
    return { id: fixture.id, kind: fixture.kind, query: buildStoredGamingLexicalQuery(fixture.input.prompt, fixture.input.game, fixture.input).query,
      selected: ids, relevant: fixture.relevantIds, recallAt3: hit / fixture.relevantIds.length,
      // Fixed-k precision counts unused slots; precision of returned evidence is
      // reported separately, so an empty result cannot appear perfectly precise.
      precisionAt3: hit / 3, returnedPrecision: ids.length ? hit / ids.length : 0,
      coverage: assessGamingRequestCoverage(fixture.input, knowledge).coverageSatisfied,
      clearDecision: assessGamingClearEvidence(fixture.input, knowledge,
        { identityVerified: true, now: new Date(GAMING_LEXICAL_BENCHMARK_DATE) }).decision,
      provenanceIntact: selected.every(candidate => {
        const original = records.find(record => record.recordId === candidate.evidence.recordId)!;
        return candidate.evidence.revisionId === original.revisionId && candidate.source.url === original.publicUrl
          && candidate.evidence.publicUrl === original.publicUrl && candidate.source.fetchedAt === original.fetchedAt.toISOString();
      }) };
  });
}

describe('deterministic stored Gaming lexical retrieval benchmark', () => {
  const observations = evaluate();
  const average = (rows: typeof observations, key: 'recallAt3' | 'precisionAt3' | 'returnedPrecision') => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;

  it('has independently reasoned known/unfamiliar, exact/paraphrase and authority fixtures', () => {
    expect(gamingLexicalBenchmarkCases).toHaveLength(15);
    expect(gamingLexicalBenchmarkCases.every(fixture => fixture.rationale.length > 50)).toBe(true);
    expect(new Set(gamingLexicalBenchmarkCases.map(fixture => fixture.input.game)).size).toBe(4);
    expect(observations).toEqual(evaluate());
  });

  it('retrieves exact mechanics and complementary passages without contamination', () => {
    for (const row of observations.filter(row => row.kind !== 'paraphrase')) {
      expect({ id: row.id, selected: [...row.selected].sort() }).toEqual({ id: row.id, selected: [...row.relevant].sort() });
      expect({ id: row.id, coverage: row.coverage }).toEqual({ id: row.id, coverage: true });
      expect({ id: row.id, clearDecision: row.clearDecision }).toEqual({ id: row.id, clearDecision: 'accept' });
    }
    expect(observations.every(row => row.provenanceIntact)).toBe(true);
    expect(observations.every(row => row.selected.length <= 3)).toBe(true);
  });

  it.each(['foreign', 'foreign-edition', 'foreign-platform', 'unverified', 'reference', 'revoked'])(
    'withholds isolated %s distractors before they become answer evidence', id => {
      const input = gamingLexicalBenchmarkCases.find(row => row.id === 'authority-isolation')!.input;
      const selected = selectStoredGamingEvidence(gamingLexicalBenchmarkRecords.filter(record => record.recordId === id),
        input, limits, resolvePatch, assessGamingRequestCoverage);
      expect(selected).toEqual([]);
    });

  it.each([false, true])('filters an explicit edition conflict before v2 coverage selection: coverage=%s', requireRequestCoverage => {
    const fixture = gamingLexicalBenchmarkCases.find(row => row.id === 'authority-isolation')!;
    const input = { ...fixture.input, requireRequestCoverage };
    const rows = gamingLexicalBenchmarkRecords.filter(record => ['foreign-edition', 'load'].includes(record.recordId));
    expect(selectStoredGamingEvidence(rows, input, limits, resolvePatch, assessGamingRequestCoverage)
      .map(candidate => candidate.evidence.recordId)).toEqual(['load']);
    expect(selectStoredGamingEvidence(rows.filter(record => record.recordId === 'foreign-edition'), input,
      limits, resolvePatch, assessGamingRequestCoverage)).toEqual([]);
    const baseAlias = rows.filter(record => record.recordId === 'load').map(record => ({ ...record,
      provenance: { ...record.provenance, edition: 'Base game' } }));
    expect(selectStoredGamingEvidence(baseAlias, input, limits, resolvePatch, assessGamingRequestCoverage)).toHaveLength(1);
  });

  it('excludes a verified older patch without inventing proof of currentness for the survivor', () => {
    const fixture = gamingLexicalBenchmarkCases.find(row => row.id === 'authority-isolation')!;
    const input = { ...fixture.input, requestedVersion: '1.2' };
    const records = gamingLexicalBenchmarkRecords.filter(record => ['load', 'old-patch'].includes(record.recordId));
    const selected = selectStoredGamingEvidence(records, input, limits, resolvePatch, assessGamingRequestCoverage);
    expect(selected.map(candidate => candidate.evidence.recordId)).toEqual(['load']);
    expect(assessGamingClearEvidence(input, formatStoredGamingEvidence(selected, input, limits),
      { identityVerified: true, now: new Date(GAMING_LEXICAL_BENCHMARK_DATE) }).decision).toBe('clarify');
  });

  it('records paraphrase recall failures without lowering authority or claiming semantic retrieval', () => {
    const paraphrases = observations.filter(row => row.kind === 'paraphrase');
    expect(paraphrases.some(row => row.recallAt3 < 1)).toBe(true);
    expect(paraphrases.find(row => row.id === 'load-paraphrase')!.selected).toEqual([]);
    expect(paraphrases.find(row => row.id === 'gate-paraphrase')!.selected).toEqual([]);
  });

  it('reports quality, bounded latency and resources without unstable timing assertions', () => {
    const cpu = process.cpuUsage();
    const heapStart = process.memoryUsage().heapUsed;
    const elapsed: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const started = performance.now();
      expect(evaluate()).toEqual(observations);
      elapsed.push(performance.now() - started);
    }
    const cpuUsed = process.cpuUsage(cpu);
    console.info('GAMING_LEXICAL_BENCHMARK_REPORT', JSON.stringify({ version: GAMING_LEXICAL_BENCHMARK_VERSION, baseSha: GAMING_LEXICAL_BENCHMARK_BASE_SHA,
      scope: 'production pure post-query selector; fixed candidate ranks; no PostgreSQL or provider acceptance',
      records: gamingLexicalBenchmarkRecords.length, cases: observations.length, k: 3,
      recallAt3: average(observations, 'recallAt3'), precisionAt3: average(observations, 'precisionAt3'),
      meanReturnedPrecision: average(observations, 'returnedPrecision'),
      pooledReturnedPrecision: observations.reduce((sum, row) => sum + row.selected.filter(id => row.relevant.includes(id)).length, 0)
        / Math.max(1, observations.reduce((sum, row) => sum + row.selected.length, 0)),
      requestCoverageRate: observations.filter(row => row.coverage).length / observations.length,
      clearAcceptRate: observations.filter(row => row.clearDecision === 'accept').length / observations.length,
      exactRecallAt3: average(observations.filter(row => row.kind === 'exact'), 'recallAt3'),
      paraphraseRecallAt3: average(observations.filter(row => row.kind === 'paraphrase'), 'recallAt3'),
      provenanceIntegrityRate: observations.filter(row => row.provenanceIntact).length / observations.length,
      falseAuthorityAccepted: observations.filter(row => row.clearDecision === 'accept' && row.selected.some(id => !row.relevant.includes(id))).length,
      iterations: elapsed.length, batchElapsedMs: elapsed, batchMedianMs: [...elapsed].sort((a, b) => a - b)[2], batchMaxMs: Math.max(...elapsed),
      cpuUserMicros: cpuUsed.user, cpuSystemMicros: cpuUsed.system, heapDeltaBytes: process.memoryUsage().heapUsed - heapStart,
      maxRssKiB: process.resourceUsage().maxRSS, observations }));
  });
});
