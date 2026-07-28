import fs from 'fs/promises';
import path from 'path';

export type RepositoryFileAccessResult =
  | {
      status: 'missing';
    }
  | {
      status: 'unsafe';
    }
  | {
      status: 'regular-file';
      canonicalFilePath: string;
    };

function isContainedRelativePath(relativePath: string): boolean {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function isMissingFileError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Classify one existing repository path without following it outside the root.
 * Missing paths are retained for deleted-file PRs; unsafe paths fail closed.
 */
export async function classifyRepositoryFileAccess(
  basePath: string,
  file: string
): Promise<RepositoryFileAccessResult> {
  const canonicalBasePath = await fs.realpath(basePath);
  const candidatePath = path.resolve(canonicalBasePath, file);
  const lexicalRelativePath = path.relative(canonicalBasePath, candidatePath);
  if (!isContainedRelativePath(lexicalRelativePath)) {
    return { status: 'unsafe' };
  }

  let canonicalFilePath: string;
  try {
    canonicalFilePath = await fs.realpath(candidatePath);
  } catch (error) {
    return isMissingFileError(error)
      ? { status: 'missing' }
      : { status: 'unsafe' };
  }
  const canonicalRelativePath = path.relative(
    canonicalBasePath,
    canonicalFilePath
  );
  if (!isContainedRelativePath(canonicalRelativePath)) {
    return { status: 'unsafe' };
  }

  try {
    const stats = await fs.stat(canonicalFilePath);
    return stats.isFile()
      ? { status: 'regular-file', canonicalFilePath }
      : { status: 'unsafe' };
  } catch (error) {
    return isMissingFileError(error)
      ? { status: 'missing' }
      : { status: 'unsafe' };
  }
}

/**
 * Purpose: Count total lines in a file for size-based checks.
 * Inputs/Outputs: basePath + repository-relative file path; returns a bounded
 * newline-separated line count.
 * Edge cases: Rejects path traversal, escaping symlinks, and non-regular files.
 */
export async function getFileLineCount(
  basePath: string,
  file: string,
  maxLines = Number.MAX_SAFE_INTEGER
): Promise<number> {
  const access = await classifyRepositoryFileAccess(basePath, file);
  if (access.status === 'unsafe') {
    throw new Error('PR file path must remain inside the repository.');
  }
  if (access.status === 'missing') {
    throw new Error('PR file path does not exist.');
  }

  const boundedMaxLines = Number.isSafeInteger(maxLines) && maxLines > 0
    ? maxLines
    : Number.MAX_SAFE_INTEGER;
  const fileHandle = await fs.open(access.canonicalFilePath, 'r');
  try {
    const stats = await fileHandle.stat();
    if (!stats.isFile()) {
      throw new Error('PR file path must reference a regular file.');
    }

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let lineCount = 1;
    let position = 0;
    while (lineCount < boundedMaxLines) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        buffer.byteLength,
        position
      );
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 0x0a) {
          lineCount += 1;
          if (lineCount >= boundedMaxLines) {
            break;
          }
        }
      }
    }
    return lineCount;
  } finally {
    await fileHandle.close();
  }
}

/**
 * Purpose: Extract regex matches from a diff for analysis.
 * Inputs/Outputs: diff string + pattern; returns array of matches or empty array.
 * Edge cases: No matches returns empty array.
 */
export function collectMatches(diff: string, pattern: RegExp): string[] {
  return diff.match(pattern) || [];
}

/**
 * Purpose: Detect whether any function addition exceeds the line threshold.
 * Inputs/Outputs: longFunctions list + threshold; returns true if any exceed threshold.
 * Edge cases: Empty list returns false.
 */
export function hasLongFunctionAddition(longFunctions: string[], threshold: number): boolean {
  return longFunctions.some(fn => fn.split('\n').length > threshold);
}

/**
 * Purpose: Normalize a list of strings to unique values.
 * Inputs/Outputs: string list; returns de-duplicated list.
 * Edge cases: Empty list returns empty list.
 */
export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Purpose: Convert camelCase check keys into human-readable labels.
 * Inputs/Outputs: check key string; returns spaced label.
 * Edge cases: Non-camelCase strings return unchanged.
 */
export function formatCheckLabel(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
