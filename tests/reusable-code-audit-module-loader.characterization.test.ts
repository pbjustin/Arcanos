import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL as realPathToFileURL } from 'node:url';

type ModuleLoader = typeof import('../src/services/moduleLoader.js');

interface SyntheticModuleFile {
  name: string;
  fixture?: string;
  dataUrl?: string;
  isFile?: boolean;
}

interface ModuleLoaderHarness {
  loader: ModuleLoader;
  readdirMock: jest.Mock;
  dirents: Array<{ name: string; isFile: () => boolean }>;
}

declare global {
  var __arcanosModuleLoaderFixtureEvents: string[] | undefined;
  var __arcanosModuleLoaderFixtureListener: (() => void) | undefined;
  var __arcanosModuleLoaderFixtureTimer: ReturnType<typeof setInterval> | undefined;
  var __arcanosModuleLoaderFixtureGate: Promise<void> | undefined;
}

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'module-loader'
);
const originalEnvironment = { ...process.env };
let harnessSequence = 0;

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnvironment);
}

function cleanupFixtureSideEffects(): void {
  if (globalThis.__arcanosModuleLoaderFixtureTimer) {
    clearInterval(globalThis.__arcanosModuleLoaderFixtureTimer);
    delete globalThis.__arcanosModuleLoaderFixtureTimer;
  }
  if (globalThis.__arcanosModuleLoaderFixtureListener) {
    process.removeListener(
      'arcanos-module-loader-fixture',
      globalThis.__arcanosModuleLoaderFixtureListener
    );
    delete globalThis.__arcanosModuleLoaderFixtureListener;
  }
  delete globalThis.__arcanosModuleLoaderFixtureGate;
}

async function loadModuleLoaderHarness(
  files: SyntheticModuleFile[]
): Promise<ModuleLoaderHarness> {
  jest.resetModules();
  harnessSequence += 1;
  const harnessId = `module-loader-audit-${harnessSequence}`;
  const byName = new Map(files.map((file) => [file.name, file]));
  const dirents = files.map((file) => ({
    name: file.name,
    isFile: () => file.isFile !== false,
  }));
  const readdirMock = jest.fn(async () => dirents);

  jest.unstable_mockModule('fs', () => ({
    promises: {
      readdir: readdirMock,
    },
  }));
  jest.unstable_mockModule('url', () => ({
    fileURLToPath,
    pathToFileURL: (candidatePath: string) => {
      const syntheticName = path.basename(candidatePath);
      const file = byName.get(syntheticName);
      if (!file) {
        throw new Error(`No fixture mapping for ${syntheticName}`);
      }
      if (file.dataUrl) {
        return new URL(file.dataUrl);
      }
      if (!file.fixture) {
        throw new Error(`Fixture file missing for ${syntheticName}`);
      }
      const fixtureUrl = realPathToFileURL(path.join(fixtureDirectory, file.fixture));
      fixtureUrl.searchParams.set('audit-case', `${harnessId}-${syntheticName}`);
      return fixtureUrl;
    },
  }));

  const loader = await import('../src/services/moduleLoader.js');
  return { loader, readdirMock, dirents };
}

beforeEach(() => {
  restoreEnvironment();
  process.env.MODULE_LOADER_FIXTURE_FLAG = 'observed';
  globalThis.__arcanosModuleLoaderFixtureEvents = [];
  jest.useFakeTimers();
});

afterEach(() => {
  cleanupFixtureSideEffects();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.resetModules();
  delete globalThis.__arcanosModuleLoaderFixtureEvents;
  restoreEnvironment();
});

