import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { readdir, readFile, stat } = fsp;

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

const DEFAULT_MAX_BYTES = 250 * 1024;
let cachedRoot: string | null = null;

function candidateRepositoryRoots(): string[] {
  const candidates: string[] = [];
  const envRoot = process.env.CODEBASE_ROOT;
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

export function resolveRepositoryRoot(): string {
  if (cachedRoot) {
    return cachedRoot;
  }

  for (const candidate of candidateRepositoryRoots()) {
    const resolved = path.resolve(candidate);
    if (hasRepositoryMarker(resolved)) {
      cachedRoot = resolved;
      return cachedRoot;
    }
  }

  cachedRoot = path.resolve(process.cwd());
  return cachedRoot;
}

function ensureWithinRepository(resolvedPath: string, root: string): void {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolvedPath === root) {
    return;
  }
  if (!resolvedPath.startsWith(normalizedRoot)) {
    throw new Error('Path is outside of repository root');
  }
}

function normalizeRelativePath(relativePath = ''): string {
  if (!relativePath) {
    return '';
  }
  const cleaned = relativePath.replace(/\\/g, '/');
  const stripped = cleaned.startsWith('/') ? cleaned.slice(1) : cleaned;
  return stripped;
}

export function resolveSafePath(relativePath = ''): { absolutePath: string; relativePath: string; root: string } {
  const root = resolveRepositoryRoot();
  const normalizedRelative = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(root, normalizedRelative);
  ensureWithinRepository(absolutePath, root);
  return { absolutePath, relativePath: normalizedRelative, root };
}

export async function listDirectory(relativePath = ''): Promise<{ entries: DirectoryEntry[]; path: string }> {
  const { absolutePath, relativePath: normalizedRelative, root } = resolveSafePath(relativePath);
  const stats = await stat(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error('Requested path is not a directory');
  }

  const dirEntries = await readdir(absolutePath, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];

  for (const entry of dirEntries) {
    const entryPath = path.join(absolutePath, entry.name);
    const entryStats = await stat(entryPath);
    const relative = path.relative(root, entryPath) || entry.name;
    entries.push({
      name: entry.name,
      path: relative.replace(/\\/g, '/'),
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entryStats.size,
      modifiedAt: entryStats.mtime.toISOString(),
    });
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
  const { absolutePath, relativePath: normalizedRelative } = resolveSafePath(relativePath);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    throw new Error('Requested path is not a file');
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = await readFile(absolutePath);
  const binary = detectBinary(raw);

  if (binary) {
    return {
      path: normalizedRelative,
      size: fileStats.size,
      modifiedAt: fileStats.mtime.toISOString(),
      binary: true,
      truncated: fileStats.size > maxBytes,
    };
  }

  let content = raw.toString('utf8');
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    const limitedBuffer = raw.slice(0, maxBytes);
    content = limitedBuffer.toString('utf8');
    truncated = true;
  }

  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  let startLine = options.startLine && options.startLine > 0 ? options.startLine : 1;
  let endLine = options.endLine && options.endLine >= startLine ? options.endLine : totalLines;

  startLine = Math.max(1, Math.min(startLine, totalLines));
  endLine = Math.max(startLine, Math.min(endLine, totalLines));

  if (startLine !== 1 || endLine !== totalLines) {
    content = lines.slice(startLine - 1, endLine).join('\n');
  }

  return {
    path: normalizedRelative,
    size: fileStats.size,
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
