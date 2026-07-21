import { createHash, timingSafeEqual } from 'node:crypto';

function digestOpaqueSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf16le').digest();
}

/**
 * Compare already-extracted opaque credential values without applying
 * protocol-specific parsing or normalization.
 *
 * Missing, empty, or non-string values fail closed. Callers retain ownership
 * of trimming, header parsing, precedence, and boundary-specific size limits.
 */
export function timingSafeEqualOpaqueSecret(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (
    typeof provided !== 'string'
    || typeof expected !== 'string'
    || provided.length === 0
    || expected.length === 0
  ) {
    return false;
  }

  return timingSafeEqual(
    digestOpaqueSecret(provided),
    digestOpaqueSecret(expected),
  );
}
