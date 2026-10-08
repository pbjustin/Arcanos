/** Internal policy only: callers cannot grant a larger allowance than the shared hard ceiling. */
export interface ProtectedDocumentFetchByteLimits {
  maxTransferredBytes: number;
  maxDecodedBytes: number;
}

export interface ProtectedDocumentByteBudgetSnapshot extends ProtectedDocumentFetchByteLimits {
  declaredBytes?: number;
  transferredBytes: number;
  decodedBytes: number;
}

/** Numeric acquisition facts only; no transport identity, headers or source content. */
export interface ProtectedDocumentFetchByteDiagnostics extends ProtectedDocumentByteBudgetSnapshot {
  limitStage: 'declared_length' | 'transferred_bytes' | 'decoded_bytes';
}

export interface ProtectedDocumentByteBudgetFailure {
  code: 'TRANSFER_LIMIT' | 'DECODED_LIMIT';
  byteDiagnostics: ProtectedDocumentFetchByteDiagnostics;
}

/**
 * The protected transport supplies validated counts and normalized, finite limits.
 * Each stage checks its own aggregate allowance, before admitting a complete body.
 */
export function getProtectedDocumentByteBudgetFailure(
  stage: ProtectedDocumentFetchByteDiagnostics['limitStage'],
  facts: Readonly<ProtectedDocumentByteBudgetSnapshot>
): ProtectedDocumentByteBudgetFailure | undefined {
  const exceeded = stage === 'declared_length'
    ? facts.declaredBytes !== undefined && facts.declaredBytes > facts.maxTransferredBytes - facts.transferredBytes
    : stage === 'transferred_bytes'
      ? facts.transferredBytes > facts.maxTransferredBytes
      : facts.decodedBytes > facts.maxDecodedBytes;
  if (!exceeded) return undefined;
  return {
    code: stage === 'decoded_bytes' ? 'DECODED_LIMIT' : 'TRANSFER_LIMIT',
    byteDiagnostics: {
      limitStage: stage,
      ...(facts.declaredBytes === undefined ? {} : { declaredBytes: facts.declaredBytes }),
      transferredBytes: facts.transferredBytes,
      decodedBytes: facts.decodedBytes,
      maxTransferredBytes: facts.maxTransferredBytes,
      maxDecodedBytes: facts.maxDecodedBytes
    }
  };
}
