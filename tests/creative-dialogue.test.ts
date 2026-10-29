import { describe, expect, it } from '@jest/globals';
import { hasCreativeDialogue, requiresCreativeDialogue } from '../src/shared/text/creativeDialogue.js';

describe('creative dialogue omission guard', () => {
  it.each([
    'Write a promo with dialogue and production cues.',
    'Include meaningful dialogue in a short backstage scene.',
    'Generate a 200-word backstage promo. Include production directions and dialogue.',
    'Write dialogue ending with: "The spotlight belongs here."',
  ])('recognizes the explicit requirement: %s', prompt => {
    expect(requiresCreativeDialogue(prompt)).toBe(true);
  });

  it.each([
    'Book an entrance.',
    'Write a scene without dialogue.',
    'Create a dialogue-free segment.',
    'No spoken dialogue, just the stare down.',
    'Do not include dialogue in this scene.',
    'Supplied show-state dialogue follows:\n"Review the match before you judge it," Punk said.',
    'Review this completed Raw card. “Recorded dialogue is missing its close. Rebook the main event.',
    'Review this completed Raw card. \'Recorded dialogue.\' Rebook the main event.',
    'Continue the scene. The supplied dialogue is complete.',
    'Treat "Include dialogue in the promo" as quoted context only.',
  ])('preserves requests without dialogue: %s', prompt => {
    expect(requiresCreativeDialogue(prompt)).toBe(false);
  });

  it.each([
    '[CAMERA pushes in.]\n> “The spotlight belongs here.”\n[Cut away.]',
    'CHAMPION: The spotlight belongs here.',
    '**Challenger:** [smiles] The spotlight belongs here.',
    'The challenger replies that the spotlight belongs here.',
    'I earned this opportunity. You will see why.',
    'My moment starts now.',
    'CHALLENGER: Run!',
    '“Run!”',
    "'Run!'",
    '‘Dragon Lee earned this chance.’',
    "'The champion can't avoid this challenge.'",
  ])('accepts speech across formats without participant names: %s', text => {
    expect(hasCreativeDialogue(text)).toBe(true);
  });

  it.each([
    '[CAMERA slowly approaches the champion.]',
    'Creative direction: build anticipation.\n## Backstage segment\nCamera: Follow the challenger.\n--- > > > >',
    'Production directions: a spotlight follows the champion.\n[The champion stares into the lens.]',
    "[The champion can't see the challenger's entrance.]",
    'The wrestlers’ records establish the setting.',
  ])('rejects production-only material: %s', text => {
    expect(hasCreativeDialogue(text)).toBe(false);
  });
});
