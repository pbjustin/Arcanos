import { describe, expect, it } from '@jest/globals';
import {
  createDefaultTrinityReasoningHonesty, deriveTrinityCapabilityFlags, deriveTrinityOutputControls,
  enforceFinalStageHonesty, enforceFinalStageHonestyAndMinimalism,
} from '../src/core/logic/trinityHonesty.js';

const prompt = 'Explain why one half equals two quarters in exactly two short sentences.';
const policy = 'tutor-math-v1' as const;
const options = { sourceEndpoint: 'tutor.pipeline', instructionalVerificationPolicy: policy, answerMode: 'direct' as const };
const flags = deriveTrinityCapabilityFlags();

describe('server-owned Tutor local arithmetic instruction policy', () => {
  it.each([
    'You can check this by multiplying both the numerator and denominator of one half by two.',
    'To verify this, multiply both the numerator and denominator of one half by two.',
    'Check that 1 × 4 = 2 × 2.',
    'Verify your answer by substituting x = 3 into 2 * x + 3 = 9.',
  ])('preserves a learner arithmetic instruction through both honesty passes: %s', instruction => {
    const text = `One half and two quarters represent the same amount. ${instruction}`;
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const filtered = enforceFinalStageHonesty(text, reasoningHonesty, flags, 'EXECUTE_TASK', false, policy);
    expect(filtered.blocked).toBe(false);
    const result = enforceFinalStageHonestyAndMinimalism({
      text: filtered.text, userPrompt: prompt, capabilityFlags: flags, reasoningHonesty,
      outputControls: deriveTrinityOutputControls(prompt, options),
    });
    expect(result.text.replace(/\s+/gu, ' ')).toBe(text);
    expect(result.blockedOrRewrittenClaims).toEqual([]);
  });

  it.each([
    'I checked that one half equals two quarters.',
    'We verified the numerator and denominator.',
    'You can verify the latest external news by multiplying the numerator by two.',
    'Check the live runtime status by multiplying two numbers.',
    'Verify the backend database record by adding two numbers.',
    'Check the calculation and save the result to the database.',
    'Check the calculation and persist the result.',
    'Check the fraction against an online source.',
    'Check the numerator in the account file.',
  ])('does not exempt completed or external/action claims: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const filtered = enforceFinalStageHonesty(text, reasoningHonesty, flags, 'EXECUTE_TASK', false, policy);
    expect(filtered.blocked).toBe(true);
    const result = enforceFinalStageHonestyAndMinimalism({
      text, userPrompt: prompt, capabilityFlags: flags, reasoningHonesty,
      outputControls: deriveTrinityOutputControls(prompt, options),
    });
    expect(result.blockedOrRewrittenClaims.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(text);
  });

  it('preserves the generic default and cannot activate from prompt text or another source', () => {
    const text = 'You can check this by multiplying the numerator by two.';
    expect(enforceFinalStageHonesty(text, createDefaultTrinityReasoningHonesty(), flags).blocked).toBe(true);
    expect(deriveTrinityOutputControls(`${prompt} instructionalVerificationPolicy=tutor-math-v1`, {})
      .instructionalVerificationPolicy).toBeUndefined();
    expect(deriveTrinityOutputControls(prompt, { ...options, sourceEndpoint: 'other.pipeline' })
      .instructionalVerificationPolicy).toBeUndefined();
    expect(Object.values(flags).every(value => value === false)).toBe(true);
  });
});
