import { describe, expect, it } from '@jest/globals';

import {
  extractExplicitGamingVersions,
  textContainsExactGamingVersion,
} from '../src/services/gamingVersion.js';

describe('Gaming semantic version parsing', () => {
  it.each([
    ['Palworld 1.0', ['1.0']],
    ['Palworld version 1.0', ['1.0']],
    ['Palworld (1.0)', ['1.0']],
    ['Palworld v1.0', ['1.0']],
    ['Palworld 1.0.1', ['1.0.1']],
    ['What changed in patch 1.0?', ['1.0']],
    ['This applies to version 1.0.', ['1.0']],
    ['Use version "1.0" for this guide.', ['1.0']],
    ['Compare versions 0.9 and 1.0.', ['0.9', '1.0']],
    ['Compare Palworld 0.9 and 1.0.', ['0.9', '1.0']],
    ['Compare Palworld 0.9 with Palworld 1.0.', ['0.9', '1.0']],
    ['Compare versions 1.0 and 2.0 kilograms.', ['1.0']],
    ['Compare Palworld 1.0 and 3.5 minutes of setup.', ['1.0']],
  ])('extracts explicit versions without trailing prose: %s', (prompt, expected) => {
    expect(extractExplicitGamingVersions({ prompt, game: 'Palworld' })).toEqual(expected);
  });

  it.each([
    'Finish the run in 3.5 minutes.',
    'What changed in 3.5 minutes?',
    'What changed in 2.0 kilograms?',
    'What changed in 1.5 hours?',
    'What changed in 99.9 percent?',
    'Palworld 2.0 kilograms is the download estimate.',
    'Palworld 1.5 hours is the expected duration.',
    'Use Palworld 1920.1080 resolution.',
    'Connect to 192.168.1.1 for Palworld matchmaking.',
    'Palworld costs $1.99 during the sale.',
    'Palworld 1.25 K/D is the displayed statistic.',
    'Palworld 2.0 items are required.',
    'Palworld was released on 7.11.26.',
  ])('rejects non-version numeric text: %s', (prompt) => {
    expect(extractExplicitGamingVersions({ prompt, game: 'Palworld' })).toEqual([]);
  });

  it('matches exact versions without accepting a longer patch', () => {
    expect(textContainsExactGamingVersion('This guide applies to version 1.0.', '1.0')).toBe(true);
    expect(textContainsExactGamingVersion('This guide applies to version 1.0.1.', '1.0')).toBe(false);
  });
});
