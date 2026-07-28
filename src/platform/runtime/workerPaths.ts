import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEnv } from "@platform/runtime/env.js";

interface WorkersDirectoryResolution {
  /**
   * Absolute path to the workers directory (even if it does not exist).
   */
  path: string;
  /**
   * Whether any of the candidate directories currently exists on disk.
   */
  exists: boolean;
  /**
   * Ordered list of the locations that were inspected while resolving the
   * directory. Useful for diagnostics when no candidate exists.
   */
  checked: string[];
}

export type WorkerModuleFileResolution =
  | { status: 'ready'; path: string }
  | { status: 'invalid_worker_id' }
  | { status: 'not_found' }
  | { status: 'outside_workers_directory' };

const WORKER_MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function existsDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath !== ''
    && !path.isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`);
}

/**
 * Resolve one file-backed worker identifier to an existing JavaScript module
 * that remains inside the selected workers directory after canonicalization.
 */
export function resolveWorkerModuleFile(
  workersDirectory: string,
  workerId: string
): WorkerModuleFileResolution {
  if (!WORKER_MODULE_ID_PATTERN.test(workerId)) {
    return { status: 'invalid_worker_id' };
  }

  const resolvedWorkersDirectory = path.resolve(workersDirectory);
  const candidatePath = path.resolve(resolvedWorkersDirectory, `${workerId}.js`);

  if (!isPathInside(resolvedWorkersDirectory, candidatePath)) {
    return { status: 'outside_workers_directory' };
  }

  if (!fs.existsSync(candidatePath)) {
    return { status: 'not_found' };
  }

  try {
    const candidateStats = fs.statSync(candidatePath);
    if (!candidateStats.isFile()) {
      return { status: 'not_found' };
    }

    const canonicalWorkersDirectory = fs.realpathSync(resolvedWorkersDirectory);
    const canonicalCandidatePath = fs.realpathSync(candidatePath);

    //audit Assumption: worker module identifiers and worker-directory contents can be influenced by deployment configuration; failure risk: path traversal or an escaping symlink imports executable code outside the selected worker root; expected invariant: only canonical regular files beneath that root are importable; handling strategy: allowlist identifier characters and compare canonical relative paths before import.
    if (!isPathInside(canonicalWorkersDirectory, canonicalCandidatePath)) {
      return { status: 'outside_workers_directory' };
    }

    return {
      status: 'ready',
      path: canonicalCandidatePath
    };
  } catch {
    return { status: 'not_found' };
  }
}

/**
 * Resolve the most appropriate workers directory for the current runtime.
 *
 * The application can be executed from several entry points (the repository
 * root during development, the compiled `dist` folder in production, or inside
 * tests that modify `process.cwd()`).  Relying exclusively on `process.cwd()`
 * therefore causes false negatives when the runtime is rooted somewhere other
 * than the repository root.  To make the resolution robust we build a set of
 * candidate directories and return the first one that exists.
 */
export function resolveWorkersDirectory(): WorkersDirectoryResolution {
  const checked: string[] = [];
  const candidates: string[] = [];

  const cwd = process.cwd();

  // Use config layer for env access (adapter boundary pattern)
  const envOverride = getEnv('WORKERS_DIRECTORY');
  const resolvedEnvOverride = envOverride
    ? path.isAbsolute(envOverride)
      ? envOverride
      : path.resolve(cwd, envOverride)
    : undefined;

  if (resolvedEnvOverride) {
    candidates.push(resolvedEnvOverride);
  }

  const cwdIsDist = path.basename(cwd).toLowerCase() === 'dist';
  const cwdDistWorkers = cwdIsDist ? path.resolve(cwd, 'workers') : path.resolve(cwd, 'dist', 'workers');
  const cwdWorkers = path.resolve(cwd, 'workers');

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const moduleDistWorkersA = path.resolve(moduleDir, '../../workers');   // typically dist/workers
  const moduleDistWorkersB = path.resolve(moduleDir, '../../../workers'); // fallback

  // Prefer dist/workers only when present; otherwise preserve source-first fallback.
  candidates.push(cwdDistWorkers);
  candidates.push(moduleDistWorkersA);
  candidates.push(moduleDistWorkersB);
  candidates.push(cwdWorkers);

  for (const candidate of candidates) {
    if (checked.includes(candidate)) {
      continue;
    }

    checked.push(candidate);

    if (existsDir(candidate)) {
      return { path: candidate, exists: true, checked };
    }
  }

  // Keep fallback path stable and dev-friendly.
  const fallback = resolvedEnvOverride ?? cwdWorkers;

  return { path: fallback, exists: false, checked };
}
