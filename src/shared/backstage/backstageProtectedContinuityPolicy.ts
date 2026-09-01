export type BackstageDurableContinuityFailureResolution<T> =
  | {
      state: 'unavailable';
      reason: 'legacy_read_quarantined' | 'protected_generation';
    }
  | { state: 'process_fallback'; value: T };

/**
 * Apply the durable-continuity failure policy through an injected fallback
 * reader without accessing ambient state directly. Protected generation and
 * quarantined legacy reads fail closed; only the established unprotected
 * compatibility lane may materialize process state.
 */
export function resolveBackstageDurableContinuityFailure<T>(input: {
  protectedGenerationExecution: boolean;
  legacyReadQuarantined: boolean;
  readProcessFallback: () => T;
}): BackstageDurableContinuityFailureResolution<T> {
  if (input.legacyReadQuarantined) {
    return { state: 'unavailable', reason: 'legacy_read_quarantined' };
  }
  if (input.protectedGenerationExecution) {
    return { state: 'unavailable', reason: 'protected_generation' };
  }

  return {
    state: 'process_fallback',
    value: input.readProcessFallback(),
  };
}
