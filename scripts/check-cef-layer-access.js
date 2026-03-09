import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTECTED_FILE_PATTERNS = [
  /^src\/services\/.*planner.*\.ts$/i,
  /^src\/services\/.*capability.*\.ts$/i,
  /^src\/services\/agentExecutionService\.ts$/i,
  /^src\/services\/agentExecutionTraceService\.ts$/i,
  /^src\/routes\/api-agent\.ts$/i
];

const BLOCKED_IMPORT_RULES = [
  {
    pattern: /\bfrom ['"](node:fs|fs|node:child_process|child_process)['"]|\brequire\(['"](node:fs|fs|node:child_process|child_process)['"]\)/,
    reason: 'filesystem and process access must stay behind the CEF boundary'
  },
  {
    pattern: /\bfrom ['"](node:path|path)['"]|\brequire\(['"](node:path|path)['"]\)/,
    reason: 'path-based storage wiring must stay behind the CEF boundary'
  },
  {
    pattern: /\bfrom ['"][^'"]*(?:@core\/db|\/core\/db\/)[^'"]*['"]|\brequire\(['"][^'"]*(?:@core\/db|\/core\/db\/)[^'"]*['"]\)/,
    reason: 'database access must stay behind the CEF boundary'
  },
  {
    pattern: /\bfrom ['"](?:@prisma\/client|knex|sequelize)['"]|\brequire\(['"](?:@prisma\/client|knex|sequelize)['"]\)/,
    reason: 'ORM and query-builder access must stay behind the CEF boundary'
  },
  {
    pattern: /\bfrom ['"][^'"]*(?:\/infrastructure\/|@services\/sessionStorage\.js|@services\/memory\/storage\.js|@shared\/fileStorage\.js)[^'"]*['"]|\brequire\(['"][^'"]*(?:\/infrastructure\/|@services\/sessionStorage\.js|@services\/memory\/storage\.js|@shared\/fileStorage\.js)[^'"]*['"]\)/,
    reason: 'storage and infrastructure access must stay behind the CEF boundary'
  },
  {
    pattern: /\bfrom ['"](?:axios)['"]|\brequire\(['"](?:axios)['"]\)|\bfrom ['"][^'"]*(?:@services\/openai\.js|@services\/railwayClient\.js)[^'"]*['"]|\brequire\(['"][^'"]*(?:@services\/openai\.js|@services\/railwayClient\.js)[^'"]*['"]\)/,
    reason: 'external API access must stay behind the CEF boundary'
  },
  {
    pattern: /\bfrom ['"][^'"]*(?:\/jobs\/|jobQueue|DatabaseBackedDagJobQueue)[^'"]*['"]|\brequire\(['"][^'"]*(?:\/jobs\/|jobQueue|DatabaseBackedDagJobQueue)[^'"]*['"]\)/,
    reason: 'queue client access must stay behind the CEF boundary'
  }
];

function collectRepositoryFilesFromFilesystem(rootPath) {
  if (!existsSync(rootPath)) {
    return [];
  }

  const discoveredFiles = [];
  const pendingDirectories = [rootPath];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    const directoryEntries = readdirSync(currentDirectory, { withFileTypes: true });

    for (const entry of directoryEntries) {
      const absoluteEntryPath = path.join(currentDirectory, entry.name);
      const relativeEntryPath = path.relative(process.cwd(), absoluteEntryPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        //audit Assumption: the fallback filesystem scan should stay constrained to source files and avoid vendor/build artifacts; failure risk: false positives or excessive scan time from `node_modules`, `.git`, and `dist`; expected invariant: only relevant repository source trees are traversed; handling strategy: skip known non-source directories during recursion.
        if (['.git', 'node_modules', 'dist', '.next', 'coverage'].includes(entry.name)) {
          continue;
        }

        pendingDirectories.push(absoluteEntryPath);
        continue;
      }

      if (entry.isFile() && /\.(ts|js)$/.test(relativeEntryPath)) {
        discoveredFiles.push(relativeEntryPath);
      }
    }
  }

  return discoveredFiles;
}

function listTrackedFiles() {
  try {
    const stdout = execFileSync('git', ['ls-files'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    return stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch (error) {
    //audit Assumption: CI and Docker builds may not include `.git`, but the layer-access policy must still run; failure risk: builds fail for environmental reasons instead of real policy violations; expected invariant: the scanner works with or without git metadata; handling strategy: fall back to a bounded filesystem scan rooted in the source tree when `git ls-files` is unavailable.
    const fallbackFiles = [
      ...collectRepositoryFilesFromFilesystem(path.resolve(process.cwd(), 'src')),
      ...collectRepositoryFilesFromFilesystem(path.resolve(process.cwd(), 'scripts'))
    ];

    return Array.from(new Set(fallbackFiles));
  }
}

/**
 * Resolve the tracked planner/capability files protected by the CEF layer-access policy.
 *
 * Purpose:
 * - Keep the CI scanner aligned to the current planner and capability module locations.
 *
 * Inputs/outputs:
 * - Input: tracked repository file paths.
 * - Output: protected planner/capability file paths.
 *
 * Edge case behavior:
 * - Returns an empty array when no protected files are tracked yet.
 */
export function getProtectedLayerFiles(trackedFiles) {
  return trackedFiles.filter(filePath =>
    PROTECTED_FILE_PATTERNS.some(pattern => pattern.test(filePath))
  );
}

/**
 * Scan one protected file for direct infrastructure import violations.
 *
 * Purpose:
 * - Detect architecture leaks before CI or production builds continue.
 *
 * Inputs/outputs:
 * - Input: relative file path and file contents.
 * - Output: list of matching rule violations.
 *
 * Edge case behavior:
 * - Returns an empty array when the file has no blocked imports.
 */
export function scanFileForLayerAccessViolations(filePath, sourceText) {
  const violations = [];

  for (const rule of BLOCKED_IMPORT_RULES) {
    const matches = sourceText.match(rule.pattern) ?? [];

    //audit Assumption: planner and capability modules should never directly import infrastructure dependencies; failure risk: architectural drift bypasses CEF validation and tracing; expected invariant: protected files import only non-infrastructure modules; handling strategy: collect every matching import and fail the check with explicit file-level diagnostics.
    if (matches.length > 0) {
      violations.push({
        filePath,
        reason: rule.reason,
        matches
      });
    }
  }

  return violations;
}

/**
 * Find all protected-layer import violations across tracked files.
 *
 * Purpose:
 * - Provide one reusable CI entrypoint for the planner/capability boundary check.
 *
 * Inputs/outputs:
 * - Input: optional tracked file list for tests.
 * - Output: aggregated violation records.
 *
 * Edge case behavior:
 * - Returns an empty array when no protected files or no violations are found.
 */
export function findLayerAccessViolations(trackedFiles = listTrackedFiles()) {
  const protectedFiles = getProtectedLayerFiles(trackedFiles);
  const violations = [];

  for (const relativeFilePath of protectedFiles) {
    const absoluteFilePath = path.resolve(process.cwd(), relativeFilePath);
    const sourceText = readFileSync(absoluteFilePath, 'utf8');
    violations.push(...scanFileForLayerAccessViolations(relativeFilePath, sourceText));
  }

  return violations;
}

export function runCliCheck() {
  const violations = findLayerAccessViolations();

  if (violations.length === 0) {
    console.log('check:cef-layer-access passed');
    return;
  }

  console.error('check:cef-layer-access failed');
  for (const violation of violations) {
    console.error(`- ${violation.filePath}: ${violation.reason}`);
    for (const match of violation.matches) {
      console.error(`  match: ${match}`);
    }
  }
  process.exitCode = 1;
}

const currentScriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)) {
  runCliCheck();
}
