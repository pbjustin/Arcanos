import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const ROUTING_OVERRIDE_KEYS = [
  'GPT_MODULE_MAP',
  'GPTID_ARCANOS_GAMING',
  'GPTID_ARCANOS_TUTOR',
  'GPTID_BACKSTAGE_BOOKER',
  'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG'
] as const;
const originalRoutingOverrides = Object.fromEntries(
  ROUTING_OVERRIDE_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ROUTING_OVERRIDE_KEYS)[number], string | undefined>;

function buildLoadedModules() {
  return [
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
      route: 'gaming',
      definition: {
        name: 'ARCANOS:GAMING',
        gptIds: ['arcanos-gaming'],
        actions: {
          query: async () => ({ ok: true })
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
  ];
}

const listRegisteredModulesMock = jest.fn(() => buildLoadedModules());
const moduleRegistryMock = {
  listRegisteredModules: listRegisteredModulesMock
};
const initializeModuleRegistryMock = jest.fn(
  async () => moduleRegistryMock
);

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry: initializeModuleRegistryMock
}));

jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: jest.fn(() => 'test-hash')
}));

const {
  getGptModuleMap,
  loadGptModuleMap,
  rebuildGptModuleMap,
  resetGptModuleMapCache
} = await import('../src/platform/runtime/gptRouterConfig.js');

beforeEach(() => {
  jest.clearAllMocks();
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
      },
      'forced-missing': {
        route: 'missing',
        module: 'ARCANOS:MISSING'
      },
      'forced-mismatched-route': {
        route: 'gaming',
        module: 'ARCANOS:ORDINARY'
      },
      malformed: null
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
    expect(map['forced-missing']).toBeUndefined();
    expect(map['forced-mismatched-route']).toBeUndefined();
    expect(map.malformed).toBeUndefined();
  });

  it('keeps built-in defaults when an override targets an unregistered pair', async () => {
    process.env.GPT_MODULE_MAP = JSON.stringify({
      gaming: {
        route: 'missing',
        module: 'ARCANOS:MISSING'
      }
    });

    const map = await loadGptModuleMap();

    expect(map.gaming).toEqual({
      route: 'gaming',
      module: 'ARCANOS:GAMING'
    });
  });

  it('rejects protected catalog aliases even when their definitions fail to load', async () => {
    listRegisteredModulesMock.mockReturnValueOnce(
      buildLoadedModules().filter(({ route }) => route !== 'productivity')
    );
    process.env.GPT_MODULE_MAP = JSON.stringify({
      'forced-cli-name': {
        route: 'ordinary',
        module: 'ARCANOS:CLI'
      },
      'forced-cli-route': {
        route: 'cli',
        module: 'ARCANOS:ORDINARY'
      },
      'forced-local-agent-source': {
        route: 'arcanos-local-agent',
        module: 'ARCANOS:ORDINARY'
      },
      'forced-productivity-slug': {
        route: 'ordinary',
        module: 'arcanos-productivity'
      },
      'arcanos-cli': {
        route: 'ordinary',
        module: 'ARCANOS:ORDINARY'
      },
      'forced-ordinary': {
        route: 'ordinary',
        module: 'ARCANOS:ORDINARY'
      }
    });
    process.env.GPTID_ARCANOS_GAMING = 'cli';

    const map = await loadGptModuleMap();

    expect(map['forced-cli-name']).toBeUndefined();
    expect(map['forced-cli-route']).toBeUndefined();
    expect(map['forced-local-agent-source']).toBeUndefined();
    expect(map['forced-productivity-slug']).toBeUndefined();
    expect(map['arcanos-cli']).toBeUndefined();
    expect(map.cli).toBeUndefined();
    expect(map['forced-ordinary']).toEqual({
      route: 'ordinary',
      module: 'ARCANOS:ORDINARY'
    });
  });

  it('rebuilds environment bindings against the same registry generation', async () => {
    const initialMap = await getGptModuleMap();
    expect(initialMap['runtime-override']).toBeUndefined();

    process.env.GPT_MODULE_MAP = JSON.stringify({
      'runtime-override': {
        route: 'ordinary',
        module: 'ARCANOS:ORDINARY'
      }
    });

    const rebuiltMap = await rebuildGptModuleMap();

    expect(rebuiltMap['runtime-override']).toEqual({
      route: 'ordinary',
      module: 'ARCANOS:ORDINARY'
    });
    expect(initializeModuleRegistryMock).toHaveBeenCalledTimes(2);
    await expect(
      initializeModuleRegistryMock.mock.results[0]?.value
    ).resolves.toBe(moduleRegistryMock);
    await expect(
      initializeModuleRegistryMock.mock.results[1]?.value
    ).resolves.toBe(moduleRegistryMock);
  });

  it('fails closed when a pin would attest more public modules than registered', async () => {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = 'a'.repeat(64);

    await expect(loadGptModuleMap()).rejects.toThrow(
      'Pinned GPT router configuration requires the complete public module catalog.'
    );
  });

  it('fails closed on an invalid override whenever the router is pinned', async () => {
    process.env.SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG = 'a'.repeat(64);
    process.env.GPT_MODULE_MAP = JSON.stringify({
      invalid: { route: 'missing', module: 'ARCANOS:MISSING' }
    });

    await expect(loadGptModuleMap()).rejects.toThrow(
      'Pinned GPT router configuration contains an invalid override.'
    );
  });
});
