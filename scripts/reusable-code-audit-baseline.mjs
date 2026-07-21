#!/usr/bin/env node

/**
 * Generate deterministic, reviewable baseline artifacts for the reusable-code audit.
 *
 * This script is audit-only. It reads repository state and existing coverage output;
 * it does not alter runtime configuration, connect to external services, or modify
 * production source files.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = process.cwd();
const DEFAULT_OUTPUT = 'docs/audits/reusable-code/2026-07-16';
const DEFAULT_SOURCE_COMMIT = '462e279f264372d42be4c9781a98fe72b6f498a5';
const DEFAULT_SOURCE_BRANCH = 'codex/fix-gaming-action-resilience';
const DEFAULT_BASELINE_AT = '2026-07-16T16:37:54.4989251-04:00';

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseArgs(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    sourceCommit: DEFAULT_SOURCE_COMMIT,
    sourceBranch: DEFAULT_SOURCE_BRANCH,
    baselineAt: DEFAULT_BASELINE_AT,
    verifyDeterminism: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    if (argument === '--output' && nextValue) {
      options.output = nextValue;
      index += 1;
    } else if (argument === '--source-commit' && nextValue) {
      options.sourceCommit = nextValue;
      index += 1;
    } else if (argument === '--source-branch' && nextValue) {
      options.sourceBranch = nextValue;
      index += 1;
    } else if (argument === '--baseline-at' && nextValue) {
      options.baselineAt = nextValue;
      index += 1;
    } else if (argument === '--verify-determinism') {
      options.verifyDeterminism = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  return options;
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function relativePath(absolutePath) {
  return normalizePath(path.relative(REPO_ROOT, absolutePath));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, { allowNonZero = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (!allowNonZero && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}:\n${result.stderr || result.stdout}`
    );
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readVersion(command, args) {
  const result = run(command, args, { allowNonZero: true });
  const output = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return output ?? 'not available';
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeArtifacts(artifacts) {
  return new Map(
    Object.entries(artifacts)
      .sort(([left], [right]) => compareText(left, right))
      .map(([fileName, value]) => [
        fileName,
        typeof value === 'string' ? value : stringifyJson(value),
      ])
  );
}

async function writeArtifacts(outputDirectory, artifacts) {
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const [fileName, content] of serializeArtifacts(artifacts)) {
    const targetPath = path.join(outputDirectory, fileName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, 'utf8');
  }
}

function parseGitPaths(sourceCommit) {
  const result = run('git', ['ls-tree', '-r', '--name-only', sourceCommit]);
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean)
    .sort(compareText);
}

async function discoverJestTests() {
  const result = run(
    process.execPath,
    ['scripts/run-jest.mjs', '--listTests', '--coverage=false', '--runInBand'],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        FORCE_MOCK: 'true',
      },
    }
  );

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line))
    .map((line) => relativePath(line))
    .sort(compareText);
}

function gitOutput(args, { allowNonZero = false } = {}) {
  return run('git', args, { allowNonZero }).stdout.trim();
}

function auditOnlyPath(filePath, outputPath) {
  const normalized = normalizePath(filePath);
  const normalizedOutput = normalizePath(outputPath).replace(/\/+$/u, '');
  return normalized === normalizedOutput
    || normalized.startsWith(`${normalizedOutput}/`)
    || normalized === 'scripts/reusable-code-audit-baseline.mjs'
    || /^tests\/reusable-code-audit-.*\.test\.ts$/u.test(normalized)
    || normalized === 'tests/openai-response-conversion-parity.test.ts'
    || normalized === 'tests/fixtures/openai-response-conversion.ts'
    || normalized.startsWith('tests/fixtures/module-loader/');
}

function changedWorktreePaths() {
  const commands = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  return [...new Set(commands.flatMap((args) =>
    gitOutput(args)
      .split(/\r?\n/u)
      .map((entry) => normalizePath(entry.trim()))
      .filter(Boolean)
  ))].sort(compareText);
}

function sourceState(options) {
  const sourceRefCommit = gitOutput(['rev-parse', options.sourceBranch]);
  if (sourceRefCommit !== options.sourceCommit) {
    throw new Error(
      `Source branch ${options.sourceBranch} resolves to ${sourceRefCommit}, not ${options.sourceCommit}.`
    );
  }

  const headCommit = gitOutput(['rev-parse', 'HEAD']);
  const ancestor = run(
    'git',
    ['merge-base', '--is-ancestor', options.sourceCommit, headCommit],
    { allowNonZero: true }
  );
  if (ancestor.status !== 0) {
    throw new Error(`HEAD ${headCommit} is not descended from source commit ${options.sourceCommit}.`);
  }

  const committedPaths = headCommit === options.sourceCommit
    ? []
    : gitOutput(['diff', '--name-only', `${options.sourceCommit}..${headCommit}`])
      .split(/\r?\n/u)
      .map((entry) => normalizePath(entry.trim()))
      .filter(Boolean)
      .sort(compareText);
  const worktreePaths = changedWorktreePaths();
  const outOfScopePaths = [...new Set([...committedPaths, ...worktreePaths])]
    .filter((filePath) => !auditOnlyPath(filePath, options.output))
    .sort(compareText);
  if (outOfScopePaths.length > 0) {
    throw new Error(
      `Source verification found non-audit changes: ${outOfScopePaths.join(', ')}`
    );
  }

  return {
    sourceBranchRefVerified: true,
    sourceBranchCommit: sourceRefCommit,
    headDescendsFromSourceCommit: true,
    committedAndUncommittedDifferencesValidated: true,
    auditOnlyPathPolicy:
      'Only the dated reusable-code audit, its generator, characterization tests, and their fixtures may differ from the source commit.',
    outOfScopeChangedPathCount: 0,
  };
}

async function testEnvironmentMetadata(trackedPaths) {
  const relativeFile = '.env.test';
  const absoluteFile = path.join(REPO_ROOT, relativeFile);
  let variableNames = [];
  try {
    const text = await fs.readFile(absoluteFile, 'utf8');
    variableNames = text
      .split(/\r?\n/u)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u)?.[1])
      .filter(Boolean)
      .sort(compareText);
  } catch {
    // Absence is recorded below; values are never read into the artifact.
  }
  return {
    path: relativeFile,
    presentAtGeneration: variableNames.length > 0,
    trackedAtSourceCommit: trackedPaths.includes(relativeFile),
    variableNames: [...new Set(variableNames)],
    valuesRecorded: false,
    note:
      'scripts/test-env.mjs loads this ignored file when present; only variable names are recorded.',
  };
}

async function ciNodeVersionDeclarations(trackedPaths) {
  const workflowPaths = trackedPaths
    .filter((filePath) => /^\.github\/workflows\/.*\.ya?ml$/u.test(filePath))
    .sort(compareText);
  const versions = new Map();
  for (const workflowPath of workflowPaths) {
    const lines = (await fs.readFile(path.join(REPO_ROOT, workflowPath), 'utf8')).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!/(?:node-version|NODE_VERSION)\s*:/u.test(line)) return;
      for (const match of line.matchAll(/\b(\d+(?:\.\d+){0,2})\b/gu)) {
        const version = match[1];
        const sources = versions.get(version) ?? [];
        sources.push(`${workflowPath}:${index + 1}`);
        versions.set(version, sources);
      }
    });
  }
  return [...versions.entries()]
    .map(([version, sources]) => ({
      version,
      sources: [...new Set(sources)].sort(compareText),
    }))
    .sort((left, right) => compareText(left.version, right.version));
}

function collectPythonTestCount() {
  const args = [
    '-B',
    '-m',
    'pytest',
    'daemon-python/tests',
    '-q',
    '--collect-only',
    '-p',
    'no:cacheprovider',
  ];
  const result = run('python', args);
  const match = result.stdout.match(/(\d+)\s+tests?\s+collected\b/iu);
  if (!match) {
    throw new Error('Unable to parse daemon-python pytest collection count.');
  }
  return {
    count: Number(match[1]),
    command: `python ${args.join(' ')}`,
  };
}

async function workspaceInventory(trackedPaths) {
  const rootManifest = await readJson(path.join(REPO_ROOT, 'package.json'));
  const manifestPaths = [];
  for (const workspacePattern of rootManifest.workspaces ?? []) {
    const normalizedPattern = normalizePath(workspacePattern);
    if (normalizedPattern.endsWith('/*')) {
      const prefix = normalizedPattern.slice(0, -1);
      manifestPaths.push(
        ...trackedPaths.filter(
          (filePath) =>
            filePath.startsWith(prefix)
            && filePath.endsWith('/package.json')
            && filePath.slice(prefix.length).split('/').filter(Boolean).length === 2
        )
      );
    } else {
      const manifestPath = `${normalizedPattern}/package.json`;
      if (trackedPaths.includes(manifestPath)) manifestPaths.push(manifestPath);
    }
  }

  const inventory = [];
  for (const manifestPath of [...new Set(manifestPaths)].sort(compareText)) {
    const manifest = await readJson(path.join(REPO_ROOT, manifestPath));
    inventory.push({
      name: manifest.name,
      manifest: manifestPath,
      hasLocalTestScript: typeof manifest.scripts?.test === 'string',
    });
  }
  return inventory.sort((left, right) => compareText(left.name, right.name));
}

function parseCoverageSummary(
  coverageSummary,
  applicableTypeScriptCount,
  scopeFiles,
  declarations,
  trackedPaths
) {
  const total = coverageSummary.total;
  const summaryFiles = Object.keys(coverageSummary)
    .filter((key) => key !== 'total')
    .map((filePath) => {
      const normalized = normalizePath(filePath);
      return path.isAbsolute(filePath)
        ? relativePath(filePath)
        : normalized.replace(/^\.\//u, '');
    })
    .sort(compareText);
  const uniqueScopeFiles = [...new Set(scopeFiles)].sort(compareText);
  const missingFromSummary = uniqueScopeFiles.filter((filePath) => !summaryFiles.includes(filePath));
  const unexpectedInSummary = summaryFiles.filter((filePath) => !uniqueScopeFiles.includes(filePath));
  const missingFromSourceCommit = uniqueScopeFiles.filter((filePath) => !trackedPaths.includes(filePath));
  if (
    uniqueScopeFiles.length !== scopeFiles.length
    || missingFromSummary.length > 0
    || unexpectedInSummary.length > 0
    || missingFromSourceCommit.length > 0
  ) {
    throw new Error(
      'Coverage scope and coverage-summary file sets differ: '
      + JSON.stringify({
        duplicateConfiguredPaths: scopeFiles.length - uniqueScopeFiles.length,
        missingFromSummary,
        unexpectedInSummary,
        missingFromSourceCommit,
      })
    );
  }

  const fileCount = summaryFiles.length;
  const representedPercent = Number(
    ((scopeFiles.length / applicableTypeScriptCount) * 100).toFixed(4)
  );
  const productionRoots = [
    { root: 'src/', ownership: 'Root backend' },
    { root: 'packages/protocol/src/', ownership: '@arcanos/protocol workspace' },
    { root: 'packages/cli/src/', ownership: '@arcanos/cli workspace' },
    { root: 'packages/arcanos-runtime/src/', ownership: '@arcanos/runtime workspace' },
    { root: 'packages/arcanos-openai/src/', ownership: '@arcanos/openai workspace' },
    { root: 'workers/src/', ownership: 'arcanos-workers workspace' },
    { root: 'arcanos-ai-runtime/src/', ownership: 'arcanos-ai-runtime workspace' },
  ].map((entry) => ({
    ...entry,
    applicableTypeScriptFileCount: trackedPaths.filter(
      (filePath) =>
        filePath.startsWith(entry.root)
        && filePath.endsWith('.ts')
        && !filePath.endsWith('.d.ts')
    ).length,
  }));
  const monorepoProductionTypeScriptFileCount = productionRoots.reduce(
    (totalCount, entry) => totalCount + entry.applicableTypeScriptFileCount,
    0
  );
  const monorepoRepresentedPercent = Number(
    ((scopeFiles.length / monorepoProductionTypeScriptFileCount) * 100).toFixed(4)
  );

  return {
    label: 'Configured coverage scope (not repository-wide coverage)',
    configuredScope: {
      fileCount,
      configuredFileCount: scopeFiles.length,
      files: scopeFiles,
      coverageSummaryFiles: summaryFiles,
      exactFileSetMatch: true,
      metrics: {
        lines: total.lines,
        functions: total.functions,
        branches: total.branches,
        statements: total.statements,
      },
    },
    repositorySourceDenominator: {
      scopeLabel: 'Root backend src/ TypeScript denominator (not all repository TypeScript)',
      rule: 'Tracked root-backend src/**/*.ts files excluding tracked *.d.ts declaration files',
      applicableTypeScriptFileCount: applicableTypeScriptCount,
      representedFileCount: scopeFiles.length,
      representedPercent,
      exclusions: [
        {
          category: 'TypeScript declarations',
          reason: 'Declarations contain no executable source behavior.',
          files: declarations,
        },
      ],
    },
    monorepoProductionSourceDenominator: {
      scopeLabel: 'Configured production TypeScript roots across the monorepo',
      rule:
        'Tracked non-declaration *.ts files under the seven explicitly listed production source roots.',
      roots: productionRoots,
      applicableTypeScriptFileCount: monorepoProductionTypeScriptFileCount,
      representedFileCount: scopeFiles.length,
      representedPercent: monorepoRepresentedPercent,
      exclusions: [
        {
          category: 'Declarations',
          reason: 'Declaration files contain no executable source behavior.',
          rule: 'All tracked *.d.ts files are excluded.',
        },
        {
          category: 'Tests, fixtures, and repository tooling',
          reason:
            'Files outside the seven production source roots are not part of this production-source denominator.',
          rule:
            'Tracked TypeScript under tests/, package test directories, scripts/, and other non-production roots is excluded.',
        },
      ],
      note:
        'This denominator is context only. It does not expand Jest collectCoverageFrom or its thresholds.',
    },
    interpretation: {
      repositoryWide100Percent: false,
      statement: `${scopeFiles.length} configured files are fully covered; they represent ${representedPercent}% of the ${applicableTypeScriptCount}-file executable src/ denominator.`,
    },
  };
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findVariableInitializer(sourceFile, identifierName) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === identifierName
        && declaration.initializer
      ) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function resolveLocalExpression(sourceFile, expression, seen = new Set()) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) return unwrapped;
  if (seen.has(unwrapped.text)) return unwrapped;
  seen.add(unwrapped.text);
  const initializer = findVariableInitializer(sourceFile, unwrapped.text);
  return initializer ? resolveLocalExpression(sourceFile, initializer, seen) : unwrapped;
}

