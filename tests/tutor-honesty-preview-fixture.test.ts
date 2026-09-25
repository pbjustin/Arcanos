import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actual = await import('../src/core/logic/trinityHonesty.js');
const prepare = jest.fn(actual.prepareTrinityDirectAnswerHonesty);
const enforce = jest.fn(actual.enforceFinalStageHonestyAndMinimalism);
jest.unstable_mockModule('../src/core/logic/trinityHonesty.js', () => ({
  ...actual,
  prepareTrinityDirectAnswerHonesty: prepare,
  enforceFinalStageHonestyAndMinimalism: enforce,
}));
const { assertTutorHonestyPreviewFixture } = await import('../src/shared/chatgpt/tutorHonestyPreviewFixture.js');
const FAILURE = 'TUTOR_HONESTY_PREVIEW_ASSERTION_FAILED';

beforeEach(() => {
  prepare.mockReset().mockImplementation(actual.prepareTrinityDirectAnswerHonesty);
  enforce.mockReset().mockImplementation(actual.enforceFinalStageHonestyAndMinimalism);
});

describe('finite served Tutor honesty fixture', () => {
  it('executes the real shared admission and both final-pass paths for all 26 constructed cases', () => {
    expect(assertTutorHonestyPreviewFixture()).toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(26);
    expect(enforce).toHaveBeenCalledTimes(52);
    for (const [input] of prepare.mock.calls) {
      expect(Object.values(input.capabilityFlags)).toEqual([false, false, false, false, false, false]);
    }
    expect(prepare.mock.calls.slice(0, 3).map(([input]) => input.userPrompt)).toEqual([
      'Explain why one half equals two quarters, in two short sentences.',
      'In exactly two sentences, explain why 1/2 equals 2/4 and ask the learner to check the equality by cross-multiplying.',
      'Give exactly three numbered steps to solve 2x + 3 = 9, with no introduction.',
    ]);
  });

  it.each(['false local caveat', 'false external provenance', 'allowed external claim', 'forged evidence', 'policy injection'])(
    'withholds proof when admission regresses: %s', scenario => {
      prepare.mockImplementation(input => {
        const result = actual.prepareTrinityDirectAnswerHonesty(input);
        if (scenario === 'false local caveat') {
          result.reasoningHonesty.userVisibleCaveats.push('Unexpected local caveat.');
        } else if (scenario === 'false external provenance' && input.candidateText.startsWith('Verify whether')) {
          result.ruleIds.push('CURRENT_EXTERNAL_MODEL_CLAIM');
        } else if (scenario === 'allowed external claim' && input.candidateText === 'Check the latest news about this company.') {
          result.honestyFiltered.blocked = false;
        } else if (scenario === 'forged evidence') {
          result.reasoningHonesty.evidenceTags.push({
            claimText: 'Synthetic unearned evidence.', sourceType: 'tool', confidence: 'high', verificationStatus: 'verified',
          });
        } else if (scenario === 'policy injection' && input.outputControls.instructionalVerificationPolicy === undefined) {
          result.ruleIds.push('TUTOR_LOCAL_INSTRUCTION_EXEMPT');
        }
        return result;
      });
      expect(assertTutorHonestyPreviewFixture).toThrow(FAILURE);
    },
  );

  it.each(['collapse numbered lines', 'insert caveat', 'rewrite learner instruction', 'restore blocked claim'])(
    'rejects final-output regressions: %s', scenario => {
      enforce.mockImplementation(input => {
        const result = actual.enforceFinalStageHonestyAndMinimalism(input);
        if (scenario === 'collapse numbered lines' && input.text.startsWith('1. Subtract 3')) {
          result.text = result.text.replace(/\n/gu, ' ');
        } else if (scenario === 'insert caveat') {
          result.text = 'I have not independently established that claim.\n\n' + result.text;
        } else if (scenario === 'rewrite learner instruction') {
          result.text = result.text.replace('Check the equality by cross-multiplying.', 'The fractions are equal.');
        } else if (scenario === 'restore blocked claim' && input.text.includes('current external')) {
          result.text += ' I verified the live runtime.';
        }
        return result;
      });
      expect(assertTutorHonestyPreviewFixture).toThrow(FAILURE);
    },
  );

  it.each(['admission', 'final pass'])('sanitizes unexpected dependency failures from %s', dependency => {
    const fail = () => { throw new Error('Unexpected synthetic dependency prose.'); };
    if (dependency === 'admission') prepare.mockImplementation(fail);
    else enforce.mockImplementation(fail);
    try {
      assertTutorHonestyPreviewFixture();
      throw new Error('Expected fixture rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(FAILURE);
    }
  });
});
