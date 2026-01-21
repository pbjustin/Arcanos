import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  const envOverride = process.env.WORKERS_DIRECTORY;
  if (envOverride) {
    candidates.push(
      path.isAbsolute(envOverride)
        ? envOverride
        : path.resolve(process.cwd(), envOverride)
    );
  }

  candidates.push(path.resolve(process.cwd(), 'workers'));

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(moduleDir, '../../workers'));
  candidates.push(path.resolve(moduleDir, '../../../workers'));

  for (const candidate of candidates) {
    if (checked.includes(candidate)) {
      continue;
    }

    checked.push(candidate);

    if (fs.existsSync(candidate)) {
      return { path: candidate, exists: true, checked };
    }
  }

  const fallback = candidates[0] ?? path.resolve(process.cwd(), 'workers');
  if (!checked.includes(fallback)) {
    checked.push(fallback);
  }

  return { path: fallback, exists: false, checked };
}
