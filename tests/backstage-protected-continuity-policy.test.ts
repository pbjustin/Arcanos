import {
  resolveBackstageDurableContinuityFailure,
} from '../src/shared/backstage/backstageProtectedContinuityPolicy.js';

describe('protected Backstage durable continuity failure policy', () => {
  it('forbids process fallback after a protected durable read failure', () => {
    let processFallbackReads = 0;
    const readProcessFallback = () => {
      processFallbackReads += 1;
      return { source: 'process' };
    };

    const resolution = resolveBackstageDurableContinuityFailure({
      protectedGenerationExecution: true,
      legacyReadQuarantined: false,
      readProcessFallback,
    });

    expect(resolution).toEqual({
      state: 'unavailable',
      reason: 'protected_generation',
    });
    expect(processFallbackReads).toBe(0);
  });

  it('preserves process fallback for the unprotected compatibility lane', () => {
    const fallback = { source: 'process' } as const;
    let processFallbackReads = 0;
    const readProcessFallback = () => {
      processFallbackReads += 1;
      return fallback;
    };

    const resolution = resolveBackstageDurableContinuityFailure({
      protectedGenerationExecution: false,
      legacyReadQuarantined: false,
      readProcessFallback,
    });

    expect(resolution).toEqual({
      state: 'process_fallback',
      value: fallback,
    });
    expect(processFallbackReads).toBe(1);
  });

  it('keeps quarantined legacy reads fail closed outside protected execution', () => {
    let processFallbackReads = 0;
    const readProcessFallback = () => {
      processFallbackReads += 1;
      return { source: 'process' };
    };

    const resolution = resolveBackstageDurableContinuityFailure({
      protectedGenerationExecution: false,
      legacyReadQuarantined: true,
      readProcessFallback,
    });

    expect(resolution).toEqual({
      state: 'unavailable',
      reason: 'legacy_read_quarantined',
    });
    expect(processFallbackReads).toBe(0);
  });

  it('preserves quarantine precedence when protected execution is also active', () => {
    let processFallbackReads = 0;

    const resolution = resolveBackstageDurableContinuityFailure({
      protectedGenerationExecution: true,
      legacyReadQuarantined: true,
      readProcessFallback: () => {
        processFallbackReads += 1;
        return { source: 'process' };
      },
    });

    expect(resolution).toEqual({
      state: 'unavailable',
      reason: 'legacy_read_quarantined',
    });
    expect(processFallbackReads).toBe(0);
  });
});
