#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import madge from 'madge';
import ts from 'typescript';

const currentScriptPath = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(currentScriptPath), '..');
const PREVIEW_ENTRY_FILES = [
  'scripts/esm-alias-loader.mjs',
  'scripts/native-pr-preview-contract.mjs',
  'scripts/register-esm-loader.mjs',
  'scripts/start-railway-service.mjs',
  'src/nativePrPreviewApplication.ts',
  'src/routes/genericJobsRouter.ts',
  'src/start-native-pr-preview.ts',
];
export const NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES = Object.freeze([
  'scripts/esm-alias-loader.mjs',
  'scripts/native-pr-preview-contract.d.mts',
  'scripts/native-pr-preview-contract.mjs',
  'scripts/register-esm-loader.mjs',
  'scripts/start-railway-service.mjs',
  'src/lib/errors/responses.ts',
  'src/nativePrPreviewApplication.ts',
  'src/nativePrPreviewContract.ts',
  'src/routes/genericJobsRouter.ts',
  'src/shared/gpt/gptIdempotency.ts',
  'src/shared/gpt/gptJobLifecycle.ts',
  'src/shared/gpt/gptJobResult.ts',
  'src/shared/http/clientJsonPayload.ts',
  'src/shared/http/clientResponseCommon.ts',
  'src/shared/http/errors.ts',
  'src/shared/http/sendBoundedJsonResponse.ts',
  'src/shared/http/sendPreparedJsonResponse.ts',
  'src/shared/http/validation.ts',
  'src/shared/jobs/jobLinks.ts',
  'src/shared/jobs/jobReadCapability.ts',
  'src/shared/security/opaqueSecret.ts',
  'src/shared/security/purposeBoundCredential.ts',
  'src/start-native-pr-preview.ts',
  'src/transport/http/asyncHandler.ts',
  'src/transport/http/responseHelpers.ts',
]);
const ALLOWED_GRAPH_FILES =
  new Set(NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES);
const FORBIDDEN_LOCAL_IMPORT_PATTERNS = [
  /^src\/app\.ts$/u,
  /^src\/server\.ts$/u,
  /^src\/core\/db\//u,
  /^src\/core\/diagnostics\.ts$/u,
  /^src\/core\/init-openai\.ts$/u,
  /^src\/middleware\//u,
  /^src\/platform\//u,
  /^src\/routes\/jobs\.ts$/u,
  /^src\/routes\/modules\.ts$/u,
  /^src\/routes\/register\.ts$/u,
  /^src\/services\//u,
  /^src\/shared\/http\/index\.ts$/u,
  /^src\/shared\/http\/middleware\.ts$/u,
  /^src\/transport\/http\/middleware\//u,
  /^src\/workers\//u,
];
const LOCAL_IMPORT_PREFIXES = [
  '.',
  '@analytics/',
  '@config/',
  '@core/',
  '@dag/',
  '@dispatcher/',
  '@middleware/',
  '@platform/',
  '@routes/',
  '@services/',
  '@shared/',
  '@stores/',
  '@transport/',
  '@trinity/',
  '@workers/',
];
const ALLOWED_EXTERNAL_RUNTIME_IMPORTS = new Set([
  'express',
  'node:crypto',
  'zod',
]);
const FILE_SPECIFIC_EXTERNAL_RUNTIME_IMPORTS = new Map([
  ['scripts/esm-alias-loader.mjs', new Set(['node:path', 'node:url'])],
  ['scripts/register-esm-loader.mjs', new Set(['node:module'])],
  [
    'scripts/start-railway-service.mjs',
    new Set([
      'node:child_process',
      'node:http',
      'node:process',
      'node:url',
    ]),
  ],
  ['src/start-native-pr-preview.ts', new Set(['node:http', 'node:url'])],
]);
const FILE_SPECIFIC_EXTERNAL_IMPORT_BINDINGS = new Map([
  [
    'scripts/esm-alias-loader.mjs',
    new Map([
      ['node:path', new Set(['default:path'])],
      ['node:url', new Set(['pathToFileURL:pathToFileURL'])],
    ]),
  ],
  [
    'scripts/register-esm-loader.mjs',
    new Map([
      ['node:module', new Set(['register:register'])],
    ]),
  ],
  [
    'scripts/start-railway-service.mjs',
    new Map([
      ['node:child_process', new Set(['spawn:spawn'])],
      ['node:http', new Set(['createServer:createServer'])],
      ['node:process', new Set(['default:process'])],
      [
        'node:url',
        new Set([
          'fileURLToPath:fileURLToPath',
          'pathToFileURL:pathToFileURL',
        ]),
      ],
    ]),
  ],
  [
    'src/start-native-pr-preview.ts',
    new Map([
      ['node:http', new Set(['createServer:createServer'])],
      ['node:url', new Set(['pathToFileURL:pathToFileURL'])],
    ]),
  ],
]);
const ALLOWED_LISTENER_CALLS = new Map([
  [
    'scripts/start-railway-service.mjs',
    new Map([
      ['runPassivePrPreview', new Set(['server'])],
      ['runWorkerRuntimeWithHealthServer', new Set(['healthServer'])],
    ]),
  ],
  [
    'src/start-native-pr-preview.ts',
    new Map([
      ['listen', new Set(['server'])],
    ]),
  ],
]);
const RAILWAY_LAUNCHER_FILE = 'scripts/start-railway-service.mjs';
const NATIVE_PREVIEW_LAUNCH_FUNCTION = 'runNativePrApplicationPreview';

