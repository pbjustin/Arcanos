import fs from 'fs/promises';
import path from 'path';
import { FileStorageError } from './errors.js';
import { resolveErrorMessage } from "@shared/errorUtils.js";

interface JsonWriteOptions {
  space?: number;
}

/**
 * Ensure a directory exists for a target file path.
 * Purpose: Create parent directories before write operations.
 * Inputs/Outputs: Receives a file path and creates missing directories.
 * Edge cases: Uses recursive creation so existing paths do not throw.
 */
export async function ensureDirectoryForFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Write JSON data to disk with deterministic formatting.
 * Purpose: Persist JSON payloads for shared storage consumers.
 * Inputs/Outputs: Accepts destination path, serializable data, and spacing options.
 * Edge cases: Wraps filesystem failures in FileStorageError with contextual detail.
 */
export async function writeJsonFile<T>(filePath: string, data: T, options: JsonWriteOptions = {}): Promise<void> {
  const { space = 2 } = options;
  const serialized = JSON.stringify(data, null, space);

  try {
    await ensureDirectoryForFile(filePath);
    await fs.writeFile(filePath, serialized);
  } catch (error: unknown) {
    const message = resolveErrorMessage(error);
    //audit Assumption: file write errors should surface to caller with context; risk: masked filesystem failures; invariant: thrown error contains file path and root message; handling: throw shared FileStorageError.
    throw new FileStorageError('FileWriteError', `Failed to write JSON file at ${filePath}: ${message}`, { cause: error });
  }
}
