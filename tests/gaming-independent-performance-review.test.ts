import { describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { readGamingAcquiredAliasDeclarations, resolveGamingAcquiredIdentity } from '../src/shared/gaming/gamingAcquiredIdentity.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';
import { resolveGamingRegistryGame } from '../src/shared/gaming/gamingGameRegistry.js';

const url = 'https://guides.example.org/independent-bounded-performance';
const topic = 'Resonance Matrix';
const game = 'Quicksilver Observatory';
const titlePrefix = 'Uncharted Observatory ';
const longestGame = titlePrefix + 'z'.repeat(120 - titlePrefix.length);
const gameplay = 'Observe the flux relay, preserve resonance for recovery, and practice one careful action. ';
const opening = (name: string) => `${topic}. In the game ${name}, ${gameplay}`;

function sizedDocument(name: string, size: number): string {
  const start = opening(name);
  return (start + gameplay.repeat(Math.ceil((size - start.length) / gameplay.length))).slice(0, size - 1) + '.';
}

function assess(text: string, requestedGame = game) {
  return assessGamingClearSourceIdentity({ publicUrl: url, text, metadata: { title: topic, headings: topic } },
    { game: requestedGame, mode: 'guide', prompt: 'Explain flux relay timing and resonance recovery.' },
    assessGamingSourcePolicy(url, requestedGame));
}

describe('independent adversarial identity bounds with synthetic acquired prose', () => {
  it('measures the longest unregistered request title and complete contradiction scan through the document ceiling', () => {
    expect(longestGame).toHaveLength(120);
    expect(resolveGamingRegistryGame(longestGame)).toBeUndefined();
    const observations = [];
    for (const chars of [32_000, 128_000, 512_000, 1_000_000]) {
      for (const conflict of [false, true]) {
        const tail = conflict ? ' In the game Quicksilver Observatory II, preserve resonance.' : '';
        const text = sizedDocument(longestGame, chars - tail.length) + tail;
        const samplesMs = [];
        const statuses = [];
        for (let run = 0; run < 4; run += 1) {
          const started = performance.now();
          const result = assess(text, longestGame);
          if (run > 0) samplesMs.push(performance.now() - started);
          statuses.push(result.status);
          expect(result.status).toBe(conflict ? 'conflict' : 'verified');
          if (conflict) expect(result.reasonCodes).toEqual(['GAME_MISMATCH']);
        }
        const sorted = [...samplesMs].sort((left, right) => left - right);
        observations.push({ chars, conflict, statuses: [...new Set(statuses)], medianMs: sorted[1], maxMs: sorted[2] });
        // Shared-runner noise may change timings; this only guards a pathological hang.
        expect(sorted[2]).toBeLessThan(5_000);
      }
    }
    console.info('GAMING_INDEPENDENT_PERFORMANCE_REPORT', JSON.stringify({ syntheticOnly: true,
      includesAcquisition: false, includesProvider: false, requestedTitleChars: longestGame.length, observations }));
  }, 60_000);

  it('rejects a document one character beyond the complete-inspection ceiling', () => {
    const result = assess(sizedDocument(longestGame, 1_000_001), longestGame);
    expect(result).toMatchObject({ status: 'unknown', gameIdentityVerified: false,
      diagnostic: { ruleId: 'gaming.identity.source_scope_scan_incomplete' } });
  });

  it('does not promote ordinary-word ambiguity across a long document, but accepts independent explicit game scope', () => {
    const ordinaryGame = 'Stillness';
    expect(resolveGamingRegistryGame(ordinaryGame)).toBeUndefined();
    const ambiguous = `${ordinaryGame}. Keep stillness while observing the flux relay. ` + gameplay.repeat(5_000);
    expect(assess(ambiguous, ordinaryGame).status).toBe('unknown');
    expect(assess(sizedDocument(ordinaryGame, 512_000), ordinaryGame).status).toBe('verified');
  });

  it('preserves the inclusive acquired assertion cap and refuses overflow', () => {
    const declaration = `In the game ${game}, observe the flux relay. `;
    const atLimit = `${topic}. ` + declaration.repeat(1_024);
    expect(assess(atLimit)).toMatchObject({ status: 'verified', gameIdentityVerified: true });
    const overflow = assess(atLimit + declaration);
    expect(overflow).toMatchObject({ status: 'unknown', gameIdentityVerified: false,
      diagnostic: { ruleId: 'gaming.identity.source_scope_scan_incomplete' } });
  });

  it('bounds source-local alias expansion and never accepts an uninspected 129th declaration', () => {
    const declarations = Array.from({ length: 129 }, (_, index) =>
      `The game ${game} is also known as Relay Alias ${index}. `);
    const atLimit = opening(game) + declarations.slice(0, 128).join('');
    const parsed = readGamingAcquiredAliasDeclarations(atLimit);
    expect(parsed.complete).toBe(true);
    expect(parsed.declarations).toHaveLength(128);
    expect(assess(atLimit).status).toBe('verified');
    const overflow = atLimit + declarations[128];
    const bounded = readGamingAcquiredAliasDeclarations(overflow);
    expect(bounded.complete).toBe(false);
    expect(bounded.declarations).toHaveLength(128);
    expect(assess(overflow)).toMatchObject({ status: 'unknown', gameIdentityVerified: false,
      diagnostic: { ruleId: 'gaming.identity.source_scope_scan_incomplete' } });
  });

  it('rejects request identity overflow rather than treating its common prefix as ownership', () => {
    expect(resolveGamingAcquiredIdentity({ sourceGame: longestGame, requestedGame: longestGame,
      explicitGameContext: true })).toBe('IDENTITY_VERIFIED');
    expect(resolveGamingAcquiredIdentity({ sourceGame: longestGame + 'q', requestedGame: longestGame + 'q',
      explicitGameContext: true })).toBe('IDENTITY_UNVERIFIED');
  });
});
