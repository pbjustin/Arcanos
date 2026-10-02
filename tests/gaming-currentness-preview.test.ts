import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actualFreshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const actualCurrentness = await import('../src/shared/gaming/gamingCurrentnessAdapters.js');
const actualEvidence = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualBinding = await import('../src/shared/gaming/gamingClearAnswerBinding.js');
const actualPolicy = await import('../src/shared/gaming/gamingHybridPolicyCore.js');
const actualDisposition = await import('../src/shared/gaming/gamingFreshnessDisposition.js');
const extract = jest.fn(actualFreshness.extractGamingFreshnessMetadata);
const evaluate = jest.fn(actualFreshness.evaluateGamingFreshness);
const combine = jest.fn(actualCurrentness.combineGamingCurrentnessEvidence);
const evidence = jest.fn(actualEvidence.assessGamingClearEvidence);
const binding = jest.fn(actualBinding.hasBoundGamingClearAnswer);
const project = jest.fn(actualPolicy.projectGamingHybridCandidateEvidence);
const attempt = jest.fn(actualPolicy.resolveGamingHybridCandidateAttempt);
const reason = jest.fn(actualPolicy.resolveGamingHybridCurrentnessReason);
const disposition = jest.fn(actualDisposition.resolveGamingFreshnessDisposition);
const currentnessClaim = jest.fn(actualDisposition.gamingAnswerClaimsVerifiedCurrentness);
const advisorySelection = jest.fn(actualDisposition.selectGamingAdvisoryGameplayEvidence);
const advisoryOperation = jest.fn(actualDisposition.isGamingAdvisoryCurrentnessOperation);
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...actualFreshness,
  extractGamingFreshnessMetadata: extract, evaluateGamingFreshness: evaluate }));
jest.unstable_mockModule('../src/shared/gaming/gamingCurrentnessAdapters.js', () => ({ ...actualCurrentness, combineGamingCurrentnessEvidence: combine }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...actualEvidence, assessGamingClearEvidence: evidence }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearAnswerBinding.js', () => ({ ...actualBinding, hasBoundGamingClearAnswer: binding }));
jest.unstable_mockModule('../src/shared/gaming/gamingHybridPolicyCore.js', () => ({ ...actualPolicy,
  projectGamingHybridCandidateEvidence: project, resolveGamingHybridCandidateAttempt: attempt, resolveGamingHybridCurrentnessReason: reason }));
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessDisposition.js', () => ({ ...actualDisposition,
  resolveGamingFreshnessDisposition: disposition, gamingAnswerClaimsVerifiedCurrentness: currentnessClaim,
  selectGamingAdvisoryGameplayEvidence: advisorySelection, isGamingAdvisoryCurrentnessOperation: advisoryOperation }));
