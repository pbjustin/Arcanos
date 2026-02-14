import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// We test the extractor and zipSlipGuard directly
import { guardZipSlip } from '../src/upload/utils/zipSlipGuard';

describe('guardZipSlip', () => {
  it('allows paths inside the base directory', () => {
    expect(() =>
      guardZipSlip('/tmp/uploads', '/tmp/uploads/file.txt')
    ).not.toThrow();
  });

  it('allows nested paths inside the base directory', () => {
    expect(() =>
      guardZipSlip('/tmp/uploads', '/tmp/uploads/sub/deep/file.txt')
    ).not.toThrow();
  });

  it('blocks paths that escape the base directory via ..', () => {
    expect(() =>
      guardZipSlip('/tmp/uploads', '/tmp/uploads/../etc/passwd')
    ).toThrow('Zip Slip detected');
  });

  it('blocks paths that are entirely outside the base directory', () => {
    expect(() =>
      guardZipSlip('/tmp/uploads', '/etc/passwd')
    ).toThrow('Zip Slip detected');
  });

  it('blocks paths that are prefix matches but not actual children', () => {
    // /tmp/uploads-evil is a prefix match of /tmp/uploads but not a child
    expect(() =>
      guardZipSlip('/tmp/uploads', '/tmp/uploads-evil/file.txt')
    ).toThrow('Zip Slip detected');
  });
});

describe('extractZip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extractor-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects non-zip files', async () => {
    // Create a fake file that is not a zip
    const fakePath = path.join(tmpDir, 'fake.zip');
    await fs.writeFile(fakePath, 'this is not a zip file');

    const outputDir = path.join(tmpDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });

    // Dynamic import to handle ESM
    const { extractZip } = await import('../src/upload/services/extractor');

    await expect(extractZip(fakePath, outputDir)).rejects.toThrow();
  });

  it('rejects when zip file does not exist', async () => {
    const outputDir = path.join(tmpDir, 'output');
    await fs.mkdir(outputDir, { recursive: true });

    const { extractZip } = await import('../src/upload/services/extractor');

    await expect(
      extractZip(path.join(tmpDir, 'nonexistent.zip'), outputDir)
    ).rejects.toThrow();
  });
});

describe('UploadError', () => {
  it('carries a statusCode', async () => {
    const { UploadError } = await import('../src/upload/types/upload');
    const err = new UploadError('test error', 413);
    expect(err.message).toBe('test error');
    expect(err.statusCode).toBe(413);
    expect(err.name).toBe('UploadError');
  });

  it('defaults statusCode to 400', async () => {
    const { UploadError } = await import('../src/upload/types/upload');
    const err = new UploadError('bad');
    expect(err.statusCode).toBe(400);
  });
});
