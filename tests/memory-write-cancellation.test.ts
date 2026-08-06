import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockReadFile = jest.fn();
const mockUnlink = jest.fn();

jest.unstable_mockModule('fs', () => ({
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    unlink: mockUnlink,
  },
}));

const { setMemory } = await import('../src/services/memory.js');

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createAbortReason(message: string): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

describe('file memory write cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('rejects an expired deadline before scheduling filesystem work', async () => {
    await expect(setMemory(
      'research/deadline/summary',
      { insight: 'must not persist' },
      { deadlineAt: Date.now() - 1 },
    )).rejects.toMatchObject({
      name: 'AbortError',
      message: 'memory write deadline exceeded',
    });

    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('waits for an in-flight mkdir to settle and never starts the write after abort', async () => {
    const mkdirStarted = createDeferred();
    const releaseMkdir = createDeferred();
    mockMkdir.mockImplementationOnce(async () => {
      mkdirStarted.resolve();
      await releaseMkdir.promise;
    });
    const controller = new AbortController();
    const abortReason = createAbortReason('cancelled during mkdir');
    let memorySettled = false;

    const memoryWrite = setMemory(
      'research/mkdir/summary',
      { insight: 'bounded' },
      { signal: controller.signal, deadlineAt: Date.now() + 30_000 },
    );
    void memoryWrite.then(
      () => { memorySettled = true; },
      () => { memorySettled = true; },
    );

    await mkdirStarted.promise;
    controller.abort(abortReason);
    await Promise.resolve();
    expect(memorySettled).toBe(false);

    releaseMkdir.resolve();
    await expect(memoryWrite).rejects.toBe(abortReason);
    expect(memorySettled).toBe(true);
    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('forwards the exact signal to writeFile and waits for cooperative write drain', async () => {
    const writeStarted = createDeferred();
    const releaseWrite = createDeferred();
    const controller = new AbortController();
    const abortReason = createAbortReason('cancelled during write');
    let observedSignal: AbortSignal | undefined;
    let writeObservedAbort = false;
    let writeSettled = false;
    let memorySettled = false;

    mockWriteFile.mockImplementationOnce(
      async (_filePath: string, _value: string, options: { signal?: AbortSignal }) => {
        observedSignal = options.signal;
        writeStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            writeObservedAbort = true;
            void releaseWrite.promise.then(() => {
              writeSettled = true;
              reject(options.signal?.reason);
            });
          };
          if (options.signal?.aborted) {
            onAbort();
          } else {
            options.signal?.addEventListener('abort', onAbort, { once: true });
          }
        });
      },
    );

    const memoryWrite = setMemory(
      'research/write/summary',
      { insight: 'bounded' },
      { signal: controller.signal, deadlineAt: Date.now() + 30_000 },
    );
    void memoryWrite.then(
      () => { memorySettled = true; },
      () => { memorySettled = true; },
    );

    await writeStarted.promise;
    expect(observedSignal).toBe(controller.signal);
    controller.abort(abortReason);
    await Promise.resolve();
    expect(writeObservedAbort).toBe(true);
    expect(writeSettled).toBe(false);
    expect(memorySettled).toBe(false);

    releaseWrite.resolve();
    await expect(memoryWrite).rejects.toBe(abortReason);
    expect(writeSettled).toBe(true);
    expect(memorySettled).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile.mock.calls[0]?.[2]).toEqual({
      encoding: 'utf-8',
      signal: controller.signal,
    });
  });
});
