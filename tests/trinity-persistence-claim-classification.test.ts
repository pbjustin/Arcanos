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
    'The game’s checkpoint system saves your progress, but the assistant will save your work.',
    'The in-game autosave system saves your progress, and this chat will save your notes.',
    'Near the in-game checkpoint system, this chat will save your progress.',
    'The in-game assistant will save your progress.',
    "The game's assistant system will save your progress.",
    "The game's conversation system will save your progress.",
    "The game's application system will save your work.",
    "The game's chat system will save your progress.",
    "The game's backend system will save your state.",
    "The game's checkpoint system saves your progress to the backend.",
    "The game's autosave system retains your history in a database.",
    "The game's checkpoint system saves your progress and will save your state to the backend.",
    "The game's checkpoint system saves your conversation.",
    "The game's checkpoint system saves your access tokens.",
    "The application's checkpoint system saves your progress.",
    'The autosave system saves your progress.',
    'The assistant will save your progress.',
    'This chat will save your work.',
    'The application retains your history.',
    'The system will retain your state.',
    'This chat retains everything.',
    'The assistant promises to save all your progress.',
    'The application will save your current progress.',
    'This chat will retain all of your current work.',
    'The software will retain our entire history.',
    'This chat will save the latest state.',
    'The application saves you time and your progress.',
    'The application saves you time and your progress automatically.',
    'This chat will save time and your work for later.',
    'The application saves you time and all your current progress automatically.',
    'This chat will not save your progress but will retain your work.',
    'This chat will retain your progress and your history.',
    'The assistant will save some current progress.'
  ])('blocks software-owned personal-state retention independently in both stages: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(true);
    expect(first.text).not.toBe(text);
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims.length).toBeGreaterThan(0);
      expect(final.text).not.toBe(text);
    }
  });

  it.each([
    'The game’s checkpoint system saves your progress.',
    'The in-game autosave system saves your progress at each bonfire.',
    "The game's save system retains your state.",
    'The in game checkpoint system will save your progress at each checkpoint.',
    "The game's autosave system retains your progress and your history.",
    'The in-game checkpoint systems save all your current progress.',
    'The in-game autosave system saves time and your progress automatically.',
    "The game's checkpoint system will retain your progress but will not retain your history.",
    "The game's autosave system saves automatically.",
    'The in-game save system will save after battles.',
    "The game's progression system saves your progress.",
    'The in-game character progression system retains your state.',
    "The game's system saves your progress.",
    'Save your progress at the checkpoint.',
    'Save your current progress before leaving.',
    'Save your work before the next encounter.',
    'The assistant explains how to save your progress.',
    'The application reminds players to save their current progress.',
    'This chat will not save your progress.',
    'This chat will never retain your work.',
    'The application will retain no history.',
    'The application saves you time while you make progress.',
    'The application saves you time and helps you make progress.',
    'The application can retain heat.',
    'The application can retain heat and your work benefits.',
    'The application saves stamina and your progress accelerates.',
    'The application saves energy and your state improves.',
    'The application saves stamina and your progress automatically accelerates.',
    'The application saves energy and your work for later improves.',
    'Save stamina while you make progress.',
    'This chat will not save your current progress and will not retain your history.'
  ])('preserves personal-state player guidance and software denials in both stages: %s', text => {
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
    'I plan to save.',
    'We intend to save a snapshot.',
    'I promise to save a backup.',
    'I recommend players save and will save a backup.',
    'We suggest travelers save, but will also save a snapshot.',
    "I'd save supplies and will save a backup.",
    'I recommend players save and will not only save a backup.',
    'I recommend players save and will not save, but will save a backup.',
    'I will not forget to save.',
    'I never forget to save.'
  ])('blocks direct and inherited first-person commitments independently in both stages: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(true);
    expect(first.text).not.toBe(text);
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims.length).toBeGreaterThan(0);
      expect(final.text).not.toBe(text);
    }
  });

  it.each([
    'I recommend players save and rest.',
    'I recommend players save and you can save tokens.',
    'I recommend players save and will not save.',
    'I will not save.',
    'I never save.'
  ])('preserves first-person advice and denials in both stages: %s', text => {
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

  it.each(['Write down the clue before exploring.', 'Store supplies near the checkpoint.'])(
    'does not broaden first-stage persistence detection to ordinary player instructions: %s', text => {
      const first = enforceFinalStageHonesty(text, createDefaultTrinityReasoningHonesty(), capabilityFlags, 'EXECUTE_TASK', true);
      expect(first.blocked).toBe(false);
      expect(first.text).toBe(text);
    }
  );

  it.each([
    { tail: 'and rest.', blocked: false },
    { tail: 'and will save a backup.', blocked: true }
  ])('inspects the complete tail after repeated first-person advice: $tail', ({ tail, blocked }) => {
    const text = `${'I recommend players save '.repeat(8_000)}${tail}`;
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(blocked);
    expect(first.text === text).toBe(!blocked);
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims.length > 0).toBe(blocked);
      expect(final.text === text).toBe(!blocked);
    }
  });

  it.each([
    { tail: 'The application can retain heat.', blocked: false },
    { tail: 'This chat will retain your notes.', blocked: true }
  ])('inspects the complete tail after a long harmless actor prefix: $tail', ({ tail, blocked }) => {
    const text = `${'chat '.repeat(8_000)}${tail}`;
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(blocked);
    expect(first.text === text).toBe(!blocked);
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims.length > 0).toBe(blocked);
      expect(final.text === text).toBe(!blocked);
    }
  });

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
    'The assistant promises to save.',
    'The assistant has agreed to save.',
    'The assistant is ready to save.',
    'This chat has been configured to save.',
    'The application is configured to save.',
    'The application is set to save.',
    'This chat will remember to save.',
    'This chat is guaranteed to save.',
    'The assistant undertakes to save.',
    'The application plans to save.',
    'The application intends to save.',
    'The assistant has committed to save.',
    'This chat is scheduled to save.',
    'This chat will make sure to save.',
    'This chat will retain your notes.',
    'The application retains your preferences.',
    'This conversation can retain data automatically.',
    'This chat retains automatically.',
    'The assistant will promise to save.',
    'This chat may have agreed to save.',
    'The application will be configured to retain your notes.',
    'The assistant promises to always save.',
    'The application is configured to automatically save.',
    'This chat will not retain your notes but will retain your preferences.',
    'This chat will not save your notes but will save your preferences.',
    'This chat will retain no data but will retain your preferences.',
    'The assistant promises to help you save, but will save your notes.',
    'I recommend players save. The assistant promises to save.',
    'Use the checkpoint to save. This chat will retain your notes.'
  ])('blocks unsupported software-owned commitments and retention in both stages: %s', text => {
    const reasoningHonesty = createDefaultTrinityReasoningHonesty();
    const first = enforceFinalStageHonesty(text, reasoningHonesty, capabilityFlags, 'EXECUTE_TASK', true);
    expect(first.blocked).toBe(true);
    expect(first.text).not.toBe(text);
    for (const preservePresentation of [true, false]) {
      const final = enforceFinalStageHonestyAndMinimalism({
        text, userPrompt: prompt, capabilityFlags, reasoningHonesty,
        outputControls: deriveTrinityOutputControls(prompt, {}), preservePresentation
      });
      expect(final.blockedOrRewrittenClaims.length).toBeGreaterThan(0);
      expect(final.text).not.toBe(text);
    }
  });

  it.each([
    'This chat has been configured to explain how to save.',
    'The assistant promises to help you save.',
    'The application is configured to save you time.',
    'This chat will retain no data.',
    'This chat will not retain your notes.',
    'The application can retain heat.',
    'This chat will not retain your notes but will not retain your preferences.',
    'This chat will not retain your notes but will explain how to save.',
    'This chat will not retain your notes but you can retain your notes.',
    'This chat will not save your notes but will save you time.',
    'This chat will not retain your notes but will retain heat.',
    'This chat will retain no data but will retain heat.',
    'The assistant will never promise to save.',
    'The assistant promises not to save.',
    'The application is not configured to retain your notes.',
    'The assistant promises to help you save, but you can retain your notes.',
    'The assistant recommends players conserve supplies and save.',
    'The application reminds you to heal and save.',
    'The assistant suggests players rest and save.',
    'The assistant suggests players rest and automatically save.',
    'The assistant recommends players retain tokens for the final stage.'
  ])('preserves mediated advice, resource retention and denials in both stages: %s', text => {
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
    'This chat will not retain your notes but you can save your notes to disk.',
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
