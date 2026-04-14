import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOUNDARY_GROUPS = [
  {
    name: 'write-plane',
    filePatterns: [
      /^src\/routes\/_core\/gptDispatch\.ts$/i,
      /^src\/workers\/jobRunner\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@services\/arcanosMcp|\/services\/arcanosMcp|@services\/runtimeInspectionRoutingService|\/services\/runtimeInspectionRoutingService|@routes\/ask\/dagTools|\/routes\/ask\/dagTools|@services\/systemState|\/services\/systemState)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:arcanosMcp|runtimeInspectionRoutingService|routes\/ask\/dagTools|systemState)(?:\.js)?['"]\)/,
        reason: 'write-plane modules must not import control-plane execution modules',
      },
    ],
  },
  {
    name: 'control-plane',
    filePatterns: [
      /^src\/services\/runtimeInspectionRoutingService\.ts$/i,
      /^src\/services\/systemState\.ts$/i,
      /^src\/routes\/ask\/dagTools\.ts$/i,
      /^src\/mcp\/server\/.*\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@routes\/_core\/gptDispatch|\/routes\/_core\/gptDispatch)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:@routes\/_core\/gptDispatch|\/routes\/_core\/gptDispatch)(?:\.js)?['"]\)/,
        reason: 'control-plane modules must not import the writing dispatcher',
      },
    ],
  },
  {
    name: 'shared-routing',
    filePatterns: [
      /^src\/shared\/.*\.(?:ts|js)$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@routes\/|\/routes\/)[^'"]*['"]|\brequire\(['"][^'"]*(?:@routes\/|\/routes\/)[^'"]*['"]\)/,
        reason: 'shared modules must remain routing-agnostic',
      },
    ],
  },
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return Array.from(
      new Set([
        ...collectRepositoryFilesFromFilesystem(path.resolve(process.cwd(), 'src')),
        ...collectRepositoryFilesFromFilesystem(path.resolve(process.cwd(), 'workers')),
        ...collectRepositoryFilesFromFilesystem(path.resolve(process.cwd(), 'packages')),
      ]),
    );
  }
}

export function findRoutingBoundaryViolations(trackedFiles = listTrackedFiles()) {
  const violations = [];

  for (const group of BOUNDARY_GROUPS) {
    const protectedFiles = trackedFiles.filter((filePath) =>
      group.filePatterns.some((pattern) => pattern.test(filePath)),
    );

    for (const relativeFilePath of protectedFiles) {
      const absoluteFilePath = path.resolve(process.cwd(), relativeFilePath);
      const sourceText = readFileSync(absoluteFilePath, 'utf8');

      for (const rule of group.blockedImportRules) {
        const matches = sourceText.match(rule.pattern) ?? [];
        if (matches.length === 0) {
          continue;
        }

        violations.push({
          boundary: group.name,
          filePath: relativeFilePath,
          reason: rule.reason,
          matches,
        });
      }
    }
  }

  return violations;
}

export function runCliCheck() {
  const violations = findRoutingBoundaryViolations();

  if (violations.length === 0) {
    console.log('check:routing-boundaries passed');
    return;
  }

  console.error('check:routing-boundaries failed');
  for (const violation of violations) {
    console.error(`- [${violation.boundary}] ${violation.filePath}: ${violation.reason}`);
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
