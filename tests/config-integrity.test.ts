import { readFileSync } from 'fs';
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  assertProtectedConfigIntegrity,
  IntegrityValidationError,
  prepareAssistantRegistryIntegrityUpdate
} from '../src/services/safety/configIntegrity.js';
import {
  getActiveQuarantines,
  getTrustedHash,
  hasUnsafeBlockingConditions,
  releaseQuarantine,
  resetSafetyRuntimeStateForTests
} from '../src/services/safety/runtimeState.js';
import {
  getTelemetrySnapshot,
  resetTelemetry
} from '../src/platform/logging/telemetry.js';
import { computeIntegrityHash } from '../src/platform/runtime/integrityDigest.js';

describe('config integrity safety', () => {
  const expectedHashEnvName = 'SAFETY_EXPECTED_HASH_PROTECTED_JSON';
  const assistantRegistryHashEnvName =
    'SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY';
  const originalExpectedHash = process.env[expectedHashEnvName];
  const originalAssistantRegistryHash =
    process.env[assistantRegistryHashEnvName];

  beforeEach(() => {
    resetSafetyRuntimeStateForTests();
    resetTelemetry();
    delete process.env[expectedHashEnvName];
    delete process.env[assistantRegistryHashEnvName];
  });

  afterAll(() => {
    resetSafetyRuntimeStateForTests();
    resetTelemetry();
    if (originalExpectedHash === undefined) {
      delete process.env[expectedHashEnvName];
    } else {
      process.env[expectedHashEnvName] = originalExpectedHash;
    }
    if (originalAssistantRegistryHash === undefined) {
      delete process.env[assistantRegistryHashEnvName];
    } else {
      process.env[assistantRegistryHashEnvName] =
        originalAssistantRegistryHash;
    }
  });

  it.each([
    '/app/config/protected.json',
    'C:\\runtime\\config\\protected.json',
    '\\\\runtime-host\\config\\protected.json',
    'file:///app/config/protected.json'
  ])('keeps absolute source %s out of integrity logs, traces, and quarantine metadata', absoluteSource => {
    const payload = { mode: 'strict', priority: 10 };
    process.env[expectedHashEnvName] = '0'.repeat(64);

    expect(() =>
      assertProtectedConfigIntegrity('protected_json_file', payload, {
        source: absoluteSource,
        schemaOverride: z.object({
          mode: z.string(),
          priority: z.number()
        })
      })
    ).toThrow(IntegrityValidationError);

    const quarantine = getActiveQuarantines('integrity')[0];
    expect(quarantine.metadata?.source).toBe('protected-config:protected_json_file');

    const observableState = JSON.stringify({
      quarantine,
      telemetry: getTelemetrySnapshot().traces
    });
    expect(observableState).not.toContain(absoluteSource);
    expect(observableState).toContain('protected-config:protected_json_file');
  });

  it('accepts payload when schema and expected hash are valid', () => {
    const payload = { mode: 'strict', priority: 10 };
    const schema = z.object({
      mode: z.string().min(1),
      priority: z.number().int().min(0)
    });
    process.env[expectedHashEnvName] = computeIntegrityHash(payload);

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
    process.env[expectedHashEnvName] = computeIntegrityHash(payload);

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

  it('rotates assistant-registry TOFU only after durable-install commit', () => {
    const registry = {
      ALPHA: {
        id: 'asst_alpha',
        name: 'Alpha',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'ALPHA'
      }
    };

    const prepared = prepareAssistantRegistryIntegrityUpdate(registry, {
      source: 'tests/config-integrity.assistant-registry-update'
    });

    expect(prepared.hash).toBe(computeIntegrityHash(registry));
    expect(getTrustedHash('assistant_registry')).toBeUndefined();

    prepared.commit();
    prepared.commit();

    expect(getTrustedHash('assistant_registry')).toBe(prepared.hash);
    const rotations = getTelemetrySnapshot().traces.recentEvents.filter(
      trace => trace.name === 'safety.integrity_baseline_rotated'
    );
    expect(rotations).toHaveLength(1);
  });

  it('accepts the tracked assistant registry semantic mapping', () => {
    const registry = JSON.parse(
      readFileSync('config/assistants.json', 'utf8')
    );

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'config/assistants.json'
      })
    ).not.toThrow();
    expect(Object.keys(registry)).toEqual([
      'CLI_HYBRID_CHATGPT_CODING_AGENT'
    ]);
  });

  it('rejects an assistant name that normalizes to an empty value', () => {
    const registry = {
      PUNCTUATION: {
        id: 'asst_punctuation',
        name: '!!!',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'PUNCTUATION'
      }
    };

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'tests/config-integrity.assistant-registry-empty-normalization'
      })
    ).toThrow(IntegrityValidationError);
  });

  it('rejects an assistant name whose NFKD normalization exceeds the length limit', () => {
    const registry = {
      EXPANDED_NAME: {
        id: 'asst_expanded_name',
        name: '\uFB03'.repeat(86),
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'EXPANDED_NAME'
      }
    };

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'tests/config-integrity.assistant-registry-expanded-name'
      })
    ).toThrow(IntegrityValidationError);
  });

  it('rejects an assistant registry key that differs from its normalized name', () => {
    const registry = {
      WRONG_KEY: {
        id: 'asst_alpha',
        name: 'Alpha',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'ALPHA'
      }
    };

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'tests/config-integrity.assistant-registry-key-mismatch'
      })
    ).toThrow(IntegrityValidationError);
  });

  it('rejects a normalized name that does not match the assistant name', () => {
    const registry = {
      ALPHA: {
        id: 'asst_alpha',
        name: 'Beta',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'ALPHA'
      }
    };

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'tests/config-integrity.assistant-registry-name-mismatch'
      })
    ).toThrow(IntegrityValidationError);
  });

  it('rejects duplicate assistant provider IDs', () => {
    const registry = {
      ALPHA: {
        id: 'asst_duplicate',
        name: 'Alpha',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'ALPHA'
      },
      BETA: {
        id: 'asst_duplicate',
        name: 'Beta',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'BETA'
      }
    };

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'tests/config-integrity.assistant-registry-duplicate-id'
      })
    ).toThrow(IntegrityValidationError);
  });

  it('rejects an assistant registry that exceeds the record limit', () => {
    const registry = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => {
        const normalizedName = `ASSISTANT_${index}`;
        return [
          normalizedName,
          {
            id: `asst_${index}`,
            name: `Assistant ${index}`,
            instructions: null,
            tools: null,
            model: 'gpt-4.1-mini',
            normalizedName
          }
        ];
      })
    );

    expect(() =>
      assertProtectedConfigIntegrity('assistant_registry', registry, {
        source: 'tests/config-integrity.assistant-registry-record-limit'
      })
    ).toThrow(IntegrityValidationError);
  });

  it('does not let assistant-registry updates bypass an explicit hash pin', () => {
    const registry = {
      ALPHA: {
        id: 'asst_alpha',
        name: 'Alpha',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'ALPHA'
      }
    };
    process.env[assistantRegistryHashEnvName] = '0'.repeat(64);

    expect(() =>
      prepareAssistantRegistryIntegrityUpdate(registry, {
        source: 'tests/config-integrity.assistant-registry-pinned'
      })
    ).toThrow(IntegrityValidationError);

    expect(getTrustedHash('assistant_registry')).toBeUndefined();
    expect(getActiveQuarantines('integrity')).toHaveLength(1);
  });
});
