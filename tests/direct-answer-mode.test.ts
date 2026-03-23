import { describe, expect, it } from '@jest/globals';
import {
  resolveTrinityDirectAnswerPreference,
  shouldPreferDirectAnswerMode
} from '../src/services/directAnswerMode.js';

describe('directAnswerMode', () => {
  it('preserves explicit direct-answer detection', () => {
    expect(
      shouldPreferDirectAnswerMode('Answer directly. Do not simulate. What is a mutex?')
    ).toBe(true);
    expect(
      resolveTrinityDirectAnswerPreference('Answer directly. Do not simulate. What is a mutex?')
    ).toBe('explicit_direct_answer');
  });

  it('auto-selects direct-answer mode for simple informational prompts', () => {
    expect(
      resolveTrinityDirectAnswerPreference('What is a mutex, and when would you use one?')
    ).toBe('simple_informational_prompt');
    expect(
      resolveTrinityDirectAnswerPreference('Summarize the purpose of a database index in one paragraph.')
    ).toBe('simple_informational_prompt');
  });

  it('keeps complex implementation prompts on the full Trinity path', () => {
    expect(
      resolveTrinityDirectAnswerPreference('Debug the retry storm in this queue worker and propose a patch.')
    ).toBeNull();
    expect(
      resolveTrinityDirectAnswerPreference('Implement a database migration plan for the booking service.')
    ).toBeNull();
  });
});
