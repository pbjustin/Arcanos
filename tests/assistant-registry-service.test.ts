import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'arcanos-assistant-registry-')
);
const registryPath = path.join(temporaryRoot, 'assistants.json');

const listAssistantsMock = jest.fn<
  (...args: unknown[]) => Promise<Record<string, unknown>>
>();
const createThreadMock = jest.fn<(...args: unknown[]) => Promise<{ id: string }>>();
const createRunMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const integrityCommitMock = jest.fn();
const assertIntegrityMock = jest.fn();
const prepareIntegrityUpdateMock = jest.fn(() => ({
  hash: 'prepared-test-hash',
  commit: integrityCommitMock,
}));
const aiLogger = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  startTimer: jest.fn(() => jest.fn()),
};

jest.unstable_mockModule('@platform/runtime/config.js', () => ({
  config: {
    assistantSync: {
      registryPath,
    },
  },
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger,
}));
jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: assertIntegrityMock,
  prepareAssistantRegistryIntegrityUpdate: prepareIntegrityUpdateMock,
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  requireOpenAIClientOrAdapter: jest.fn(() => ({
    client: {
      beta: {
        assistants: {
          list: listAssistantsMock,
        },
        threads: {
          create: createThreadMock,
          runs: {
            create: createRunMock,
          },
        },
      },
    },
  })),
}));

const {
  AssistantRegistrySyncError,
  AssistantRegistrySyncInProgressError,
  buildAssistantLookup,
  callAssistantByName,
  getAssistant,
  getAssistantRegistry,
  syncAssistantRegistry,
} = await import('../src/services/openai-assistants.js');

function assistant(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name,
    instructions: `Instructions for ${name}`,
    tools: [],
    model: 'gpt-4.1-mini',
    ...overrides,
  };
}

function initialRegistry(): Record<string, unknown> {
  return {
    ALPHA: {
      id: 'asst_alpha',
      name: 'Alpha',
      instructions: 'Initial instructions',
      tools: [],
      model: 'gpt-4.1-mini',
      normalizedName: 'ALPHA',
    },
  };
}

async function writeInitialRegistry(): Promise<string> {
  await fs.rm(registryPath, { force: true, recursive: true });
  const content = `${JSON.stringify(initialRegistry(), null, 2)}\n`;
  await fs.writeFile(registryPath, content, { encoding: 'utf8', mode: 0o600 });
  return content;
}