function findObjectProperty(sourceFile, objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
      return resolveLocalExpression(sourceFile, property.initializer);
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
      return resolveLocalExpression(sourceFile, property.name);
    }
    if (ts.isMethodDeclaration(property) && propertyNameText(property.name) === propertyName) {
      return property;
    }
    if (ts.isGetAccessorDeclaration(property) && propertyNameText(property.name) === propertyName) {
      return property;
    }
  }
  return null;
}

function stringLiteralValue(expression) {
  const unwrapped = expression ? unwrapExpression(expression) : null;
  return unwrapped && (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped))
    ? unwrapped.text
    : null;
}

function actionKeys(sourceFile, expression) {
  const resolved = expression ? resolveLocalExpression(sourceFile, expression) : null;
  if (!resolved || !ts.isObjectLiteralExpression(resolved)) return [];
  return resolved.properties
    .map((property) => propertyNameText(property.name))
    .filter((value) => typeof value === 'string')
    .sort(compareText);
}

async function inspectModuleFile(absolutePath, fileName) {
  const sourceText = await fs.readFile(absolutePath, 'utf8');
  const scriptKind = fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  let defaultExpression = null;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      defaultExpression = resolveLocalExpression(sourceFile, statement.expression);
      break;
    }
  }

  if (!defaultExpression) {
    return {
      classification: 'no_default_export',
      accepted: false,
      moduleName: null,
      defaultAction: null,
      actions: [],
    };
  }

  if (
    ts.isCallExpression(defaultExpression)
    && ts.isIdentifier(defaultExpression.expression)
    && defaultExpression.expression.text === 'createArcanosTrinityModule'
  ) {
    const optionsExpression = defaultExpression.arguments[0]
      ? resolveLocalExpression(sourceFile, defaultExpression.arguments[0])
      : null;
    const moduleName = optionsExpression && ts.isObjectLiteralExpression(optionsExpression)
      ? stringLiteralValue(findObjectProperty(sourceFile, optionsExpression, 'name'))
      : null;

    return {
      classification: 'accepted_static_candidate',
      accepted: true,
      moduleName,
      defaultAction: 'query',
      actions: ['query'],
    };
  }

  if (!ts.isObjectLiteralExpression(defaultExpression)) {
    return {
      classification: 'default_without_actions',
      accepted: false,
      moduleName: null,
      defaultAction: null,
      actions: [],
    };
  }

  const actionsExpression = findObjectProperty(sourceFile, defaultExpression, 'actions');
  if (!actionsExpression) {
    return {
      classification: 'default_without_actions',
      accepted: false,
      moduleName: stringLiteralValue(findObjectProperty(sourceFile, defaultExpression, 'name')),
      defaultAction: stringLiteralValue(
        findObjectProperty(sourceFile, defaultExpression, 'defaultAction')
      ),
      actions: [],
    };
  }

  return {
    classification: 'accepted_static_candidate',
    accepted: true,
    moduleName: stringLiteralValue(findObjectProperty(sourceFile, defaultExpression, 'name')),
    defaultAction: stringLiteralValue(
      findObjectProperty(sourceFile, defaultExpression, 'defaultAction')
    ),
    actions: actionKeys(sourceFile, actionsExpression),
  };
}

