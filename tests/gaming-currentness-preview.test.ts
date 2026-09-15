import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actualFreshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const actualCurrentness = await import('../src/shared/gaming/gamingCurrentnessAdapters.js');
const actualEvidence = await import('../src/shared/gaming/gamingClearEvidence.js');
const actualBinding = await import('../src/shared/gaming/gamingClearAnswerBinding.js');
const extract = jest.fn(actualFreshness.extractGamingFreshnessMetadata);
const evaluate = jest.fn(actualFreshness.evaluateGamingFreshness);
const combine = jest.fn(actualCurrentness.combineGamingCurrentnessEvidence);
const evidence = jest.fn(actualEvidence.assessGamingClearEvidence);
const binding = jest.fn(actualBinding.hasBoundGamingClearAnswer);
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...actualFreshness,
  extractGamingFreshnessMetadata: extract, evaluateGamingFreshness: evaluate }));
jest.unstable_mockModule('../src/shared/gaming/gamingCurrentnessAdapters.js', () => ({ ...actualCurrentness, combineGamingCurrentnessEvidence: combine }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearEvidence.js', () => ({ ...actualEvidence, assessGamingClearEvidence: evidence }));
jest.unstable_mockModule('../src/shared/gaming/gamingClearAnswerBinding.js', () => ({ ...actualBinding, hasBoundGamingClearAnswer: binding }));
const { runGamingCurrentnessPreview, GAMING_CURRENTNESS_PREVIEW_VERSION } = await import('../src/shared/gaming/gamingCurrentnessPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_CURRENTNESS_CONTRACT_INVALID';

describe('sealed PC Elden Ring currentness and answer-admission fixture', () => {
  beforeEach(() => {
    extract.mockReset().mockImplementation(actualFreshness.extractGamingFreshnessMetadata);
    evaluate.mockReset().mockImplementation(actualFreshness.evaluateGamingFreshness);
    combine.mockReset().mockImplementation(actualCurrentness.combineGamingCurrentnessEvidence);
    evidence.mockReset().mockImplementation(actualEvidence.assessGamingClearEvidence);
    binding.mockReset().mockImplementation(actualBinding.hasBoundGamingClearAnswer);
  });

  it('repeats fixed document extraction, separate App/Regulation and PC answer checks', () => {
    expect(runGamingCurrentnessPreview()).toBeUndefined();
    expect(runGamingCurrentnessPreview()).toBeUndefined();
    expect(GAMING_CURRENTNESS_PREVIEW_VERSION).toBe('gaming-currentness/v1');
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Patch: 1.17\nBuild: 1.17\nPlatforms: PC') }),
      { game: 'Elden Ring' }, new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Regulation Ver. 1.17.1') }),
      { game: 'Elden Ring' }, new Date('2026-09-09T12:00:00.000Z'), expect.any(Array));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ game: 'Elden Ring', mode: 'build', platform: 'PC' }));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ platform: 'PS5' }));
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ platform: 'PC' }), expect.any(Object), { now: new Date('2026-09-09T12:00:00.000Z') });
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({ response: expect.stringContaining('Works on every platform.') }));
    expect(extract.mock.calls.every(([doc]) => new URL(doc.publicUrl).host === 'currentness-preview.example')).toBe(true);
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
