import fs from 'fs';
import path from 'path';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  resolveWorkerModuleFile,
  resolveWorkersDirectory
} from '../../../src/platform/runtime/workerPaths.js';

type ExistsMap = Set<string>;

function makeFsMocks(existsDirs: ExistsMap) {
  jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
    return existsDirs.has(String(p));
  });

  jest.spyOn(fs, 'statSync').mockImplementation((p: any) => {
    const key = String(p);
    if (!existsDirs.has(key)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${key}'`), { code: 'ENOENT' });
    }
    return {
      isDirectory: () => true
    } as any;
  });
}

describe('resolveWorkersDirectory', () => {
  const originalEnv = { ...process.env };
  let cwdSpy: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    if (cwdSpy) cwdSpy.mockRestore();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test('WORKERS_DIRECTORY env override is highest priority (relative)', () => {
    const cwd = path.resolve('/app');
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);

    process.env.WORKERS_DIRECTORY = 'custom/workers';
    const overrideAbs = path.resolve(cwd, 'custom/workers');

    const existsDirs: ExistsMap = new Set([overrideAbs]);
    makeFsMocks(existsDirs);

    const result = resolveWorkersDirectory();
    expect(result.exists).toBe(true);
    expect(result.path).toBe(overrideAbs);
    expect(result.checked[0]).toBe(overrideAbs);
  });

  test('prefers source workers when dist/workers does not exist (dev reliability)', () => {
    const cwd = path.resolve('/app');
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);

    // dist/workers missing
    const distWorkers = path.resolve(cwd, 'dist', 'workers');
    // source workers exists
    const sourceWorkers = path.resolve(cwd, 'workers');

    const existsDirs: ExistsMap = new Set([sourceWorkers]);
    makeFsMocks(existsDirs);

    const result = resolveWorkersDirectory();
    expect(result.exists).toBe(true);
    expect(result.path).toBe(sourceWorkers);
    expect(result.checked).toContain(distWorkers); // checked but not chosen
    expect(result.checked).toContain(sourceWorkers);
  });

  test('when cwd ends with dist, checks cwd/workers (avoids dist/dist/workers)', () => {
    const cwd = path.resolve('/app/dist');
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);

    const cwdWorkers = path.resolve(cwd, 'workers'); // /app/dist/workers
    const badDoubleDist = path.resolve(cwd, 'dist', 'workers'); // /app/dist/dist/workers (should be checked at most, but not required)

    const existsDirs: ExistsMap = new Set([cwdWorkers]);
    makeFsMocks(existsDirs);

    const result = resolveWorkersDirectory();
    expect(result.exists).toBe(true);
    expect(result.path).toBe(cwdWorkers);
    // Ensure we do not "fallback" to /dist/dist/workers
    expect(result.path).not.toBe(badDoubleDist);
  });

  test('fallback target is cwd/workers when nothing exists (no misleading dist fallback)', () => {
    const cwd = path.resolve('/app');
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);

    const existsDirs: ExistsMap = new Set([]);
    makeFsMocks(existsDirs);

    const result = resolveWorkersDirectory();
    expect(result.exists).toBe(false);
    expect(result.path).toBe(path.resolve(cwd, 'workers'));
  });
});

describe('resolveWorkerModuleFile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    '../../workers/dist/worker-logger',
    '../../scripts/migration-repair',
    '..\\..\\workers\\dist\\worker-logger',
    '/tmp/worker',
    'C:\\temp\\worker',
    '\\\\server\\share\\worker',
    'nested/worker',
    'nested\\worker',
    '%2e%2e%2fworker',
    '\0worker',
    '.',
    '..',
    'a'.repeat(129),
    ''
  ])('rejects non-module worker identifier %p before touching the filesystem', (workerId) => {
    const existsSpy = jest.spyOn(fs, 'existsSync');

    expect(resolveWorkerModuleFile(path.resolve('/app/workers'), workerId)).toEqual({
      status: 'invalid_worker_id'
    });
    expect(existsSpy).not.toHaveBeenCalled();
  });

  test.each([
    'metricsAgent',
    'worker-gpt5-reasoning',
    'worker.module_v1'
  ])('resolves existing regular worker file %p beneath the canonical worker root', (workerId) => {
    const workersDirectory = path.resolve('/app/workers');
    const candidatePath = path.resolve(workersDirectory, `${workerId}.js`);

    jest.spyOn(fs, 'existsSync').mockImplementation((value: any) => String(value) === candidatePath);
    jest.spyOn(fs, 'statSync').mockReturnValue({
      isFile: () => true
    } as any);
    jest.spyOn(fs, 'realpathSync').mockImplementation(((value: any) => String(value)) as any);

    expect(resolveWorkerModuleFile(workersDirectory, workerId)).toEqual({
      status: 'ready',
      path: candidatePath
    });
  });

  test('rejects an existing worker file whose canonical path escapes through a symlink', () => {
    const workersDirectory = path.resolve('/app/workers');
    const candidatePath = path.resolve(workersDirectory, 'linkedWorker.js');
    const outsidePath = path.resolve('/outside/linkedWorker.js');

    jest.spyOn(fs, 'existsSync').mockImplementation((value: any) => String(value) === candidatePath);
    jest.spyOn(fs, 'statSync').mockReturnValue({
      isFile: () => true
    } as any);
    jest.spyOn(fs, 'realpathSync').mockImplementation(((value: any) => {
      return String(value) === workersDirectory ? workersDirectory : outsidePath;
    }) as any);

    expect(resolveWorkerModuleFile(workersDirectory, 'linkedWorker')).toEqual({
      status: 'outside_workers_directory'
    });
  });

  test('does not treat a directory with a JavaScript suffix as an executable worker module', () => {
    const workersDirectory = path.resolve('/app/workers');
    const candidatePath = path.resolve(workersDirectory, 'directoryWorker.js');

    jest.spyOn(fs, 'existsSync').mockImplementation((value: any) => String(value) === candidatePath);
    jest.spyOn(fs, 'statSync').mockReturnValue({
      isFile: () => false
    } as any);

    expect(resolveWorkerModuleFile(workersDirectory, 'directoryWorker')).toEqual({
      status: 'not_found'
    });
  });
});
