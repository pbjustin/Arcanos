import fs, { promises as fsp, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from "@platform/runtime/env.js";

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export interface ReadFileOptions {
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface FileReadResult {
  path: string;
  size: number;
  modifiedAt: string;
  content?: string;
  binary: boolean;
  truncated: boolean;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
}

export const DEFAULT_CODEBASE_MAX_BYTES = 250 * 1024;
export const MAX_CODEBASE_READ_BYTES = 262_144;
export const MAX_CODEBASE_DIRECTORY_ENTRIES = 256;
export const MAX_CODEBASE_RELATIVE_PATH_CHARS = 1024;
export const MAX_CODEBASE_LINE_NUMBER = 1_000_000;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
let cachedRoot: string | null = null;

function candidateRepositoryRoots(): string[] {
  const candidates: string[] = [];
  // Use config layer for env access (adapter boundary pattern)
  const envRoot = getEnv('CODEBASE_ROOT');
  if (envRoot) {
    candidates.push(path.isAbsolute(envRoot) ? envRoot : path.resolve(process.cwd(), envRoot));
  }

  candidates.push(process.cwd());

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(moduleDir, '../../'));
  candidates.push(path.resolve(moduleDir, '../../../'));

  return [...new Set(candidates)];
}

function hasRepositoryMarker(directory: string): boolean {
  try {
    return fs.existsSync(path.join(directory, 'package.json'));
  } catch {
    return false;
  }
}

function resolveCanonicalDirectorySync(directory: string): string | null {
  try {
    const canonical = fs.realpathSync.native(directory);
    const stats = fs.lstatSync(canonical);
    return stats.isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

export function resolveRepositoryRoot(): string {
  if (cachedRoot) {
    return cachedRoot;
  }

  const configuredRoot = getEnv('CODEBASE_ROOT');
  if (configuredRoot) {
    const resolvedConfiguredRoot = path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(process.cwd(), configuredRoot);
    const canonicalConfiguredRoot =
      resolveCanonicalDirectorySync(resolvedConfiguredRoot);
    if (
      !canonicalConfiguredRoot ||
      !hasRepositoryMarker(canonicalConfiguredRoot)
    ) {
      throw new Error('Configured repository root is unavailable');
    }
    cachedRoot = canonicalConfiguredRoot;
    return cachedRoot;
  }

  for (const candidate of candidateRepositoryRoots()) {
    const resolved = path.resolve(candidate);
    const canonical = resolveCanonicalDirectorySync(resolved);
    if (canonical && hasRepositoryMarker(canonical)) {
      cachedRoot = canonical;
      return cachedRoot;
    }
  }

  const fallback = resolveCanonicalDirectorySync(process.cwd());
  if (!fallback) {
    throw new Error('Repository root is unavailable');
  }
  cachedRoot = fallback;
  return cachedRoot;
}

function ensureWithinRepository(resolvedPath: string, root: string): void {
  const relative = path.relative(root, resolvedPath);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Path is outside of repository root');
  }
}

function normalizeRelativePath(relativePath = ''): string {
  if (typeof relativePath !== 'string') {
    throw new Error('Repository path must be a string');
  }
  if (relativePath.length === 0) {
    return '';
  }
  if (
    relativePath.length > MAX_CODEBASE_RELATIVE_PATH_CHARS ||
    relativePath.includes('\0')
  ) {
    throw new Error('Repository path is invalid');
  }

  const cleaned = relativePath.replace(/\\/g, '/');
  if (
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(cleaned) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    throw new Error('Absolute repository paths are not allowed');
  }

  const segments = cleaned.split('/');
  if (
    segments.some(segment =>
      segment === '..' ||
      segment.includes(':') ||
      /[ .]$/u.test(segment) ||
      (process.platform === 'win32' &&
        WINDOWS_DEVICE_NAME_PATTERN.test(segment))
    )
  ) {
    throw new Error('Repository path is invalid');
  }

  const normalized = path.posix.normalize(cleaned);
  return normalized === '.' ? '' : normalized;
}

export function resolveSafePath(relativePath = ''): { absolutePath: string; relativePath: string; root: string } {
  const root = resolveRepositoryRoot();
  const normalizedRelative = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(root, normalizedRelative);
  ensureWithinRepository(absolutePath, root);
  return { absolutePath, relativePath: normalizedRelative, root };
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function toJsonSafeFileSize(size: bigint): number {
  return size > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(size);
}

async function assertPathHasNoSymbolicLinks(
  root: string,
  relativePath: string,
): Promise<void> {
  let currentPath = root;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stats = await fsp.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error('Symbolic links are not available through codebase access');
    }
  }
}

async function resolveCanonicalRepositoryPath(
  relativePath = '',
): Promise<{
  absolutePath: string;
  relativePath: string;
  root: string;
}> {
  const resolved = resolveSafePath(relativePath);
  const canonicalRoot = await fsp.realpath(resolved.root);
  ensureWithinRepository(canonicalRoot, resolved.root);
  await assertPathHasNoSymbolicLinks(
    canonicalRoot,
    resolved.relativePath,
  );
  const canonicalPath = await fsp.realpath(resolved.absolutePath);
  ensureWithinRepository(canonicalPath, canonicalRoot);
  const canonicalRelative = path.relative(canonicalRoot, canonicalPath);
  return {
    absolutePath: canonicalPath,
    relativePath: canonicalRelative.replace(/\\/g, '/'),
    root: canonicalRoot,
  };
}

function validatePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  fieldName: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(`${fieldName} is outside the allowed range`);
  }
  return value;
}

