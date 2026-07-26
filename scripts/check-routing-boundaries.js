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
      /^src\/platform\/runtime\/writingPlaneContract\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@services\/arcanosMcp|\/services\/arcanosMcp|@services\/runtimeInspectionRoutingService|\/services\/runtimeInspectionRoutingService|@routes\/ask\/dagTools|\/routes\/ask\/dagTools|@services\/systemState|\/services\/systemState)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:arcanosMcp|runtimeInspectionRoutingService|routes\/ask\/dagTools|systemState)(?:\.js)?['"]\)/,
        reason: 'write-plane modules must not import control-plane execution modules',
      },
    ],
  },
  {
    name: 'runtime-inspection-classifier',
    filePatterns: [
      /^src\/shared\/runtimeInspectionPrompt\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@core\/|@platform\/|@routes\/|@services\/|\/core\/|\/platform\/|\/routes\/|\/services\/)[^'"]*['"]|\brequire\(['"][^'"]*(?:@core\/|@platform\/|@routes\/|@services\/|\/core\/|\/platform\/|\/routes\/|\/services\/)[^'"]*['"]\)/,
        reason: 'the runtime-inspection classifier must remain a pure shared dependency leaf',
      },
    ],
  },
  {
    name: 'control-plane',
    filePatterns: [
      /^src\/services\/runtimeInspectionRoutingService\.ts$/i,
      /^src\/services\/systemState\.ts$/i,
      /^src\/services\/controlPlane\/.*\.(?:ts|js)$/i,
      /^src\/routes\/ask\/dagTools\.ts$/i,
      /^src\/mcp\/server\/jobTools\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@routes\/_core\/gptDispatch|\/routes\/_core\/gptDispatch)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:@routes\/_core\/gptDispatch|\/routes\/_core\/gptDispatch)(?:\.js)?['"]\)/,
        reason: 'control-plane modules must not import the writing dispatcher',
      },
      {
        pattern: /\bfrom ['"][^'"]*(?:@core\/logic\/trinityWritingPipeline|\/core\/logic\/trinityWritingPipeline|@core\/logic\/trinityGenerationFacade|\/core\/logic\/trinityGenerationFacade)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:@core\/logic\/trinityWritingPipeline|\/core\/logic\/trinityWritingPipeline|@core\/logic\/trinityGenerationFacade|\/core\/logic\/trinityGenerationFacade)(?:\.js)?['"]\)/,
        reason: 'control-plane modules must not invoke the Trinity writing facade',
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
  {
    name: 'module-registry-ownership',
    filePatterns: [
      /^src\/mcp\/server\/index\.ts$/i,
      /^src\/routes\/_core\/gptDispatch\.ts$/i,
      /^src\/routes\/api-daemon\.ts$/i,
      /^src\/routes\/gpt-access\.ts$/i,
      /^src\/routes\/introspection\.ts$/i,
      /^src\/services\/.*\.(?:ts|js)$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@routes\/modules|\/routes\/modules|\.\.\/modules|\.\/modules)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:@routes\/modules|\/routes\/modules|\.\.\/modules|\.\/modules)(?:\.js)?['"]\)/,
        reason: 'module-registry consumers must use the service port instead of importing the route adapter',
      },
    ],
  },
  {
    name: 'gpt-router-registry-projection',
    filePatterns: [
      /^src\/platform\/runtime\/gptRouterConfig\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@services\/moduleLoader|\/services\/moduleLoader)(?:\.js)?['"]|\brequire\(['"][^'"]*(?:@services\/moduleLoader|\/services\/moduleLoader)(?:\.js)?['"]\)/,
        reason: 'the GPT router map must project the immutable module-registry generation instead of owning a loader cache',
      },
    ],
  },
  {
    name: 'observability-leaf',
    filePatterns: [
      /^src\/platform\/observability\/appMetrics\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@services\/|\/services\/)[^'"]*['"]|\bimport\(['"][^'"]*(?:@services\/|\/services\/)[^'"]*['"]\)|\brequire\(['"][^'"]*(?:@services\/|\/services\/)[^'"]*['"]\)/,
        reason: 'the metrics registry must receive runtime providers from the composition root instead of importing services',
      },
    ],
  },
  {
    name: 'control-plane-mcp-port',
    filePatterns: [
      /^src\/services\/controlPlane\/executor\.ts$/i,
      /^src\/services\/controlPlane\/service\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@services\/arcanosMcp|\/services\/arcanosMcp|\.\.\/arcanosMcp)(?:\.js)?['"]|\bimport\(['"][^'"]*(?:@services\/arcanosMcp|\/services\/arcanosMcp|\.\.\/arcanosMcp)(?:\.js)?['"]\)|\brequire\(['"][^'"]*(?:@services\/arcanosMcp|\/services\/arcanosMcp|\.\.\/arcanosMcp)(?:\.js)?['"]\)/,
        reason: 'control-plane execution must receive the ARCANOS MCP port from composition instead of importing the concrete in-process client',
      },
    ],
  },
  {
    name: 'trinity-openai-leaves',
    filePatterns: [
      /^src\/core\/audit\/runClearAudit\.ts$/i,
      /^src\/core\/logic\/trinity(?:Stages|Tier)?\.ts$/i,
      /^src\/services\/ai-reflections\.ts$/i,
      /^src\/services\/selfImprove\/patchProposal\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"](?:@services\/openai|\.\/openai)(?:\.js)?['"]|\bimport\(['"](?:@services\/openai|\.\/openai)(?:\.js)?['"]\)|\brequire\(['"](?:@services\/openai|\.\/openai)(?:\.js)?['"]\)/,
        reason: 'Trinity and self-improvement internals must import focused OpenAI leaf modules instead of the facade that eagerly includes image generation',
      },
    ],
  },
  {
    name: 'arcanos-core-operator-dispatch-port',
    filePatterns: [
      /^src\/services\/arcanos-core\.ts$/i,
    ],
    blockedImportRules: [
      {
        pattern: /\bfrom ['"][^'"]*(?:@services\/gptAccessNaturalLanguageDispatch|\/services\/gptAccessNaturalLanguageDispatch|@services\/gptAccessGateway|\/services\/gptAccessGateway)(?:\.js)?['"]|\bimport\(['"][^'"]*(?:@services\/gptAccessNaturalLanguageDispatch|\/services\/gptAccessNaturalLanguageDispatch|@services\/gptAccessGateway|\/services\/gptAccessGateway)(?:\.js)?['"]\)|\brequire\(['"][^'"]*(?:@services\/gptAccessNaturalLanguageDispatch|\/services\/gptAccessNaturalLanguageDispatch|@services\/gptAccessGateway|\/services\/gptAccessGateway)(?:\.js)?['"]\)/,
        reason: 'ARCANOS:CORE must receive operator dispatch through its configured port instead of importing GPT Access control-plane services',
      },
    ],
  },
];