async function buildModuleInventory(directoryPath, extension) {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return {
      directory: relativePath(directoryPath),
      evaluated: [],
      accepted: [],
      rejected: {
        defaultWithoutActions: [],
        noDefaultExport: [],
      },
    };
  }

  const evaluated = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => fileName.endsWith(extension))
    .filter((fileName) => !fileName.endsWith('.d.ts'))
    .filter((fileName) => !/moduleLoader\.(ts|js)$/iu.test(fileName))
    .sort(compareText);

  const accepted = [];
  const rejectedDefault = [];
  const rejectedNoDefault = [];

  for (const fileName of evaluated) {
    const inspected = await inspectModuleFile(path.join(directoryPath, fileName), fileName);
    const route = fileName
      .replace(/\.(ts|js)$/iu, '')
      .replace(/^arcanos-/u, '');
    const record = {
      file: normalizePath(path.join(relativePath(directoryPath), fileName)),
      route,
      moduleName: inspected.moduleName,
      defaultAction: inspected.defaultAction,
      actions: inspected.actions,
    };

    if (inspected.accepted) {
      accepted.push(record);
    } else if (inspected.classification === 'default_without_actions') {
      rejectedDefault.push(record.file);
    } else {
      rejectedNoDefault.push(record.file);
    }
  }

  return {
    directory: relativePath(directoryPath),
    evaluated,
    accepted,
    rejected: {
      defaultWithoutActions: rejectedDefault.sort(compareText),
      noDefaultExport: rejectedNoDefault.sort(compareText),
    },
  };
}

