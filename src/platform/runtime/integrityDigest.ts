import { createHash } from 'node:crypto';
import type { z } from 'zod';

export const CANONICAL_INTEGRITY_DIGEST_VERSION = 'arcanos-semantic-json-v1';

export class IntegrityPayloadSchemaError extends Error {
  constructor(readonly issueCount: number, issueMessages: string[]) {
    super(`Schema validation failed: ${issueMessages.join('; ')}`);
    this.name = 'IntegrityPayloadSchemaError';
  }
}

/**
 * Serialize one protected configuration payload using the established runtime
 * contract. Object keys are locale-sorted while array order remains semantic.
 *
 * This representation is pin-compatible behavior. A future canonicalization
 * change requires a new version and a coordinated digest migration.
 */
export function stableSerializeIntegrityPayload(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerializeIntegrityPayload(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableSerializeIntegrityPayload(entryValue)}`
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

/** Compute the canonical semantic SHA-256 used by protected configuration pins. */
export function computeIntegrityHash(value: unknown): string {
  return createHash('sha256')
    .update(stableSerializeIntegrityPayload(value), 'utf8')
    .digest('hex');
}

/** Validate without returning Zod's parsed/stripped value; callers hash the original payload. */
export function assertIntegrityPayloadSchema(
  schema: z.ZodType<unknown>,
  payload: unknown
): void {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new IntegrityPayloadSchemaError(
      result.error.issues.length,
      result.error.issues.map(issue => issue.message)
    );
  }
}
