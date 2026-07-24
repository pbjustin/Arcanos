import { afterEach, describe, expect, it, jest } from '@jest/globals';

const originalGptModuleMap = process.env.GPT_MODULE_MAP;

jest.unstable_mockModule('@services/moduleLoader.js', () => ({
  clearModuleDefinitionCache: jest.fn(),
  loadModuleDefinitions: jest.fn(async () => [
    {
      route: 'productivity',
      definition: {
        name: 'ARCANOS:PRODUCTIVITY',
        gptIds: ['arcanos-productivity'],
        gptAccessOnly: true,
        actions: {
          'state.current': async () => ({ ok: true })
        }
      }
    },
    {
      route: 'ordinary',
      definition: {
        name: 'ARCANOS:ORDINARY',
        gptIds: ['arcanos-ordinary'],
        actions: {
          query: async () => ({ ok: true })
        }
      }
    }
  ])
}));

jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: jest.fn(() => 'test-hash')
}));

const {
  loadGptModuleMap,
  resetGptModuleMapCache
} = await import('../src/platform/runtime/gptRouterConfig.js');

afterEach(() => {
  resetGptModuleMapCache();
  if (originalGptModuleMap === undefined) {
    delete process.env.GPT_MODULE_MAP;
  } else {
    process.env.GPT_MODULE_MAP = originalGptModuleMap;
  }
});

describe('GPT router GPT Access-only isolation', () => {
  it('omits protected modules from defaults and explicit public GPT overrides', async () => {
    process.env.GPT_MODULE_MAP = JSON.stringify({
      'forced-productivity': {
        route: 'productivity',
        module: 'ARCANOS:PRODUCTIVITY'
      },
      'forced-productivity-alias': {
        route: 'productivity',
        module: 'productivity'
      },
      'forced-ordinary': {
        route: 'ordinary',
        module: 'ARCANOS:ORDINARY'
      }
    });

    const map = await loadGptModuleMap();

    expect(map.productivity).toBeUndefined();
    expect(map['arcanos-productivity']).toBeUndefined();
    expect(map['forced-productivity']).toBeUndefined();
    expect(map['forced-productivity-alias']).toBeUndefined();
    expect(map.ordinary).toEqual({
      route: 'ordinary',
      module: 'ARCANOS:ORDINARY'
    });
    expect(map['forced-ordinary']).toEqual({
      route: 'ordinary',
      module: 'ARCANOS:ORDINARY'
    });
  });
});
