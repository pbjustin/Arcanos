import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';
import { jest } from '@jest/globals';

const actualEvidence = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const actualExtraction = await import('../src/services/gamingDocumentEvidence.js');
const actualHtml = await import('../src/services/gamingHtmlEvidence.js');
const actualProjection = await import('../src/shared/gaming/gamingDocumentProjectionCore.js');
const actualCoverage = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualPolicy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const actualByteBudget = await import('../src/shared/protectedDocumentByteBudget.js');
const mockSelect = jest.fn(actualEvidence.selectStoredGamingEvidence);
const mockExtract = jest.fn(actualExtraction.extractGamingDocumentEvidence);
const mockHtml = jest.fn(actualHtml.extractGamingHtmlEvidence);
const mockProjection = jest.fn(actualProjection.projectGamingDocumentText);
const mockCoverage = jest.fn(actualCoverage.assessGamingRequestCoverage);
const mockArtifact = jest.fn(actualPolicy.isGamingApprovedArtifactCurrent);
const mockSupplied = jest.fn(actualPolicy.projectGamingHybridSuppliedGuides);
const mockByteBudget = jest.fn(actualByteBudget.getProtectedDocumentByteBudgetFailure);
jest.unstable_mockModule('../src/shared/gaming/gamingStoredEvidenceCore.js', () => ({
  ...actualEvidence, selectStoredGamingEvidence: mockSelect
}));
jest.unstable_mockModule('../src/services/gamingDocumentEvidence.js', () => ({
  ...actualExtraction, extractGamingDocumentEvidence: mockExtract
}));
jest.unstable_mockModule('../src/services/gamingHtmlEvidence.js', () => ({
  ...actualHtml, extractGamingHtmlEvidence: mockHtml
}));
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentProjectionCore.js', () => ({
  ...actualProjection, projectGamingDocumentText: mockProjection
}));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({
  ...actualCoverage, assessGamingRequestCoverage: mockCoverage
}));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({
  ...actualPolicy, isGamingApprovedArtifactCurrent: mockArtifact, projectGamingHybridSuppliedGuides: mockSupplied
}));
jest.unstable_mockModule('../src/shared/protectedDocumentByteBudget.js', () => ({
  ...actualByteBudget, getProtectedDocumentByteBudgetFailure: mockByteBudget
}));
const { runGamingLargeSourcePreview, GAMING_LARGE_SOURCE_PREVIEW_VERSION, GAMING_LARGE_SOURCE_PREVIEW_CASES } =
  await import('../src/shared/gaming/gamingDurableRagPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_LARGE_SOURCE_CONTRACT_INVALID';

describe('additional sealed Gaming large-source component proof', () => {
  beforeEach(() => {
    mockSelect.mockReset().mockImplementation(actualEvidence.selectStoredGamingEvidence);
    mockExtract.mockReset().mockImplementation(actualExtraction.extractGamingDocumentEvidence);
    mockHtml.mockReset().mockImplementation(actualHtml.extractGamingHtmlEvidence);
    mockProjection.mockReset().mockImplementation(actualProjection.projectGamingDocumentText);
    mockCoverage.mockReset().mockImplementation(actualCoverage.assessGamingRequestCoverage);
    mockArtifact.mockReset().mockImplementation(actualPolicy.isGamingApprovedArtifactCurrent);
    mockSupplied.mockReset().mockImplementation(actualPolicy.projectGamingHybridSuppliedGuides);
    mockByteBudget.mockReset().mockImplementation(actualByteBudget.getProtectedDocumentByteBudgetFailure);
  });

  it('executes fixed HTML, full-pool, Samurai, negative and artifact assertions through production pure cores', async () => {
    const report = await runGamingLargeSourcePreview();
    expect(report).toEqual(expect.objectContaining({ version: 'gaming-large-source/v1',
      scope: 'pure-synthetic-large-source-selection-coverage-artifact', cases: expect.any(Array) }));
    expect(report.cases.map(entry => entry.id)).toEqual([...GAMING_LARGE_SOURCE_PREVIEW_CASES]);
    expect(report.cases.map(entry => entry.checks)).toEqual([...NATIVE_PR_PREVIEW_E2E_CONTRACT.gaming.largeSourceReportChecks]);
    expect(report.cases.every(entry => entry.checks > 0 && entry.passed === entry.checks
      && Object.keys(entry.values).length > 0)).toBe(true);
    expect(GAMING_LARGE_SOURCE_PREVIEW_VERSION).toBe('gaming-large-source/v1');
    expect(GAMING_LARGE_SOURCE_PREVIEW_CASES).toContain('samurai-multi-topic-late');
    expect(Buffer.byteLength(mockHtml.mock.calls[0][0].body, 'utf8')).toBeGreaterThan(2_000_000);
    expect(mockExtract.mock.calls.some(([input]) => {
      const bytes = Buffer.byteLength(input.body, 'utf8');
      return bytes > 2_000_000 && bytes <= 5_000_000;
    })).toBe(false);
    expect(mockSelect).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ recordId: 'pool-record-24' })]),
      expect.objectContaining({ requireRequestCoverage: true }), expect.anything(), undefined, expect.any(Function));
    const samuraiCalls = mockSelect.mock.calls.filter(call => call[1].class === 'Samurai' && call[0].length > 20);
    expect(samuraiCalls.some(call => call[0][0].relevance === 0.1)).toBe(true);
    expect(samuraiCalls.some(call => call[0][call[0].length - 1].relevance === 0.1)).toBe(true);
    expect(mockSupplied).toHaveBeenCalledWith(expect.objectContaining({
      accepted: [expect.objectContaining({ candidateId: 'another-workflow-source' })]
    }));
  });

  it('keeps the HTML structural proof independent of the optional JSON wall-clock budget', async () => {
    let elapsed = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => { elapsed += 1_100; return elapsed; });
    try { await runGamingLargeSourcePreview(); } finally { clock.mockRestore(); }
  });

  it('fails closed when selection only inspects the original twenty-row prefix', async () => {
    mockSelect.mockImplementation((rows, input, limits, patch, assess) =>
      actualEvidence.selectStoredGamingEvidence(rows.slice(0, 20), input, limits, patch, assess));
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it.each(['early', 'late'])('fails closed when the %s multi-topic passage is displaced', async placement => {
    mockSelect.mockImplementation((rows, input, limits, patch, assess) => {
      const index = placement === 'early' ? 0 : rows.length - 1;
      return actualEvidence.selectStoredGamingEvidence(input.class === 'Samurai' && rows.length > 20 && rows[index].relevance === 0.1
        ? rows.filter((_row, ordinal) => ordinal !== index) : rows, input, limits, patch, assess);
    });
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when extracted structural provenance changes', async () => {
    mockHtml.mockImplementation(input => {
      const result = actualHtml.extractGamingHtmlEvidence(input);
      return { ...result, units: result.units.map(unit => ({ ...unit,
        provenance: { ...unit.provenance, sourceUrl: 'https://other.example/synthetic' } })) };
    });
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when navigation records contaminate article evidence', async () => {
    mockHtml.mockImplementation(input => {
      const result = actualHtml.extractGamingHtmlEvidence(input);
      return Buffer.byteLength(input.body, 'utf8') > 2_000_000 && result.units.length ? { ...result,
        units: [...result.units, { ...result.units[0], id: 'navigation-sentinel', text: 'Navigation Sentinel' }] } : result;
    });
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when incomplete projection is advertised as complete', async () => {
    mockProjection.mockImplementation(input => ({ ...actualProjection.projectGamingDocumentText(input), truncated: false }));
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when oversized transfer or decoded content is admitted', async () => {
    mockByteBudget.mockReturnValue(undefined);
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when oversized structural input is advertised as within budget', async () => {
    mockExtract.mockImplementation(input => {
      const result = actualExtraction.extractGamingDocumentEvidence(input);
      return input.body.length > 5_000_000 ? { ...result,
        diagnostics: { ...result.diagnostics, budgetOutcome: 'within_budget' } } : result;
    });
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when evidence loses its acquired source revision', async () => {
    mockSelect.mockImplementation((rows, input, limits, patch, assess) =>
      actualEvidence.selectStoredGamingEvidence(rows, input, limits, patch, assess).map(candidate => ({ ...candidate,
        evidence: { ...candidate.evidence, revisionId: 'incorrect-revision' } })));
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when missing coverage is promoted to success', async () => {
    mockCoverage.mockImplementation((input, knowledge) => ({ ...actualCoverage.assessGamingRequestCoverage(input, knowledge), coverageSatisfied: true }));
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when stale or changed artifacts are treated as current', async () => {
    mockArtifact.mockReturnValue(true);
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when workflow, actor, source or expiry checks are bypassed', async () => {
    mockSupplied.mockImplementation(input => input.accepted.map(candidate => ({ requestedUrl: candidate.document.requestedUrl,
      sourceId: candidate.candidateId, publicUrl: candidate.publicUrl })));
    await expect(runGamingLargeSourcePreview()).rejects.toThrow(FAILURE);
  });

  it('replaces dependency errors with a fixed cause-free error', async () => {
    mockHtml.mockImplementation(() => { throw new Error('private-fixture-sentinel'); });
    let caught: unknown;
    try { await runGamingLargeSourcePreview(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(FAILURE);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).stack).not.toContain('private-fixture-sentinel');
  });
});
