import { describe, expect, it } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import { assessGamingClearSourceIdentity } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy } from '../src/shared/gaming/gamingFreshnessCore.js';

const url = 'https://guides.example.org/universal-performance';
const prompt = 'Explain early Arcanist wand attacks and stamina recovery.';
const filler = 'Observe an attack cue, preserve resources for recovery, and practice one careful action. ';
const warmups = 3;
const repetitions = 5;

describe('bounded universal identity scan performance with synthetic source text', () => {
  it('measures known and unknown full-source decisions before checking correctness and ceilings', () => {
    const cases = [];
    for (const [kind, game, title] of [
      ['unknown-game', 'Copper Harbor', 'Resonant Icewarden'],
      ['known-game', 'Elden Ring', 'Elden Ring Arcanist guide']
    ]) {
      const opening = `${title}. In the game ${game}, the early Arcanist uses the starting wand and conserves stamina. `;
      for (const size of [32_000, 128_000, 512_000]) for (const foreign of [false, true]) {
        cases.push({ kind, game, title, size, lateForeignScope: foreign,
          text: opening + filler.repeat(Math.ceil(size / filler.length))
            + (foreign ? ' In the game Orbit Orchard, use the starting wand.' : ' Continue practicing the starting wand.'),
          expectedStatus: foreign ? 'conflict' : 'verified' });
      }
    }
    const opening = 'Resonant Icewarden. In the game Copper Harbor, the early Arcanist uses the starting wand. ';
    cases.push({ kind: 'document-over-limit', game: 'Copper Harbor', title: 'Resonant Icewarden', size: 1_000_001,
      lateForeignScope: false, text: opening + filler.repeat(Math.ceil(1_000_001 / filler.length)), expectedStatus: 'unknown' });
    cases.push({ kind: 'assertion-over-limit', game: 'Copper Harbor', title: 'Resonant Icewarden', size: 1_025,
      lateForeignScope: false, text: opening + 'In the game Copper Harbor, use the wand. '.repeat(1_025), expectedStatus: 'unknown' });
    const observations = cases.map(fixture => {
      const input = { game: fixture.game, mode: 'build' as const, prompt };
      const policy = assessGamingSourcePolicy(url, fixture.game);
      const document = { publicUrl: url, text: fixture.text,
        metadata: { title: fixture.title, headings: fixture.title } };
      for (let run = 0; run < warmups; run += 1) assessGamingClearSourceIdentity(document, input, policy);
      const samplesMs = [];
      const statuses = [];
      const reasons = [];
      for (let run = 0; run < repetitions; run += 1) {
        const started = performance.now();
        const identity = assessGamingClearSourceIdentity(document, input, policy);
        samplesMs.push(performance.now() - started);
        statuses.push(identity.status);
        reasons.push(identity.reasonCodes.join(','));
      }
      const sorted = [...samplesMs].sort((left, right) => left - right);
      return { kind: fixture.kind, game: fixture.game, chars: fixture.text.length,
        lateForeignScope: fixture.lateForeignScope, expectedStatus: fixture.expectedStatus,
        statuses: [...new Set(statuses)], reasons: [...new Set(reasons)],
        minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), samplesMs };
    });
    // Print all measurements before assertions, so an unchanged baseline can
    // report timing without pretending it accepts newly supported identities.
    console.info('GAMING_UNIVERSAL_PERFORMANCE_REPORT', JSON.stringify({ syntheticOnly: true,
      includesAcquisition: false, includesProvider: false, warmups, repetitions, observations }));
    for (const observation of observations) {
      expect(observation.statuses).toEqual([observation.expectedStatus]);
      if (observation.lateForeignScope) expect(observation.reasons).toEqual(['GAME_MISMATCH']);
      // A generous hang guard allows shared CI load. Measured baseline/final
      // medians are reported separately and do not change production budgets.
      expect(observation.maxMs).toBeLessThan(5_000);
    }
  }, 60_000);
});