function resolveImportTarget(importer, specifier, aliasPaths, knownFiles) {
  const cleanSpecifier = specifier.replace(/[?#].*$/u, '');

  function tryCandidate(candidateBase) {
    const normalizedBase = normalizePath(candidateBase)
      .replace(/\.js$/iu, '')
      .replace(/\.tsx?$/iu, '');
    const candidates = [
      `${normalizedBase}.ts`,
      `${normalizedBase}/index.ts`,
    ];
    return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
  }

  if (cleanSpecifier.startsWith('.')) {
    return tryCandidate(path.posix.normalize(path.posix.join(path.posix.dirname(importer), cleanSpecifier)));
  }

  for (const [pattern, targets] of Object.entries(aliasPaths)) {
    const wildcardIndex = pattern.indexOf('*');
    const hasWildcard = wildcardIndex >= 0;
    const prefix = hasWildcard ? pattern.slice(0, wildcardIndex) : pattern;
    const suffix = hasWildcard ? pattern.slice(wildcardIndex + 1) : '';
    const matches = hasWildcard
      ? cleanSpecifier.startsWith(prefix) && cleanSpecifier.endsWith(suffix)
      : cleanSpecifier === pattern;
    if (!matches) continue;

    const wildcardValue = hasWildcard
      ? cleanSpecifier.slice(prefix.length, cleanSpecifier.length - suffix.length)
      : '';
    for (const target of targets) {
      const resolved = tryCandidate(target.replace('*', wildcardValue));
      if (resolved) return resolved;
    }
  }

  return null;
}

function hasRuntimeImport(importDeclaration) {
  const clause = importDeclaration.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return true;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function hasRuntimeExport(exportDeclaration) {
  if (exportDeclaration.isTypeOnly) return false;
  const clause = exportDeclaration.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function collectRuntimeSpecifiers(sourceFile) {
  const specifiers = new Set();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && hasRuntimeImport(statement)
    ) {
      specifiers.add(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
      && hasRuntimeExport(statement)
    ) {
      specifiers.add(statement.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(statement)
      && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      specifiers.add(statement.moduleReference.expression.text);
    }
  }

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return [...specifiers].sort(compareText);
}

function tarjanStronglyConnectedComponents(nodes, adjacency) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  const components = [];

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      while (stack.length > 0) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      components.push(component.sort(compareText));
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) visit(node);
  }

  return components;
}

function architectureArea(filePath) {
  const parts = filePath.split('/');
  return parts.length >= 3 ? parts[1] : 'root';
}

async function buildRuntimeDependencyReport(applicableSourceFiles) {
  const tsconfig = await readJson(path.join(REPO_ROOT, 'tsconfig.json'));
  const aliasPaths = tsconfig.compilerOptions?.paths ?? {};
  const knownFiles = new Set(applicableSourceFiles);
  const adjacency = new Map(applicableSourceFiles.map((filePath) => [filePath, []]));
  const edges = [];

  for (const importer of applicableSourceFiles) {
    const sourceText = await fs.readFile(path.join(REPO_ROOT, importer), 'utf8');
    const sourceFile = ts.createSourceFile(
      importer,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    for (const specifier of collectRuntimeSpecifiers(sourceFile)) {
      const target = resolveImportTarget(importer, specifier, aliasPaths, knownFiles);
      if (!target || target === importer) continue;
      if (!adjacency.get(importer).includes(target)) {
        adjacency.get(importer).push(target);
        edges.push({ source: importer, target });
      }
    }
    adjacency.get(importer).sort(compareText);
  }

  edges.sort((left, right) => {
    const sourceOrder = compareText(left.source, right.source);
    return sourceOrder !== 0 ? sourceOrder : compareText(left.target, right.target);
  });

  const stronglyConnectedComponents = tarjanStronglyConnectedComponents(
    applicableSourceFiles,
    adjacency
  )
    .filter((component) => component.length > 1)
    .sort((left, right) => {
      const sizeOrder = right.length - left.length;
      return sizeOrder !== 0 ? sizeOrder : compareText(left[0], right[0]);
    });

  const crossArea = new Map();
  for (const edge of edges) {
    const sourceArea = architectureArea(edge.source);
    const targetArea = architectureArea(edge.target);
    if (sourceArea === targetArea) continue;
    const key = `${sourceArea},${targetArea}`;
    const current = crossArea.get(key) ?? {
      sourceArea,
      targetArea,
      edgeCount: 0,
      importers: new Set(),
    };
    current.edgeCount += 1;
    current.importers.add(edge.source);
    crossArea.set(key, current);
  }

  const architectureEdges = [...crossArea.values()]
    .map((entry) => ({
      sourceArea: entry.sourceArea,
      targetArea: entry.targetArea,
      edgeCount: entry.edgeCount,
      uniqueImporterCount: entry.importers.size,
    }))
    .sort((left, right) => {
      const edgeOrder = right.edgeCount - left.edgeCount;
      if (edgeOrder !== 0) return edgeOrder;
      const sourceOrder = compareText(left.sourceArea, right.sourceArea);
      return sourceOrder !== 0 ? sourceOrder : compareText(left.targetArea, right.targetArea);
    });

  return {
    graph: {
      sourceFileCount: applicableSourceFiles.length,
      runtimeEdgeCount: edges.length,
      typeOnlyEdgesExcluded: true,
      runtimeStronglyConnectedComponentCount: stronglyConnectedComponents.length,
      modulesInRuntimeStronglyConnectedComponents: stronglyConnectedComponents.reduce(
        (total, component) => total + component.length,
        0
      ),
      stronglyConnectedComponents: stronglyConnectedComponents.map((modules, index) => ({
        id: `runtime-scc-${index + 1}`,
        size: modules.length,
        modules,
      })),
    },
    edges,
    architectureEdges,
  };
}

function buildArchitectureCsv(rows) {
  const lines = ['source_area,target_area,edge_count,unique_importer_count'];
  for (const row of rows) {
    lines.push(
      `${row.sourceArea},${row.targetArea},${row.edgeCount},${row.uniqueImporterCount}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function readMadgeCircularPaths() {
  const cliPath = path.join('node_modules', 'madge', 'bin', 'cli.js');
  const result = run(
    process.execPath,
    [
      cliPath,
      '--circular',
      '--json',
      '--extensions',
      'ts',
      '--ts-config',
      'tsconfig.json',
      'src',
    ],
    { allowNonZero: true }
  );
  const parsed = JSON.parse(result.stdout);
  const circularPaths = parsed
    .map((cycle) => cycle.map((modulePath) => `src/${normalizePath(modulePath)}`))
    .sort((left, right) => compareText(left.join(' -> '), right.join(' -> ')));

  return {
    command:
      'node node_modules/madge/bin/cli.js --circular --json --extensions ts --ts-config tsconfig.json src',
    expectedExitCodeWithCycles: 1,
    observedExitCode: result.status,
    circularPathCount: circularPaths.length,
    paths: circularPaths,
  };
}

function readUnusedDiagnostics() {
  const result = run(
    process.execPath,
    [
      path.join('node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--noUnusedLocals',
      '--noUnusedParameters',
      '--pretty',
      'false',
    ],
    { allowNonZero: true }
  );

  const diagnostics = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => /^src\//u.test(line))
    .sort(compareText);

  return {
    exitCode: result.status,
    diagnostics,
  };
}

async function buildArtifacts(options, verifiedSourceState) {
  const trackedPaths = parseGitPaths(options.sourceCommit);
  const srcTracked = trackedPaths.filter((filePath) => filePath.startsWith('src/'));
  const srcTypeScript = srcTracked.filter((filePath) => filePath.endsWith('.ts'));
  const declarations = srcTypeScript.filter((filePath) => filePath.endsWith('.d.ts'));
  const applicableSourceFiles = srcTypeScript
    .filter((filePath) => !filePath.endsWith('.d.ts'))
    .sort(compareText);
  const pythonFiles = trackedPaths.filter((filePath) => filePath.endsWith('.py'));
  const discoveredWorktreeJestTests = await discoverJestTests();
  const sourceCommitTrackedSet = new Set(trackedPaths);
  const jestTests = discoveredWorktreeJestTests
    .filter((filePath) => sourceCommitTrackedSet.has(filePath))
    .sort(compareText);
  const worktreeOnlyJestTests = discoveredWorktreeJestTests
    .filter((filePath) => !sourceCommitTrackedSet.has(filePath))
    .sort(compareText);
  const phaseOneJestTests = worktreeOnlyJestTests.filter(
    (filePath) =>
      /^tests\/reusable-code-audit-.*\.test\.ts$/u.test(filePath)
      || filePath === 'tests/openai-response-conversion-parity.test.ts'
  );
  const otherWorktreeOnlyJestTests = worktreeOnlyJestTests
    .filter((filePath) => !phaseOneJestTests.includes(filePath))
    .sort(compareText);
  if (otherWorktreeOnlyJestTests.length > 0) {
    throw new Error(
      `Unclassified worktree-only Jest files: ${otherWorktreeOnlyJestTests.join(', ')}`
    );
  }
  const coverageScopeModule = await import(
    `${pathToFileURL(path.join(REPO_ROOT, 'config', 'coverageScope.js')).href}?audit-baseline`
  );
  const coverageScopeFiles = [...coverageScopeModule.codecovCoverageScopeFiles]
    .map((filePath) => normalizePath(filePath))
    .sort(compareText);
  const coverageSummaryRaw = await readJson(
    path.join(REPO_ROOT, 'coverage', 'coverage-summary.json')
  );
  const sourceModules = await buildModuleInventory(
    path.join(REPO_ROOT, 'src', 'services'),
    '.ts'
  );
  const compiledModules = await buildModuleInventory(
    path.join(REPO_ROOT, 'dist', 'services'),
    '.js'
  );
  const runtimeDependency = await buildRuntimeDependencyReport(applicableSourceFiles);
  const circularPaths = readMadgeCircularPaths();
  const unused = readUnusedDiagnostics();
  const ciNodeVersions = await ciNodeVersionDeclarations(trackedPaths);
  const testEnvironment = await testEnvironmentMetadata(trackedPaths);
  const pythonCollection = collectPythonTestCount();
  const workspaces = await workspaceInventory(trackedPaths);

  const sourceBasenames = new Set(
    sourceModules.evaluated.map((fileName) => fileName.replace(/\.ts$/u, ''))
  );
  const compiledOnly = compiledModules.evaluated
    .filter((fileName) => !sourceBasenames.has(fileName.replace(/\.js$/u, '')))
    .sort(compareText);

  const toolVersions = {
    node: process.version.replace(/^v/u, ''),
    npm: process.platform === 'win32'
      ? readVersion('pwsh', ['-NoProfile', '-Command', 'npm --version'])
      : readVersion('npm', ['--version']),
    typescript: ts.version,
    jestPackage: (await readJson(path.join(REPO_ROOT, 'node_modules', 'jest', 'package.json'))).version,
    jestCli: readVersion(process.execPath, ['scripts/run-jest.mjs', '--version']),
    tsJest: (await readJson(path.join(REPO_ROOT, 'node_modules', 'ts-jest', 'package.json'))).version,
    eslint: (await readJson(path.join(REPO_ROOT, 'node_modules', 'eslint', 'package.json'))).version,
    madge: (await readJson(path.join(REPO_ROOT, 'node_modules', 'madge', 'package.json'))).version,
    python: readVersion('python', ['--version']).replace(/^Python\s+/u, ''),
    pytest: readVersion('python', ['-m', 'pytest', '--version']).replace(/^pytest\s+/u, ''),
    coveragePy: readVersion('python', ['-m', 'coverage', '--version'])
      .replace(/^Coverage\.py, version\s+/u, '')
      .replace(/\s+with.*$/u, ''),
    railwayCli: process.platform === 'win32'
      ? readVersion('pwsh', ['-NoProfile', '-Command', 'railway --version']).replace(/^railway\s+/iu, '')
      : readVersion('railway', ['--version']).replace(/^railway\s+/iu, ''),
    git: readVersion('git', ['--version']).replace(/^git version\s+/u, ''),
    powershell: readVersion('pwsh', [
      '-NoProfile',
      '-Command',
      '$PSVersionTable.PSVersion.ToString()',
    ]),
  };

  const sourceInventory = {
    sourceCommit: options.sourceCommit,
    counts: {
      trackedFiles: trackedPaths.length,
      trackedEntriesUnderSrc: srcTracked.length,
      trackedSrcTypeScriptFiles: srcTypeScript.length,
      trackedSrcDeclarationFiles: declarations.length,
      applicableSrcTypeScriptFiles: applicableSourceFiles.length,
      trackedPythonFiles: pythonFiles.length,
      activeDaemonPythonFiles: pythonFiles.filter((filePath) =>
        filePath.startsWith('daemon-python/arcanos/')
      ).length,
      legacyPythonFiles: pythonFiles.filter((filePath) => filePath.startsWith('legacy/')).length,
    },
    declarationExclusions: declarations,
    workspaces: workspaces.map((workspace) => workspace.name),
    workspaceManifests: workspaces,
  };

  const testInventory = {
    rootJest: {
      scope:
        'Jest-discovered test files that are tracked by the source commit; Phase 1 additions are cataloged separately.',
      sourceCommitFilterApplied: true,
      discoveredFileCount: jestTests.length,
      files: jestTests,
      integrationNamedFileCount: jestTests.filter(
        (filePath) =>
          filePath.includes('/integration/')
          || filePath.includes('.integration.test.')
      ).length,
      workerNamedFileCount: jestTests.filter((filePath) =>
        /worker/iu.test(path.posix.basename(filePath))
      ).length,
    },
    phaseOneCharacterization: {
      discoveredFileCount: phaseOneJestTests.length,
      files: phaseOneJestTests,
      sourceCommitTracked: false,
      note:
        'These audit-branch tests are intentionally excluded from the 365-file pre-change source-commit baseline.',
    },
    currentWorktreeDiscovery: {
      discoveredFileCount: discoveredWorktreeJestTests.length,
      worktreeOnlyFileCount: worktreeOnlyJestTests.length,
      otherWorktreeOnlyFiles: otherWorktreeOnlyJestTests,
    },
    python: {
      collectedTestCount: pythonCollection.count,
      command: pythonCollection.command,
    },
    runtimePackage: {
      nodeTestFiles: [
        'arcanos-ai-runtime/tests/runtime_integration.test.js',
        'arcanos-ai-runtime/tests/smoke.test.js',
      ],
    },
    packageLocalTestScripts: Object.fromEntries(
      workspaces.map((workspace) => [workspace.name, workspace.hasLocalTestScript])
    ),
  };

  const coverageReport = parseCoverageSummary(
    coverageSummaryRaw,
    applicableSourceFiles.length,
    coverageScopeFiles,
    declarations,
    trackedPaths
  );

  const evaluatedSourcePaths = sourceModules.evaluated.map(
    (fileName) => `src/services/${fileName}`
  );
  const acceptedSourcePaths = sourceModules.accepted.map((entry) => entry.file);
  const dynamicModuleInventory = {
    acceptanceRule:
      'Runtime loader accepts an evaluated module when imported.default and imported.default.actions are both truthy; this artifact is a static prediction, not a production manifest.',
    source: {
      directory: sourceModules.directory,
      evaluatedCount: sourceModules.evaluated.length,
      acceptedStaticCandidateCount: sourceModules.accepted.length,
      evaluatedSha256: sha256(`${evaluatedSourcePaths.join('\n')}\n`),
      acceptedSha256: sha256(`${acceptedSourcePaths.join('\n')}\n`),
      evaluatedModules: evaluatedSourcePaths,
      acceptedStaticCandidates: sourceModules.accepted,
      rejected: sourceModules.rejected,
    },
    compiled: {
      provenance:
        'Machine-local ignored dist/ state observed during baseline capture; it is not content-addressed by the source commit and is not source-reproducible.',
      sourceReproducible: false,
      trackedBySourceCommit: false,
      directory: compiledModules.directory,
      evaluatedCount: compiledModules.evaluated.length,
      acceptedStaticCandidateCount: compiledModules.accepted.length,
      evaluatedSha256: sha256(
        `${compiledModules.evaluated.map((fileName) => `dist/services/${fileName}`).join('\n')}\n`
      ),
      acceptedSha256: sha256(
        `${compiledModules.accepted.map((entry) => entry.file).join('\n')}\n`
      ),
      evaluatedModules: compiledModules.evaluated.map(
        (fileName) => `dist/services/${fileName}`
      ),
      acceptedStaticCandidates: compiledModules.accepted,
      rejected: compiledModules.rejected,
      compiledOnlyModules: compiledOnly.map((fileName) => `dist/services/${fileName}`),
      cleanSourceExpectation: {
        evaluatedCount: sourceModules.evaluated.length,
        acceptedStaticCandidateCount: sourceModules.accepted.length,
        compiledOnlyModules: [],
        basis:
          'A clean build from the source commit should emit one top-level service JavaScript file per evaluated source TypeScript file and no compiled-only service files.',
      },
    },
    runtimeSafety:
      'Real source-wide loading is intentionally not performed in the long-lived audit process because rejected imports can mutate filesystem, metric, listener, and singleton state.',
  };
  const runtimeDependencyScope = {
    sourceCommit: options.sourceCommit,
    sourceRoot: 'src/',
    sourceRule: 'Tracked root-backend src/**/*.ts excluding *.d.ts',
    sourceFileCount: applicableSourceFiles.length,
    excludedAreas: [
      'packages/',
      'workers/',
      'arcanos-ai-runtime/',
      'tests/',
      'scripts/',
    ],
    typeOnlyEdgesExcluded: true,
    resolution:
      'Relative imports and tsconfig paths aliases resolving to tracked root-backend src/ files.',
  };
  const runtimeSccReport = {
    sourceCommit: options.sourceCommit,
    command:
      'node scripts/reusable-code-audit-baseline.mjs (TypeScript AST runtime graph)',
    toolVersions: {
      node: toolVersions.node,
      typescript: toolVersions.typescript,
    },
    scope: runtimeDependencyScope,
    ...runtimeDependency.graph,
  };
  const runtimeEdgesReport = {
    sourceCommit: options.sourceCommit,
    command:
      'node scripts/reusable-code-audit-baseline.mjs (TypeScript AST runtime graph)',
    toolVersions: {
      node: toolVersions.node,
      typescript: toolVersions.typescript,
    },
    scope: runtimeDependencyScope,
    runtimeEdgeCount: runtimeDependency.edges.length,
    edges: runtimeDependency.edges,
  };

  const baseline = {
    repositoryRoot: '.',
    repositoryName: path.basename(REPO_ROOT),
    sourceBranch: options.sourceBranch,
    sourceCommit: options.sourceCommit,
    baselineAt: options.baselineAt,
    timezone: readVersion('tzutil', ['/g']),
    operatingSystem: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    preChangeWorktreeObservation: {
      status: 'clean',
      branch: options.sourceBranch,
      commit: options.sourceCommit,
      recordedAt: options.baselineAt,
      sourceUpstream: 'origin/codex/fix-gaming-action-resilience',
      sourceBranchAhead: 1,
      sourceBranchBehind: 0,
      provenance:
        'Observed before Phase 1 edits; generationRepositoryState below is derived on every generator run.',
    },
    generationRepositoryState: verifiedSourceState,
    packageManagerPin: null,
    lockfileVersion: 3,
    ciNodeVersionDeclarations: ciNodeVersions,
    ciNodeVersionInterpretation:
      'Workflows declare Node 18, 20, and 20.19.0; 20.19.0 is common but not universal.',
    localToolVersions: toolVersions,
    testEnvironment,
    relevantFeatureFlagNames: [
      'ALLOW_ROOT_OVERRIDE',
      'ARCANOS_PROCESS_KIND',
      'RUN_WORKERS',
      'ASK_ASYNC_WAIT_FOR_RESULT_MS',
      'ASK_ASYNC_WAIT_POLL_MS',
      'GPT_ASYNC_WAIT_FOR_RESULT_MS',
      'GPT_ASYNC_WAIT_POLL_MS',
      'GPT_ROUTE_ASYNC_CORE_DEFAULT',
      'GPT_FAST_PATH_ENABLED',
      'ALLOW_MOCK_OPENAI',
      'ALLOW_MOCK_FALLBACK',
      'FORCE_MOCK',
      'OPENAI_STORE',
      'BUDGET_DISABLED',
      'ENABLE_ACTION_PLANS',
      'ENABLE_CLEAR_2',
      'MCP_EXPOSE_DESTRUCTIVE',
      'MCP_REQUIRE_CONFIRMATION',
      'MCP_ENABLE_SESSIONS',
      'METRICS_ENABLED',
      'WORKER_SNAPSHOT_PIPELINE_V2',
      'WORKER_SNAPSHOT_PRESERVE_LEGACY_TABLE',
      'WORKER_SNAPSHOT_HISTORY_ENABLED',
    ].sort(compareText),
    secretValuesRecorded: false,
  };

  const commands = {
    shell: 'PowerShell 7',
    testEnvironmentPrefix: "$env:NODE_ENV='test'; $env:FORCE_MOCK='true';",
    generator: [
      'node scripts/reusable-code-audit-baseline.mjs',
      `--source-commit ${options.sourceCommit}`,
      `--source-branch ${options.sourceBranch}`,
      `--baseline-at ${options.baselineAt}`,
      `--output ${normalizePath(options.output)}`,
      '--verify-determinism',
    ].join(' '),
    artifacts: {
      'commands.json': 'Written by the generator command recorded in generator.',
      'baseline.json':
        'Generator plus git rev-parse/status/rev-list, local tool --version commands, and name-only .env.test inspection.',
      'source-inventory.json': `git ls-tree -r --name-only ${options.sourceCommit}`,
      'test-inventory.json':
        "$env:NODE_ENV='test'; $env:FORCE_MOCK='true'; node scripts/run-jest.mjs --listTests --coverage=false --runInBand; source baseline filtered through git ls-tree",
      'coverage-scope.txt':
        'Import config/coverageScope.js; normalize, de-duplicate, sort, and verify against the source commit.',
      'coverage-report.json':
        "$env:NODE_ENV='test'; $env:FORCE_MOCK='true'; node scripts/run-jest.mjs --coverage --coverageReporters=json-summary --coverageReporters=lcov --coverageReporters=text-summary --maxWorkers=50% --silent; then run the generator",
      'dynamic-module-inventory.json':
        'Generator TypeScript AST classification of source services plus explicitly machine-local ignored dist/services observation.',
      'circular-paths.json':
        'node node_modules/madge/bin/cli.js --circular --json --extensions ts --ts-config tsconfig.json src',
      'runtime-scc.json':
        'Generator TypeScript AST graph over tracked root-backend src/**/*.ts with explicit type-only edges excluded.',
      'runtime-edges.json':
        'Generator sorted source/target edge list from the same TypeScript AST runtime graph.',
      'architecture-edges.csv':
        'Generator cross-area aggregation of runtime-edges.json.',
      'unused-declarations.txt':
        'node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false',
    },
    manuallyMaintainedArtifacts: {
      'README.md': 'Curated index and interpretation of the generated evidence.',
      'characterization-report.md':
        'Curated from the cited characterization tests and generated artifacts.',
      'dependency-boundary-proposals.md':
        'Curated recommendations from runtime-edges.json and runtime-scc.json; no changes are authorized.',
      'findings.json':
        'Curated review-label records backed by cited production files, tests, and generated evidence.',
      'validation-results.json':
        'Manually captured pre-change command results with durations and classifications.',
      'post-change-validation.json':
        'Manually captured post-change command results supplied by the validation run.',
    },
  };

  const unusedText = [
    `command: node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false`,
    `observed_exit_code: ${unused.exitCode}`,
    `diagnostic_count: ${unused.diagnostics.length}`,
    '',
    ...unused.diagnostics,
    '',
  ].join('\n');

  return {
    'baseline.json': baseline,
    'commands.json': commands,
    'source-inventory.json': sourceInventory,
    'test-inventory.json': testInventory,
    'coverage-scope.txt': `${coverageScopeFiles.join('\n')}\n`,
    'coverage-report.json': coverageReport,
    'dynamic-module-inventory.json': dynamicModuleInventory,
    'circular-paths.json': circularPaths,
    'runtime-scc.json': runtimeSccReport,
    'runtime-edges.json': runtimeEdgesReport,
    'architecture-edges.csv': buildArchitectureCsv(runtimeDependency.architectureEdges),
    'unused-declarations.txt': unusedText,
  };
}

function compareArtifacts(left, right) {
  const leftSerialized = serializeArtifacts(left);
  const rightSerialized = serializeArtifacts(right);
  const fileNames = [...new Set([...leftSerialized.keys(), ...rightSerialized.keys()])]
    .sort(compareText);
  const mismatches = fileNames.filter(
    (fileName) => leftSerialized.get(fileName) !== rightSerialized.get(fileName)
  );
  if (mismatches.length > 0) {
    throw new Error(`Determinism verification failed for: ${mismatches.join(', ')}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDirectory = path.resolve(REPO_ROOT, options.output);
  const verifiedSourceState = sourceState(options);
  const firstArtifacts = await buildArtifacts(options, verifiedSourceState);
  await writeArtifacts(outputDirectory, firstArtifacts);

  if (options.verifyDeterminism) {
    const secondArtifacts = await buildArtifacts(options, verifiedSourceState);
    compareArtifacts(firstArtifacts, secondArtifacts);
  }

  process.stdout.write(
    `Reusable-code audit baseline written to ${relativePath(outputDirectory)}`
      + `${options.verifyDeterminism ? ' (determinism verified)' : ''}.\n`
  );
}

await main();
