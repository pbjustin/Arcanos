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
    'You can check the equality by cross-multiplying 1 × 4 and 2 × 2.',
    'Check the equality by cross multiplying the numerator and denominator.',
    'Verify your answer by substituting x = 3 into 2 * x + 3 = 9.',
    'Can you check the equality by cross-multiplying?',
    'Can you check this by multiplying both sides?',
    'Can you check whether 1/2 = 2/4 by cross-multiplying?',
    'Check your answer by substituting x = 3 into 2x + 3 = 9.',
    'Verify this by plugging x = 3 into the equation.',
    'As a check, multiply both numerator and denominator by two.',
    'CHECK THAT 1 × 4 = 2 × 2?',
    'Could you verify the solution by putting it back into the original equation?',
    'Can you check whether both sides of the equation are equal?',
    'Check your work.',
    'Check your understanding by multiplying the numerator and denominator by two.',
    'Check the equality of 0.5 and 2/4.',
    'Check this by comparing the two arithmetic expressions.',
    'Check your work by adding or subtracting.',
    'Check your work by multiplying or dividing.',
    'Check your work by adding, subtracting, multiplying, or dividing.',
    'Check your work by adding 3 to both sides.',
    'Check your work by subtracting 3 from both sides.',
    'Check your answer by plugging 3 back into the original equation.',
    'Check the equation and verify the equality.',
    'Check your result by simplifying the fraction.',
    '1. Check your answer by substituting x = 3 into the original equation.',
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
    const secondPassOnly = enforceFinalStageHonestyAndMinimalism({
      text, userPrompt: prompt, capabilityFlags: flags, reasoningHonesty,
      outputControls: deriveTrinityOutputControls(prompt, options),
    });
    expect(secondPassOnly.text).toBe(text);
    expect(secondPassOnly.blockedOrRewrittenClaims).toEqual([]);
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
    'You can check the equality by cross-multiplying and verify the live account status.',
    'I checked that 1/2 equals 2/4.',
    'We verified the answer.',
    'This has been confirmed: 1/2 = 2/4.',
    'Check the latest external news.',
    'Verify the live runtime status.',
    'Check the backend database.',
    'Verify the account record.',
    'Check the answer and save it.',
    'Cross-multiply and verify the live account status.',
    'Can you check 2 + 2 against an online source?',
    'Can you check the current stock price by dividing two numbers?',
    'Check the equation by browsing the web.',
    'Check your work and persist it.',
    'Check your equation; the answer was verified.',
    '1. Check 2 + 2 = 4. I checked your account.',
    'Check the weather by multiplying 2 × 2.',
    'Check the election result using the equation.',
    'Check your equation and confirm the transaction.',
    'Can you check your work and look up the answer?',
    'Check the equality using the external API.',
    'Check by comparing the weather forecast.',
    'As a check, add an administrator.',
    'Check by putting a message in the inbox.',
    'Check the result of the football match.',
    'Check the value of my portfolio.',
    'Check your equation by updating your password.',
    'Check the equality and send a message.',
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

  it.each(['other.pipeline', 'gaming.pipeline', 'core.pipeline'])('does not exempt learner instructions for %s', sourceEndpoint => {
    const text = 'Can you check the equality by cross-multiplying?';
    const outputControls = deriveTrinityOutputControls(prompt, { ...options, sourceEndpoint });
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    expect(outputControls.instructionalVerificationPolicy).toBeUndefined();
    expect(enforceFinalStageHonesty(text, reasoningHonesty, flags, 'EXECUTE_TASK', false,
      outputControls.instructionalVerificationPolicy).blocked).toBe(true);
    expect(enforceFinalStageHonestyAndMinimalism({
      text, userPrompt: prompt, capabilityFlags: flags, reasoningHonesty, outputControls,
    }).blockedOrRewrittenClaims).toContain(text);
  });

  it.each([
    '1. Subtract 3 from both sides.\n2. Divide both sides by 2.\n3. Check your answer by substituting x = 3 into the equation.',
    '- Check that 0.5 = 1/2.\n- Verify this by plugging x = 3 into 2x + 3 = 9.',
    'Check your work by simplifying.\n\nCan you check the equality by cross-multiplying?',
  ])('preserves existing instructional line structure: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, flags, 'EXECUTE_TASK', false, policy);
    expect(first.blocked).toBe(false);
    const result = enforceFinalStageHonestyAndMinimalism({
      text: first.text, userPrompt: prompt, capabilityFlags: flags, reasoningHonesty,
      outputControls: deriveTrinityOutputControls(prompt, options),
    });
    expect(result.text).toBe(text);
  });

  it.each([
    "I cannot verify live or current external information here.\n\n1. Subtract 3.\n2. Divide by 2.\n3. The answer is x = 3.",
    "I cannot verify live or current external information here.\n\n- Subtract 3.\n- Divide by 2.\n\nThe answer is x = 3.",
    'I checked the live account.\n\n1. Subtract 3.\n2. Divide by 2.\n3. The answer is x = 3.',
  ])('preserves remaining layout when a real limitation is normalized: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    reasoningHonesty.responseMode = 'partial_refusal';
    reasoningHonesty.userVisibleCaveats = ["I can't verify current external state here without live access."];
    const suffix = text.slice(text.indexOf('\n\n'));
    const result = enforceFinalStageHonestyAndMinimalism({
      text, userPrompt: prompt, capabilityFlags: flags, reasoningHonesty,
      outputControls: deriveTrinityOutputControls(prompt, options),
    });
    expect(result.text).toBe(`${reasoningHonesty.userVisibleCaveats[0]}${suffix}`);
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

  it('retains unsupported-item classification for detached list markers', () => {
    const text = '1.\nI verified the live runtime.\n2.\nThe answer is x = 3.';
    const result = enforceFinalStageHonestyAndMinimalism({
      text, userPrompt: prompt, capabilityFlags: flags,
      reasoningHonesty: createDefaultTrinityReasoningHonesty(),
      outputControls: deriveTrinityOutputControls(prompt, {}),
    });
    expect(result.blockedOrRewrittenClaims).toContain('1. I verified the live runtime.');
    expect(result.text).not.toMatch(/^\d+\.$/mu);
    // Existing generic policy conservatively carries unsupported list context
    // through the following item, even when that item is mathematical.
    expect(result.blockedOrRewrittenClaims).toContain('2. The answer is x = 3.');
  });

  it('retains inherited unsupported runtime context across detached list markers', () => {
    const result = enforceFinalStageHonestyAndMinimalism({
      text: '1.\nI verified the live runtime.\n2.\nThe worker is healthy.',
      userPrompt: 'Explain the answer.', capabilityFlags: flags,
      reasoningHonesty: createDefaultTrinityReasoningHonesty(),
      outputControls: deriveTrinityOutputControls(prompt, {}),
    });
    expect(result.blockedOrRewrittenClaims).toEqual([
      '1. I verified the live runtime.', '2. The worker is healthy.',
    ]);
    expect(result.text).not.toContain('worker is healthy');
  });
});
