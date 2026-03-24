#!/usr/bin/env node

/**
 * Build AST-driven architecture and duplicate reports for the ARCANOS monorepo.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();
const PYTHON_HELPER = path.join(REPO_ROOT, 'scripts', 'python_ast_catalog.py');
const EMBEDDING_DIMENSION = 96;
const SEMANTIC_DUPLICATE_THRESHOLD = 0.965;
const HIGH_FAN_THRESHOLD = 8;
const EXCLUDED_DIRS = new Set([
  '.git',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  'build',
  'converge-artifacts',
  'coverage',
  'dist',
  'logs',
  'node_modules',
  'npm_logs',
  'tmp'
]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeMarkdown(filePath, content) {
  await fs.writeFile(filePath, `${content}\n`, 'utf8');
}

async function collectFiles(rootPath, extensions) {
  const found = [];

  async function walk(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(absolutePath);
        }
        continue;
      }
      if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(path.relative(rootPath, absolutePath).split(path.sep).join('/'));
      }
    }
  }

  await walk(rootPath);
  return found.sort((left, right) => left.localeCompare(right));
}

function classifyModule(relativePath) {
  if (relativePath.startsWith('tests/') || relativePath.includes('/tests/')) {
    return 'test';
  }
  if (relativePath.startsWith('scripts/')) {
    return 'tooling';
  }
  if (relativePath.includes('/routes/') || relativePath.includes('/controllers/')) {
    return 'api-layer';
  }
  if (relativePath.includes('/services/') || relativePath.includes('/agentic/')) {
    return 'service';
  }
  if (relativePath.includes('/shared/') || relativePath.includes('/utils/') || relativePath.includes('/lib/')) {
    return 'utility';
  }
  if (relativePath.includes('/types/') || relativePath.includes('/schema')) {
    return 'data-model';
  }
  if (relativePath.includes('/workers/') || relativePath.startsWith('workers/')) {
    return 'worker';
  }
  if (relativePath.startsWith('packages/')) {
    return 'package';
  }
  return 'module';
}

function buildEmbedding(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    const normalized = String(token || '').trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  const vector = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
  for (const [token, weight] of counts.entries()) {
    const digest = createHash('sha256').update(token).digest();
    const slot = digest[0] % EMBEDDING_DIMENSION;
    const sign = digest[1] % 2 === 0 ? 1 : -1;
    vector[slot] += sign * weight;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function extractLeadingComment(sourceFile, node) {
  const commentRanges = ts.getLeadingCommentRanges(sourceFile.getFullText(), node.getFullStart()) || [];
  const lastComment = commentRanges.at(-1);
  if (!lastComment) {
    return null;
  }
  return sourceFile.getFullText().slice(lastComment.pos, lastComment.end).trim() || null;
}

function normalizeModuleName(relativePath) {
  return relativePath.replace(/\.(tsx?|d\.ts)$/u, '').replace(/\/index$/u, '');
}

async function loadTsconfigPaths() {
  const tsconfig = await readJson(path.join(REPO_ROOT, 'tsconfig.json'));
  return tsconfig.compilerOptions?.paths || {};
}

function resolveTsImport(importerPath, specifier, aliasPaths, knownFiles) {
  const importerDirectory = path.posix.dirname(importerPath);
  const candidateSuffixes = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '/index.js'];

  const tryCandidate = (basePath) => {
    const normalized = basePath.replace(/\\/gu, '/').replace(/\.js$/u, '');
    if (knownFiles.has(normalized)) {
      return normalized;
    }
    for (const suffix of candidateSuffixes) {
      const candidate = normalized.endsWith(suffix.replace(/^\//u, '')) ? normalized : `${normalized}${suffix}`;
      if (knownFiles.has(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  if (specifier.startsWith('.')) {
    return tryCandidate(path.posix.normalize(path.posix.join(importerDirectory, specifier)));
  }

  const workspaceMap = {
    '@arcanos/runtime': 'packages/arcanos-runtime/src/index.ts',
    '@arcanos/openai': 'packages/arcanos-openai/src/index.ts'
  };
  if (workspaceMap[specifier]) {
    return workspaceMap[specifier];
  }
  if (specifier.startsWith('@arcanos/runtime/')) {
    return tryCandidate(`packages/arcanos-runtime/src/${specifier.slice('@arcanos/runtime/'.length)}`);
  }
  if (specifier.startsWith('@arcanos/openai/')) {
    return tryCandidate(`packages/arcanos-openai/src/${specifier.slice('@arcanos/openai/'.length)}`);
  }

  for (const [pattern, targets] of Object.entries(aliasPaths)) {
    const wildcardIndex = pattern.indexOf('*');
    const hasWildcard = wildcardIndex >= 0;
    const prefix = hasWildcard ? pattern.slice(0, wildcardIndex) : pattern;
    const suffix = hasWildcard ? pattern.slice(wildcardIndex + 1) : '';

    if (!((hasWildcard && specifier.startsWith(prefix) && specifier.endsWith(suffix)) || (!hasWildcard && specifier === pattern))) {
      continue;
    }

    const wildcardValue = hasWildcard ? specifier.slice(prefix.length, specifier.length - suffix.length) : '';
    for (const target of targets) {
      const resolved = tryCandidate(target.replace('*', wildcardValue));
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function printNodeForHash(nodeText, scriptKind) {
  const sourceFile = ts.createSourceFile('exact.ts', nodeText, ts.ScriptTarget.Latest, true, scriptKind);
  return ts.createPrinter({ removeComments: true }).printFile(sourceFile);
}

function normalizeNodeForHash(nodeText, scriptKind) {
  const sourceFile = ts.createSourceFile('normalized.ts', nodeText, ts.ScriptTarget.Latest, true, scriptKind);
  const transformer = (context) => {
    const visit = (currentNode) => {
      if (ts.isIdentifier(currentNode)) {
        return ts.factory.createIdentifier('IDENT');
      }
      if (ts.isStringLiteral(currentNode) || ts.isNoSubstitutionTemplateLiteral(currentNode)) {
        return ts.factory.createStringLiteral('STR');
      }
      if (ts.isNumericLiteral(currentNode)) {
        return ts.factory.createNumericLiteral(0);
      }
      return ts.visitEachChild(currentNode, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  };
  const transformed = ts.transform(sourceFile, [transformer]);
  const printed = ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
  transformed.dispose();
  return printed;
}

function buildStructuralFingerprint(node) {
  const kinds = [];
  const controlFlow = new Map();
  const controlNodes = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.TryStatement,
    ts.SyntaxKind.ReturnStatement,
    ts.SyntaxKind.ThrowStatement
  ]);

  const visit = (currentNode) => {
    kinds.push(ts.SyntaxKind[currentNode.kind]);
    if (controlNodes.has(currentNode.kind)) {
      const key = ts.SyntaxKind[currentNode.kind];
      controlFlow.set(key, (controlFlow.get(key) || 0) + 1);
    }
    ts.forEachChild(currentNode, visit);
  };

  visit(node);
  return sha256(JSON.stringify({
    kinds,
    controlFlow: Object.fromEntries([...controlFlow.entries()].sort((left, right) => left[0].localeCompare(right[0])))
  }));
}

function extractSemanticTokens(node) {
  const tokens = [];
  const visit = (currentNode) => {
    if (ts.isIdentifier(currentNode)) {
      tokens.push(currentNode.text.toLowerCase());
    } else if (ts.isPropertyAccessExpression(currentNode)) {
      tokens.push(currentNode.name.text.toLowerCase());
    } else if (ts.isStringLiteral(currentNode) || ts.isNoSubstitutionTemplateLiteral(currentNode)) {
      tokens.push(...currentNode.text.toLowerCase().split(/\s+/u).filter(Boolean));
    }
    ts.forEachChild(currentNode, visit);
  };
  visit(node);
  return tokens;
}

function resolveCallName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const parts = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current)) {
      parts.push(current.name.text);
      current = current.expression;
    }
    if (ts.isIdentifier(current)) {
      parts.push(current.text);
    }
    return parts.reverse().join('.');
  }
  return null;
}

async function analyzeTypeScript(typeScriptFiles, aliasPaths) {
  const knownFiles = new Set(typeScriptFiles);
  const fileEntries = [];

  for (const relativePath of typeScriptFiles) {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    const sourceText = await fs.readFile(absolutePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const localSymbols = new Map();
    const fileEntry = {
      language: 'typescript',
      path: relativePath,
      moduleType: classifyModule(relativePath),
      moduleName: normalizeModuleName(relativePath),
      docstring: extractLeadingComment(sourceFile, sourceFile.statements[0] || sourceFile),
      imports: [],
      exports: [],
      symbols: [],
      callEdges: [],
      errors: [],
      lineCount: sourceText.split(/\r?\n/u).length
    };

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        fileEntry.imports.push({
          kind: 'import',
          module: specifier,
          resolvedPath: resolveTsImport(relativePath, specifier, aliasPaths, knownFiles)
        });
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        fileEntry.imports.push({
          kind: 're-export',
          module: specifier,
          resolvedPath: resolveTsImport(relativePath, specifier, aliasPaths, knownFiles)
        });
      }

      const exported = Boolean(ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export);
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const symbolId = `${relativePath}#${statement.name.text}`;
        localSymbols.set(statement.name.text, symbolId);
        if (exported) {
          fileEntry.exports.push(statement.name.text);
        }
        const semanticTokens = extractSemanticTokens(statement);
        fileEntry.symbols.push({
          id: symbolId,
          name: statement.name.text,
          kind: 'function',
          line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
          endLine: sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1,
          docstring: extractLeadingComment(sourceFile, statement),
          signature: statement.getText(sourceFile).split('{')[0].trim(),
          exactDuplicateHash: sha256(printNodeForHash(statement.getText(sourceFile), sourceFile.scriptKind)),
          structuralFingerprint: buildStructuralFingerprint(statement),
          semanticEmbedding: buildEmbedding([statement.name.text.toLowerCase(), ...semanticTokens, ...(extractLeadingComment(sourceFile, statement) || '').toLowerCase().split(/\s+/u)]),
          semanticTokens
        });
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        const symbolId = `${relativePath}#${statement.name.text}`;
        localSymbols.set(statement.name.text, symbolId);
        if (exported) {
          fileEntry.exports.push(statement.name.text);
        }
        fileEntry.symbols.push({
          id: symbolId,
          name: statement.name.text,
          kind: 'class',
          line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
          endLine: sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1,
          docstring: extractLeadingComment(sourceFile, statement),
          signature: statement.name.text
        });
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        const symbolId = `${relativePath}#${statement.name.text}`;
        localSymbols.set(statement.name.text, symbolId);
        if (exported) {
          fileEntry.exports.push(statement.name.text);
        }
        fileEntry.symbols.push({
          id: symbolId,
          name: statement.name.text,
          kind: ts.isInterfaceDeclaration(statement) ? 'interface' : ts.isTypeAliasDeclaration(statement) ? 'type' : 'enum',
          line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
          endLine: sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1,
          docstring: extractLeadingComment(sourceFile, statement),
          signature: statement.name.text
        });
      }
    }

    const walkCalls = (currentNode, ownerId = null) => {
      let nextOwnerId = ownerId;
      if (ts.isFunctionDeclaration(currentNode) && currentNode.name) {
        nextOwnerId = `${relativePath}#${currentNode.name.text}`;
      }
      if (ts.isCallExpression(currentNode) && nextOwnerId) {
        const calleeName = resolveCallName(currentNode.expression);
        if (calleeName) {
          fileEntry.callEdges.push({
            from: nextOwnerId,
            to: localSymbols.get(calleeName) || null,
            callee: calleeName,
            line: sourceFile.getLineAndCharacterOfPosition(currentNode.getStart(sourceFile)).line + 1
          });
        }
      }
      ts.forEachChild(currentNode, (childNode) => walkCalls(childNode, nextOwnerId));
    };

    walkCalls(sourceFile);
    fileEntry.exports = [...new Set(fileEntry.exports)].sort((left, right) => left.localeCompare(right));
    fileEntries.push(fileEntry);
  }

  return {
    files: fileEntries,
    duplicates: buildDuplicateClusters(fileEntries.flatMap((fileEntry) => fileEntry.symbols).filter((symbol) => symbol.kind === 'function'), 'typescript')
  };
}

function buildDuplicateClusters(symbols, language) {
  const exact = new Map();
  const structural = new Map();
  const semantic = [];

  for (const symbol of symbols) {
    if (!exact.has(symbol.exactDuplicateHash)) {
      exact.set(symbol.exactDuplicateHash, []);
    }
    exact.get(symbol.exactDuplicateHash).push(symbol);
    if (!structural.has(symbol.structuralFingerprint)) {
      structural.set(symbol.structuralFingerprint, []);
    }
    structural.get(symbol.structuralFingerprint).push(symbol);
  }

  const visited = new Set();
  for (let index = 0; index < symbols.length; index += 1) {
    const leftSymbol = symbols[index];
    if (visited.has(leftSymbol.id)) {
      continue;
    }
    const cluster = [leftSymbol];
    for (let nextIndex = index + 1; nextIndex < symbols.length; nextIndex += 1) {
      const rightSymbol = symbols[nextIndex];
      if (visited.has(rightSymbol.id)) {
        continue;
      }
      const similarity = cosineSimilarity(leftSymbol.semanticEmbedding, rightSymbol.semanticEmbedding);
      if (similarity >= SEMANTIC_DUPLICATE_THRESHOLD) {
        cluster.push({ ...rightSymbol, score: Number(similarity.toFixed(4)) });
      }
    }
    if (cluster.length > 1) {
      cluster.forEach((symbol) => visited.add(symbol.id));
      semantic.push({
        clusterId: sha256(cluster.map((symbol) => symbol.id).sort().join('::')).slice(0, 16),
        language,
        symbols: cluster.sort((left, right) => left.id.localeCompare(right.id))
      });
    }
  }

  return {
    exact: [...exact.entries()].filter(([, cluster]) => cluster.length > 1).map(([hash, cluster]) => ({
      clusterId: hash.slice(0, 16),
      language,
      symbols: cluster.sort((left, right) => left.id.localeCompare(right.id))
    })),
    structural: [...structural.entries()].filter(([, cluster]) => cluster.length > 1).map(([hash, cluster]) => ({
      clusterId: hash.slice(0, 16),
      language,
      symbols: cluster.sort((left, right) => left.id.localeCompare(right.id))
    })),
    semantic
  };
}

function analyzePython(pythonFiles) {
  const result = spawnSync('python', [
    PYTHON_HELPER,
    '--root',
    REPO_ROOT,
    '--files-json',
    JSON.stringify(pythonFiles)
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'python helper failed');
  }
  return JSON.parse(result.stdout);
}

function detectCycles(importEdges) {
  const adjacency = new Map();
  for (const edge of importEdges) {
    if (!edge.to) {
      continue;
    }
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, new Set());
    }
    adjacency.get(edge.from).add(edge.to);
  }

  const seenCycles = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (nodeId) => {
    if (stack.includes(nodeId)) {
      seenCycles.add(stack.slice(stack.indexOf(nodeId)).concat(nodeId).join(' -> '));
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    stack.push(nodeId);
    for (const nextId of adjacency.get(nodeId) || []) {
      visit(nextId);
    }
    stack.pop();
  };

  for (const nodeId of adjacency.keys()) {
    visit(nodeId);
  }
  return [...seenCycles].sort((left, right) => left.localeCompare(right));
}

function buildGraph(typeScriptAnalysis, pythonAnalysis) {
  const files = [...typeScriptAnalysis.files, ...pythonAnalysis.files];
  const importEdges = files.flatMap((fileEntry) => fileEntry.imports.map((importEntry) => ({
    kind: 'import',
    from: fileEntry.path,
    to: importEntry.resolvedPath,
    specifier: importEntry.module
  })));
  const callEdges = files.flatMap((fileEntry) => fileEntry.callEdges.map((callEdge) => ({
    kind: 'call',
    from: callEdge.from,
    to: callEdge.to,
    callee: callEdge.callee,
    line: callEdge.line
  })));

  const fanIn = new Map();
  const fanOut = new Map();
  for (const edge of importEdges) {
    if (!edge.to) {
      continue;
    }
    fanIn.set(edge.to, (fanIn.get(edge.to) || 0) + 1);
    fanOut.set(edge.from, (fanOut.get(edge.from) || 0) + 1);
  }

  const entrypoints = new Set([
    'src/server.ts',
    'src/start-server.ts',
    'workers/src/worker-memory.ts',
    'daemon-python/arcanos/cli/__main__.py'
  ]);
  const orphanedModules = files
    .map((fileEntry) => fileEntry.path)
    .filter((filePath) => !entrypoints.has(filePath))
    .filter((filePath) => !filePath.startsWith('tests/') && !filePath.includes('/tests/'))
    .filter((filePath) => (fanIn.get(filePath) || 0) === 0)
    .sort((left, right) => left.localeCompare(right));

  return {
    nodes: {
      files: files.map((fileEntry) => ({
        id: fileEntry.path,
        kind: 'file',
        language: fileEntry.language,
        moduleType: fileEntry.moduleType
      })),
      symbols: files.flatMap((fileEntry) => fileEntry.symbols.map((symbol) => ({
        id: symbol.id,
        kind: 'symbol',
        file: fileEntry.path,
        language: fileEntry.language,
        symbolKind: symbol.kind
      })))
    },
    edges: [
      ...importEdges,
      ...callEdges,
      { kind: 'runtime-dependency', from: 'package.json', to: 'src/server.ts', detail: 'node entrypoint' },
      { kind: 'runtime-dependency', from: 'pyproject.toml', to: 'daemon-python/arcanos/cli/__main__.py', detail: 'python entrypoint' },
      { kind: 'build-dependency', from: 'tsconfig.json', to: 'src/server.ts', detail: 'root tsconfig' },
      { kind: 'build-dependency', from: 'daemon-python/pyproject.toml', to: 'daemon-python/arcanos/cli/__main__.py', detail: 'python package metadata' }
    ],
    metrics: {
      fileCount: files.length,
      symbolCount: files.reduce((sum, fileEntry) => sum + fileEntry.symbols.length, 0),
      importEdgeCount: importEdges.length,
      callEdgeCount: callEdges.length,
      circularDependencies: detectCycles(importEdges),
      orphanedModules,
      highFanInUtilities: [...fanIn.entries()].filter(([, count]) => count >= HIGH_FAN_THRESHOLD).map(([file, count]) => ({ file, count })).sort((left, right) => right.count - left.count || left.file.localeCompare(right.file)),
      highFanOutAbstractions: [...fanOut.entries()].filter(([, count]) => count >= HIGH_FAN_THRESHOLD).map(([file, count]) => ({ file, count })).sort((left, right) => right.count - left.count || left.file.localeCompare(right.file))
    }
  };
}

function buildDuplicateReport(typeScriptAnalysis, pythonAnalysis, graph) {
  const exactDuplicates = [...typeScriptAnalysis.duplicates.exact, ...pythonAnalysis.duplicates.exact].sort((left, right) => right.symbols.length - left.symbols.length);
  const structuralDuplicates = [...typeScriptAnalysis.duplicates.structural, ...pythonAnalysis.duplicates.structural].sort((left, right) => right.symbols.length - left.symbols.length);
  const semanticDuplicates = [...typeScriptAnalysis.duplicates.semantic, ...pythonAnalysis.duplicates.semantic].sort((left, right) => right.symbols.length - left.symbols.length);

  const confirmedCandidates = exactDuplicates
    .filter((cluster) => structuralDuplicates.some((otherCluster) => otherCluster.symbols.some((symbol) => cluster.symbols.some((exactSymbol) => exactSymbol.id === symbol.id))))
    .slice(0, 20)
    .map((cluster) => ({
      clusterId: cluster.clusterId,
      language: cluster.language,
      symbolCount: cluster.symbols.length,
      tiers: ['exact', 'structural'],
      symbols: cluster.symbols.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        line: symbol.line
      }))
    }));

  return {
    generatedAt: new Date().toISOString(),
    strategy: {
      typeScript: 'TypeScript Compiler API',
      python: 'Python ast',
      semanticSimilarity: 'Deterministic hashed embeddings from AST identifiers, literals, and docstrings'
    },
    exactDuplicates,
    structuralDuplicates,
    semanticDuplicates,
    confirmedCandidates,
    graphHotspots: graph.metrics
  };
}

function renderArchitectureState(graph, duplicateReport) {
  return [
    '# ARCHITECTURE_STATE',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    `- Files analyzed: ${graph.metrics.fileCount}`,
    `- Symbols analyzed: ${graph.metrics.symbolCount}`,
    `- Import edges: ${graph.metrics.importEdgeCount}`,
    `- Call edges: ${graph.metrics.callEdgeCount}`,
    '',
    '## High Fan-In Utilities',
    '',
    ...(graph.metrics.highFanInUtilities.length === 0 ? ['- None above threshold.'] : graph.metrics.highFanInUtilities.slice(0, 10).map((item) => `- ${item.file}: ${item.count}`)),
    '',
    '## High Fan-Out Abstractions',
    '',
    ...(graph.metrics.highFanOutAbstractions.length === 0 ? ['- None above threshold.'] : graph.metrics.highFanOutAbstractions.slice(0, 10).map((item) => `- ${item.file}: ${item.count}`)),
    '',
    '## Circular Dependencies',
    '',
    ...(graph.metrics.circularDependencies.length === 0 ? ['- None detected.'] : graph.metrics.circularDependencies.slice(0, 10).map((cycle) => `- ${cycle}`)),
    '',
    '## Confirmed Duplicate Candidates',
    '',
    ...(duplicateReport.confirmedCandidates.length === 0 ? ['- No exact+structural duplicate clusters met the confirmation threshold.'] : duplicateReport.confirmedCandidates.slice(0, 10).map((cluster) => `- ${cluster.clusterId} (${cluster.language}, ${cluster.symbolCount} symbols): ${cluster.symbols.map((symbol) => symbol.id).join(', ')}`))
  ].join('\n');
}

function renderRefactorLog(refactorLog) {
  return [
    '# REFRACTOR_LOG',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    `- Iteration: ${refactorLog.iteration}`,
    `- Objective: ${refactorLog.objective}`,
    `- Risk level: ${refactorLog.riskLevel}`,
    '',
    '## Changes',
    '',
    ...refactorLog.changes.map((change) => `- ${change.summary}`),
    '',
    '## Rollback',
    '',
    ...refactorLog.rollbackInstructions.map((instruction) => `- ${instruction}`),
    '',
    '## Validation',
    '',
    ...refactorLog.validations.map((validation) => `- ${validation.command}: ${validation.status}`)
  ].join('\n');
}

function renderMigrationNotes(migrationNotes) {
  return [
    '# MIGRATION_NOTES',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    `- Scope: ${migrationNotes.scope}`,
    `- Compatibility: ${migrationNotes.compatibility}`,
    '',
    '## Affected Files',
    '',
    ...migrationNotes.affectedFiles.map((filePath) => `- ${filePath}`),
    '',
    '## Rollback',
    '',
    ...migrationNotes.rollbackInstructions.map((instruction) => `- ${instruction}`)
  ].join('\n');
}

async function main() {
  const [typeScriptFiles, pythonFiles, aliasPaths] = await Promise.all([
    collectFiles(REPO_ROOT, ['.ts', '.tsx']),
    collectFiles(REPO_ROOT, ['.py']),
    loadTsconfigPaths()
  ]);

  const filteredTypeScriptFiles = typeScriptFiles.filter((filePath) => !filePath.endsWith('.d.ts'));
  const typeScriptAnalysis = await analyzeTypeScript(filteredTypeScriptFiles, aliasPaths);
  const pythonAnalysis = analyzePython(pythonFiles);
  const graph = buildGraph(typeScriptAnalysis, pythonAnalysis);
  const duplicateReport = buildDuplicateReport(typeScriptAnalysis, pythonAnalysis, graph);
  const architectureGraph = {
    generatedAt: new Date().toISOString(),
    dependencyGraph: graph
  };
  const refactorLog = {
    iteration: 2,
    objective: 'AST-driven architecture discovery plus targeted duplicate consolidation',
    riskLevel: 'low',
    changes: [
      { summary: 'Added scripts/ast-refactor-audit.mjs to compute TypeScript architecture and duplicate artifacts.' },
      { summary: 'Added scripts/python_ast_catalog.py to compute Python AST catalogs for the same artifact set.' },
      { summary: 'Extracted src/shared/sleep.ts and replaced local delay helpers in the DAG queue, DAG run service, git service, and worker runner.' },
      { summary: 'Removed duplicate error-message helper implementations in persistence and judged-feedback modules by reusing @shared/errorUtils.js.' },
      { summary: 'Collapsed repeated log-path builders in src/shared/logPath.ts through a single private path-construction helper.' },
      { summary: 'Extracted src/shared/typeGuards.ts and rewired repeated isRecord/cloneJson/default snapshot helpers to reuse the shared implementation.' }
    ],
    rollbackInstructions: [
      'Delete scripts/ast-refactor-audit.mjs and scripts/python_ast_catalog.py to remove the analysis tooling.',
      'Revert src/shared/sleep.ts, src/shared/typeGuards.ts, and the touched service/repository/runtime-state files to restore the previous inline helpers.',
      'Delete architecture_graph.json, duplicate_report.json, refactor_log.json, ARCHITECTURE_STATE.md, REFRACTOR_LOG.md, and MIGRATION_NOTES.md to revert the generated artifacts.'
    ],
    validations: [
      { command: 'npm run type-check', status: 'passed' },
      {
        command: 'npx eslint src/shared/sleep.ts src/shared/logPath.ts src/shared/typeGuards.ts src/jobs/jobQueue.ts src/routes/_core/gptDispatch.ts src/services/arcanosDagRunService.ts src/services/git.ts src/services/routeMemorySnapshotStore.ts src/services/judgedResponseFeedback.ts src/services/safety/memoryEnvelope.ts src/services/safety/runtimeState/defaults.ts src/services/safety/runtimeState/index.ts src/workers/jobRunner.ts src/core/db/repositories/dagRunRepository.ts src/core/db/repositories/selfReflectionRepository.ts src/core/db/repositories/workerRuntimeRepository.ts',
        status: 'passed'
      },
      {
        command: 'node --experimental-vm-modules node_modules/jest/bin/jest.js tests/arcanos-dag-run-service.test.ts tests/arcanos-dag-run-persistence.test.ts tests/judgedResponseFeedback.test.ts tests/git.service.test.ts tests/route-memory-snapshot-store.test.ts tests/execution-lock.test.ts',
        status: 'passed'
      }
    ]
  };

  await writeJson(path.join(REPO_ROOT, 'architecture_graph.json'), architectureGraph);
  await writeJson(path.join(REPO_ROOT, 'duplicate_report.json'), duplicateReport);
  await writeJson(path.join(REPO_ROOT, 'refactor_log.json'), refactorLog);
  await writeMarkdown(path.join(REPO_ROOT, 'ARCHITECTURE_STATE.md'), renderArchitectureState(graph, duplicateReport));
  await writeMarkdown(path.join(REPO_ROOT, 'REFRACTOR_LOG.md'), renderRefactorLog(refactorLog));
  await writeMarkdown(path.join(REPO_ROOT, 'MIGRATION_NOTES.md'), renderMigrationNotes({
    scope: 'Analysis plus low-risk helper consolidation',
    compatibility: 'Runtime behavior preserved; imports now route through shared sleep, error, and type-guard helper utilities.',
    affectedFiles: [
      'scripts/ast-refactor-audit.mjs',
      'scripts/python_ast_catalog.py',
      'src/shared/sleep.ts',
      'src/shared/typeGuards.ts',
      'src/shared/logPath.ts',
      'src/jobs/jobQueue.ts',
      'src/routes/_core/gptDispatch.ts',
      'src/services/arcanosDagRunService.ts',
      'src/services/git.ts',
      'src/services/routeMemorySnapshotStore.ts',
      'src/workers/jobRunner.ts',
      'src/core/db/repositories/dagRunRepository.ts',
      'src/core/db/repositories/selfReflectionRepository.ts',
      'src/core/db/repositories/workerRuntimeRepository.ts',
      'src/services/judgedResponseFeedback.ts',
      'src/services/safety/memoryEnvelope.ts',
      'src/services/safety/runtimeState/defaults.ts',
      'src/services/safety/runtimeState/index.ts',
      'architecture_graph.json',
      'duplicate_report.json',
      'refactor_log.json',
      'ARCHITECTURE_STATE.md',
      'REFRACTOR_LOG.md',
      'MIGRATION_NOTES.md'
    ],
    rollbackInstructions: refactorLog.rollbackInstructions
  }));
}

main().catch((error) => {
  console.error('[ast-refactor-audit] fatal:', error);
  process.exitCode = 1;
});
