import { describe, expect, it } from '@jest/globals';
import { getProtectedDocumentByteBudgetFailure } from '../src/shared/protectedDocumentByteBudget.js';

describe('protected document aggregate byte budget', () => {
  it('admits a declared body exactly within the allowance left by earlier responses', () => {
    const facts = { declaredBytes: 40, transferredBytes: 80, decodedBytes: 80,
      maxTransferredBytes: 120, maxDecodedBytes: 256 };
    expect(getProtectedDocumentByteBudgetFailure('declared_length', facts)).toBeUndefined();
    expect(getProtectedDocumentByteBudgetFailure('declared_length', { ...facts, declaredBytes: 41 })).toEqual({
      code: 'TRANSFER_LIMIT',
      byteDiagnostics: { ...facts, declaredBytes: 41, limitStage: 'declared_length' }
    });
  });

  it('leaves absent content length to the actual byte meters', () => {
    expect(getProtectedDocumentByteBudgetFailure('declared_length', {
      transferredBytes: 0, decodedBytes: 0, maxTransferredBytes: 120, maxDecodedBytes: 256
    })).toBeUndefined();
  });

  it('admits the exact transferred ceiling and rejects the next byte independently of decoded allowance', () => {
    const facts = { transferredBytes: 120, decodedBytes: 100, maxTransferredBytes: 120, maxDecodedBytes: 256 };
    expect(getProtectedDocumentByteBudgetFailure('transferred_bytes', facts)).toBeUndefined();
    expect(getProtectedDocumentByteBudgetFailure('transferred_bytes', { ...facts, transferredBytes: 121 })).toEqual({
      code: 'TRANSFER_LIMIT',
      byteDiagnostics: { ...facts, transferredBytes: 121, limitStage: 'transferred_bytes' }
    });
  });

  it('admits the exact decoded ceiling and rejects expansion while transfer bytes remain allowed', () => {
    const facts = { declaredBytes: 80, transferredBytes: 80, decodedBytes: 256,
      maxTransferredBytes: 120, maxDecodedBytes: 256 };
    expect(getProtectedDocumentByteBudgetFailure('decoded_bytes', facts)).toBeUndefined();
    expect(getProtectedDocumentByteBudgetFailure('decoded_bytes', { ...facts, decodedBytes: 257 })).toEqual({
      code: 'DECODED_LIMIT',
      byteDiagnostics: { ...facts, decodedBytes: 257, limitStage: 'decoded_bytes' }
    });
  });

  it('snapshots only numeric byte facts without retaining headers, body or later counter changes', () => {
    const facts = { declaredBytes: 121, transferredBytes: 0, decodedBytes: 0,
      maxTransferredBytes: 120, maxDecodedBytes: 256,
      headers: { authorization: 'dummy-test-secret' }, body: 'untrusted source content' };
    const failure = getProtectedDocumentByteBudgetFailure('declared_length', facts);
    facts.declaredBytes = 0;
    facts.transferredBytes = 120;
    expect(failure).toEqual({
      code: 'TRANSFER_LIMIT',
      byteDiagnostics: { limitStage: 'declared_length', declaredBytes: 121,
        transferredBytes: 0, decodedBytes: 0, maxTransferredBytes: 120, maxDecodedBytes: 256 }
    });
  });
});