export async function listDirectory(
  relativePath = '',
): Promise<{ entries: DirectoryEntry[]; path: string }> {
  const {
    absolutePath,
    relativePath: normalizedRelative,
    root,
  } = await resolveCanonicalRepositoryPath(relativePath);
  const beforeStats = await fsp.lstat(absolutePath, { bigint: true });
  if (beforeStats.isSymbolicLink() || !beforeStats.isDirectory()) {
    throw new Error('Requested path is not a directory');
  }

  const directory = await fsp.opendir(absolutePath);
  const entries: DirectoryEntry[] = [];
  let observedEntryCount = 0;
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) {
        break;
      }
      observedEntryCount += 1;
      if (observedEntryCount > MAX_CODEBASE_DIRECTORY_ENTRIES) {
        throw new Error('Directory exceeds the codebase listing limit');
      }

      const entryPath = path.join(absolutePath, entry.name);
      const entryStats = await fsp.lstat(entryPath, { bigint: true });
      const relative = path.relative(root, entryPath) || entry.name;
      ensureWithinRepository(entryPath, root);
      entries.push({
        name: entry.name,
        path: relative.replace(/\\/g, '/'),
        type:
          !entryStats.isSymbolicLink() && entryStats.isDirectory()
            ? 'directory'
            : 'file',
        size: toJsonSafeFileSize(entryStats.size),
        modifiedAt: entryStats.mtime.toISOString(),
      });
    }
  } finally {
    await directory.close().catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
        throw error;
      }
    });
  }

  await assertPathHasNoSymbolicLinks(root, normalizedRelative);
  const afterStats = await fsp.lstat(absolutePath, { bigint: true });
  if (
    afterStats.isSymbolicLink() ||
    !afterStats.isDirectory() ||
    !sameFileIdentity(beforeStats, afterStats)
  ) {
    throw new Error('Directory changed during codebase access');
  }
  entries.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'directory' ? -1 : 1;
  });

  return { entries, path: normalizedRelative };
}

