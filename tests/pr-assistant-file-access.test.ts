import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  classifyRepositoryFileAccess,
  getFileLineCount,
} from '../src/services/prAssistant/utils.js';

const cleanupPaths: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

describe('PR Assistant repository file access', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(cleanupPaths.splice(0).map(async (cleanupPath) => {
      await fs.rm(cleanupPath, { recursive: true, force: true });
    }));
  });

  it('rejects lexical traversal outside the repository root', async () => {
    const parent = await createTempDirectory('arcanos-pr-parent-');
    const repositoryRoot = path.join(parent, 'repository');
    const outsideFile = path.join(parent, 'outside.txt');
    await fs.mkdir(repositoryRoot);
    await fs.writeFile(outsideFile, 'outside\ncontent\n', 'utf8');

    await expect(
      getFileLineCount(repositoryRoot, '../outside.txt', 10)
    ).rejects.toThrow('must remain inside the repository');
  });

  it('rejects a repository symlink that resolves outside the root', async () => {
    const parent = await createTempDirectory('arcanos-pr-symlink-');
    const repositoryRoot = path.join(parent, 'repository');
    const outsideDirectory = path.join(parent, 'outside');
    await fs.mkdir(repositoryRoot);
    await fs.mkdir(outsideDirectory);
    await fs.writeFile(
      path.join(outsideDirectory, 'outside.txt'),
      'outside\ncontent\n',
      'utf8'
    );
    await fs.symlink(
      outsideDirectory,
      path.join(repositoryRoot, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await expect(
      getFileLineCount(repositoryRoot, 'escape/outside.txt', 10)
    ).rejects.toThrow('must remain inside the repository');
    await expect(
      classifyRepositoryFileAccess(repositoryRoot, 'escape/outside.txt')
    ).resolves.toEqual({ status: 'unsafe' });
  });

  it('rejects repository directories as non-regular files', async () => {
    const repositoryRoot = await createTempDirectory('arcanos-pr-directory-');
    await fs.mkdir(path.join(repositoryRoot, 'nested'));

    await expect(
      classifyRepositoryFileAccess(repositoryRoot, 'nested')
    ).resolves.toEqual({ status: 'unsafe' });
  });

  it.each([
    ['a file that disappears before stat', 'ENOENT', { status: 'missing' }],
    ['an unexpected stat failure', 'EACCES', { status: 'unsafe' }]
  ])('fails closed for %s', async (_label, errorCode, expectedResult) => {
    const repositoryRoot = await createTempDirectory('arcanos-pr-stat-race-');
    await fs.writeFile(path.join(repositoryRoot, 'candidate.ts'), 'line\n', 'utf8');
    jest.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('simulated stat race'), { code: errorCode })
    );

    await expect(
      classifyRepositoryFileAccess(repositoryRoot, 'candidate.ts')
    ).resolves.toEqual(expectedResult);
  });

  it('fails closed when canonicalization fails for a reason other than a missing file', async () => {
    const repositoryRoot = await createTempDirectory('arcanos-pr-realpath-error-');
    const realpathError = Object.assign(new Error('simulated realpath failure'), {
      code: 'EACCES'
    });
    jest.spyOn(fs, 'realpath')
      .mockResolvedValueOnce(repositoryRoot)
      .mockRejectedValueOnce(realpathError);

    await expect(
      classifyRepositoryFileAccess(repositoryRoot, 'candidate.ts')
    ).resolves.toEqual({ status: 'unsafe' });
  });

  it('stops counting once the requested line threshold is reached', async () => {
    const repositoryRoot = await createTempDirectory('arcanos-pr-lines-');
    await fs.writeFile(
      path.join(repositoryRoot, 'large.ts'),
      Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n'),
      'utf8'
    );

    await expect(
      getFileLineCount(repositoryRoot, 'large.ts', 501)
    ).resolves.toBe(501);
  });

  it('uses an unbounded fallback for an invalid line threshold', async () => {
    const repositoryRoot = await createTempDirectory('arcanos-pr-invalid-limit-');
    await fs.writeFile(path.join(repositoryRoot, 'small.ts'), 'one\ntwo\nthree', 'utf8');

    await expect(
      getFileLineCount(repositoryRoot, 'small.ts', 0)
    ).resolves.toBe(3);
  });

  it('rejects a file that changes type after access classification', async () => {
    const repositoryRoot = await createTempDirectory('arcanos-pr-open-race-');
    await fs.writeFile(path.join(repositoryRoot, 'candidate.ts'), 'line\n', 'utf8');
    const close = jest.fn(async () => undefined);
    jest.spyOn(fs, 'open').mockResolvedValueOnce({
      stat: async () => ({
        isFile: () => false
      }),
      close
    } as Awaited<ReturnType<typeof fs.open>>);

    await expect(
      getFileLineCount(repositoryRoot, 'candidate.ts', 10)
    ).rejects.toThrow('must reference a regular file');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
