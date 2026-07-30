import { createHash, timingSafeEqual } from 'node:crypto';

function digestOpaqueSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf16le').digest();
}

/**
 * Build a stable, purpose-namespaced actor identifier after a route has
 * authenticated an opaque credential. The credential itself is never retained.
 */
export function buildAuthenticatedCredentialActorKey(
  namespace: string,
  credential: string
): string {
  const normalizedNamespace = namespace.trim().toLowerCase();
  if (!normalizedNamespace || !credential) {
    throw new Error('Authenticated credential actor keys require a namespace and credential.');
  }

  return `${normalizedNamespace}:${createHash('sha256').update(credential).digest('hex')}`;
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