function isRuntimeImportDeclaration(node) {
  if (!node.importClause) {
    return true;
  }
  if (node.importClause.isTypeOnly) {
    return false;
  }
  if (node.importClause.name || !node.importClause.namedBindings) {
    return true;
  }
  if (ts.isNamespaceImport(node.importClause.namedBindings)) {
    return true;
  }
  return node.importClause.namedBindings.elements.some(
    (element) => !element.isTypeOnly
  );
}

function isRuntimeExportDeclaration(node) {
  if (node.isTypeOnly) {
    return false;
  }
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
    return true;
  }
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function isLocalImportSpecifier(specifier) {
  return LOCAL_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

function propertyAccessParts(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return [
      ts.isIdentifier(node.expression) ? node.expression.text : null,
      node.name.text,
    ];
  }
  if (
    ts.isElementAccessExpression(node)
    && node.argumentExpression
    && ts.isStringLiteral(node.argumentExpression)
  ) {
    return [
      ts.isIdentifier(node.expression) ? node.expression.text : null,
      node.argumentExpression.text,
    ];
  }
  return null;
}

function runtimeImportBindings(node) {
  const bindings = [];
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) {
    return bindings;
  }
  if (clause.name) {
    bindings.push(`default:${clause.name.text}`);
  }
  if (!clause.namedBindings) {
    return bindings;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    bindings.push(`*:${clause.namedBindings.name.text}`);
    return bindings;
  }
  for (const element of clause.namedBindings.elements) {
    if (!element.isTypeOnly) {
      bindings.push(
        `${element.propertyName?.text ?? element.name.text}:${element.name.text}`
      );
    }
  }
  return bindings;
}

function isNamedPropertyAccess(node, objectName, propertyName) {
  return (
    ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === objectName
    && node.name.text === propertyName
  );
}

function isSafeNativePreviewSpawnCall(node) {
  const [command, args, role, options] = node.arguments;
  if (
    !command
    || !args
    || !role
    || !options
    || !isNamedPropertyAccess(command, 'spawnSpec', 'command')
    || !isNamedPropertyAccess(args, 'spawnSpec', 'args')
    || !ts.isStringLiteral(role)
    || role.text !== 'web'
    || !ts.isObjectLiteralExpression(options)
  ) {
    return false;
  }
  const properties = new Map();
  for (const property of options.properties) {
    if (
      !ts.isPropertyAssignment(property)
      || !ts.isIdentifier(property.name)
    ) {
      return false;
    }
    properties.set(property.name.text, property.initializer);
  }
  return (
    properties.size === 2
    && isNamedPropertyAccess(properties.get('cwd'), 'spawnSpec', 'cwd')
    && isNamedPropertyAccess(properties.get('env'), 'spawnSpec', 'env')
  );
}

