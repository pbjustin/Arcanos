import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

import type {
  NextFunction,
  Request,
  Response,
} from 'express';
import {
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import ts from 'typescript';

import { codecovCoverageScopeFiles } from '../config/coverageScope.js';

const getOpenAIClientOrAdapterMock = jest.fn(() => ({
  adapter: {},
  client: null,
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
}));
jest.unstable_mockModule('@services/reusableCodeGeneration.js', () => ({
  generateReusableCodeSnippets: jest.fn(),
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const reusableCodeRouter = (
  await import('../src/routes/api-reusable-code.js')
).default;

const EMPTY_API_ROUTE_MODULES = [
  '@routes/api-arcanos.js',
  '@routes/api-sim.js',
  '@routes/api-memory.js',
  '@routes/api-save-conversation.js',
  '@routes/api-codebase.js',
  '@routes/api-commands.js',
  '@routes/api-control-plane.js',
  '@routes/api-assistants.js',
  '@routes/api-vision.js',
  '@routes/api-transcribe.js',
  '@routes/api-update.js',
  '@routes/api-daemon.js',
  '@routes/api-agent.js',
  '@routes/api-prompt-debug.js',
  '@routes/api-ai-routing-debug.js',
  '@routes/pr-analysis.js',
  '@routes/openai.js',
  '@routes/afol.js',
  '@routes/web-search.js',
] as const;

for (const moduleName of EMPTY_API_ROUTE_MODULES) {
  jest.unstable_mockModule(moduleName, () => ({
    default: express.Router(),
  }));
}

const memoryConsistencyGateMock = jest.fn(
  (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-reusable-audit-memory-gate', 'observed');
    next();
  },
);

jest.unstable_mockModule('@transport/http/middleware/memoryConsistencyGate.js', () => ({
  memoryConsistencyGate: memoryConsistencyGateMock,
}));
jest.unstable_mockModule('@routes/api-reusable-code.js', () => ({
  default: reusableCodeRouter,
}));

const apiRouter = (await import('../src/routes/api/index.js')).default;

const repositoryRoot = process.cwd();
const routeRoot = path.join(repositoryRoot, 'src', 'routes');
const routeMethods = new Set(['all', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

interface MiddlewareRule {
  line: number;
  name: string;
  path: string;
  position: number;
}

interface RouteEvent {
  kind: 'route';
  line: number;
  method: string;
  paths: string[];
  position: number;
  routeMiddleware: string[];
}

interface MountEvent {
  kind: 'mount';
  child: string;
  line: number;
  path: string;
  position: number;
}

interface ParsedRouteModule {
  events: Array<RouteEvent | MountEvent>;
  middlewareRules: MiddlewareRule[];
}

interface RouteRegistration {
  method: string;
  path: string;
  source: string;
  line: number;
  order: number;
  mountChain: string[];
  middlewareStack: string[];
}

interface CoverageReport {
  label: string;
  configuredScope: {
    fileCount: number;
    configuredFileCount: number;
    files: string[];
    metrics: Record<string, { total: number; covered: number; skipped: number; pct: number }>;
  };
  repositorySourceDenominator: {
    rule: string;
    applicableTypeScriptFileCount: number;
    representedFileCount: number;
    representedPercent: number;
    exclusions: Array<{
      category: string;
      reason: string;
      files: string[];
    }>;
  };
  monorepoProductionSourceDenominator: {
    scopeLabel: string;
    rule: string;
    roots: Array<{
      root: string;
      ownership: string;
      applicableTypeScriptFileCount: number;
    }>;
    applicableTypeScriptFileCount: number;
    representedFileCount: number;
    representedPercent: number;
  };
  interpretation: {
    repositoryWide100Percent: boolean;
    statement: string;
  };
}

function normalizeRepositoryPath(value: string): string {
  return value.replace(/\\/gu, '/');
}

function relativeRepositoryPath(value: string): string {
  return normalizeRepositoryPath(path.relative(repositoryRoot, value));
}

function normalizeHttpPath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/gu, '/');
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

function joinHttpPaths(parent: string, child: string): string {
  if (parent === '/') {
    return normalizeHttpPath(child);
  }
  if (child === '/') {
    return normalizeHttpPath(parent);
  }
  return normalizeHttpPath(`${parent}/${child}`);
}

function pathIsWithin(candidate: string, middlewarePath: string): boolean {
  const normalizedCandidate = normalizeHttpPath(candidate);
  const normalizedMiddlewarePath = normalizeHttpPath(middlewarePath);
  return normalizedMiddlewarePath === '/'
    || normalizedCandidate === normalizedMiddlewarePath
    || normalizedCandidate.startsWith(`${normalizedMiddlewarePath}/`);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalPaths(expression: ts.Expression | undefined): string[] {
  if (!expression) {
    return [];
  }
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return [normalizeHttpPath(unwrapped.text)];
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap((element) =>
      ts.isExpression(element) ? literalPaths(element) : []
    );
  }
  return [];
}

function middlewareName(expression: ts.Expression): string {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.getText();
  }
  if (ts.isCallExpression(unwrapped)) {
    return `${unwrapped.expression.getText()}()`;
  }
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return '<inline>';
  }
  return unwrapped.getText();
}

function resolveRouteImport(importer: string, specifier: string): string | null {
  let candidateBase: string;
  if (specifier.startsWith('@routes/')) {
    candidateBase = path.join(routeRoot, specifier.slice('@routes/'.length));
  } else if (specifier.startsWith('.')) {
    candidateBase = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }

  candidateBase = candidateBase.replace(/\.js$/iu, '').replace(/\.ts$/iu, '');
  const candidates = [
    `${candidateBase}.ts`,
    path.join(candidateBase, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    return null;
  }

  const relativeToRouteRoot = path.relative(routeRoot, resolved);
  return relativeToRouteRoot.startsWith('..') ? null : resolved;
}

const parsedModuleCache = new Map<string, ParsedRouteModule>();

function parseRouteModule(filePath: string): ParsedRouteModule {
  const cached = parsedModuleCache.get(filePath);
  if (cached) {
    return cached;
  }

  const sourceText = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const defaultImports = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      && statement.importClause?.name
      && ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const resolved = resolveRouteImport(filePath, statement.moduleSpecifier.text);
      if (resolved) {
        defaultImports.set(statement.importClause.name.text, resolved);
      }
    }
  }

  const events: Array<RouteEvent | MountEvent> = [];
  const middlewareRules: MiddlewareRule[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && (node.expression.expression.text === 'router' || node.expression.expression.text === 'app')
    ) {
      const callName = node.expression.name.text.toLowerCase();
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

      if (routeMethods.has(callName)) {
        const paths = literalPaths(node.arguments[0]);
        if (paths.length > 0) {
          events.push({
            kind: 'route',
            line,
            method: callName.toUpperCase(),
            paths,
            position: node.getStart(sourceFile),
            routeMiddleware: node.arguments
              .slice(1)
              .map((argument) => middlewareName(argument)),
          });
        }
      } else if (callName === 'use') {
        const childArgument = node.arguments.find((argument) => {
          const unwrapped = unwrapExpression(argument);
          return ts.isIdentifier(unwrapped) && defaultImports.has(unwrapped.text);
        });

        if (childArgument) {
          const childIdentifier = unwrapExpression(childArgument) as ts.Identifier;
          const explicitPaths = literalPaths(node.arguments[0]);
          events.push({
            kind: 'mount',
            child: defaultImports.get(childIdentifier.text)!,
            line,
            path: explicitPaths[0] ?? '/',
            position: node.getStart(sourceFile),
          });
        } else {
          const explicitPaths = literalPaths(node.arguments[0]);
          const middlewareArguments = explicitPaths.length > 0
            ? node.arguments.slice(1)
            : node.arguments;
          for (const argument of middlewareArguments) {
            middlewareRules.push({
              line,
              name: middlewareName(argument),
              path: explicitPaths[0] ?? '/',
              position: node.getStart(sourceFile),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  events.sort((left, right) => left.position - right.position);
  middlewareRules.sort((left, right) => left.position - right.position);

  const parsed = { events, middlewareRules };
  parsedModuleCache.set(filePath, parsed);
  return parsed;
}

function buildRouteManifest(): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  let nextOrder = 0;

  function walk(
    filePath: string,
    mountedAt: string,
    mountChain: string[],
    inheritedMiddleware: string[],
    ancestry: Set<string>,
  ): void {
    if (ancestry.has(filePath)) {
      return;
    }

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(filePath);
    const parsed = parseRouteModule(filePath);
    const source = relativeRepositoryPath(filePath);

    for (const event of parsed.events) {
      const applicableMiddleware = parsed.middlewareRules
        .filter((rule) =>
          rule.position < event.position
          && pathIsWithin(
            event.kind === 'route' ? event.paths[0] ?? '/' : event.path,
            rule.path,
          )
        )
        .map((rule) => `${source}:${rule.line}:${rule.name}`);

      if (event.kind === 'route') {
        for (const routePath of event.paths) {
          registrations.push({
            method: event.method,
            path: joinHttpPaths(mountedAt, routePath),
            source,
            line: event.line,
            order: nextOrder,
            mountChain,
            middlewareStack: [
              ...inheritedMiddleware,
              ...applicableMiddleware,
              ...event.routeMiddleware.map((name) => `${source}:${event.line}:${name}`),
            ],
          });
          nextOrder += 1;
        }
        continue;
      }

      const childSource = relativeRepositoryPath(event.child);
      walk(
        event.child,
        joinHttpPaths(mountedAt, event.path),
        [...mountChain, `${source}:${event.line}->${childSource}`],
        [...inheritedMiddleware, ...applicableMiddleware],
        nextAncestry,
      );
    }
  }

  walk(
    path.join(routeRoot, 'register.ts'),
    '/',
    [],
    [],
    new Set(),
  );

  return registrations;
}

function collisionMap(manifest: RouteRegistration[]): Map<string, RouteRegistration[]> {
  const grouped = new Map<string, RouteRegistration[]>();
  for (const registration of manifest) {
    const key = `${registration.method} ${registration.path}`;
    const current = grouped.get(key) ?? [];
    current.push(registration);
    grouped.set(key, current);
  }

  return new Map(
    [...grouped.entries()]
      .filter(([, registrations]) => registrations.length > 1)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, registrations]) => [
        key,
        [...registrations].sort((left, right) => left.order - right.order),
      ]),
  );
}

function readTrackedFiles(sourceCommit: string): string[] {
  return execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', sourceCommit],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
    .split(/\r?\n/u)
    .map((filePath) => normalizeRepositoryPath(filePath.trim()))
    .filter(Boolean)
    .sort();
}

function validateCoverageLabels(report: CoverageReport): void {
  if (report.interpretation.repositoryWide100Percent) {
    throw new Error('Scoped coverage must not be labeled as repository-wide 100% coverage.');
  }
  if (!/configured coverage scope/iu.test(report.label) || !/not repository-wide/iu.test(report.label)) {
    throw new Error('Coverage label must distinguish configured scope from repository-wide coverage.');
  }
  if (report.configuredScope.configuredFileCount > report.repositorySourceDenominator.applicableTypeScriptFileCount) {
    throw new Error('Configured coverage scope cannot exceed the repository source denominator.');
  }
  if (
    report.configuredScope.configuredFileCount
    > report.monorepoProductionSourceDenominator.applicableTypeScriptFileCount
  ) {
    throw new Error('Configured coverage scope cannot exceed the monorepo source denominator.');
  }
}

describe('reusable-code audit: deterministic route-collision manifest', () => {
  it('detects the currently registered collision families in source registration order', () => {
    const manifest = buildRouteManifest();
    const collisions = collisionMap(manifest);

    expect([...collisions.keys()]).toEqual(
      [...collisions.keys()].sort((left, right) => left.localeCompare(right)),
    );

    const reusablePost = collisions.get('POST /api/reusables');
    const reusableHealth = collisions.get('GET /api/reusables/health');
    const audit = collisions.get('POST /audit');
    const update = collisions.get('POST /api/update');
    const health = collisions.get('GET /health');

    expect(reusablePost).toHaveLength(2);
    expect(reusableHealth).toHaveLength(2);
    expect(audit).toHaveLength(2);
    expect(update).toHaveLength(2);
    expect(health).toHaveLength(3);

    expect(reusablePost?.map((entry) => entry.source)).toEqual([
      'src/routes/api-reusable-code.ts',
      'src/routes/api-reusable-code.ts',
    ]);
    expect(reusablePost?.[0]?.mountChain).toEqual(expect.arrayContaining([
      expect.stringMatching(
        /^src\/routes\/register\.ts:\d+->src\/routes\/api\/index\.ts$/u,
      ),
      expect.stringMatching(
        /^src\/routes\/api\/index\.ts:\d+->src\/routes\/api-reusable-code\.ts$/u,
      ),
    ]));
    expect(reusablePost?.[0]?.middlewareStack.join('\n')).toContain('memoryConsistencyGate');
    expect(reusablePost?.[1]?.mountChain).toEqual([
      expect.stringMatching(
        /^src\/routes\/register\.ts:\d+->src\/routes\/api-reusable-code\.ts$/u,
      ),
    ]);
    expect(reusablePost?.[1]?.middlewareStack.join('\n')).not.toContain('memoryConsistencyGate');

    expect(audit?.map((entry) => entry.source)).toEqual([
      'src/routes/ai-endpoints.ts',
      'src/routes/reinforcement.ts',
    ]);
    expect(update?.map((entry) => entry.source)).toEqual([
      'src/routes/api-update.ts',
      'src/routes/api-daemon.ts',
    ]);
    expect(health?.map((entry) => entry.source)).toEqual([
      'src/routes/health.ts',
      'src/routes/status.ts',
      'src/routes/reinforcement.ts',
    ]);
  });

  it('keeps duplicate mount chains and middleware stacks stable across repeated scans', () => {
    const first = buildRouteManifest()
      .filter((entry) => entry.path === '/api/reusables' || entry.path === '/api/reusables/health');
    const second = buildRouteManifest()
      .filter((entry) => entry.path === '/api/reusables' || entry.path === '/api/reusables/health');

    expect(second).toEqual(first);
  });
});

describe('reusable-code audit: actual API/reusable routers without full registerRoutes bootstrap', () => {
  it('proves the nested API registration terminates before the later direct registration', async () => {
    memoryConsistencyGateMock.mockClear();
    getOpenAIClientOrAdapterMock.mockClear();
    const app = express();
    app.use('/', apiRouter);
    app.use('/', reusableCodeRouter);

    const response = await request(app).get('/api/reusables/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ready',
    }));
    expect(response.headers['x-reusable-audit-memory-gate']).toBe('observed');
    expect(memoryConsistencyGateMock).toHaveBeenCalledTimes(1);
    expect(getOpenAIClientOrAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('proves reversing the same actual routers bypasses the nested middleware stack', async () => {
    memoryConsistencyGateMock.mockClear();
    getOpenAIClientOrAdapterMock.mockClear();
    const app = express();
    app.use('/', reusableCodeRouter);
    app.use('/', apiRouter);

    const response = await request(app).get('/api/reusables/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      status: 'ready',
    }));
    expect(response.headers['x-reusable-audit-memory-gate']).toBeUndefined();
    expect(memoryConsistencyGateMock).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapterMock).toHaveBeenCalledTimes(1);
  });
});

describe('reusable-code audit: configured coverage scope labels and denominator', () => {
  const auditDirectory = path.join(
    repositoryRoot,
    'docs',
    'audits',
    'reusable-code',
    '2026-07-16',
  );
  const baseline = JSON.parse(
    readFileSync(path.join(auditDirectory, 'baseline.json'), 'utf8'),
  ) as { sourceCommit: string };
  const coverageReport = JSON.parse(
    readFileSync(path.join(auditDirectory, 'coverage-report.json'), 'utf8'),
  ) as CoverageReport;

  it('derives the executable TypeScript denominator and represented percentage from repository rules', () => {
    const trackedFiles = readTrackedFiles(baseline.sourceCommit);
    const trackedTypeScript = trackedFiles.filter(
      (filePath) => filePath.startsWith('src/') && filePath.endsWith('.ts'),
    );
    const declarations = trackedTypeScript.filter((filePath) => filePath.endsWith('.d.ts'));
    const applicableSource = trackedTypeScript.filter((filePath) => !filePath.endsWith('.d.ts'));
    const configuredScope = [...new Set(codecovCoverageScopeFiles)]
      .map(normalizeRepositoryPath)
      .sort();
    const representedPercent = Number(
      ((configuredScope.length / applicableSource.length) * 100).toFixed(4),
    );
    const productionRoots = [
      { root: 'src/', ownership: 'Root backend' },
      { root: 'packages/protocol/src/', ownership: '@arcanos/protocol workspace' },
      { root: 'packages/cli/src/', ownership: '@arcanos/cli workspace' },
      { root: 'packages/arcanos-runtime/src/', ownership: '@arcanos/runtime workspace' },
      { root: 'packages/arcanos-openai/src/', ownership: '@arcanos/openai workspace' },
      { root: 'workers/src/', ownership: 'arcanos-workers workspace' },
      { root: 'arcanos-ai-runtime/src/', ownership: 'arcanos-ai-runtime workspace' },
    ];
    const productionRootCounts = productionRoots.map(({ root, ownership }) => ({
      root,
      ownership,
      applicableTypeScriptFileCount: trackedFiles.filter(
        (filePath) =>
          filePath.startsWith(root)
          && filePath.endsWith('.ts')
          && !filePath.endsWith('.d.ts'),
      ).length,
    }));
    const monorepoSourceCount = productionRootCounts.reduce(
      (total, entry) => total + entry.applicableTypeScriptFileCount,
      0,
    );
    const monorepoRepresentedPercent = Number(
      ((configuredScope.length / monorepoSourceCount) * 100).toFixed(4),
    );

    expect(coverageReport.configuredScope.configuredFileCount).toBe(configuredScope.length);
    expect(coverageReport.configuredScope.fileCount).toBe(configuredScope.length);
    expect(coverageReport.configuredScope.files).toEqual(configuredScope);
    expect(coverageReport.repositorySourceDenominator.applicableTypeScriptFileCount)
      .toBe(applicableSource.length);
    expect(coverageReport.repositorySourceDenominator.representedFileCount)
      .toBe(configuredScope.length);
    expect(coverageReport.repositorySourceDenominator.representedPercent)
      .toBe(representedPercent);
    expect(coverageReport.repositorySourceDenominator.exclusions).toEqual([
      {
        category: 'TypeScript declarations',
        reason: 'Declarations contain no executable source behavior.',
        files: declarations,
      },
    ]);

    for (const sourceFile of configuredScope) {
      expect(applicableSource).toContain(sourceFile);
    }

    expect(coverageReport.monorepoProductionSourceDenominator.roots)
      .toEqual(productionRootCounts);
    expect(coverageReport.monorepoProductionSourceDenominator.applicableTypeScriptFileCount)
      .toBe(monorepoSourceCount);
    expect(coverageReport.monorepoProductionSourceDenominator.representedFileCount)
      .toBe(configuredScope.length);
    expect(coverageReport.monorepoProductionSourceDenominator.representedPercent)
      .toBe(monorepoRepresentedPercent);
  });

  it('reports scoped metrics without making a repository-wide 100% claim', () => {
    validateCoverageLabels(coverageReport);
    expect(coverageReport.label).toBe('Configured coverage scope (not repository-wide coverage)');
    expect(coverageReport.interpretation.repositoryWide100Percent).toBe(false);
    expect(coverageReport.interpretation.statement).toContain(
      `${coverageReport.repositorySourceDenominator.representedPercent}%`,
    );

    for (const metric of Object.values(coverageReport.configuredScope.metrics)) {
      expect(metric.pct).toBe(100);
    }
  });

  it('rejects a misleading repository-wide label for scoped metrics', () => {
    const misleadingReport: CoverageReport = {
      ...coverageReport,
      label: 'Repository coverage: 100%',
      interpretation: {
        ...coverageReport.interpretation,
        repositoryWide100Percent: true,
      },
    };

    expect(() => validateCoverageLabels(misleadingReport)).toThrow(
      'Scoped coverage must not be labeled as repository-wide 100% coverage.',
    );
  });
});
