import { createHash } from 'crypto';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  assertProtectedConfigIntegrity,
  IntegrityValidationError
} from '../src/services/safety/configIntegrity.js';
import {
  getActiveQuarantines,
  hasUnsafeBlockingConditions,
  releaseQuarantine,
  resetSafetyRuntimeStateForTests
} from '../src/services/safety/runtimeState.js';

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeHash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

describe('config integrity safety', () => {
  const expectedHashEnvName = 'SAFETY_EXPECTED_HASH_PROTECTED_JSON';
  const originalExpectedHash = process.env[expectedHashEnvName];

  beforeEach(() => {
    resetSafetyRuntimeStateForTests();
    delete process.env[expectedHashEnvName];
  });

  afterAll(() => {
    resetSafetyRuntimeStateForTests();
    if (originalExpectedHash === undefined) {
      delete process.env[expectedHashEnvName];
    } else {
      process.env[expectedHashEnvName] = originalExpectedHash;
    }
  });

  it('accepts payload when schema and expected hash are valid', () => {
    const payload = { mode: 'strict', priority: 10 };
    const schema = z.object({
      mode: z.string().min(1),
      priority: z.number().int().min(0)
    });
    process.env[expectedHashEnvName] = computeHash(payload);

    const computedHash = assertProtectedConfigIntegrity('protected_json_file', payload, {
      source: 'tests/config-integrity.valid',
      schemaOverride: schema
    });

    expect(computedHash).toBe(process.env[expectedHashEnvName]);
    expect(getActiveQuarantines('integrity')).toHaveLength(0);
  });

  it('quarantines and rejects payload on hash mismatch', () => {
    const payload = { mode: 'strict', priority: 10 };
    process.env[expectedHashEnvName] = '0'.repeat(64);

    expect(() =>
      assertProtectedConfigIntegrity('protected_json_file', payload, {
        source: 'tests/config-integrity.hash-mismatch',
        schemaOverride: z.object({
          mode: z.string(),
          priority: z.number()
        })
      })
    ).toThrow(IntegrityValidationError);

    expect(getActiveQuarantines('integrity').length).toBeGreaterThan(0);
    expect(hasUnsafeBlockingConditions()).toBe(true);
  });

  it('quarantines and rejects payload on schema mismatch', () => {
    const payload = { mode: 'strict', priority: 'not-a-number' };
    process.env[expectedHashEnvName] = computeHash(payload);

    expect(() =>
      assertProtectedConfigIntegrity('protected_json_file', payload, {
        source: 'tests/config-integrity.schema-mismatch',
        schemaOverride: z.object({
          mode: z.string(),
          priority: z.number().int()
        })
      })
    ).toThrow(IntegrityValidationError);

    const activeIntegrityQuarantines = getActiveQuarantines('integrity');
    expect(activeIntegrityQuarantines.length).toBeGreaterThan(0);
  });

  it('keeps integrity quarantine active until explicit operator-style release', () => {
    const payload = { mode: 'strict', priority: 10 };
    process.env[expectedHashEnvName] = 'f'.repeat(64);

    expect(() =>
      assertProtectedConfigIntegrity('protected_json_file', payload, {
        source: 'tests/config-integrity.release-required',
        schemaOverride: z.object({
          mode: z.string(),
          priority: z.number()
        })
      })
    ).toThrow(IntegrityValidationError);

    const quarantine = getActiveQuarantines('integrity')[0];
    expect(quarantine).toBeDefined();
    expect(hasUnsafeBlockingConditions()).toBe(true);

    const releaseResult = releaseQuarantine(quarantine.quarantineId, {
      actor: 'operator:test',
      releaseNote: 'manual-release-for-test',
      integrityOnly: true
    });

    expect(releaseResult.released).toBe(true);
    expect(getActiveQuarantines('integrity')).toHaveLength(0);
    expect(hasUnsafeBlockingConditions()).toBe(false);
  });
});
