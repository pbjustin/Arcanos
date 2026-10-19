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
    "I'd save the Elixir for the final boss.",
    'I would save supplies for the return journey.',
    "We'd save tokens for the next activity.",
    'I recommend players save their potions for phase two.',
    'I suggest travelers save supplies for the return journey.',
    'We advise participants to save energy for the final stage.',
    "I'd save.",
    'I would save.',
    'I recommend players save.',
    'I suggest that you save.',
    'We advise participants to save.',
    'Use the checkpoint to save.',
    "Before continuing, don't forget to save.",
    'Before continuing, remember to save.',
    'Before continuing, make sure to save.',
    "Don't forget to save.",
    'Do not forget to save.',
    'Make sure to save.',
    'Remember to save.'
  ])('preserves counterfactual advice and reader reminders in both stages: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(false);
    expect(first.text).toBe(text);
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims).toEqual([]);
      expect(final.text).toBe(text);
    }
  });

  it.each([
    'I plan to save a copy.',
    'We intend to save a snapshot.',
    'I promise to save a backup.',
    'I will remember to save.',
    'I will make sure to save.',
    "I'll save your notes.",
    "I'll save.",
    'We will save.',
    'I plan to save.',
    'I recommend players save and I will save.',
    "I'd save your notes to disk.",
    'I recommend players save tokens and I will save a snapshot.',
    'I recommend a plan and save a copy.',
    'I recommend players conserve potions and will save a backup.',
    'We suggest players conserve energy, but will save a snapshot.',
    'I suggest travelers save energy; I plan to save a copy.',
    'Remember to save and I will save a backup.',
    'Make sure to save. This chat saves automatically.'
  ])('keeps commitments and mixed advice under persistence enforcement: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims.length).toBeGreaterThan(0);
      expect(final.text).not.toBe(text);
    }
    expect(review(text).final.text).not.toBe(text);
  });

  it.each([
    'Before exploring, prepare food for healing and save stamina for the return climb. [Source 1]',
    'Save a healing meal for a difficult climb.',
    'Keep moving carefully and save taunts for enemies leaving your control.',
    'You should save supplies for the return journey.',
    'Save time by preparing the ingredients together.',
    'Save money for the return trip.',
    'I recommend you save stamina for the return climb.',
    'I suggest that you save supplies for the return journey.',
    'Save tokens for the final stage.',
    'Save at least ten tokens for the final stage.',
    'Save tokens by waiting until prices fall.',
    'Use chat to organize your route and save tokens.',
    'The assistant recommends you save tokens.',
    'This chat can save you time.',
    'This chat saves you time.',
    'The service saves you time.',
    'This conversation saves you time.',
    'This session saves you time.',
    'This chat saves you time when editing files.',
    'This chat saves no data.',
    'The assistant saves tokens by using shorter replies.',
    'The application automatically saves you time.',
    'This chat never saves automatically.',
    'The application does not save automatically.',
    'The assistant can save tokens by using shorter replies.',
    'This chat will explain how to save automatically.',
    'The application can recommend ways to save automatically.',
    'This chat will not save automatically.',
    'This chat will never save automatically.',
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

  it('keeps an explicit cannot-save limitation truthful under presentation normalization', () => {
    const text = 'This chat cannot save automatically.';
    const preserved = review(text);
    expect(preserved.first.blocked).toBe(false);
    expect(preserved.final.blockedOrRewrittenClaims).toEqual([]);
    expect(preserved.final.text).toBe(text);
    const normalized = review(text, false).final;
    expect(normalized.blockedOrRewrittenClaims).toEqual([]);
    expect(normalized.text).toBe("I haven't saved or persisted anything here.");
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
    'I will save tokens for later.',
    'We always save tokens for later.',
    'Save access tokens for later.',
    'Save authentication tokens for later.',
    'Save refresh tokens securely.',
    'Save secret tokens for later.',
    'Save tokens to disk.',
    'Save tokens in a file.',
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

  it.each([
    'This chat will save automatically.',
    'This chat saves automatically.',
    'These chats save automatically.',
    'This chat automatically saves.',
    'This chat always saves automatically.',
    'The application saves the snapshot.',
    'The browser saves to disk.',
    'The software saves a backup.',
    'This chat saves you time and your data.',
    'This chat saves you time while storing your data.',
    'This chat saves you time when recording your conversations.',
    'This chat saves no data but your preferences.',
    'This chat saves no data; it saves your preferences.',
    'This chat will automatically save before closing.',
    'Your chat can now save automatically.',
    'Your conversation will save automatically.',
    'The application can now save the snapshot.',
    'The assistant will silently save a copy.',
    'The system will always save automatically.',
    'The system will never fail to save automatically.',
    'The application will be able to save automatically.',
    'The browser should automatically save to disk.',
    'This session may automatically save after closing.',
    'The software will save a backup.',
    'This chat will not only save automatically but also retain a copy.',
    'Chat will quietly save on its own.'
  ])('guards automatic system-owned retention in each enforcement stage: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(true);
    expect(first.text).not.toBe(text);

    // Exercise the later guard independently: an earlier rewrite must not mask
    // a gap when callers enter through the final normalization stage directly.
    const final = enforceFinalStageHonestyAndMinimalism({
      text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
      outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation: true
    });
    expect(final.blockedOrRewrittenClaims).toContain(text);
    expect(final.text).not.toBe(text);
  });
});
