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

function existsDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
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

  // Use config layer for env access (adapter boundary pattern)
  const envOverride = getEnv('WORKERS_DIRECTORY');
  if (envOverride) {
    candidates.push(
      path.isAbsolute(envOverride)
        ? envOverride
        : path.resolve(process.cwd(), envOverride)
    );
  }

  const cwd = process.cwd();
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
  const fallback =
    envOverride
      ? path.isAbsolute(envOverride)
        ? envOverride
        : path.resolve(cwd, envOverride)
      : cwdWorkers;

  return { path: fallback, exists: false, checked };
}