const DIRECT_TRINITY_IMPORT_ALLOWED_FILES = new Set([
  'src/core/logic/trinity.ts',
  'src/core/logic/trinityGenerationFacade.ts',
  'src/core/logic/trinityWritingPipeline.ts',
]);

const DIRECT_TRINITY_IMPORT_PATTERN =
  /\bimport\s*\{[^}]*\brunThroughBrain\b[^}]*\}\s*from\s*['"][^'"]*(?:@core\/logic\/trinity|\/core\/logic\/trinity|\.\/trinity|trinity)(?:\.js)?['"]/;
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

  for (const relativeFilePath of trackedFiles) {
    if (!relativeFilePath.startsWith('src/')) {
      continue;
    }
    if (DIRECT_TRINITY_IMPORT_ALLOWED_FILES.has(relativeFilePath)) {
      continue;
    }

    const absoluteFilePath = path.resolve(process.cwd(), relativeFilePath);
    const sourceText = readFileSync(absoluteFilePath, 'utf8');
    const matches = sourceText.match(DIRECT_TRINITY_IMPORT_PATTERN) ?? [];
    if (matches.length === 0) {
      continue;
    }

    violations.push({
      boundary: 'trinity-import',
      filePath: relativeFilePath,
      reason: 'Production code must use runTrinityWritingPipeline instead of importing runThroughBrain directly.',
      matches,
    });
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
