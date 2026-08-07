#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const currentScriptPath = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(currentScriptPath), '..');
const RUNTIME_TARGET_FILE =
  'packages/arcanos-runtime/dist/requestAbort.js';
const RUNTIME_TARGET_SEMANTIC_DIGEST =
  '3d819666e59abbefb9e90b13daab1a5bcff74728728fe82a5e76451250dbef95';

export const NATIVE_PR_PREVIEW_DIST_IMPORT_CONTRACT = Object.freeze([
  Object.freeze({
    bindings: Object.freeze([
      'getRequestAbortContext:getRequestAbortContext',
    ]),
    filePath: 'dist/nativePrPreviewApplication.js',
    specifier: '../packages/arcanos-runtime/dist/requestAbort.js',
  }),
  Object.freeze({
    bindings: Object.freeze([
      'createAbortError:createAbortError',
      'createLinkedAbortController:createLinkedAbortController',
      'runWithRequestAbortContext:runWithRequestAbortContext',
    ]),
    filePath: 'dist/routes/_core/researchAbortDrain.js',
    specifier: '../../../packages/arcanos-runtime/dist/requestAbort.js',
  }),
]);

function runtimeImportBindings(node) {
  const importClause = node.importClause;
  if (!importClause || importClause.isTypeOnly) {
    return [];
  }
  const bindings = [];
  if (importClause.name) {
    bindings.push(`default:${importClause.name.text}`);
  }
  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    bindings.push(`namespace:${namedBindings.name.text}`);
  } else if (namedBindings) {
    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        bindings.push(
          `${element.propertyName?.text ?? element.name.text}:${element.name.text}`
        );
      }
    }
  }
  return bindings.sort();
}

function isRuntimePackageSpecifier(specifier) {
  return (
    specifier.startsWith('@arcanos/runtime')
    || specifier.includes('packages/arcanos-runtime/')
  );
}

export function findRuntimeTargetSemanticDigestViolations(sourceText) {
  const sourceFile = ts.createSourceFile(
    RUNTIME_TARGET_FILE,
    sourceText.replace(/\r\n?/gu, '\n'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });
  const observedDigest = createHash('sha256')
    .update(
      printer.printNode(
        ts.EmitHint.Unspecified,
        sourceFile,
        sourceFile
      )
    )
    .digest('hex');
  if (observedDigest === RUNTIME_TARGET_SEMANTIC_DIGEST) {
    return [];
  }
  return [
    `${RUNTIME_TARGET_FILE}: semantic digest must match the reviewed request-abort runtime build`,
  ];
}

export function findNativePrPreviewDistImportSourceViolations(
  contract,
  sourceText
) {
  const sourceFile = ts.createSourceFile(
    contract.filePath,
    sourceText.replace(/\r\n?/gu, '\n'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const runtimeImports = sourceFile.statements.filter((statement) => (
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && isRuntimePackageSpecifier(statement.moduleSpecifier.text)
  ));
  const violations = [];
  if (runtimeImports.length !== 1) {
    violations.push(
      `${contract.filePath}: expected one reviewed runtime package import`
    );
    return violations;
  }
  const [runtimeImport] = runtimeImports;
  const observedSpecifier = runtimeImport.moduleSpecifier.text;
  if (observedSpecifier !== contract.specifier) {
    violations.push(
      `${contract.filePath}: runtime package import must target ${contract.specifier}`
    );
  }
  const observedBindings = runtimeImportBindings(runtimeImport);
  const expectedBindings = [...contract.bindings].sort();
  if (
    observedBindings.length !== expectedBindings.length
    || observedBindings.some(
      (binding, index) => binding !== expectedBindings[index]
    )
  ) {
    violations.push(
      `${contract.filePath}: runtime package import bindings must match the reviewed surface`
    );
  }
  return violations;
}

export async function findNativePrPreviewDistImportViolations({
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const violations = [];
  const expectedRuntimeTarget = path.resolve(
    repositoryRoot,
    RUNTIME_TARGET_FILE
  );
  try {
    const runtimeTargetSource = await fs.readFile(
      expectedRuntimeTarget,
      'utf8'
    );
    violations.push(
      ...findRuntimeTargetSemanticDigestViolations(runtimeTargetSource)
    );
  } catch {
    violations.push(`${RUNTIME_TARGET_FILE}: built runtime target is missing`);
  }

  for (const contract of NATIVE_PR_PREVIEW_DIST_IMPORT_CONTRACT) {
    const resolvedImportTarget = path.resolve(
      repositoryRoot,
      path.dirname(contract.filePath),
      contract.specifier
    );
    if (resolvedImportTarget !== expectedRuntimeTarget) {
      violations.push(
        `${contract.filePath}: reviewed import does not resolve to ${RUNTIME_TARGET_FILE}`
      );
    }
    try {
      const sourceText = await fs.readFile(
        path.join(repositoryRoot, contract.filePath),
        'utf8'
      );
      violations.push(
        ...findNativePrPreviewDistImportSourceViolations(
          contract,
          sourceText
        )
      );
    } catch {
      violations.push(`${contract.filePath}: built preview module is missing`);
    }
  }
  return [...new Set(violations)].sort();
}

export async function runCliCheck() {
  const violations = await findNativePrPreviewDistImportViolations();
  if (violations.length > 0) {
    console.error('check:native-pr-preview-dist-imports failed');
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    'check:native-pr-preview-dist-imports passed: emitted preview imports resolve to the reviewed request-abort runtime.'
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
      'check:native-pr-preview-dist-imports failed to run: PREVIEW_DIST_IMPORT_CHECK_FAILED'
    );
    process.exitCode = 1;
  }
}
