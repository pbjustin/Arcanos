import { afterEach, describe, expect, it } from '@jest/globals';
import { loadGptModuleMap, resetGptModuleMapCache } from '../src/platform/runtime/gptRouterConfig.js';

const EXPECTED_GPT_ROUTER_HASH = '0ef88eb096a39411620ca0780bf3bdd2a359f83c4e4883c42ef2e14e7afabdf3';

describe('runtime GPT router wiring', () => {
  afterEach(() => {
    resetGptModuleMapCache();
    Reflect.deleteProperty(process.env, 'GPT_MODULE_MAP');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_GAMING');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_CORE');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_TUTOR');
    Reflect.deleteProperty(process.env, 'GPTID_BACKSTAGE_BOOKER');
    Reflect.deleteProperty(process.env, 'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG');
  });

  it('registers the built-in GPT IDs from loaded module definitions', async () => {
    resetGptModuleMapCache();
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = EXPECTED_GPT_ROUTER_HASH;

    const map = await loadGptModuleMap();

    expect(map['arcanos-gaming']).toEqual(
      expect.objectContaining({ route: 'gaming', module: 'ARCANOS:GAMING' })
    );
    expect(map['gaming']).toEqual(
      expect.objectContaining({ route: 'gaming', module: 'ARCANOS:GAMING' })
    );
    expect(map['arcanos-core']).toEqual(
      expect.objectContaining({ route: 'core', module: 'ARCANOS:CORE' })
    );
    expect(map['core']).toEqual(
      expect.objectContaining({ route: 'core', module: 'ARCANOS:CORE' })
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
    expect(map['arcanos-write']).toEqual(
      expect.objectContaining({ route: 'write', module: 'ARCANOS:WRITE' })
    );
    expect(map['write']).toEqual(
      expect.objectContaining({ route: 'write', module: 'ARCANOS:WRITE' })
    );
    expect(map['arcanos-guide']).toEqual(
      expect.objectContaining({ route: 'guide', module: 'ARCANOS:GUIDE' })
    );
    expect(map['guide']).toEqual(
      expect.objectContaining({ route: 'guide', module: 'ARCANOS:GUIDE' })
    );
    expect(map['arcanos-audit']).toEqual(
      expect.objectContaining({ route: 'audit', module: 'ARCANOS:AUDIT' })
    );
    expect(map['audit']).toEqual(
      expect.objectContaining({ route: 'audit', module: 'ARCANOS:AUDIT' })
    );
    expect(map['arcanos-research']).toEqual(
      expect.objectContaining({ route: 'research', module: 'ARCANOS:RESEARCH' })
    );
    expect(map['research']).toEqual(
      expect.objectContaining({ route: 'research', module: 'ARCANOS:RESEARCH' })
    );
    expect(map['arcanos-build']).toEqual(
      expect.objectContaining({ route: 'build', module: 'ARCANOS:BUILD' })
    );
    expect(map['build']).toEqual(
      expect.objectContaining({ route: 'build', module: 'ARCANOS:BUILD' })
    );
    expect(map['arcanos-tracker']).toEqual(
      expect.objectContaining({ route: 'tracker', module: 'ARCANOS:TRACKER' })
    );
    expect(map['tracker']).toEqual(
      expect.objectContaining({ route: 'tracker', module: 'ARCANOS:TRACKER' })
    );
  });
});