const { runGamingCurrentnessPreview, GAMING_CURRENTNESS_PREVIEW_VERSION, GAMING_CURRENTNESS_CONTINUATION_PREVIEW_VERSION,
  GAMING_ADVISORY_FRESHNESS_PREVIEW_VERSION } = await import('../src/shared/gaming/gamingCurrentnessPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_CURRENTNESS_CONTRACT_INVALID';

describe('sealed PC Elden Ring currentness and answer-admission fixture', () => {
  beforeEach(() => {
    extract.mockReset().mockImplementation(actualFreshness.extractGamingFreshnessMetadata);
    evaluate.mockReset().mockImplementation(actualFreshness.evaluateGamingFreshness);
    combine.mockReset().mockImplementation(actualCurrentness.combineGamingCurrentnessEvidence);
    evidence.mockReset().mockImplementation(actualEvidence.assessGamingClearEvidence);
    binding.mockReset().mockImplementation(actualBinding.hasBoundGamingClearAnswer);
    project.mockReset().mockImplementation(actualPolicy.projectGamingHybridCandidateEvidence);
    attempt.mockReset().mockImplementation(actualPolicy.resolveGamingHybridCandidateAttempt);
    reason.mockReset().mockImplementation(actualPolicy.resolveGamingHybridCurrentnessReason);
    disposition.mockReset().mockImplementation(actualDisposition.resolveGamingFreshnessDisposition);
    currentnessClaim.mockReset().mockImplementation(actualDisposition.gamingAnswerClaimsVerifiedCurrentness);
    advisorySelection.mockReset().mockImplementation(actualDisposition.selectGamingAdvisoryGameplayEvidence);
    advisoryOperation.mockReset().mockImplementation(actualDisposition.isGamingAdvisoryCurrentnessOperation);
  });

  it('repeats fixed document extraction, separate App/Regulation and PC answer checks', () => {
    expect(runGamingCurrentnessPreview()).toBeUndefined();
    expect(runGamingCurrentnessPreview()).toBeUndefined();
    expect(GAMING_CURRENTNESS_PREVIEW_VERSION).toBe('gaming-currentness/v1');
    expect(GAMING_CURRENTNESS_CONTINUATION_PREVIEW_VERSION).toBe('gaming-currentness-continuation/v1');
    expect(GAMING_ADVISORY_FRESHNESS_PREVIEW_VERSION).toBe('gaming-advisory-freshness/v1');
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Patch: 1.17\nBuild: 1.17\nPlatforms: PC') }),
      { game: 'Elden Ring' }, new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Regulation Ver. 1.17.1') }),
      { game: 'Elden Ring' }, new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ game: 'Elden Ring', mode: 'build', platform: 'PC' }));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ platform: 'PS5' }));
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ platform: 'PC' }), expect.any(Object), { now: new Date('2026-09-09T12:00:00.000Z') });
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({ response: expect.stringContaining('Works on every platform.') }));
    expect(extract.mock.calls.every(([doc]) => new URL(doc.publicUrl).host === 'currentness-preview.example')).toBe(true);
    expect(project).toHaveBeenCalledWith(expect.objectContaining({ knowledge: { context: '', sources: [] },
      acceptedFreshness: [expect.objectContaining({ id: 'synthetic-continuation-fresh-index', currentBuild: '1.17.1' })] }));
    expect(project).toHaveBeenCalledWith(expect.objectContaining({ knowledge: expect.objectContaining({
      sources: [expect.objectContaining({ sourceId: 'synthetic-continuation-fresh-index' })] }) }));
  });

  it('executes advisory unknown/stale gameplay admission and strict mixed-current-state checks', () => {
    expect(runGamingCurrentnessPreview()).toBeUndefined();
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ mode: 'build' }), expect.objectContaining({
      sources: [expect.objectContaining({ freshnessMetadata: expect.objectContaining({ effectiveUntil: '2026-09-08T00:00:00.000Z' }) })]
    }), expect.objectContaining({ allowAdvisoryFreshness: true }));
    expect(currentnessClaim).toHaveBeenCalledWith(expect.stringContaining('This build has not been tested on the current patch.'));
    expect(currentnessClaim).toHaveBeenCalledWith(expect.stringContaining('have never been verified compatible with the latest patch.'));
    for (const prompt of ['Recommend an Intelligence staff mage build and summarize the latest patch notes.',
      'Recommend an Intelligence staff mage build and list the current season.', 'What time does maintenance end today?']) {
      expect(disposition).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
      expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ prompt }), expect.any(Object),
        expect.objectContaining({ allowAdvisoryFreshness: true }));
    }
  });

  it('detects known stale gameplay using the weaker unverified qualification', () => {
    advisorySelection.mockImplementation(input => {
      const value = actualDisposition.selectGamingAdvisoryGameplayEvidence(input);
      return value.status === 'stale' ? { ...value, qualification: actualDisposition.GAMING_UNVERIFIED_GUIDE_WARNING } : value;
    });
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it.each(['SOURCE_INSTRUCTIONS_REJECTED', 'URL_BLOCKED', 'REVIEWED_OFFICIAL_CURRENTNESS_SOURCE_REQUIRED'])(
    'detects forbidden currentness rejection granting advisory admission: %s', reasonCode => {
      advisoryOperation.mockImplementation(input => input.decisions.some(item => item.reasonCodes.includes(reasonCode))
        || actualDisposition.isGamingAdvisoryCurrentnessOperation(input));
      expect(runGamingCurrentnessPreview).toThrow(FAILURE);
    });

  it.each(['has not been tested', 'have never been verified compatible'])(
    'detects honest passive uncertainty being rejected: %s', phrase => {
      currentnessClaim.mockImplementation(answer => answer.includes(phrase)
        || actualDisposition.gamingAnswerClaimsVerifiedCurrentness(answer));
      expect(runGamingCurrentnessPreview).toThrow(FAILURE);
    });

  it('detects an affirmative claim being hidden by a preceding negative clause', () => {
    currentnessClaim.mockImplementation(answer => answer.includes('This build works on the current patch.') ? false
      : actualDisposition.gamingAnswerClaimsVerifiedCurrentness(answer));
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it.each(['summarize the latest patch notes', 'list the current season', 'maintenance end today'])(
    'detects required current-state facts being classified as advisory: %s', phrase => {
      disposition.mockImplementation(input => input.prompt.includes(phrase) ? 'ADVISORY'
        : actualDisposition.resolveGamingFreshnessDisposition(input));
      expect(runGamingCurrentnessPreview).toThrow(FAILURE);
    });

  it.each(['advisory gameplay rejected', 'unknown freshness promoted', 'required fact admitted', 'missing grant admitted'])(
    'detects advisory evidence-admission drift: %s', scenario => {
      evidence.mockImplementation((input, knowledge, options) => {
        const value = actualEvidence.assessGamingClearEvidence(input, knowledge, options);
        const advisory = options?.allowAdvisoryFreshness === true;
        if (scenario === 'advisory gameplay rejected' && advisory && value.decision === 'accept') return { ...value, decision: 'reject' };
        if (scenario === 'unknown freshness promoted' && advisory && value.decision === 'accept') {
          return { ...value, gates: { ...value.gates, freshness: 'verified' } };
        }
        if (scenario === 'required fact admitted' && advisory && actualDisposition.resolveGamingFreshnessDisposition(input) === 'REQUIRED') {
          return { ...value, decision: 'accept' };
        }
        if (scenario === 'missing grant admitted' && !advisory && options?.freshnessEvidence?.length === 1
          && actualDisposition.resolveGamingFreshnessDisposition(input) === 'ADVISORY') return { ...value, decision: 'accept' };
        return value;
      });
      expect(runGamingCurrentnessPreview).toThrow(FAILURE);
    });

  it.each(['old source retained', 'old chunk retained', 'old positive metadata retained', 'prior contradiction dropped',
    'adapter-only contradiction dropped', 'metadata-only contradiction dropped', 'evaluated contradiction dropped'])(
    'detects currentness evidence projection drift: %s', scenario => {
      project.mockImplementation(input => {
        const value = actualPolicy.projectGamingHybridCandidateEvidence(input);
        if (scenario === 'old source retained') value.knowledge.sources.push(...(input.prior?.sources ?? [])
          .filter(source => source.sourceId === 'synthetic-continuation-old-index'));
        if (scenario === 'old chunk retained') value.knowledge.evidence!.push(...(input.prior?.evidence ?? [])
          .filter(chunk => chunk.sourceId === 'synthetic-continuation-old-index'));
        if (scenario === 'old positive metadata retained') value.freshness.push(...(input.priorFreshness ?? [])
          .filter(item => item.id === 'synthetic-continuation-old-index'));
        const drop = scenario === 'prior contradiction dropped' && input.priorFreshness?.some(item => item.metadataConflict)
          || scenario === 'adapter-only contradiction dropped' && input.priorFreshness?.some(item => !item.metadataConflict && item.currentnessMetadata?.status === 'conflicting')
          || scenario === 'metadata-only contradiction dropped' && input.priorFreshness?.some(item => item.metadataConflict && item.currentnessMetadata?.status !== 'conflicting')
          || scenario === 'evaluated contradiction dropped' && Boolean(input.currentnessEvidence?.length);
        if (drop) value.freshness = value.freshness.filter(item => item.id !== 'synthetic-continuation-conflict');
        return value;
      });
      expect(runGamingCurrentnessPreview).toThrow(FAILURE);
    });

  it('detects missing-build continuation being denied', () => {
    reason.mockImplementation(input => input.reasons.includes('CURRENT_BUILD_UNVERIFIED') ? undefined
      : actualPolicy.resolveGamingHybridCurrentnessReason(input));
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it.each(['retry denied', 'extra operation admitted'])('detects bounded currentness attempt drift: %s', scenario => {
    attempt.mockImplementation(input => scenario === 'retry denied' && input.operationKey === input.requestedKey ? 'deny'
      : scenario === 'extra operation admitted' && input.round === 1 && input.operationKey !== input.requestedKey ? 'begin'
        : actualPolicy.resolveGamingHybridCandidateAttempt(input));
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it('detects extraction that fills missing regulation metadata from the patch', () => {
    extract.mockImplementation((...args) => {
      const value = actualFreshness.extractGamingFreshnessMetadata(...args);
      return value.category === 'specialist_guide' && !value.build ? { ...value, build: value.patch } : value;
    });
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it('detects extraction that assumes a guide with no platform applies to PC', () => {
    extract.mockImplementation((...args) => {
      const value = actualFreshness.extractGamingFreshnessMetadata(...args);
      return value.category === 'specialist_guide' && !value.platforms ? { ...value, platforms: ['PC'] } : value;
    });
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it('detects completion that widens the index platform scope', () => {
    combine.mockImplementation((items, now) => actualCurrentness.combineGamingCurrentnessEvidence(items, now).map(item =>
      item.currentness === 'current_index' && item.currentnessMetadata?.status === 'verified' ? { ...item, platforms: ['Steam', 'PC', 'PS5'] } : item));
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it.each(['accepted guide rejected', 'missing build accepted', 'wrong platform accepted', 'stale index accepted', 'conflicting regulation accepted'])(
    'detects freshness policy drift: %s', scenario => {
      evaluate.mockImplementation(input => {
        const value = actualFreshness.evaluateGamingFreshness(input);
        const guide = input.evidence.find(item => item.category === 'specialist_guide');
        const index = input.evidence.find(item => item.currentness === 'current_index');
        if (scenario === 'accepted guide rejected' && value.usable) return { ...value, usable: false };
        if (scenario === 'missing build accepted' && guide && !guide.build) return { ...value, usable: true };
        if (scenario === 'wrong platform accepted' && guide?.platforms?.includes('PS5') && input.platform === 'PC') return { ...value, usable: true };
        if (scenario === 'stale index accepted' && index?.fetchedAt === '2026-09-09T05:59:59.999Z') return { ...value, usable: true };
        if (scenario === 'conflicting regulation accepted' && index?.currentnessMetadata?.status === 'conflicting') return { ...value, usable: true };
        return value;
      });
      expect(runGamingCurrentnessPreview).toThrow(FAILURE);
    }
  );

  it('detects official release notes admitted as the gameplay answer', () => {
    evidence.mockImplementation((input, knowledge, options) => {
      const value = actualEvidence.assessGamingClearEvidence(input, knowledge, options);
      return knowledge.sources.every(source => source.sourceType === 'official_updates')
        ? { ...value, decision: 'accept', gates: { ...value.gates, claimSupport: 'verified' } } : value;
    });
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it('detects altered answer text retaining approval', () => {
    binding.mockImplementation(carrier => carrier.response.endsWith('Works on every platform.') || actualBinding.hasBoundGamingClearAnswer(carrier));
    expect(runGamingCurrentnessPreview).toThrow(FAILURE);
  });

  it('returns a fixed failure without private core diagnostics', () => {
    extract.mockImplementation(() => { throw new Error('private-currentness-preview-sentinel'); });
    let failure: unknown;
    try { runGamingCurrentnessPreview(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
  });
});
