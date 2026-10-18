import { describe, expect, it } from '@jest/globals';
import {
  createDefaultTrinityReasoningHonesty, deriveTrinityCapabilityFlags, deriveTrinityOutputControls,
  enforceFinalStageHonesty, enforceFinalStageHonestyAndMinimalism
} from '../src/core/logic/trinityHonesty.js';

const prompt = 'Explain how to prepare supplies before the next activity.';
const capabilityFlags = deriveTrinityCapabilityFlags();

function review(text: string, preservePresentation = true) {
  const reasoningHonesty = createDefaultTrinityReasoningHonesty();
  const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
  const final = enforceFinalStageHonestyAndMinimalism({
    text: first.text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
    outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
  });
  return { first, final };
}

describe('generic persistence claims distinguish conserving resources from backend actions', () => {
  it.each([
    'Before exploring, prepare food for healing and save stamina for the return climb. [Source 1]',
    'Save a healing meal for a difficult climb.',
    'Keep moving carefully and save taunts for enemies leaving your control.',
    'You should save supplies for the return journey.',
    'Save time by preparing the ingredients together.',
    'Save money for the return trip.',
    'I recommend you save stamina for the return climb.',
    'I suggest that you save supplies for the return journey.',
    '1. Save energy for the final stage.\n2. Keep enough food for the return journey.'
  ])('preserves ordinary resource-conservation guidance: %s', text => {
    const { first, final } = review(text);
    expect(first.blocked).toBe(false);
    expect(final.blockedOrRewrittenClaims).toEqual([]);
    expect(final.text).toBe(text);
    const withoutPresentation = review(text, false).final;
    expect(withoutPresentation.blockedOrRewrittenClaims).toEqual([]);
    expect(withoutPresentation.text).toBe(text);
  });

  it.each([
    'I saved your preferences.',
    'Your preferences were saved.',
    'Saved.',
    "I'll save your preferences.",
    'We will save it for later.',
    'I can save that.',
    'I save the answer for future use.',
    'I always save your work.',
    'I can now save the snapshot.',
    "I'll automatically save a copy.",
    'We will also save the snapshot.',
    'I told you I will save the snapshot.',
    'Save this to memory.',
    'Save the answer to a file.',
    'Save it.',
    'Save.',
    'I stored your preferences.',
    'I wrote the answer.',
    'I persisted the answer.',
    'I updated the profile.',
    'I inserted the preferences.',
    'Save stamina and I will save your preferences.',
    'Save stamina and persist the result.',
    'Save stamina and update the backend record.'
  ])('retains unsupported persistence and mixed-clause controls: %s', text => {
    const { first, final } = review(text);
    expect(first.blocked || final.blockedOrRewrittenClaims.length > 0).toBe(true);
    expect(final.text).not.toBe(text);
  });
});
