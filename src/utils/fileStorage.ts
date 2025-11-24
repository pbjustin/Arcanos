import fs from 'fs/promises';
import path from 'path';
import { logger } from './structuredLogging.js';

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
  } catch (error) {
    logger.error('Failed to write JSON file', { module: 'fileStorage', operation: 'writeJsonFile', filePath }, error as Error);
    throw error;
  }
}
