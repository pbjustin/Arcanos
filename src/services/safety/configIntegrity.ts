import { createHash } from 'crypto';
import { z } from 'zod';
import { getEnv } from '@platform/runtime/env.js';
import { config } from '@platform/runtime/config.js';
import {
  activateUnsafeCondition,
  getTrustedHash,
  registerQuarantine,
  setTrustedHash
} from './runtimeState.js';
import { emitSafetyAuditEvent } from './auditEvents.js';
import {
  INTEGRITY_MANIFEST,
  type ProtectedConfigId,
  type ProtectedConfigManifestEntry
} from '@platform/runtime/integrityManifest.js';

export class IntegrityValidationError extends Error {
  constructor(
    message: string,
    readonly protectedId: ProtectedConfigId,
    readonly quarantineId: string
  ) {
    super(message);
    this.name = 'IntegrityValidationError';
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeIntegrityHash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function ensureSchema(
  schema: z.ZodType<unknown> | ((value: unknown) => boolean),
  payload: unknown
): void {
  //audit Assumption: protected config schema validation is required before hash acceptance; failure risk: semantically invalid config passing hash check; expected invariant: schema-valid payload only; handling strategy: fail-fast on schema mismatch.
  if (typeof schema === 'function') {
    if (!schema(payload)) {
      throw new Error('Schema validation callback returned false.');
    }
    return;
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(
      `Schema validation failed: ${result.error.issues.map(issue => issue.message).join('; ')}`
    );
  }
}

function resolveExpectedHash(entry: ProtectedConfigManifestEntry): string | undefined {
  const envHash = getEnv(entry.expectedHashEnv)?.trim();
  if (envHash) {
    return envHash;
  }

  const builtInHash = entry.builtInExpectedHash?.trim();
  if (builtInHash) {
    return builtInHash;
  }

  const trustedHash = getTrustedHash(entry.id);
  if (trustedHash) {
    return trustedHash;
  }

  return undefined;
}

function quarantineIntegrityFailure(
  protectedId: ProtectedConfigId,
  source: string,
  reason: string,
  expectedHash?: string,
  actualHash?: string
): never {
  const quarantine = registerQuarantine({
    kind: 'integrity',
    reason: `${protectedId} integrity validation failed`,
    integrityFailure: true,
    autoRecoverable: false,
    dedupeKey: `integrity:${protectedId}`,
    metadata: {
      protectedId,
      source,
      reason,
      expectedHash,
      actualHash
    }
  });

  activateUnsafeCondition({
    code: 'PATTERN_INTEGRITY_FAILURE',
    message: `${protectedId} integrity validation failed`,
    quarantineId: quarantine.quarantineId,
    metadata: {
      protectedId,
      source,
      reason
    }
  });

  emitSafetyAuditEvent({
    event: 'integrity_validation_failed',
    severity: 'error',
    details: {
      protectedId,
      source,
      reason,
      quarantineId: quarantine.quarantineId,
      expectedHash,
      actualHash
    }
  });

  throw new IntegrityValidationError(
    `${protectedId} integrity validation failed: ${reason}`,
    protectedId,
    quarantine.quarantineId
  );
}

/**
 * Purpose: Validate protected config/pattern payload by schema and hash.
 * Inputs/Outputs: Protected config ID, payload, and source metadata; returns computed hash.
 * Edge cases: Fail-closed mode blocks when baseline hash is unavailable.
 */
export function assertProtectedConfigIntegrity(
  protectedId: ProtectedConfigId,
  payload: unknown,
  options: {
    source: string;
    schemaOverride?: z.ZodType<unknown> | ((value: unknown) => boolean);
  }
): string {
  const entry = INTEGRITY_MANIFEST[protectedId];
  if (!entry) {
    throw new Error(`Unknown integrity protected id: ${protectedId}`);
  }

  try {
    ensureSchema(options.schemaOverride || entry.schema, payload);
  } catch (error) {
    return quarantineIntegrityFailure(
      protectedId,
      options.source,
      error instanceof Error ? error.message : String(error)
    );
  }

  const actualHash = computeIntegrityHash(payload);
  const expectedHash = resolveExpectedHash(entry);

  //audit Assumption: fail-closed mode requires pre-existing hash baseline unless trust-on-first-load is explicitly allowed; failure risk: accepting tampered initial payload; expected invariant: expected hash present or explicit trust bootstrap; handling strategy: quarantine when baseline missing in fail-closed mode.
  if (!expectedHash) {
    if (entry.allowTrustOnFirstLoad) {
      setTrustedHash(protectedId, actualHash);
      emitSafetyAuditEvent({
        event: 'integrity_baseline_established',
        severity: 'warn',
        details: {
          protectedId,
          source: options.source,
          hash: actualHash
        }
      });
      return actualHash;
    }

    if (config.safety.failClosedIntegrity) {
      return quarantineIntegrityFailure(
        protectedId,
        options.source,
        'Missing expected hash baseline in fail-closed mode'
      );
    }
  }

  if (expectedHash && actualHash !== expectedHash) {
    return quarantineIntegrityFailure(
      protectedId,
      options.source,
      'Hash mismatch',
      expectedHash,
      actualHash
    );
  }

  setTrustedHash(protectedId, actualHash);
  emitSafetyAuditEvent({
    event: 'integrity_validation_passed',
    severity: 'info',
    details: {
      protectedId,
      source: options.source,
      hash: actualHash
    }
  });
  return actualHash;
}

/**
 * Purpose: Validate integrity manifest hash baseline availability at startup.
 * Inputs/Outputs: No inputs; throws when fail-closed manifest requirements are unmet.
 * Edge cases: Entries with allowTrustOnFirstLoad are excluded from baseline requirement.
 */
export function verifyIntegrityManifestConfiguration(): void {
  const missingRequiredBaselines: string[] = [];

  for (const entry of Object.values(INTEGRITY_MANIFEST)) {
    if (entry.allowTrustOnFirstLoad) {
      continue;
    }

    const envHash = getEnv(entry.expectedHashEnv)?.trim();
    const builtInHash = entry.builtInExpectedHash?.trim();
    const trustedHash = getTrustedHash(entry.id);

    //audit Assumption: non-bootstrap entries must have deterministic baseline in fail-closed mode; failure risk: mutable trust boundary; expected invariant: env or built-in or trusted hash exists; handling strategy: collect and fail after scan.
    if (!envHash && !builtInHash && !trustedHash) {
      missingRequiredBaselines.push(entry.id);
    }
  }

  if (missingRequiredBaselines.length === 0) {
    return;
  }

  const message = `Missing integrity hash baselines: ${missingRequiredBaselines.join(', ')}`;
  emitSafetyAuditEvent({
    event: 'integrity_manifest_misconfigured',
    severity: 'error',
    details: {
      missingRequiredBaselines
    }
  });
  throw new Error(message);
}

