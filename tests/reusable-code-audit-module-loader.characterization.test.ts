import {
  afterEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../src/platform/logging/structuredLogging.js';
import {
  defineModuleCatalog,
  isProtectedModuleIdentifier,
  MODULE_CATALOG,
  PROTECTED_MODULE_IDENTIFIERS,
  type ModuleCatalogEntry
} from '../src/services/moduleCatalog.js';
import {
  createModuleDefinitionLoader,
  type ModuleDef
} from '../src/services/moduleLoader.js';

const EXPECTED_MODULES = [
  ['./arcanos-audit.js', 'audit', 'ARCANOS:AUDIT'],
  ['./arcanos-build.js', 'build', 'ARCANOS:BUILD'],
  ['./arcanos-cli.js', 'cli', 'ARCANOS:CLI'],
  ['./arcanos-core.js', 'core', 'ARCANOS:CORE'],
  ['./arcanos-gaming.js', 'gaming', 'ARCANOS:GAMING'],
  ['./arcanos-guide.js', 'guide', 'ARCANOS:GUIDE'],
  ['./arcanos-local-agent.js', 'local-agent', 'ARCANOS:LOCAL_AGENT'],
  ['./arcanos-productivity.js', 'productivity', 'ARCANOS:PRODUCTIVITY'],
  ['./arcanos-research.js', 'research', 'ARCANOS:RESEARCH'],
  ['./arcanos-sim.js', 'sim', 'ARCANOS:SIM'],
  ['./arcanos-tracker.js', 'tracker', 'ARCANOS:TRACKER'],
  ['./arcanos-tutor.js', 'tutor', 'ARCANOS:TUTOR'],
  ['./arcanos-write.js', 'write', 'ARCANOS:WRITE'],
  ['./backstage-booker.js', 'backstage-booker', 'BACKSTAGE:BOOKER'],
  ['./hrc.js', 'hrc', 'HRC']
] as const;

function catalogEntry(
  route: string,
  name: string
): ModuleCatalogEntry {
  return {
    source: `./${route}.js`,
    route,
    name,
    diagnosticsKey: name.split(':').at(-1) ?? name
  };
}

function moduleDefinition(
  name: string,
  marker = name
): ModuleDef {
  return {
    name,
    actions: {
      query: async () => marker
    }
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('explicit module catalog', () => {
  it('owns the exact ordered 15-module inventory as a frozen contract', async () => {
    expect(
      MODULE_CATALOG.map(({ source, route, name }) => [source, route, name])
    ).toEqual(EXPECTED_MODULES);
    expect(Object.isFrozen(MODULE_CATALOG)).toBe(true);
    expect(new Set(MODULE_CATALOG.map(({ source }) => source)).size).toBe(15);
    expect(new Set(MODULE_CATALOG.map(({ route }) => route)).size).toBe(15);
    expect(new Set(MODULE_CATALOG.map(({ name }) => name)).size).toBe(15);
    expect(MODULE_CATALOG.map(({ diagnosticsKey }) => diagnosticsKey)).toEqual([
      'AUDIT',
      'BUILD',
      'CLI',
      'CORE',
      'GAMING',
      'GUIDE',
      'LOCAL_AGENT',
      'PRODUCTIVITY',
      'RESEARCH',
      'SIM',
      'TRACKER',
      'TUTOR',
      'WRITE',
      'BOOKING',
      'HRC'
    ]);
    expect(
      MODULE_CATALOG
        .filter(({ gptAccessOnly }) => gptAccessOnly === true)
        .map(({ name }) => name)
    ).toEqual([
      'ARCANOS:CLI',
      'ARCANOS:LOCAL_AGENT',
      'ARCANOS:PRODUCTIVITY'
    ]);

    for (const entry of MODULE_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      const sourceFile = entry.source
        .replace(/^\.\//, '')
        .replace(/\.js$/, '.ts');
      await expect(
        access(path.join(process.cwd(), 'src', 'services', sourceFile))
      ).resolves.toBeUndefined();
    }
  });

  it('reserves protected module identifier variants from public routing', () => {
    expect(PROTECTED_MODULE_IDENTIFIERS).toEqual([
      'arcanos-cli',
      'arcanos-local-agent',
      'arcanos-productivity',
      'arcanos:cli',
      'arcanos:local_agent',
      'arcanos:productivity',
      'cli',
      'local-agent',
      'productivity'
    ]);
    for (const identifier of [
      'cli',
      'ARCANOS:CLI',
      'arcanos-cli',
      'local_agent',
      'ARCANOS_LOCAL_AGENT',
      'arcanos-productivity'
    ]) {
      expect(isProtectedModuleIdentifier(identifier)).toBe(true);
    }
    expect(isProtectedModuleIdentifier('arcanos-core')).toBe(false);
  });

  it('rejects empty, malformed, and duplicate catalog entries', () => {
    expect(() => defineModuleCatalog([])).toThrow(
      'Module catalog must contain at least one entry.'
    );
    expect(() => defineModuleCatalog([
      {
        source: '../escape.js',
        route: 'safe',
        name: 'TEST:SAFE',
        diagnosticsKey: 'SAFE'
      } as ModuleCatalogEntry
    ])).toThrow('Invalid module catalog source: ../escape.js');
    expect(() => defineModuleCatalog([
      {
        source: './safe.js',
        route: 'Unsafe Route',
        name: 'TEST:SAFE',
        diagnosticsKey: 'SAFE'
      }
    ])).toThrow('Invalid module catalog route: Unsafe Route');
    expect(() => defineModuleCatalog([
      {
        source: './safe.js',
        route: 'safe',
        name: 'test:safe',
        diagnosticsKey: 'SAFE'
      }
    ])).toThrow('Invalid module catalog name: test:safe');
    expect(() => defineModuleCatalog([
      {
        source: './safe.js',
        route: 'safe',
        name: 'TEST:SAFE',
        diagnosticsKey: 'SAFE',
        gptAccessOnly: false
      } as unknown as ModuleCatalogEntry
    ])).toThrow('Invalid module catalog exposure: TEST:SAFE');
    expect(() => defineModuleCatalog([
      {
        source: './safe.js',
        route: 'safe',
        name: 'TEST:SAFE',
        diagnosticsKey: 'unsafe-key'
      }
    ])).toThrow(
      'Invalid module catalog diagnostics key: unsafe-key'
    );

    const first = catalogEntry('first', 'TEST:FIRST');
    expect(() => defineModuleCatalog([
      first,
      { ...catalogEntry('second', 'TEST:SECOND'), source: first.source }
    ])).toThrow('Duplicate module catalog source: ./first.js');
    expect(() => defineModuleCatalog([
      first,
      { ...catalogEntry('second', 'TEST:SECOND'), route: first.route }
    ])).toThrow('Duplicate module catalog route: first');
    expect(() => defineModuleCatalog([
      first,
      { ...catalogEntry('second', 'TEST:SECOND'), name: first.name }
    ])).toThrow('Duplicate module catalog name: TEST:FIRST');
    expect(() => defineModuleCatalog([
      first,
      {
        ...catalogEntry('second', 'TEST:SECOND'),
        diagnosticsKey: first.diagnosticsKey
      }
    ])).toThrow('Duplicate module catalog diagnostics key: FIRST');
  });
});

describe('catalog-backed module loader', () => {
  it('imports only listed entries, sequentially, in catalog order', async () => {
    const catalog = [
      catalogEntry('first', 'TEST:FIRST'),
      catalogEntry('second', 'TEST:SECOND')
    ];
    const imports: string[] = [];
    const loader = createModuleDefinitionLoader(catalog, async (source) => {
      imports.push(source);
      const entry = catalog.find((candidate) => candidate.source === source);
      return {
        default: moduleDefinition(entry?.name ?? 'TEST:UNLISTED')
      };
    });

    const loaded = await loader.load();

    expect(imports).toEqual(['./first.js', './second.js']);
    expect(loaded.map(({ route, definition }) => [
      route,
      definition.name
    ])).toEqual([
      ['first', 'TEST:FIRST'],
      ['second', 'TEST:SECOND']
    ]);
    expect(imports).not.toContain('./unlisted.js');
  });

  it('rejects invalid definitions, sanitizes failures, and continues loading', async () => {
    const errorSpy = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);
    const catalog = [
      catalogEntry('import-failure', 'TEST:IMPORT_FAILURE'),
      catalogEntry('missing-namespace', 'TEST:MISSING_NAMESPACE'),
      catalogEntry('missing-default', 'TEST:MISSING_DEFAULT'),
      catalogEntry('name-mismatch', 'TEST:NAME_MISMATCH'),
      catalogEntry('array-actions', 'TEST:ARRAY_ACTIONS'),
      catalogEntry('empty-actions', 'TEST:EMPTY_ACTIONS'),
      catalogEntry('non-function-action', 'TEST:NON_FUNCTION_ACTION'),
      {
        ...catalogEntry('missing-protection', 'TEST:MISSING_PROTECTION'),
        gptAccessOnly: true
      },
      catalogEntry('unexpected-protection', 'TEST:UNEXPECTED_PROTECTION'),
      {
        ...catalogEntry('legacy-exposed', 'TEST:LEGACY_EXPOSED'),
        gptAccessOnly: true
      },
      catalogEntry('accepted', 'TEST:ACCEPTED')
    ];
    const loader = createModuleDefinitionLoader(catalog, async (source) => {
      switch (source) {
        case './import-failure.js':
          throw new Error('sensitive initialization details');
        case './missing-namespace.js':
          return null;
        case './missing-default.js':
          return { default: null };
        case './name-mismatch.js':
          return { default: moduleDefinition('TEST:WRONG') };
        case './array-actions.js':
          return {
            default: {
              name: 'TEST:ARRAY_ACTIONS',
              actions: []
            }
          };
        case './empty-actions.js':
          return {
            default: {
              name: 'TEST:EMPTY_ACTIONS',
              actions: {}
            }
          };
        case './non-function-action.js':
          return {
            default: {
              name: 'TEST:NON_FUNCTION_ACTION',
              actions: { query: true }
            }
          };
        case './missing-protection.js':
          return {
            default: moduleDefinition('TEST:MISSING_PROTECTION')
          };
        case './unexpected-protection.js':
          return {
            default: {
              ...moduleDefinition('TEST:UNEXPECTED_PROTECTION'),
              exposeLegacyRoute: false,
              gptAccessOnly: true
            }
          };
        case './legacy-exposed.js':
          return {
            default: {
              ...moduleDefinition('TEST:LEGACY_EXPOSED'),
              gptAccessOnly: true
            }
          };
        default:
          return { default: moduleDefinition('TEST:ACCEPTED') };
      }
    });

    const loaded = await loader.load();

    expect(loaded.map(({ route }) => route)).toEqual(['accepted']);
    expect(errorSpy).toHaveBeenCalledTimes(10);
    expect(
      errorSpy.mock.calls.map(([, context]) => context?.reason)
    ).toEqual([
      'import_failed',
      'missing_default',
      'missing_default',
      'name_mismatch',
      'invalid_actions',
      'invalid_actions',
      'invalid_actions',
      'exposure_mismatch',
      'exposure_mismatch',
      'exposure_mismatch'
    ]);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      'sensitive initialization details'
    );
  });

  it('coalesces concurrent cold loads and returns defensive array entries', async () => {
    const catalog = [catalogEntry('coalesced', 'TEST:COALESCED')];
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const importModule = jest.fn(async () => {
      await importGate;
      return {
        default: {
          ...moduleDefinition('TEST:COALESCED'),
          gptIds: ['test-coalesced'],
          actionMetadata: {
            query: {
              risk: 'readonly',
              requiredDeviceScopes: ['test.read'],
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' }
                }
              }
            }
          }
        }
      };
    });
    const loader = createModuleDefinitionLoader(catalog, importModule);

    const firstLoad = loader.load();
    const secondLoad = loader.load();
    expect(importModule).toHaveBeenCalledTimes(1);

    releaseImport();
    const [first, second] = await Promise.all([firstLoad, secondLoad]);

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(Reflect.set(first[0]!, 'route', 'caller-mutation')).toBe(true);
    expect(Object.isFrozen(first[0]!.definition)).toBe(true);
    expect(Object.isFrozen(first[0]!.definition.actions)).toBe(true);
    expect(Object.isFrozen(first[0]!.definition.gptIds)).toBe(true);
    expect(Object.isFrozen(first[0]!.definition.actionMetadata)).toBe(true);
    expect(
      Object.isFrozen(
        first[0]!.definition.actionMetadata?.query.inputSchema
      )
    ).toBe(true);
    expect(
      Reflect.set(first[0]!.definition, 'gptAccessOnly', true)
    ).toBe(false);
    expect(
      Reflect.set(
        first[0]!.definition.actions,
        'query',
        async () => 'poisoned'
      )
    ).toBe(false);
    first.push({
      route: 'extra',
      definition: moduleDefinition('TEST:EXTRA')
    });

    const cached = await loader.load();
    expect(cached.map(({ route }) => route)).toEqual(['coalesced']);
    expect(cached[0]!.definition.gptAccessOnly).toBeUndefined();
    await expect(
      cached[0]!.definition.actions.query({})
    ).resolves.toBe('TEST:COALESCED');
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('reloads after an explicit cache clear', async () => {
    const importModule = jest.fn(async () => ({
      default: moduleDefinition('TEST:RELOAD')
    }));
    const loader = createModuleDefinitionLoader(
      [catalogEntry('reload', 'TEST:RELOAD')],
      importModule
    );

    await loader.load();
    loader.clear();
    await loader.load();

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('does not let an in-flight pre-clear load repopulate the cache', async () => {
    let releaseFirstImport!: () => void;
    const firstImportGate = new Promise<void>((resolve) => {
      releaseFirstImport = resolve;
    });
    let importCount = 0;
    const importModule = jest.fn(async () => {
      importCount += 1;
      if (importCount === 1) {
        await firstImportGate;
        return {
          default: moduleDefinition('TEST:GENERATION', 'old')
        };
      }
      return {
        default: moduleDefinition('TEST:GENERATION', 'new')
      };
    });
    const loader = createModuleDefinitionLoader(
      [catalogEntry('generation', 'TEST:GENERATION')],
      importModule
    );

    const staleLoad = loader.load();
    loader.clear();
    const currentLoad = loader.load();
    releaseFirstImport();

    const [stale, current] = await Promise.all([staleLoad, currentLoad]);
    await expect(stale[0]!.definition.actions.query({})).resolves.toBe('old');
    await expect(current[0]!.definition.actions.query({})).resolves.toBe('new');
    const cached = await loader.load();
    await expect(cached[0]!.definition.actions.query({})).resolves.toBe('new');
    expect(importModule).toHaveBeenCalledTimes(2);
  });

});

describe('historical module-loader evidence', () => {
  it('preserves the dated 2026-07-16 inventory as a historical snapshot', async () => {
    const rawArtifact = await readFile(
      path.join(
        process.cwd(),
        'docs',
        'audits',
        'reusable-code',
        '2026-07-16',
        'dynamic-module-inventory.json'
      ),
      'utf8'
    );
    const artifact = JSON.parse(rawArtifact) as {
      source: {
        evaluatedCount: number;
        acceptedStaticCandidateCount: number;
      };
      compiled: {
        evaluatedCount: number;
        acceptedStaticCandidateCount: number;
        compiledOnlyModules: string[];
      };
    };

    expect(artifact.source.evaluatedCount).toBe(134);
    expect(artifact.source.acceptedStaticCandidateCount).toBe(13);
    expect(artifact.compiled.evaluatedCount).toBe(138);
    expect(artifact.compiled.acceptedStaticCandidateCount).toBe(13);
    expect(artifact.compiled.compiledOnlyModules).toEqual([
      'dist/services/gptAccessOperator.js',
      'dist/services/gptAccessOperatorRegistry.js',
      'dist/services/gptIntegrationActions.js',
      'dist/services/persistedSessionService.js'
    ]);
  });
});
