import fs from 'fs/promises';
import path from 'path';
import { FileStorageError } from '../lib/errors.js';

interface JsonWriteOptions {
  space?: number;
}

export async function ensureDirectoryForFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeJsonFile<T>(filePath: string, data: T, options: JsonWriteOptions = {}): Promise<void> {
  const { space = 2 } = options;
  const serialized = JSON.stringify(data, null, space);

  try {
    await ensureDirectoryForFile(filePath);
    await fs.writeFile(filePath, serialized);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FileStorageError('FileWriteError', undefined, `Failed to write JSON file at ${filePath}: ${message}`);
  }
}
