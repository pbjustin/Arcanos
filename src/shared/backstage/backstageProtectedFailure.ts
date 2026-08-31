export const BACKSTAGE_PROTECTED_FAILURE_CODES = [
  'BACKSTAGE_ASYNC_TIMEOUT',
  'BACKSTAGE_ASYNC_EXECUTION_FAILED',
  'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
  'BACKSTAGE_BOOKER_INTEGRITY_FAILED',
  'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
  'BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE',
  'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
] as const;

export type BackstageProtectedFailureCode =
  (typeof BACKSTAGE_PROTECTED_FAILURE_CODES)[number];

export interface ProtectedBackstageGenerationProvenance {
  version: 1;
  protected: true;
  protectedGenerationCompleted: true;
  official: true;
  continuityVerified: true;
  authority: 'notion' | 'legacy_postgresql';
  snapshotStatus: 'current_complete' | 'not_applicable';
  fallbackUsed: false;
  fallbackPermitted: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function resolveBackstageProtectedFailureCode(
  candidate: unknown,
  fallback: BackstageProtectedFailureCode = 'BACKSTAGE_ASYNC_EXECUTION_FAILED'
): BackstageProtectedFailureCode {
  return typeof candidate === 'string'
    && (BACKSTAGE_PROTECTED_FAILURE_CODES as readonly string[]).includes(candidate)
    ? candidate as BackstageProtectedFailureCode
    : fallback;
}

/** Never retain provider text, partial output, or a stack in a protected terminal failure. */
export function buildProtectedBackstageFailureEnvelope(input: {
  gptId: string;
  action: 'generateBooking' | 'generateBookingWithHRC';
  code: BackstageProtectedFailureCode;
}): Record<string, unknown> {
  return {
    ok: false,
    error: { code: input.code },
    _route: {
      gptId: input.gptId,
      action: input.action,
      route: 'worker',
    },
  };
}

/** Validate the closed provenance object before a protected completion is sealed. */
export function readProtectedBackstageGenerationProvenance(
  value: unknown
): ProtectedBackstageGenerationProvenance | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'version',
      'protected',
      'protectedGenerationCompleted',
      'official',
      'continuityVerified',
      'authority',
      'snapshotStatus',
      'fallbackUsed',
      'fallbackPermitted',
    ])
    || value.version !== 1
    || value.protected !== true
    || value.protectedGenerationCompleted !== true
    || value.official !== true
    || value.continuityVerified !== true
    || value.fallbackUsed !== false
    || value.fallbackPermitted !== false
  ) {
    return null;
  }
  if (
    value.authority === 'notion'
    && value.snapshotStatus === 'current_complete'
  ) {
    return value as unknown as ProtectedBackstageGenerationProvenance;
  }
  if (
    value.authority === 'legacy_postgresql'
    && value.snapshotStatus === 'not_applicable'
  ) {
    return value as unknown as ProtectedBackstageGenerationProvenance;
  }
  return null;
}

/** Validate a worker-created terminal failure after authenticated unsealing. */
export function readProtectedBackstageFailureCode(
  value: unknown,
  expected: {
    gptId: 'backstage-booker';
    action: 'generateBooking' | 'generateBookingWithHRC';
  }
): BackstageProtectedFailureCode | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['ok', 'error', '_route'])
    || value.ok !== false
    || !isRecord(value.error)
    || !hasExactKeys(value.error, ['code'])
    || !isRecord(value._route)
    || !hasExactKeys(value._route, ['gptId', 'action', 'route'])
    || value._route.gptId !== expected.gptId
    || value._route.action !== expected.action
    || value._route.route !== 'worker'
  ) {
    return null;
  }
  return typeof value.error.code === 'string'
    && (BACKSTAGE_PROTECTED_FAILURE_CODES as readonly string[])
      .includes(value.error.code)
    ? value.error.code as BackstageProtectedFailureCode
    : null;
}

/** Extract only validated server-owned completion provenance from a GPT envelope. */
export function readProtectedBackstageCompletionProvenance(
  value: unknown,
  expected?: {
    gptId: 'backstage-booker';
    action: 'generateBooking' | 'generateBookingWithHRC';
  }
): ProtectedBackstageGenerationProvenance | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) {
    return null;
  }
  if (expected) {
    if (
      !isRecord(value._route)
      || value._route.gptId !== expected.gptId
      || value._route.action !== expected.action
    ) {
      return null;
    }
  }
  return readProtectedBackstageGenerationProvenance(value.result.protectedGeneration);
}

/** Keep persisted protected error text itself non-sensitive and bounded. */
export function buildProtectedBackstageFailureMessage(
  code: BackstageProtectedFailureCode
): string {
  return `${code}: Protected Backstage generation failed.`;
}