describe('assistant registry synchronization and persistence', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await writeInitialRegistry();
    listAssistantsMock.mockResolvedValue({
      data: [assistant('asst_alpha', 'Alpha')],
      has_more: false,
      last_id: 'asst_alpha',
    });
    createThreadMock.mockResolvedValue({ id: 'thread_1' });
    createRunMock.mockResolvedValue({ id: 'run_1' });
  });

  it('keeps reads and misses local and returns defensive registry copies', async () => {
    const first = await getAssistantRegistry();
    first.ALPHA.name = 'Mutated by caller';
    const second = await getAssistantRegistry();
    const missing = await getAssistant('missing');
    const lookup = await buildAssistantLookup();

    expect(second.ALPHA.name).toBe('Alpha');
    expect(missing).toBeUndefined();
    expect(lookup).toEqual({
      alpha: 'asst_alpha',
    });
    await expect(
      callAssistantByName('missing', 'provider must not receive this')
    ).rejects.toThrow('Assistant not found.');
    expect(listAssistantsMock).not.toHaveBeenCalled();
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('handles prototype-like assistant names through own null-prototype maps', async () => {
    listAssistantsMock.mockResolvedValueOnce({
      data: [
        assistant('asst_constructor', 'constructor'),
        assistant('asst_to_string', 'toString'),
        assistant('asst_proto', '__proto__'),
      ],
      has_more: false,
      last_id: 'asst_proto',
    });

    await expect(syncAssistantRegistry()).resolves.toMatchObject({
      changed: true,
    });
    await expect(getAssistant('constructor')).resolves.toMatchObject({
      id: 'asst_constructor',
    });
    await expect(getAssistant('toString')).resolves.toMatchObject({
      id: 'asst_to_string',
    });
    await expect(getAssistant('__proto__')).resolves.toMatchObject({
      id: 'asst_proto',
    });
    await expect(getAssistant('hasOwnProperty')).resolves.toBeUndefined();

    const lookup = await buildAssistantLookup();
    expect(Object.getPrototypeOf(lookup)).toBeNull();
    expect(lookup.constructor).toBe('asst_constructor');
    expect(lookup.tostring).toBe('asst_to_string');
    expect(lookup.__proto__).toBe('asst_proto');
    expect(Object.prototype.hasOwnProperty.call(lookup, '__proto__')).toBe(true);
  });

  it('preserves the live registry when the cache is missing or invalid', async () => {
    await getAssistantRegistry();
    await fs.unlink(registryPath);

    const afterMissing = await getAssistantRegistry();
    await expect(fs.stat(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(registryPath, '{"broken":', 'utf8');
    const afterInvalid = await getAssistantRegistry();
    const invalidContent = await fs.readFile(registryPath, 'utf8');

    expect(afterMissing.ALPHA.name).toBe('Alpha');
    expect(afterInvalid.ALPHA.name).toBe('Alpha');
    expect(invalidContent).toBe('{"broken":');
  });

  it('rejects a pre-open file identity swap without trusting its bytes', async () => {
    await getAssistantRegistry();
    assertIntegrityMock.mockClear();
    const replacementPath = path.join(temporaryRoot, 'replacement.json');
    await fs.writeFile(replacementPath, JSON.stringify({
      SWAPPED: {
        id: 'asst_swapped',
        name: 'Swapped',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'SWAPPED',
      },
    }), 'utf8');
    const actualOpen = fs.open.bind(fs);
    const openSpy = jest.spyOn(fs, 'open') as unknown as {
      mockImplementation(
        implementation: (...args: unknown[]) => unknown
      ): void;
      mockRestore(): void;
    };
    openSpy.mockImplementation((...args: unknown[]) => {
      const [targetPath, ...rest] = args;
      const openedPath = path.resolve(String(targetPath)) === registryPath
        ? replacementPath
        : targetPath;
      return Reflect.apply(actualOpen, fs, [openedPath, ...rest]);
    });

    try {
      const retained = await getAssistantRegistry();

      expect(retained.ALPHA.name).toBe('Alpha');
      expect(retained.SWAPPED).toBeUndefined();
      expect(assertIntegrityMock).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      await fs.unlink(replacementPath).catch(() => undefined);
    }
  });

  it('rejects a post-read path identity swap without TOFU acceptance', async () => {
    await getAssistantRegistry();
    assertIntegrityMock.mockClear();
    const replacementPath = path.join(temporaryRoot, 'replacement.json');
    await fs.writeFile(replacementPath, JSON.stringify(initialRegistry()), 'utf8');
    const replacementStats = await fs.lstat(replacementPath, { bigint: true });
    const actualLstat = fs.lstat.bind(fs);
    let targetLstatCount = 0;
    const lstatSpy = jest.spyOn(fs, 'lstat') as unknown as {
      mockImplementation(
        implementation: (...args: unknown[]) => unknown
      ): void;
      mockRestore(): void;
    };
    lstatSpy.mockImplementation((...args: unknown[]) => {
      const [targetPath] = args;
      if (path.resolve(String(targetPath)) === registryPath) {
        targetLstatCount += 1;
        if (targetLstatCount === 2) {
          return Promise.resolve(replacementStats);
        }
      }
      return Reflect.apply(actualLstat, fs, args);
    });

    try {
      const retained = await getAssistantRegistry();

      expect(targetLstatCount).toBe(2);
      expect(retained.ALPHA.name).toBe('Alpha');
      expect(assertIntegrityMock).not.toHaveBeenCalled();
    } finally {
      lstatSpy.mockRestore();
      await fs.unlink(replacementPath).catch(() => undefined);
    }
  });

  it('rejects inconsistent registry mappings before TOFU acceptance', async () => {
    await getAssistantRegistry();
    assertIntegrityMock.mockClear();
    await fs.writeFile(registryPath, JSON.stringify({
      WRONG_KEY: {
        id: 'asst_alpha',
        name: 'Alpha',
        instructions: null,
        tools: null,
        model: 'gpt-4.1-mini',
        normalizedName: 'WRONG_KEY',
      },
    }), 'utf8');

    const retained = await getAssistantRegistry();

    expect(retained.ALPHA.name).toBe('Alpha');
    expect(retained.WRONG_KEY).toBeUndefined();
    expect(assertIntegrityMock).not.toHaveBeenCalled();
  });

  it('validates bounded pagination and atomically installs a complete candidate', async () => {
    listAssistantsMock
      .mockResolvedValueOnce({
        data: [assistant('asst_alpha', 'Alpha')],
        has_more: true,
        last_id: 'asst_alpha',
      })
      .mockResolvedValueOnce({
        data: [assistant('asst_beta', 'Beta')],
        has_more: false,
        last_id: 'asst_beta',
      });

    const result = await syncAssistantRegistry();
    const persisted = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    const directoryEntries = await fs.readdir(temporaryRoot);

    expect(result.changed).toBe(true);
    expect(Object.keys(result.registry)).toEqual(['ALPHA', 'BETA']);
    expect(Object.keys(persisted)).toEqual(['ALPHA', 'BETA']);
    expect(listAssistantsMock).toHaveBeenNthCalledWith(1, {
      limit: 20,
      after: undefined,
    });
    expect(listAssistantsMock).toHaveBeenNthCalledWith(2, {
      limit: 20,
      after: 'asst_alpha',
    });
    expect(prepareIntegrityUpdateMock).toHaveBeenCalledTimes(1);
    expect(integrityCommitMock).toHaveBeenCalledTimes(1);
    expect(directoryEntries).toEqual(['assistants.json']);
  });

  it('does not report false failure when post-install integrity reporting throws', async () => {
    listAssistantsMock.mockResolvedValueOnce({
      data: [assistant('asst_beta', 'Beta')],
      has_more: false,
      last_id: 'asst_beta',
    });
    integrityCommitMock.mockImplementationOnce(() => {
      throw new Error('simulated integrity observability failure');
    });
    aiLogger.warn.mockImplementationOnce(() => {
      throw new Error('simulated logger failure');
    });

    const result = await syncAssistantRegistry();
    const persisted = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    await fs.writeFile(registryPath, '{"broken":', 'utf8');
    const retained = await getAssistantRegistry();

    expect(result).toMatchObject({
      changed: true,
      registry: {
        BETA: {
          id: 'asst_beta',
        },
      },
    });
    expect(Object.keys(persisted)).toEqual(['BETA']);
    expect(retained.BETA.id).toBe('asst_beta');
    expect(integrityCommitMock).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate normalized names and retains the prior registry', async () => {
    const before = await fs.readFile(registryPath, 'utf8');
    listAssistantsMock.mockResolvedValueOnce({
      data: [
        assistant('asst_one', 'Alpha!'),
        assistant('asst_two', 'Alpha'),
      ],
      has_more: false,
      last_id: 'asst_two',
    });

    await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
      AssistantRegistrySyncError
    );

    expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
    expect(prepareIntegrityUpdateMock).not.toHaveBeenCalled();
    expect(integrityCommitMock).not.toHaveBeenCalled();
  });

  it('rejects non-progressing cursors and retains the prior registry', async () => {
    const before = await fs.readFile(registryPath, 'utf8');
    listAssistantsMock.mockResolvedValueOnce({
      data: [assistant('asst_alpha', 'Alpha')],
      has_more: true,
      last_id: 'different_cursor',
    });

    await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
      AssistantRegistrySyncError
    );

    expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized provider fields before persistence', async () => {
    const before = await fs.readFile(registryPath, 'utf8');
    listAssistantsMock.mockResolvedValueOnce({
      data: [
        assistant('asst_oversized', 'x'.repeat(257), {
          model: 'model-sentinel',
        }),
      ],
      has_more: false,
      last_id: 'asst_oversized',
    });

    await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
      AssistantRegistrySyncError
    );

    expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
  });

  it('rejects lossy tool values before persistence or live-state mutation', async () => {
    const before = await fs.readFile(registryPath, 'utf8');
    listAssistantsMock.mockResolvedValueOnce({
      data: [
        assistant('asst_lossy', 'Lossy', {
          tools: [undefined],
        }),
      ],
      has_more: false,
      last_id: 'asst_lossy',
    });

    await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
      AssistantRegistrySyncError
    );

    expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
    expect((await getAssistantRegistry()).ALPHA.name).toBe('Alpha');
    expect(prepareIntegrityUpdateMock).not.toHaveBeenCalled();
    expect(integrityCommitMock).not.toHaveBeenCalled();
  });

  it('rejects hidden and accessor array metadata without evaluating getters', async () => {
    const before = await fs.readFile(registryPath, 'utf8');
    const getter = jest.fn(() => ({ type: 'code_interpreter' }));
    const accessorTools: unknown[] = [];
    Object.defineProperty(accessorTools, '0', {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const hiddenTools: unknown[] = [];
    Object.defineProperty(hiddenTools, 'hidden', {
      configurable: true,
      enumerable: false,
      value: 'discarded-by-json',
    });
    const symbolTools: unknown[] = [];
    Object.defineProperty(symbolTools, Symbol('hidden'), {
      configurable: true,
      enumerable: true,
      value: 'discarded-by-json',
    });

    for (const tools of [accessorTools, hiddenTools, symbolTools]) {
      listAssistantsMock.mockResolvedValueOnce({
        data: [assistant('asst_lossy', 'Lossy', { tools })],
        has_more: false,
        last_id: 'asst_lossy',
      });

      await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
        AssistantRegistrySyncError
      );
    }

    expect(getter).not.toHaveBeenCalled();
    expect(await fs.readFile(registryPath, 'utf8')).toBe(before);
    expect((await getAssistantRegistry()).ALPHA.name).toBe('Alpha');
    expect(prepareIntegrityUpdateMock).not.toHaveBeenCalled();
    expect(integrityCommitMock).not.toHaveBeenCalled();
  });

  it('reserves synchronization synchronously across direct callers', async () => {
    let resolveProvider!: (value: Record<string, unknown>) => void;
    listAssistantsMock.mockImplementationOnce(() => (
      new Promise((resolve) => {
        resolveProvider = resolve;
      })
    ));

    const first = syncAssistantRegistry();
    await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
      AssistantRegistrySyncInProgressError
    );
    resolveProvider({
      data: [assistant('asst_alpha', 'Alpha')],
      has_more: false,
      last_id: 'asst_alpha',
    });
    await expect(first).resolves.toEqual(expect.objectContaining({
      changed: true,
    }));
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);
  });

  it('does not replace a non-regular target when atomic persistence fails', async () => {
    await getAssistantRegistry();
    await fs.unlink(registryPath);
    await fs.mkdir(registryPath);
    listAssistantsMock.mockResolvedValueOnce({
      data: [assistant('asst_beta', 'Beta')],
      has_more: false,
      last_id: 'asst_beta',
    });

    await expect(syncAssistantRegistry()).rejects.toBeInstanceOf(
      AssistantRegistrySyncError
    );

    expect((await fs.lstat(registryPath)).isDirectory()).toBe(true);
    expect((await fs.readdir(temporaryRoot))).toEqual(['assistants.json']);
  });
});

afterAll(async () => {
  await fs.rm(temporaryRoot, { force: true, recursive: true });
});
