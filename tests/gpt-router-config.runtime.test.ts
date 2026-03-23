import { afterEach, describe, expect, it } from '@jest/globals';
import {
  loadGptModuleMap,
  resetGptModuleMapCache,
  validateGptRegistry
} from '../src/platform/runtime/gptRouterConfig.js';

const CURRENT_GPT_ROUTER_HASH = '038d9a189896633b03691aa674e8656374424dc6a1ce120c8191629c592118c4';

describe('runtime GPT router wiring', () => {
  const originalGptRouterHash = process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG;

  afterEach(() => {
    resetGptModuleMapCache();
    Reflect.deleteProperty(process.env, 'GPT_MODULE_MAP');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_GAMING');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_TUTOR');
    Reflect.deleteProperty(process.env, 'GPTID_BACKSTAGE_BOOKER');
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
  });

  it('flags missing required GPT IDs when the registry is incomplete', () => {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = CURRENT_GPT_ROUTER_HASH;
    const validation = validateGptRegistry({});

    expect(validation.requiredGptIds).toEqual(expect.arrayContaining(['arcanos-core', 'core']));
    expect(validation.missingGptIds).toEqual(expect.arrayContaining(['arcanos-core', 'core']));
    expect(validation.registeredGptCount).toBe(0);
  });
});
