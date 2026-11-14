import { describe, expect, it } from '@jest/globals';
import { formatGamingGuidePresentation } from '../src/services/gamingGuidePresentation.js';
import {
  colonisationRequest, installedColonisationAnswer, isolatedColonisationAnswer
} from './testUtils/gamingPresentationRegressionFixture.js';

const warning = installedColonisationAnswer.split('\n\n')[0];
const source = '**Source:** [1] Valve guide, [Valve guide](https://example.com/guide).';

function present(answer: string, options: { prompt?: string; singleSource?: boolean } = {}): string {
  return formatGamingGuidePresentation({
    answer, prompt: options.prompt ?? 'How do I get started with the floodgate? Give the first concrete steps.',
    game: 'Test Game', singleSource: options.singleSource ?? true, leadingQualifications: [warning]
  });
}

describe('Gaming guide delivery formatting', () => {
  it('numbers the exact isolated colonisation answer and preserves all remaining text', () => {
    const expected = [
      warning,
      'To start system colonisation in **Elite Dangerous**:',
      '1. Use the **System Colonisation Contact** at a starport to select an unpopulated system within 15 light-years.\n2. Choose your initial starport or outpost.\n3. Pay the registration fee.',
      'Your claim lasts 24 hours and is launched through the **System Colonisation Suite** in your ship, making you the System Architect and starting a countdown to the arrival of a System Colonisation Ship that acts as a temporary construction hub. The supplied excerpts cover registration and launch, not the full construction process or every prerequisite. [1]',
      '**Source:** [Frontier Developments, System Colonisation Guide](https://www.elitedangerous.com/news/system-colonisation-guide) [1]',
      "I can't verify live game state here."
    ].join('\n\n');
    const options = { prompt: colonisationRequest };
    expect(present(isolatedColonisationAnswer, options)).toBe(expected);
    expect(present(expected, options)).toBe(expected);
  });

  it('numbers another clearly ordered procedure and preserves its scope and citations', () => {
    const answer = 'To start the floodgate, open the **Valve Log**, select the spare slot, and then turn the handle twice. The upper gate opens. [1]';
    const presented = present(warning + '\n\n' + answer + '\n\n' + source);
    expect(presented).toBe([warning, 'To start the floodgate:',
      '1. Open the **Valve Log**.\n2. Select the spare slot.\n3. Turn the handle twice.',
      'The upper gate opens. [1]', source].join('\n\n'));
    expect(present(presented)).toBe(presented);
  });

  it('keeps a citation that followed the sequence attached to the last step', () => {
    const answer = 'To start the floodgate, open the valve, and then enter the tunnel. [1] The upper gate opens. [2]';
    expect(present(answer)).toBe('To start the floodgate:\n\n1. Open the valve.\n2. Enter the tunnel. [1]\n\nThe upper gate opens. [2]');
  });

  it.each([
    ['comma inside a UI name', 'To start the floodgate, open the **Trial, Turn the Tide** journal entry, and then select any slot. [1]'],
    ['comma inside a double-quoted UI name', 'To start the floodgate, open the "Trial, Turn the Tide" journal entry, and then select any slot. [1]'],
    ['comma inside a curly-quoted UI name', 'To start the floodgate, open the “Trial, Turn the Tide” journal entry, and then select any slot. [1]'],
    ['comma inside a single-quoted UI name', "To start the floodgate, open the 'Trial, Turn the Tide' journal entry, and then select any slot. [1]"],
    ['comma inside a curly single-quoted UI name', 'To start the floodgate, open the ‘Trial, Turn the Tide’ journal entry, and then select any slot. [1]'],
    ['condition with a comma', 'To start the floodgate, open the valve if the light is green, and then enter the tunnel. [1]'],
    ['an alternative action', 'To start the floodgate, open the valve or use the bypass, and then enter the tunnel. [1]'],
    ['citation inside an action', 'To start the floodgate, open the valve [1], and then enter the tunnel. [2]'],
    ['a linked citation after the procedure', 'To start the floodgate, open the valve, and then enter the tunnel. [1](https://example.com/guide)'],
    ['a quoted example', '> To start the floodgate, open the valve, and then enter the tunnel. [1]'],
    ['an existing list', 'To start the floodgate:\n\n1. Open the valve.\n2. Enter the tunnel. [1]'],
    ['two actions without an ordering cue', 'To start the floodgate, open the valve, and enter the tunnel. [1]'],
    ['a nonterminal coordinating conjunction', 'To start the floodgate, open the valve, and enter the tunnel, turn the handle. [1]'],
    ['a descriptive clause in an action list', 'To start the floodgate, open the valve, the light turns blue, and enter the tunnel. [1]'],
    ['a quoted action-like comma in an action list', 'To start the floodgate, open the “Trial, Turn the Tide” journal entry, select a slot, and enter the tunnel. [1]']
  ])('keeps the original text with %s', (_label, answer) => {
    expect(present(answer)).toBe(answer);
  });

  it.each([
    'Where is the valve?',
    'How do I get started with the floodgate? Answer in prose.',
    'Give the first concrete steps as a single paragraph, no bullets.',
    'Walk me through starting the floodgate. Do not use numbered lists.',
    'Walk me through starting the floodgate, without a numbered list.',
    'Walk me through starting the floodgate. No numbered steps.',
    'Walk me through starting the floodgate. Don’t use numbered bullets.'
  ])('keeps prose when the request does not call for numbered instructions (%s)', prompt => {
    const answer = 'To start the floodgate, open the valve, and then enter the tunnel. [1]';
    expect(present(answer, { prompt })).toBe(answer);
  });

  it('collapses an identical source gap while retaining distinct gaps and the citation', () => {
    const answer = [
      'To start the floodgate, open the valve, and then enter the tunnel. The supplied excerpts cover the gate, but do not establish exact prices or the later procedure. [1]',
      source,
      'Exact prices, additional materials, and later deadlines are not established here.'
    ].join('\n\n');
    expect(present(answer)).toContain('The supplied excerpts cover the gate, but do not establish exact prices, the later procedure, additional materials, or later deadlines. [1]');
  });

  it('does not merge qualifications where the evidence source differs', () => {
    const [notice, guide, citation, limit, live] = installedColonisationAnswer.split('\n\n');
    const answer = present(installedColonisationAnswer, { prompt: colonisationRequest, singleSource: false });
    expect(answer).toContain(notice + '\n\n');
    expect(answer).toContain(guide.slice(guide.indexOf('The supplied excerpts')));
    expect(answer).toContain([citation, limit, live].join('\n\n'));
  });

  it('preserves composite gap phrases rather than extracting new claims from them', () => {
    const guide = 'To start the floodgate, open the valve, and then enter the tunnel. The supplied excerpts cover the gate, but do not establish the requirements for a station or outpost. [1]';
    const limit = 'Exact prices, additional materials, and later deadlines are not established here.';
    const answer = present([guide, source, limit].join('\n\n'));
    expect(answer).toContain('the requirements for a station or outpost. [1]');
    expect(answer).toContain(limit);
  });

  it('retains commas inside a quantity', () => {
    const guide = 'To start the floodgate, open the valve, and then enter the tunnel. The supplied excerpts cover the gate, but do not establish every prerequisite or the later procedure. [1]';
    const limit = 'Exact prices above 20,000 credits, additional materials, and later deadlines are not established here.';
    expect(present([guide, source, limit].join('\n\n'))).toContain('exact prices above 20,000 credits');
  });
});
