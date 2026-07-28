import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  loadGptModuleMap,
  resetGptModuleMapCache,
  validateGptRegistry
} from '../src/platform/runtime/gptRouterConfig.js';

const CURRENT_GPT_ROUTER_HASH = 'e02a4e9739fe4772aac59afe24a99f45348090434c90d7acb560d28c14bd4e2a';
const ROUTING_OVERRIDE_KEYS = [
  'GPT_MODULE_MAP',
  'GPTID_ARCANOS_GAMING',
  'GPTID_ARCANOS_TUTOR',
  'GPTID_BACKSTAGE_BOOKER'
] as const;

describe('runtime GPT router wiring', () => {
  const originalGptRouterHash = process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;
  const originalRoutingOverrides = Object.fromEntries(
    ROUTING_OVERRIDE_KEYS.map((key) => [key, process.env[key]])
  ) as Record<(typeof ROUTING_OVERRIDE_KEYS)[number], string | undefined>;

  beforeEach(() => {
    resetGptModuleMapCache();
    for (const key of ROUTING_OVERRIDE_KEYS) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    resetGptModuleMapCache();
    for (const key of ROUTING_OVERRIDE_KEYS) {
      const originalValue = originalRoutingOverrides[key];
      if (originalValue === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = originalValue;
      }
    }
    if (originalGptRouterHash === undefined) {
      Reflect.deleteProperty(process.env, 'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG');
    } else {
      process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = originalGptRouterHash;
    }
  });

  it('registers the built-in GPT IDs from loaded module definitions', async () => {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
    resetGptModuleMapCache();

    const map = await loadGptModuleMap();

    expect(map['arcanos-core']).toEqual(
      expect.objectContaining({ route: 'core', module: 'ARCANOS:CORE' })
    );
    expect(map['arcanos-daemon']).toEqual(
      expect.objectContaining({ route: 'core', module: 'ARCANOS:CORE' })
    );
    expect(map['core']).toEqual(
      expect.objectContaining({ route: 'core', module: 'ARCANOS:CORE' })
    );
    expect(map['arcanos-gaming']).toEqual(
      expect.objectContaining({ route: 'gaming', module: 'ARCANOS:GAMING' })
    );
    expect(map['gaming']).toEqual(
      expect.objectContaining({ route: 'gaming', module: 'ARCANOS:GAMING' })
    );
    expect(map['arcanos-tutor']).toEqual(
      expect.objectContaining({ route: 'tutor', module: 'ARCANOS:TUTOR' })
    );
    expect(map['tutor']).toEqual(
      expect.objectContaining({ route: 'tutor', module: 'ARCANOS:TUTOR' })
    );
    expect(map['arcanos-sim']).toEqual(
      expect.objectContaining({ route: 'sim', module: 'ARCANOS:SIM' })
    );
    expect(map['sim']).toEqual(
      expect.objectContaining({ route: 'sim', module: 'ARCANOS:SIM' })
    );
    expect(map['backstage-booker']).toEqual(
      expect.objectContaining({ route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' })
    );
    expect(map['backstage']).toEqual(
      expect.objectContaining({ route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' })
    );
    expect(map['hrc']).toEqual(
      expect.objectContaining({ route: 'hrc', module: 'HRC' })
    );
    expect(map['cli']).toBeUndefined();
    expect(map['local-agent']).toBeUndefined();
    expect(map['productivity']).toBeUndefined();
  });

  it('flags missing required GPT IDs when the registry is incomplete', () => {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
    const validation = validateGptRegistry({});

    expect(validation.requiredGptIds).toEqual(expect.arrayContaining(['arcanos-core', 'core']));
    expect(validation.missingGptIds).toEqual(expect.arrayContaining(['arcanos-core', 'core']));
    expect(validation.registeredGptCount).toBe(0);
  });
});