function detectBinary(buffer: Buffer): boolean {
  if (!buffer.length) {
    return false;
  }
  const sample = buffer.slice(0, Math.min(buffer.length, 1024));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

export async function readRepositoryFile(relativePath: string, options: ReadFileOptions = {}): Promise<FileReadResult> {
  const maxBytes = validatePositiveInteger(
    options.maxBytes,
    DEFAULT_CODEBASE_MAX_BYTES,
    MAX_CODEBASE_READ_BYTES,
    'maxBytes',
  );
  const requestedStartLine = validatePositiveInteger(
    options.startLine,
    1,
    MAX_CODEBASE_LINE_NUMBER,
    'startLine',
  );
  const requestedEndLine =
    options.endLine === undefined
      ? undefined
      : validatePositiveInteger(
          options.endLine,
          requestedStartLine,
          MAX_CODEBASE_LINE_NUMBER,
          'endLine',
        );
  if (
    requestedEndLine !== undefined &&
    requestedEndLine < requestedStartLine
  ) {
    throw new Error('endLine must not precede startLine');
  }

  const {
    absolutePath,
    relativePath: normalizedRelative,
    root,
  } = await resolveCanonicalRepositoryPath(relativePath);
  const beforePathStats = await fsp.lstat(absolutePath, { bigint: true });
  if (beforePathStats.isSymbolicLink() || !beforePathStats.isFile()) {
    throw new Error('Requested path is not a file');
  }

  // O_NOFOLLOW closes the final-component swap where the platform exposes it.
  // Windows Node does not expose that flag, so the post-open canonical and
  // identity checks below remain defense in depth rather than a race-free proof.
  const openFlags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fsp.open(absolutePath, openFlags);
  let fileStats: BigIntStats;
  let raw: Buffer;
  try {
    fileStats = await handle.stat({ bigint: true });
    if (
      !fileStats.isFile() ||
      !sameFileIdentity(beforePathStats, fileStats)
    ) {
      throw new Error('File changed before codebase access');
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const readResult = await handle.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (readResult.bytesRead === 0) {
        break;
      }
      totalBytesRead += readResult.bytesRead;
    }
    raw = buffer.subarray(0, totalBytesRead);

    const afterHandleStats = await handle.stat({ bigint: true });
    await assertPathHasNoSymbolicLinks(root, normalizedRelative);
    const afterPathStats = await fsp.lstat(absolutePath, {
      bigint: true,
    });
    const afterCanonicalPath = await fsp.realpath(absolutePath);
    ensureWithinRepository(afterCanonicalPath, root);
    if (
      path.relative(absolutePath, afterCanonicalPath) !== '' ||
      afterPathStats.isSymbolicLink() ||
      !sameFileIdentity(fileStats, afterHandleStats) ||
      !sameFileIdentity(fileStats, afterPathStats) ||
      fileStats.size !== afterHandleStats.size ||
      fileStats.mtimeNs !== afterHandleStats.mtimeNs
    ) {
      throw new Error('File changed during codebase access');
    }
  } finally {
    await handle.close();
  }

  const binary = detectBinary(raw);
  const truncated =
    fileStats.size > BigInt(maxBytes) || raw.length > maxBytes;
  if (binary) {
    return {
      path: normalizedRelative,
      size: toJsonSafeFileSize(fileStats.size),
      modifiedAt: fileStats.mtime.toISOString(),
      binary: true,
      truncated,
    };
  }

  let content = raw.subarray(0, maxBytes).toString('utf8');

  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  let startLine = requestedStartLine;
  let endLine = requestedEndLine ?? totalLines;

  startLine = Math.max(1, Math.min(startLine, totalLines));
  endLine = Math.max(startLine, Math.min(endLine, totalLines));

  if (startLine !== 1 || endLine !== totalLines) {
    content = lines.slice(startLine - 1, endLine).join('\n');
  }

  return {
    path: normalizedRelative,
    size: toJsonSafeFileSize(fileStats.size),
    modifiedAt: fileStats.mtime.toISOString(),
    content,
    binary: false,
    truncated,
    totalLines,
    startLine,
    endLine,
  };
}

export function resetRepositoryRootCache(): void {
  cachedRoot = null;
}