export function findUnsafeRuntimeSyntax(filePath, sourceText) {
  const violations = [];
  let nativePreviewSpawnCallCount = 0;
  let nativePreviewSpawnSpecCallCount = 0;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );

  function checkSpecifier(specifier, lineNumber) {
    const fileSpecificImports =
      FILE_SPECIFIC_EXTERNAL_RUNTIME_IMPORTS.get(filePath);
    if (
      !isLocalImportSpecifier(specifier)
      && !ALLOWED_EXTERNAL_RUNTIME_IMPORTS.has(specifier)
      && !fileSpecificImports?.has(specifier)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: external runtime import "${specifier}"`
      );
    }
  }

  function checkImportBindings(node, specifier, lineNumber) {
    const allowedBindings =
      FILE_SPECIFIC_EXTERNAL_IMPORT_BINDINGS
        .get(filePath)
        ?.get(specifier);
    if (!allowedBindings) {
      return;
    }
    for (const binding of runtimeImportBindings(node)) {
      if (!allowedBindings.has(binding)) {
        violations.push(
          `${filePath}:${lineNumber}: forbidden runtime import binding "${binding}"`
        );
      }
    }
  }

  function visit(node, containingFunctionName = null) {
    const lineNumber =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
      + 1;
    const currentFunctionName =
      ts.isFunctionDeclaration(node) && node.name
        ? node.name.text
        : containingFunctionName;
    if (
      ts.isImportDeclaration(node)
      && isRuntimeImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, lineNumber);
      checkImportBindings(node, node.moduleSpecifier.text, lineNumber);
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && isRuntimeExportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node.moduleSpecifier.text, lineNumber);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (!argument || !ts.isStringLiteral(argument)) {
        violations.push(`${filePath}:${lineNumber}: non-literal dynamic import`);
      } else if (!isLocalImportSpecifier(argument.text)) {
        violations.push(`${filePath}:${lineNumber}: external dynamic import`);
      } else {
        checkSpecifier(argument.text, lineNumber);
      }
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && ['eval', 'fetch', 'Function', 'require', 'setInterval', 'setTimeout'].includes(
        node.expression.text
      )
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden ${node.expression.text} call`
      );
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'spawn'
      && !(
        filePath === RAILWAY_LAUNCHER_FILE
        && currentFunctionName === 'spawnProcess'
      )
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden child process spawn call`
      );
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'spawnProcess'
      && currentFunctionName === NATIVE_PREVIEW_LAUNCH_FUNCTION
    ) {
      nativePreviewSpawnCallCount += 1;
      if (!isSafeNativePreviewSpawnCall(node)) {
        violations.push(
          `${filePath}:${lineNumber}: unsafe native preview spawn call`
        );
      }
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'buildNativePrApplicationSpawnSpec'
      && currentFunctionName === NATIVE_PREVIEW_LAUNCH_FUNCTION
    ) {
      nativePreviewSpawnSpecCallCount += 1;
      if (node.arguments.length !== 0) {
        violations.push(
          `${filePath}:${lineNumber}: unsafe native preview spawn specification call`
        );
      }
    } else if (ts.isCallExpression(node)) {
      const propertyAccess = propertyAccessParts(node.expression);
      const allowedListenerObjects =
        ALLOWED_LISTENER_CALLS
          .get(filePath)
          ?.get(currentFunctionName);
      if (
        propertyAccess
        && (
          (
            propertyAccess[0] === 'globalThis'
            && ['fetch', 'setInterval', 'setTimeout'].includes(propertyAccess[1])
          )
          || (
            propertyAccess[0] === 'process'
            && [
              '_linkedBinding',
              'binding',
              'dlopen',
              'getBuiltinModule',
            ].includes(propertyAccess[1])
          )
          || (
            propertyAccess[1] === 'listen'
            && !allowedListenerObjects?.has(propertyAccess[0])
          )
        )
      ) {
        violations.push(
          `${filePath}:${lineNumber}: forbidden runtime effect call`
        );
      }
    } else if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && ['EventSource', 'Function', 'WebSocket'].includes(node.expression.text)
    ) {
      violations.push(
        `${filePath}:${lineNumber}: forbidden ${node.expression.text} constructor`
      );
    }
    ts.forEachChild(
      node,
      (child) => visit(child, currentFunctionName)
    );
  }

  visit(sourceFile);
  if (filePath === RAILWAY_LAUNCHER_FILE) {
    if (nativePreviewSpawnSpecCallCount !== 1) {
      violations.push(
        `${filePath}: native preview spawn specification call count must be 1`
      );
    }
    if (nativePreviewSpawnCallCount !== 1) {
      violations.push(
        `${filePath}: native preview spawn call count must be 1`
      );
    }
  }
  return violations;
}

export async function findNativePrPreviewImportViolations({
  repositoryRoot = REPOSITORY_ROOT,
  analyzeDependencies = madge,
} = {}) {
  const graph = await analyzeDependencies(PREVIEW_ENTRY_FILES, {
    baseDir: repositoryRoot,
    detectiveOptions: {
      ts: { skipTypeImports: true },
    },
    fileExtensions: ['mjs', 'ts'],
    tsConfig: path.join(repositoryRoot, 'tsconfig.json'),
  });
  const graphFiles = Object.keys(graph.obj()).sort();
  const violations = [];
  const skippedImports = graph.warnings().skipped ?? [];

  for (const skippedImport of skippedImports) {
    violations.push(`unresolved import: ${skippedImport}`);
  }
  for (const requiredFile of NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES) {
    if (!graphFiles.includes(requiredFile)) {
      violations.push(`required preview graph file missing: ${requiredFile}`);
    }
  }
  for (const graphFile of graphFiles) {
    if (!ALLOWED_GRAPH_FILES.has(graphFile)) {
      violations.push(`unreviewed preview import: ${graphFile}`);
    }
    if (
      FORBIDDEN_LOCAL_IMPORT_PATTERNS.some((pattern) =>
        pattern.test(graphFile)
      )
    ) {
      violations.push(`forbidden preview import: ${graphFile}`);
    }

    const sourceText = await fs.readFile(
      path.join(repositoryRoot, graphFile),
      'utf8'
    );
    violations.push(...findUnsafeRuntimeSyntax(graphFile, sourceText));
  }

  return [...new Set(violations)].sort();
}

export async function runCliCheck() {
  const violations = await findNativePrPreviewImportViolations();
  if (violations.length > 0) {
    console.error('check:native-pr-preview-imports failed');
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    'check:native-pr-preview-imports passed: contained preview graph is side-effect bounded.'
  );
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)
) {
  try {
    await runCliCheck();
  } catch {
    console.error(
      'check:native-pr-preview-imports failed to run: PREVIEW_IMPORT_CHECK_FAILED'
    );
    process.exitCode = 1;
  }
}