describe('reusable-code audit: dynamic module-loader characterization', () => {
  it('filters filenames, normalizes routes, and preserves raw readdir order', async () => {
    const harness = await loadModuleLoaderHarness([
      { name: 'arcanos-second.ts', fixture: 'accepted.mjs' },
      { name: 'first.js', fixture: 'accepted.mjs' },
      { name: 'types.d.ts' },
      { name: 'moduleLoader.ts' },
      { name: 'notes.md' },
      { name: 'directory.ts', fixture: 'accepted.mjs', isFile: false },
    ]);

    const loaded = await harness.loader.loadModuleDefinitions();

    expect(loaded.map((module) => module.route)).toEqual(['second', 'first']);
    expect(harness.readdirMock).toHaveBeenCalledTimes(1);
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual(['accepted']);
  });

  it('accepts every truthy actions shape and rejects missing defaults or actions', async () => {
    const harness = await loadModuleLoaderHarness([
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
      { name: 'empty-actions.ts', fixture: 'empty-actions.mjs' },
      { name: 'malformed-actions.ts', fixture: 'malformed-actions.mjs' },
      { name: 'missing-actions.ts', fixture: 'missing-actions.mjs' },
      { name: 'no-default.ts', fixture: 'no-default.mjs' },
      { name: 'duplicate-a.ts', fixture: 'duplicate-actions.mjs' },
      { name: 'duplicate-b.ts', fixture: 'duplicate-actions.mjs' },
    ]);

    const loaded = await harness.loader.loadModuleDefinitions();

    expect(loaded.map((module) => module.route)).toEqual([
      'accepted',
      'empty-actions',
      'malformed-actions',
      'duplicate-a',
      'duplicate-b',
    ]);
    expect(loaded[1]?.definition.actions).toEqual({});
    expect(loaded[2]?.definition.actions).toBe('truthy-but-not-an-action-map');
    expect(loaded[3]?.definition.name).toBe(loaded[4]?.definition.name);
    await expect(
      (loaded[3]?.definition.actions as Record<string, () => Promise<string>>)
        .duplicate()
    ).resolves.toBe('second');
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([
      'accepted',
      'empty-actions',
      'malformed-actions',
      'missing-actions',
      'no-default',
    ]);
  });

  it('logs initialization and syntax failures, then continues with later modules', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await loadModuleLoaderHarness([
      { name: 'initialization-failure.ts', fixture: 'throws.mjs' },
      {
        name: 'syntax-failure.ts',
        dataUrl: 'data:text/javascript,export default {',
      },
      { name: 'accepted-after-failures.ts', fixture: 'accepted.mjs' },
    ]);

    const loaded = await harness.loader.loadModuleDefinitions();

    expect(loaded.map((module) => module.route)).toEqual([
      'accepted-after-failures',
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      'Failed to load module initialization-failure.ts'
    );
    expect(errorSpy.mock.calls[1]?.[0]).toContain(
      'Failed to load module syntax-failure.ts'
    );
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([
      'throws',
      'accepted',
    ]);
  });

  it('observes rejected-module environment, listener, and timer side effects', async () => {
    const startingListenerCount = process.listenerCount(
      'arcanos-module-loader-fixture'
    );
    const harness = await loadModuleLoaderHarness([
      {
        name: 'rejected-side-effect.ts',
        fixture: 'side-effect-rejected.mjs',
      },
    ]);

    await expect(harness.loader.loadModuleDefinitions()).resolves.toEqual([]);

    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([
      'side-effect:observed',
    ]);
    expect(
      process.listenerCount('arcanos-module-loader-fixture')
    ).toBe(startingListenerCount + 1);
    expect(jest.getTimerCount()).toBe(1);

    cleanupFixtureSideEffects();
    expect(
      process.listenerCount('arcanos-module-loader-fixture')
    ).toBe(startingListenerCount);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns the same mutable cached array and cache reset does not re-evaluate ESM', async () => {
    const harness = await loadModuleLoaderHarness([
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
      { name: 'missing-actions.ts', fixture: 'missing-actions.mjs' },
    ]);

    const first = await harness.loader.loadModuleDefinitions();
    const second = await harness.loader.loadModuleDefinitions();
    expect(second).toBe(first);

    first.push({
      route: 'caller-mutation',
      definition: {
        name: 'CALLER:MUTATION',
        actions: {},
      },
    });
    expect(await harness.loader.loadModuleDefinitions()).toContainEqual(
      expect.objectContaining({ route: 'caller-mutation' })
    );

    harness.loader.clearModuleDefinitionCache();
    const afterReset = await harness.loader.loadModuleDefinitions();

    expect(afterReset).not.toBe(first);
    expect(afterReset.map((module) => module.route)).toEqual(['accepted']);
    expect(harness.readdirMock).toHaveBeenCalledTimes(2);
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([
      'accepted',
      'missing-actions',
    ]);
  });

  it('does not coalesce concurrent cold loads', async () => {
    const harness = await loadModuleLoaderHarness([
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
    ]);
    let releaseDirectoryRead!: () => void;
    const directoryGate = new Promise<void>((resolve) => {
      releaseDirectoryRead = resolve;
    });
    harness.readdirMock.mockImplementation(async () => {
      await directoryGate;
      return harness.dirents;
    });

    const firstLoad = harness.loader.loadModuleDefinitions();
    const secondLoad = harness.loader.loadModuleDefinitions();

    expect(harness.readdirMock).toHaveBeenCalledTimes(2);
    releaseDirectoryRead();
    const [first, second] = await Promise.all([firstLoad, secondLoad]);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual(['accepted']);
  });

  it('blocks later imports behind top-level await and then preserves result order', async () => {
    jest.useRealTimers();
    let releaseModule!: () => void;
    globalThis.__arcanosModuleLoaderFixtureGate = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    const harness = await loadModuleLoaderHarness([
      { name: 'gated.ts', fixture: 'top-level-gate.mjs' },
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
    ]);
    let settled = false;

    const loading = harness.loader.loadModuleDefinitions().then((result) => {
      settled = true;
      return result;
    });
    let loaded: Awaited<typeof loading> | undefined;
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(settled).toBe(false);
      expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual(['gate-start']);

      releaseModule();
      loaded = await loading;
    } finally {
      releaseModule();
      await loading.catch(() => undefined);
    }

    expect(loaded).toBeDefined();
    expect(loaded?.map((module) => module.route)).toEqual(['gated', 'accepted']);
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([
      'gate-start',
      'gate-finish',
      'accepted',
    ]);
  });

  it('retries the scan but retains a failed ESM evaluation after loader cache reset', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await loadModuleLoaderHarness([
      { name: 'failure.ts', fixture: 'throws.mjs' },
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
    ]);

    expect(
      (await harness.loader.loadModuleDefinitions()).map((module) => module.route)
    ).toEqual(['accepted']);
    harness.loader.clearModuleDefinitionCache();
    expect(
      (await harness.loader.loadModuleDefinitions()).map((module) => module.route)
    ).toEqual(['accepted']);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([
      'throws',
      'accepted',
    ]);
  });

  it('propagates directory discovery failures before per-file handling begins', async () => {
    const harness = await loadModuleLoaderHarness([
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
    ]);
    const directoryError = new Error('directory unavailable');
    harness.readdirMock.mockRejectedValueOnce(directoryError);

    await expect(harness.loader.loadModuleDefinitions()).rejects.toBe(
      directoryError
    );
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual([]);
  });

  it('allows a throwing failure logger to abort the remaining scan', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('logger failed');
    });
    const harness = await loadModuleLoaderHarness([
      { name: 'failure.ts', fixture: 'throws.mjs' },
      { name: 'accepted.ts', fixture: 'accepted.mjs' },
    ]);

    await expect(harness.loader.loadModuleDefinitions()).rejects.toThrow(
      'logger failed'
    );
    expect(globalThis.__arcanosModuleLoaderFixtureEvents).toEqual(['throws']);
  });

  it('matches the deterministic source and compiled inventory artifact', async () => {
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
        evaluatedModules: string[];
        acceptedStaticCandidates: Array<{ file: string }>;
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
      'dist/services/persistedSessionService.js',
    ]);
    expect(artifact.source.evaluatedModules).toEqual(
      [...artifact.source.evaluatedModules].sort()
    );
    expect(
      artifact.source.acceptedStaticCandidates.map((entry) => entry.file)
    ).toEqual(
      artifact.source.acceptedStaticCandidates
        .map((entry) => entry.file)
        .sort()
    );
  });
});
