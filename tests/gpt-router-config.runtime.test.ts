import { afterEach, describe, expect, it } from '@jest/globals';
import { loadGptModuleMap, resetGptModuleMapCache } from '../src/platform/runtime/gptRouterConfig.js';

describe('runtime GPT router wiring', () => {
  afterEach(() => {
    resetGptModuleMapCache();
    Reflect.deleteProperty(process.env, 'GPT_MODULE_MAP');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_GAMING');
    Reflect.deleteProperty(process.env, 'GPTID_ARCANOS_TUTOR');
    Reflect.deleteProperty(process.env, 'GPTID_BACKSTAGE_BOOKER');
  });

  it('registers the built-in GPT IDs from loaded module definitions', async () => {
    resetGptModuleMapCache();

    const map = await loadGptModuleMap();

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
});
