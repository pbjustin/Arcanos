import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import { gamingGenericBenchmarkFixtures, GAMING_GENERIC_BENCHMARK_VERSION, GAMING_GENERIC_BENCHMARK_LABEL_VERSION } from './testUtils/gamingGenericBenchmarkFixtures.js';
import { summarizeGamingGenericBenchmark, type GamingBenchmarkObservation } from './testUtils/gamingGenericBenchmarkMetrics.js';

const http = jest.fn();
// Only transport and DNS are replaced. The protected hop/loop, resolver,
// extractor, identity, CLEAR, applicability, and evidence selection stay real.
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { evaluateGamingHybridCandidates, assertGamingHybridEvidenceMembership } = await import('../src/services/gamingHybridCandidates.js');
const observations: GamingBenchmarkObservation[] = [];
const stageNames = ['acquisition', 'extraction', 'identity', 'applicability', 'relevance', 'freshness', 'provenance', 'selection', 'generation'];

function hasCompleteTrace(evaluation: unknown, actor: { requestId: string; traceId: string; workflowId: string },
  expectedRejection?: { stage: string; reasonCode: string }): boolean {
  if (!evaluation || typeof evaluation !== 'object') return false;
  const trace = evaluation as Record<string, any>;
  return trace.contractVersion === 'gaming-source-evaluation/v1'
    && typeof trace.ruleVersion === 'string'
    && trace.requestId === actor.requestId && trace.traceId === actor.traceId && trace.workflowId === actor.workflowId
    && stageNames.every(stage => trace.stages?.[stage]
      && ['passed', 'rejected', 'unknown', 'not_run', 'not_applicable'].includes(trace.stages[stage].status)
      && /^[A-Z][A-Z0-9_]{0,79}$/u.test(trace.stages[stage].reasonCode))
    && ['rejected', 'accepted', 'selected'].includes(trace.outcome)
    && Array.isArray(trace.rejectionReasons)
    && typeof trace.recovery?.eligible === 'boolean'
    && (!expectedRejection || trace.stages[expectedRejection.stage].status === 'rejected'
      && trace.stages[expectedRejection.stage].reasonCode === expectedRejection.reasonCode);
}

describe('generic Gaming source benchmark through the production evaluator', () => {
  beforeAll(async () => {
    for (const [index, fixture] of gamingGenericBenchmarkFixtures.entries()) {
      http.mockResolvedValue({ status: fixture.status, headers: { 'content-type': fixture.contentType }, data: fixture.body });
      const url = `https://guides.example.org/benchmark/${fixture.id}`;
      const actor = { actorKey: 'generic-benchmark', workflowId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        requestId: 'req_1234_genericbenchmark', traceId: 'a'.repeat(32) };
      const result = await evaluateGamingHybridCandidates({ game: fixture.game, edition: 'Base game', platform: 'PC',
        prompt: fixture.prompt, mode: 'guide', protocolVersion: 'gaming-hybrid-v2', candidates: [{ url, claimedGame: fixture.game }] }, actor);
      assertGamingHybridEvidenceMembership(result.knowledge, result.accepted, actor);
      const evaluated = result as typeof result & { evaluations?: unknown[] };
      observations.push({ id: fixture.id, expected: fixture.expected, accepted: result.accepted.length > 0,
        securityCritical: fixture.securityCritical, diagnosticCovered: hasCompleteTrace(evaluated.evaluations?.[0], actor, fixture.expectedRejection),
        selectedContamination: Boolean(fixture.forbiddenSelectedText && (result.knowledge.context.includes(fixture.forbiddenSelectedText)
          || result.knowledge.evidence?.some(chunk => chunk.text.includes(fixture.forbiddenSelectedText!)))),
        reasonCodes: result.decisions.flatMap(decision => decision.reasonCodes) });
    }
    // Bounded result-only report: no raw passages, URL values, or player data.
    console.info('GAMING_GENERIC_BENCHMARK_REPORT', JSON.stringify({ benchmarkVersion: GAMING_GENERIC_BENCHMARK_VERSION,
      labelVersion: GAMING_GENERIC_BENCHMARK_LABEL_VERSION, ...summarizeGamingGenericBenchmark(observations) }));
  }, 60_000);

  it('has independently specified labels for three known and two unknown games', () => {
    expect(new Set(gamingGenericBenchmarkFixtures.filter(item => item.known).map(item => item.game)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(gamingGenericBenchmarkFixtures.filter(item => !item.known).map(item => item.game)).size).toBeGreaterThanOrEqual(2);
    expect(gamingGenericBenchmarkFixtures.every(item => item.labelRationale.length > 30)).toBe(true);
    expect(new Set(gamingGenericBenchmarkFixtures.map(item => item.layout)).size).toBeGreaterThanOrEqual(4);
    expect(observations).toHaveLength(gamingGenericBenchmarkFixtures.length);
  });
  it('meets the engineering target for valid evidence without changing labels', () => {
    expect(summarizeGamingGenericBenchmark(observations).valid.acceptanceRate).toBeGreaterThanOrEqual(0.95);
  });
  it('meets the engineering target for invalid evidence independently of acceptance', () => {
    expect(summarizeGamingGenericBenchmark(observations).invalid.rejectionRate).toBeGreaterThanOrEqual(0.99);
  });
  it('blocks release on any security-critical invalid acceptance or selected contamination', () => {
    const summary = summarizeGamingGenericBenchmark(observations);
    expect(summary.securityCriticalAccepted).toEqual([]);
    expect(summary.contaminatedSelection).toEqual([]);
  });
  it('provides structured diagnostics for every evaluated outcome', () => {
    expect(summarizeGamingGenericBenchmark(observations).diagnostics.coverageRate).toBe(1);
  });
});
