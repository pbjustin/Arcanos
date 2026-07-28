import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import * as nodeFs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  listDirectory,
  MAX_CODEBASE_DIRECTORY_ENTRIES,
  MAX_CODEBASE_READ_BYTES,
  readRepositoryFile,
  resetRepositoryRootCache,
  resolveRepositoryRoot,
} = await import('../src/services/codebaseAccess.js');

describe('codebaseAccess canonical filesystem containment', () => {
  let tempParent = '';
  let repositoryRoot = '';
  let outsideRoot = '';
  let previousCodebaseRoot: string | undefined;

  beforeEach(async () => {
    previousCodebaseRoot = process.env.CODEBASE_ROOT;
    tempParent = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'arcanos-codebase-access-'),
    );
    repositoryRoot = path.join(tempParent, 'repository');
    outsideRoot = path.join(tempParent, 'outside');
    await Promise.all([
      fsp.mkdir(repositoryRoot, { recursive: true }),
      fsp.mkdir(outsideRoot, { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(
        path.join(repositoryRoot, 'package.json'),
        '{"name":"fixture"}\n',
        'utf8',
      ),
      fsp.writeFile(
        path.join(repositoryRoot, 'inside.txt'),
        'line one\nline two\nline three\n',
        'utf8',
      ),
      fsp.writeFile(
        path.join(outsideRoot, 'private.txt'),
        'outside-private-marker\n',
        'utf8',
      ),
    ]);
    process.env.CODEBASE_ROOT = repositoryRoot;
    resetRepositoryRootCache();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (previousCodebaseRoot === undefined) {
      delete process.env.CODEBASE_ROOT;
    } else {
      process.env.CODEBASE_ROOT = previousCodebaseRoot;
    }
    resetRepositoryRootCache();
    await fsp.rm(tempParent, { recursive: true, force: true });
  });

  it('reads ordinary files and lists ordinary repository entries', async () => {
    await expect(readRepositoryFile('inside.txt')).resolves.toMatchObject({
      path: 'inside.txt',
      content: 'line one\nline two\nline three\n',
      binary: false,
      truncated: false,
      startLine: 1,
    });
    await expect(listDirectory()).resolves.toEqual({
      path: '',
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: 'inside.txt',
          path: 'inside.txt',
          type: 'file',
        }),
        expect.objectContaining({
          name: 'package.json',
          path: 'package.json',
          type: 'file',
        }),
      ]),
    });
  });

  it('rejects traversal, absolute, alternate-stream, and ambiguous Windows paths', async () => {
    const invalidPaths = [
      '../outside/private.txt',
      '/outside/private.txt',
      'C:\\outside\\private.txt',
      '\\\\server\\share\\private.txt',
      'inside.txt:private-stream',
      'folder./inside.txt',
      'folder /inside.txt',
    ];

    for (const invalidPath of invalidPaths) {
      await expect(readRepositoryFile(invalidPath)).rejects.toThrow();
    }
  });

  it('fails closed when an explicit repository root is invalid', () => {
    process.env.CODEBASE_ROOT = outsideRoot;
    resetRepositoryRootCache();

    expect(() => resolveRepositoryRoot()).toThrow(
      'Configured repository root is unavailable',
    );
  });

  it('rejects outside directory links without following child metadata', async () => {
    const linkedDirectory = path.join(repositoryRoot, 'outside-link');
    try {
      await fsp.symlink(
        outsideRoot,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        ['EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        return;
      }
      throw error;
    }

    const rootListing = await listDirectory();
    expect(rootListing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'outside-link',
          type: 'file',
        }),
      ]),
    );
    await expect(listDirectory('outside-link')).rejects.toThrow();
    await expect(
      readRepositoryFile('outside-link/private.txt'),
    ).rejects.toThrow();
    expect(JSON.stringify(rootListing)).not.toContain(
      'outside-private-marker',
    );
  });

  it('uses bounded handle reads and rejects invalid byte limits', async () => {
    const largePath = path.join(repositoryRoot, 'large.txt');
    await fsp.writeFile(
      largePath,
      Buffer.alloc(MAX_CODEBASE_READ_BYTES + 1024, 0x61),
    );
    const readFileSpy = jest.spyOn(nodeFs.promises, 'readFile');

    const result = await readRepositoryFile('large.txt', {
      maxBytes: 1024,
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content ?? '', 'utf8')).toBe(1024);
    expect(readFileSpy).not.toHaveBeenCalled();
    for (const maxBytes of [
      0,
      -1,
      1.5,
      MAX_CODEBASE_READ_BYTES + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      await expect(
        readRepositoryFile('inside.txt', { maxBytes }),
      ).rejects.toThrow();
    }
  });

  it('rejects invalid line bounds', async () => {
    await expect(
      readRepositoryFile('inside.txt', { startLine: 0 }),
    ).rejects.toThrow();
    await expect(
      readRepositoryFile('inside.txt', { startLine: 2.5 }),
    ).rejects.toThrow();
    await expect(
      readRepositoryFile('inside.txt', {
        startLine: 3,
        endLine: 2,
      }),
    ).rejects.toThrow();
  });

  it('fails closed before materializing a directory above the entry cap', async () => {
    const largeDirectory = path.join(repositoryRoot, 'large-directory');
    await fsp.mkdir(largeDirectory);
    await Promise.all(
      Array.from(
        { length: MAX_CODEBASE_DIRECTORY_ENTRIES + 1 },
        (_value, index) =>
          fsp.writeFile(
            path.join(largeDirectory, `entry-${index}.txt`),
            '',
            'utf8',
          ),
      ),
    );

    await expect(listDirectory('large-directory')).rejects.toThrow(
      'Directory exceeds the codebase listing limit',
    );
  });
});
