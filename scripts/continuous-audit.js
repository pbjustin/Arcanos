#!/usr/bin/env node

/**
 * ARCANOS Continuous Audit Loop
 * Purpose: Run recursive audits across configured workspaces with stateful tracking.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { StringDecoder } from 'string_decoder';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const LOG_DIR_NAME = 'logs';
const STATE_FILE_NAME = 'continuous-audit-state.json';
const LATEST_FILE_NAME = 'continuous-audit-latest.json';
const MAX_MODULE_LINES = 300;
const COMMENT_AGE_DAYS = 14;
const HASH_ALGORITHM = 'sha256';
const DUPLICATE_SAMPLE_BYTES = 128;

const CODE_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.py']);
const TEST_FILE_REGEX = /\.test\./i;
const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  /export\s+class\s+(\w+)/g,
  /export\s+const\s+(\w+)/g
];

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.vscode',
  'npm_logs',
  'logs'
]);

const COMMENTED_CODE_PATTERN =
  /^\s*(?:\/\/|#)\s*(if|for|while|return|const|let|var|class|function|def|import|from|export|try|catch|except|switch|case|break|continue|await|async|with)\b/;

const LEGACY_PATTERNS = [
  { name: 'var usage', regex: /\bvar\s+\w+/ },
  { name: 'require() usage', regex: /\brequire\s*\(/ },
  { name: 'module.exports usage', regex: /\bmodule\.exports\b/ },
  { name: 'deprecated OpenAI Completion.create', regex: /\bCompletion\.create\b/ },
  { name: 'deprecated OpenAI engine param', regex: /\bengine\s*:/ }
];

/**
 * Parse workspace list from argv or environment.
 * Purpose: Determine which roots to audit.
 * Inputs: argv array.
 * Outputs: array of absolute paths.
 * Edge cases: missing args -> default root; invalid paths -> filtered out.
 */
function parseWorkspaceArgs(argv) {
  const envValue = process.env.ARCANOS_AUDIT_WORKSPACES;
  const flagIndex = argv.findIndex(arg => arg === '--workspaces' || arg === '--workspace');
  let raw = '';

  //audit Assumption: explicit flag overrides env var; risk: ignoring env config; invariant: explicit args win; handling: read argv first.
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    raw = argv[flagIndex + 1];
  } else if (envValue) {
    raw = envValue;
  } else {
    return [DEFAULT_ROOT];
  }

  //audit Assumption: delimiter is comma or semicolon; risk: spaces-only input; invariant: trimmed list of paths; handling: split and filter empty entries.
  const workspaces = raw
    .split(/[;,]/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));

  //audit Assumption: empty workspace list should fall back; risk: audit skips everything; invariant: at least one workspace; handling: fallback to default root.
  if (workspaces.length === 0) {
    return [DEFAULT_ROOT];
  }

  return workspaces;
}

/**
 * Parse audit cycle count from argv.
 * Purpose: Control recursive loop iterations.
 * Inputs: argv array.
 * Outputs: positive integer for cycles.
 * Edge cases: invalid values -> fallback to 1.
 */
function parseCycleCount(argv) {
  const flagIndex = argv.findIndex(arg => arg === '--cycles');

  //audit Assumption: missing flag means single cycle; risk: unintended recursion; invariant: defaults to 1; handling: return 1 when flag absent.
  if (flagIndex === -1 || !argv[flagIndex + 1]) {
    return 1;
  }

  const parsed = Number.parseInt(argv[flagIndex + 1], 10);

  //audit Assumption: non-positive cycles are invalid; risk: infinite loop; invariant: cycles >= 1; handling: clamp to 1.
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return parsed;
}

/**
 * Parse command-line flags from argv.
 * Purpose: Extract boolean flags for audit behavior.
 * Inputs: argv array.
 * Outputs: object with flag values.
 */
function parseFlags(argv) {
  return {
    recursive: argv.includes('--recursive'),
    autoFix: argv.includes('--auto-fix'),
    railwayCheck: argv.includes('--railway-check'),
    maxDepth: 10 // Maximum recursive depth
  };
}

/**
 * Determine if a path should be ignored.
 * Purpose: Skip generated or vendor directories.
 * Inputs: relative path string.
 * Outputs: boolean (true = ignore).
 * Edge cases: nested directories.
 */
function shouldIgnorePath(relativePath) {
  const segments = relativePath.split(path.sep);

  //audit Assumption: any ignored segment excludes the path; risk: false negatives on nested dirs; invariant: ignored segments are skipped; handling: check all segments.
  return segments.some(segment => IGNORE_DIRS.has(segment));
}

/**
 * Normalize a relative path to POSIX separators for logging.
 * Purpose: Make logs consistent across OSes.
 * Inputs: relative path.
 * Outputs: normalized relative path.
 * Edge cases: empty path.
 */
function normalizeRelativePath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');

  //audit Assumption: normalization should not change semantics; risk: double slashes; invariant: single separator; handling: trim leading './'.
  if (normalized.startsWith('./')) {
    return normalized.slice(2);
  }

  return normalized;
}

/**
 * Create a stable fingerprint for a file used in duplicate detection.
 * Purpose: Provide a secondary verification for hash matches.
 * Inputs: file size in bytes, head sample, tail sample.
 * Outputs: object containing size and samples.
 * Edge cases: files smaller than sample size.
 */
function buildFileFingerprint(sizeBytes, headSampleBase64, tailSampleBase64) {
  return {
    sizeBytes,
    headSampleBase64,
    tailSampleBase64
  };
}

/**
 * Build a compact signature for a file fingerprint.
 * Purpose: Create stable grouping keys without logging raw samples.
 * Inputs: file fingerprint object.
 * Outputs: SHA-256 hex signature.
 * Edge cases: empty samples still produce a signature.
 */
function buildFingerprintSignature(fingerprint) {
  const signatureSource = `${fingerprint.sizeBytes}:${fingerprint.headSampleBase64}:${fingerprint.tailSampleBase64}`;
  return crypto.createHash('sha256').update(signatureSource).digest('hex');
}

/**
 * Track file hash entries with size-aware buckets.
 * Purpose: Group files by hash and size for duplicate verification.
 * Inputs: file hash map, hash string, size, relative path, fingerprint.
 * Outputs: none (mutates map).
 * Edge cases: repeated file paths.
 */
function registerFileHashEntry(fileHashes, hash, sizeBytes, relativePath, fingerprint) {
  //audit Assumption: hash and size uniquely bucket file content; risk: collisions; invariant: size bucket holds same hash; handling: group by hash+size.
  if (!fileHashes.has(hash)) {
    fileHashes.set(hash, new Map());
  }

  const sizeBuckets = fileHashes.get(hash);
  //audit Assumption: size bucket created when missing; risk: missing bucket throws; invariant: size bucket exists; handling: initialize bucket.
  if (!sizeBuckets.has(sizeBytes)) {
    sizeBuckets.set(sizeBytes, { files: new Set(), fingerprints: new Map() });
  }

  const bucket = sizeBuckets.get(sizeBytes);
  //audit Assumption: file paths are unique identifiers; risk: duplicate path entries; invariant: set prevents duplicates; handling: use Set.
  bucket.files.add(relativePath);
  bucket.fingerprints.set(relativePath, fingerprint);
}

/**
 * Scan a file's content line-by-line for signals while hashing the content.
 * Purpose: Extract findings without loading full content into memory.
 * Inputs: root path, file path, dependency bag.
 * Outputs: object with scan data or error info.
 * Edge cases: unreadable files or stream errors.
 */
async function scanFileWithStream(root, filePath, dependencies) {
  const {
    exportPatterns,
    createReadStream,
    crypto,
    sampleBytes,
    stringDecoderFactory
  } = dependencies;
  const relativePath = normalizeRelativePath(path.relative(root, filePath));
  const commentedLines = [];
  const legacyMatches = [];
  const exportMatches = [];
  let lineCount = 0;
  let resolved = false;
  let sizeBytes = 0;
  let headSample = Buffer.alloc(0);
  let tailSample = Buffer.alloc(0);
  let textRemainder = '';
  const decoder = stringDecoderFactory();
  const hasher = crypto.createHash(HASH_ALGORITHM);

  const processLine = (rawLine) => {
    //audit Assumption: line endings may contain carriage returns; risk: miscount; invariant: \r removed; handling: trim trailing \r.
    const lineText = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    lineCount += 1;

    //audit Assumption: commented code matches heuristic; risk: false positives; invariant: logged for verification; handling: record line.
    if (COMMENTED_CODE_PATTERN.test(lineText)) {
      commentedLines.push({ file: relativePath, line: lineCount, message: lineText.trim() });
    }

    //audit Assumption: legacy patterns are detectable per line; risk: missing multi-line patterns; invariant: line-based scan; handling: test per line.
    for (const pattern of LEGACY_PATTERNS) {
      if (pattern.regex.test(lineText)) {
        legacyMatches.push({
          file: relativePath,
          line: lineCount,
          message: `${pattern.name} detected.`
        });
      }
    }

    //audit Assumption: export regexes cover main symbols; risk: missing other exports; invariant: baseline export mapping; handling: scan patterns.
    for (const pattern of exportPatterns) {
      for (const match of lineText.matchAll(pattern)) {
        const name = match[1];
        exportMatches.push({ name, file: relativePath, line: lineCount });
      }
    }
  };

  //audit Assumption: stream errors are recoverable per-file; risk: missing hash; invariant: caller receives error info; handling: resolve with error.
  return await new Promise((resolve) => {
    const resolveOnce = (payload) => {
      //audit Assumption: stream resolves once; risk: double resolve; invariant: single resolve; handling: guard with flag.
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(payload);
    };

    const stream = createReadStream(filePath);

    stream.on('data', chunk => {
      hasher.update(chunk);
      sizeBytes += chunk.length;

      //audit Assumption: head sample captures initial bytes; risk: empty file; invariant: head sample <= sampleBytes; handling: slice as needed.
      if (headSample.length < sampleBytes) {
        const remaining = sampleBytes - headSample.length;
        headSample = Buffer.concat([headSample, chunk.slice(0, remaining)]);
      }

      //audit Assumption: tail sample captures final bytes; risk: very small files; invariant: tail sample <= sampleBytes; handling: keep rolling buffer.
      if (chunk.length >= sampleBytes) {
        tailSample = chunk.slice(-sampleBytes);
      } else {
        tailSample = Buffer.concat([tailSample, chunk]).slice(-sampleBytes);
      }

      const chunkText = decoder.write(chunk);
      const combinedText = textRemainder + chunkText;
      const endsWithNewline = combinedText.endsWith('\n');
      const lines = combinedText.split('\n');
      const remainder = lines.pop() ?? '';

      for (const line of lines) {
        processLine(line);
      }

      //audit Assumption: trailing newline should count as empty line; risk: missing line count; invariant: newline adds a line; handling: process empty remainder.
      if (endsWithNewline) {
        processLine('');
        textRemainder = '';
      } else {
        textRemainder = remainder;
      }
    });

    stream.on('error', error => {
      resolveOnce({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown stream error',
        relativePath
      });
    });

    stream.on('end', () => {
      const finalText = textRemainder + decoder.end();
      //audit Assumption: remaining text represents final line; risk: dropping last line; invariant: final text processed; handling: parse when non-empty.
      if (finalText.length > 0) {
        processLine(finalText);
      }

      resolveOnce({
        ok: true,
        relativePath,
        lineCount,
        commentedLines,
        legacyMatches,
        exportMatches,
        hashResult: {
          hash: hasher.digest('hex'),
          sizeBytes,
          headSampleBase64: headSample.toString('base64'),
          tailSampleBase64: tailSample.toString('base64')
        }
      });
    });
  });
}

/**
 * Collect files with matching extensions under a root.
 * Purpose: Build file inventory for scanning.
 * Inputs: root path, set of extensions.
 * Outputs: array of absolute file paths.
 * Edge cases: unreadable directories.
 */
async function collectFiles(root, extensions) {
  const files = [];

  async function walk(currentDir) {
    let entries = [];

    //audit Assumption: IO errors should not stop the audit; risk: missing files; invariant: best-effort scan; handling: swallow and continue.
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    //audit Assumption: each entry is scanned once; risk: infinite recursion; invariant: directory traversal is acyclic; handling: follow filesystem tree.
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(root, fullPath);

      //audit Assumption: ignore list covers generated content; risk: missing relevant files; invariant: known vendor dirs skipped; handling: skip ignored paths.
      if (shouldIgnorePath(relativePath)) {
        continue;
      }

      //audit Assumption: directories should be traversed; risk: deep nesting; invariant: recursion handles nested trees; handling: recurse on directories.
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      //audit Assumption: only files with target extensions matter; risk: missing relevant code in other extensions; invariant: target set is explicit; handling: filter by extension.
      if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  return files;
}

/**
 * Read JSON from a file path.
 * Purpose: Safely parse JSON configuration files.
 * Inputs: absolute file path.
 * Outputs: object with ok boolean, data, and error.
 * Edge cases: missing files or invalid JSON.
 */
async function readJsonFile(filePath) {
  //audit Assumption: IO failures should be reported as errors; risk: throwing halts audit; invariant: caller gets error info; handling: return ok=false.
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run a shell command and capture output.
 * Purpose: Execute git/tsc/npm utilities.
 * Inputs: command string, cwd path.
 * Outputs: object with ok boolean and output string.
 * Edge cases: non-zero exit codes.
 */
function runCommand(command, cwd) {
  //audit Assumption: command output is useful even on failure; risk: missing stderr; invariant: output captured; handling: return combined output.
  try {
    const output = execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output };
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout) : '';
    const stderr = error?.stderr ? String(error.stderr) : '';
    return { ok: false, output: `${stdout}\n${stderr}`.trim() };
  }
}

/**
 * Get recent merge commits.
 * Purpose: Provide snapshot references for diff comparison.
 * Inputs: workspace root and limit.
 * Outputs: array of commit SHAs.
 * Edge cases: missing git history.
 */
function getMergeCommits(root, limit = 3) {
  const result = runCommand(`git log --merges -n ${limit} --format=%H`, root);

  //audit Assumption: git log may fail outside a repo; risk: empty commits list; invariant: empty array on failure; handling: fallback to [].
  if (!result.ok) {
    return [];
  }

  return result.output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Compute a set of files changed since a commit.
 * Purpose: Track recent changes for findings context.
 * Inputs: root path and commit SHA.
 * Outputs: Set of relative file paths.
 * Edge cases: invalid commit SHA.
 */
function getChangedFilesSince(root, commitSha) {
  const result = runCommand(`git diff --name-only ${commitSha}..HEAD`, root);

  //audit Assumption: git diff may fail; risk: missing change set; invariant: empty set on failure; handling: return empty set.
  if (!result.ok) {
    return new Set();
  }

  const files = result.output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return new Set(files.map(file => normalizeRelativePath(file)));
}

/**
 * Build a union of changed files across commits.
 * Purpose: Mark findings as recently touched.
 * Inputs: array of sets.
 * Outputs: Set of relative file paths.
 * Edge cases: empty input.
 */
function unionChangedFiles(changeSets) {
  const union = new Set();

  //audit Assumption: each change set is iterable; risk: runtime errors; invariant: union contains all entries; handling: iterate defensively.
  for (const changeSet of changeSets) {
    for (const file of changeSet) {
      union.add(file);
    }
  }

  return union;
}

/**
 * Resolve OpenAI major version from package.json.
 * Purpose: Detect legacy SDK versions.
 * Inputs: package.json path.
 * Outputs: major version number or null.
 * Edge cases: missing dependency.
 */
async function getOpenAiMajor(packageJsonPath) {
  const readResult = await readJsonFile(packageJsonPath);

  //audit Assumption: missing package.json returns null; risk: false negatives; invariant: null on error; handling: return null.
  if (!readResult.ok) {
    return null;
  }

  const dependencies = readResult.data.dependencies || {};
  const rawVersion = dependencies.openai;

  //audit Assumption: missing openai dependency returns null; risk: skipping legacy check; invariant: null when not present; handling: return null.
  if (!rawVersion || typeof rawVersion !== 'string') {
    return null;
  }

  const match = rawVersion.match(/(\d+)\./);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Find manifest.json files under a workspace.
 * Purpose: Locate module interface definitions.
 * Inputs: root path.
 * Outputs: array of absolute manifest paths.
 * Edge cases: none found.
 */
function findManifestPaths(root) {
  const result = runCommand(`rg --files -g "manifest.json" "${root}"`, root);

  //audit Assumption: rg may be unavailable; risk: missing manifests; invariant: fallback to empty list; handling: return [].
  if (!result.ok || result.output.length === 0) {
    return [];
  }

  return result.output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Parse tsc output for unused symbol errors.
 * Purpose: Extract unused code findings from compiler output.
 * Inputs: output string and workspace root.
 * Outputs: array of findings.
 * Edge cases: unrelated errors.
 */
function parseTscUnusedOutput(output, root) {
  const findings = [];
  const lines = output.split(/\r?\n/);

  //audit Assumption: TS6133/TS6196 represent unused code; risk: missing other unused signals; invariant: only unused entries captured; handling: filter by codes.
  for (const line of lines) {
    const match = line.match(/^(.*)\((\d+),(\d+)\): error TS(6133|6196): (.*)$/);
    if (!match) {
      continue;
    }

    const filePath = normalizeRelativePath(path.relative(root, match[1]));
    const lineNumber = Number.parseInt(match[2], 10);
    const message = match[5];

    findings.push({
      category: 'unused',
      file: filePath,
      line: lineNumber,
      message,
      action: 'verify'
    });
  }

  return findings;
}

/**
 * Run tsc with unused checks.
 * Purpose: Detect unused locals and parameters.
 * Inputs: workspace root and tsconfig path.
 * Outputs: array of findings.
 * Edge cases: missing tsconfig.
 */
function runTscUnused(root, tsconfigPath) {
  const command = `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false -p "${tsconfigPath}"`;
  const result = runCommand(command, root);

  //audit Assumption: successful tsc run means no unused results; risk: silent failures; invariant: ok maps to empty findings; handling: return with blocked=false.
  if (result.ok) {
    return { findings: [], blocked: false };
  }

  //audit Assumption: missing output implies blocked analysis; risk: false negatives; invariant: blocked marked when no output; handling: return blocked true.
  if (!result.output) {
    return { findings: [], blocked: true };
  }

  const findings = parseTscUnusedOutput(result.output, root);
  const blocked = findings.length === 0;

  return { findings, blocked };
}

/**
 * Get line age in days via git blame.
 * Purpose: Determine age of commented-out code.
 * Inputs: root path, relative file, line number.
 * Outputs: number of days or null.
 * Edge cases: untracked files.
 */
function getLineAgeDays(root, relativeFile, lineNumber) {
  const command = `git blame -L ${lineNumber},${lineNumber} --date=short --porcelain -- "${relativeFile}"`;
  const result = runCommand(command, root);

  //audit Assumption: blame failure means unknown age; risk: missing age; invariant: null returned on failure; handling: return null.
  if (!result.ok) {
    return null;
  }

  const match = result.output.match(/author-time (\d+)/);

  //audit Assumption: author-time exists; risk: missing author-time; invariant: null when missing; handling: return null.
  if (!match) {
    return null;
  }

  const timestampSeconds = Number.parseInt(match[1], 10);

  //audit Assumption: timestamp is valid; risk: NaN; invariant: null when invalid; handling: guard with Number.isFinite.
  if (!Number.isFinite(timestampSeconds)) {
    return null;
  }

  const ageMs = Date.now() - (timestampSeconds * 1000);
  return ageMs / (1000 * 60 * 60 * 24);
}

/**
 * Scan code files for content signals.
 * Purpose: Gather line counts, commented code, legacy patterns, exports, and hashes.
 * Inputs: root path and file list.
 * Outputs: structured scan results including read errors.
 * Edge cases: unreadable files.
 */
async function scanFiles(root, files) {
  const largeFiles = [];
  const commentedLines = [];
  const legacyMatches = [];
  const exportMap = new Map();
  const fileHashes = new Map();
  const fileReadErrors = [];

  const scanDependencies = {
    createReadStream,
    crypto,
    exportPatterns: EXPORT_PATTERNS,
    sampleBytes: DUPLICATE_SAMPLE_BYTES,
    stringDecoderFactory: () => new StringDecoder('utf8')
  };

  //audit Assumption: files list is complete; risk: missing content; invariant: scan each file; handling: iterate all files.
  for (const filePath of files) {
    const scanResult = await scanFileWithStream(root, filePath, scanDependencies);

    //audit Assumption: failed scans should be reported; risk: silent omissions; invariant: errors logged; handling: collect error findings.
    if (!scanResult.ok) {
      fileReadErrors.push({
        file: scanResult.relativePath,
        line: 1,
        message: `Failed to scan file: ${scanResult.error}`
      });
      continue;
    }

    const relativePath = scanResult.relativePath;
    const lineCount = scanResult.lineCount;

    //audit Assumption: line count threshold is 300; risk: misclassifying files; invariant: consistent threshold; handling: compare to MAX_MODULE_LINES.
    if (lineCount > MAX_MODULE_LINES) {
      largeFiles.push({
        file: relativePath,
        line: 1,
        message: `Module exceeds ${MAX_MODULE_LINES} lines (${lineCount}).`
      });
    }

    commentedLines.push(...scanResult.commentedLines);
    legacyMatches.push(...scanResult.legacyMatches);

    for (const exportMatch of scanResult.exportMatches) {
      //audit Assumption: export names should aggregate entries; risk: missing map entry; invariant: map entry exists; handling: initialize when missing.
      if (!exportMap.has(exportMatch.name)) {
        exportMap.set(exportMatch.name, []);
      }
      exportMap.get(exportMatch.name).push({ file: exportMatch.file, line: exportMatch.line });
    }

    const fingerprint = buildFileFingerprint(
      scanResult.hashResult.sizeBytes,
      scanResult.hashResult.headSampleBase64,
      scanResult.hashResult.tailSampleBase64
    );

    //audit Assumption: file hashes help detect duplicates; risk: hash collisions; invariant: hash computed for each file; handling: store by hash+size.
    registerFileHashEntry(
      fileHashes,
      scanResult.hashResult.hash,
      scanResult.hashResult.sizeBytes,
      relativePath,
      fingerprint
    );
  }

  return { largeFiles, commentedLines, legacyMatches, exportMap, fileHashes, fileReadErrors };
}

/**
 * Scan test files for mock references and validate targets.
 * Purpose: Detect stale mocks pointing to missing files.
 * Inputs: root path and test file list.
 * Outputs: array of findings.
 * Edge cases: non-relative module names.
 */
async function scanTestMocks(root, testFiles) {
  const findings = [];
  const mockRegex = /\b(jest\.mock|jest\.unstable_mockModule|vi\.mock)\(\s*['"]([^'"]+)['"]/g;

  //audit Assumption: each test file can be read; risk: missing data; invariant: skip unreadable tests; handling: continue on read errors.
  for (const testFile of testFiles) {
    let content = '';
    try {
      content = await fs.readFile(testFile, 'utf8');
    } catch (error) {
      continue;
    }

    const relativePath = normalizeRelativePath(path.relative(root, testFile));

    for (const match of content.matchAll(mockRegex)) {
      const modulePath = match[2];

      //audit Assumption: only relative mocks map to local files; risk: skipping package mocks; invariant: relative paths resolved; handling: skip non-relative.
      if (!modulePath.startsWith('.') && !modulePath.startsWith('/')) {
        continue;
      }

      const basePath = path.resolve(path.dirname(testFile), modulePath);
      //audit Assumption: path extensions can be normalized; risk: incorrect trimming; invariant: base path without extension when present; handling: strip known extension.
      const baseExtension = path.extname(basePath);
      const baseWithoutExt = baseExtension ? basePath.slice(0, -baseExtension.length) : basePath;
      const candidates = [
        basePath,
        `${baseWithoutExt}.ts`,
        `${baseWithoutExt}.js`,
        `${baseWithoutExt}.mjs`,
        `${baseWithoutExt}.cjs`,
        path.join(baseWithoutExt, 'index.ts'),
        path.join(baseWithoutExt, 'index.js'),
        path.join(baseWithoutExt, 'index.mjs'),
        path.join(baseWithoutExt, 'index.cjs')
      ];

      //audit Assumption: a mock target must exist; risk: false negatives if extension differs; invariant: candidates tested; handling: check for existence.
      let exists = false;
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          exists = true;
          break;
        } catch (error) {
          continue;
        }
      }

      if (!exists) {
        const lineNumber = content.slice(0, match.index || 0).split(/\r?\n/).length;
        findings.push({
          category: 'test-mock',
          file: relativePath,
          line: lineNumber,
          message: `Mock target not found: ${modulePath}`,
          action: 'remove'
        });
      }
    }
  }

  return findings;
}

/**
 * Build findings from duplicate exports.
 * Purpose: Flag possible redundant logic.
 * Inputs: export map.
 * Outputs: array of findings.
 * Edge cases: exports shared intentionally.
 */
function buildDuplicateExportFindings(exportMap) {
  const findings = [];

  //audit Assumption: duplicate exports across files may indicate redundancy; risk: false positives; invariant: duplicates flagged for review; handling: mark verify.
  for (const [name, entries] of exportMap.entries()) {
    if (entries.length < 2) {
      continue;
    }

    for (const entry of entries) {
      findings.push({
        category: 'duplicate',
        file: entry.file,
        line: entry.line,
        message: `Duplicate export '${name}' also found in ${entries.map(item => item.file).join(', ')}`,
        action: 'verify'
      });
    }
  }

  return findings;
}

/**
 * Build findings from duplicate file hashes.
 * Purpose: Detect exact duplicate logic files with secondary fingerprint verification.
 * Inputs: file hash map keyed by hash and size.
 * Outputs: array of findings.
 * Edge cases: small files with boilerplate.
 */
function buildDuplicateFileFindings(fileHashes) {
  const findings = [];

  //audit Assumption: identical hashes require verification; risk: collisions; invariant: confirm via fingerprint; handling: group by size+samples.
  for (const [hash, sizeBuckets] of fileHashes.entries()) {
    for (const [sizeBytes, bucket] of sizeBuckets.entries()) {
      //audit Assumption: duplicate detection needs multiple files; risk: false positives; invariant: only evaluate groups with 2+ files; handling: skip singletons.
      if (bucket.files.size < 2) {
        continue;
      }

      const fingerprintGroups = new Map();
      for (const file of bucket.files) {
        const fingerprint = bucket.fingerprints.get(file);
        //audit Assumption: fingerprint exists for every file; risk: incomplete scan data; invariant: fingerprint required for verification; handling: emit warning and skip.
        if (!fingerprint) {
          findings.push({
            category: 'duplicate',
            file,
            line: 1,
            message: `Missing fingerprint for duplicate verification (hash ${hash}, size ${sizeBytes}b).`,
            action: 'verify'
          });
          continue;
        }
        const fingerprintKey = buildFingerprintSignature(fingerprint);

        if (!fingerprintGroups.has(fingerprintKey)) {
          fingerprintGroups.set(fingerprintKey, []);
        }
        fingerprintGroups.get(fingerprintKey).push(file);
      }

      for (const [fingerprintKey, files] of fingerprintGroups.entries()) {
        //audit Assumption: verified duplicates require matching fingerprints; risk: collisions; invariant: only emit duplicates when 2+ files share fingerprint; handling: skip singletons.
        if (files.length < 2) {
          continue;
        }

        for (const file of files) {
          findings.push({
            category: 'duplicate',
            file,
            line: 1,
            message: `Duplicate file content (hash ${hash}, size ${sizeBytes}b, fingerprint ${fingerprintKey}) shared by ${files.join(', ')}`,
            action: 'verify'
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Load audit state for a workspace.
 * Purpose: Track consecutive findings across runs.
 * Inputs: state file path.
 * Outputs: state object.
 * Edge cases: missing state file.
 */
async function loadAuditState(statePath) {
  const readResult = await readJsonFile(statePath);

  //audit Assumption: missing state file yields defaults; risk: losing history; invariant: default state; handling: return defaults.
  if (!readResult.ok) {
    return { lastSignatures: [], counts: {}, unusedCleanStreak: 0 };
  }

  const data = readResult.data;
  return {
    lastSignatures: Array.isArray(data.lastSignatures) ? data.lastSignatures : [],
    counts: data.counts && typeof data.counts === 'object' ? data.counts : {},
    unusedCleanStreak: Number.isFinite(data.unusedCleanStreak) ? data.unusedCleanStreak : 0
  };
}

/**
 * Save audit state to disk.
 * Purpose: Persist consecutive tracking between runs.
 * Inputs: state path and state object.
 * Outputs: none.
 * Edge cases: IO errors.
 */
async function saveAuditState(statePath, state) {
  //audit Assumption: state directory exists; risk: write failure; invariant: state persisted when possible; handling: best-effort write.
  try {
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    return;
  }
}

/**
 * Update consecutive counts for findings.
 * Purpose: Track repeat findings across runs.
 * Inputs: previous state and current findings.
 * Outputs: updated state and enriched findings.
 * Edge cases: empty findings.
 */
function applyConsecutiveCounts(previousState, findings) {
  const previousSet = new Set(previousState.lastSignatures);
  const nextCounts = {};
  const signatures = [];

  //audit Assumption: signature keys are stable; risk: signature churn; invariant: same issue yields same signature; handling: include file, line, category, message.
  for (const finding of findings) {
    const signature = `${finding.category}|${finding.file}|${finding.line}|${finding.message}`;
    signatures.push(signature);

    const previousCount = previousState.counts[signature] || 0;
    const nextCount = previousSet.has(signature) ? previousCount + 1 : 1;
    nextCounts[signature] = nextCount;

    finding.consecutiveCount = nextCount;
    finding.autoRemoveCandidate = finding.category === 'unused' && nextCount >= 2;

    //audit Assumption: auto-remove candidates should be flagged; risk: accidental removal; invariant: only consecutive unused flagged; handling: check category and count.
    if (finding.autoRemoveCandidate) {
      finding.action = 'remove';
    }
  }

  const nextState = {
    lastSignatures: signatures,
    counts: nextCounts,
    unusedCleanStreak: previousState.unusedCleanStreak
  };

  return { updatedState: nextState, findings };
}

/**
 * Audit a workspace and return results.
 * Purpose: Execute audit checks for a single root.
 * Inputs: root path.
 * Outputs: result object with findings and summary.
 * Edge cases: missing logs directory.
 */
async function auditWorkspace(root) {
  const logDir = path.join(root, LOG_DIR_NAME);
  const statePath = path.join(logDir, STATE_FILE_NAME);
  const latestPath = path.join(logDir, LATEST_FILE_NAME);

  //audit Assumption: logs directory may not exist; risk: write errors; invariant: logs directory created; handling: mkdirp.
  await fs.mkdir(logDir, { recursive: true });

  const previousState = await loadAuditState(statePath);
  const mergeCommits = getMergeCommits(root, 3);
  const mergeSets = mergeCommits.map(commit => getChangedFilesSince(root, commit));
  const recentChangeSet = unionChangedFiles(mergeSets);

  const findings = [];
  const manifestPaths = findManifestPaths(root);

  //audit Assumption: manifest.json should be validated; risk: missing modules; invariant: manifest references checked; handling: parse manifests and check paths.
  for (const manifestPath of manifestPaths) {
    const manifestResult = await readJsonFile(manifestPath);
    const relativeManifest = normalizeRelativePath(path.relative(root, manifestPath));

    if (!manifestResult.ok) {
      findings.push({
        category: 'manifest',
        file: relativeManifest,
        line: 1,
        message: `Failed to parse manifest.json: ${manifestResult.error}`,
        action: 'verify'
      });
      continue;
    }

    const modules = Array.isArray(manifestResult.data.modules) ? manifestResult.data.modules : [];

    //audit Assumption: module entries include path; risk: missing module metadata; invariant: module path existence checked; handling: verify each path.
    for (const moduleEntry of modules) {
      if (!moduleEntry || typeof moduleEntry.path !== 'string') {
        findings.push({
          category: 'manifest',
          file: relativeManifest,
          line: 1,
          message: 'Manifest entry missing module path.',
          action: 'verify'
        });
        continue;
      }

      const modulePath = path.resolve(path.dirname(manifestPath), moduleEntry.path);
      try {
        await fs.access(modulePath);
      } catch (error) {
        findings.push({
          category: 'manifest',
          file: normalizeRelativePath(path.relative(root, modulePath)),
          line: 1,
          message: `Manifest module path not found: ${moduleEntry.path}`,
          action: 'verify'
        });
      }
    }
  }

  //audit Assumption: missing manifest is notable; risk: no interface comparison; invariant: missing manifest logged; handling: add finding when none found.
  if (manifestPaths.length === 0) {
    findings.push({
      category: 'manifest',
      file: 'manifest.json',
      line: 1,
      message: 'No manifest.json found in workspace.',
      action: 'verify'
    });
  }

  const memoryStatePath = path.join(root, 'memory', 'state.json');
  const memoryStateExists = await fs
    .access(memoryStatePath)
    .then(() => true)
    .catch(() => false);

  //audit Assumption: memory state represents schema; risk: wrong file; invariant: required keys checked; handling: validate known keys.
  if (memoryStateExists) {
    const memoryResult = await readJsonFile(memoryStatePath);
    if (!memoryResult.ok) {
      findings.push({
        category: 'memory-schema',
        file: normalizeRelativePath(path.relative(root, memoryStatePath)),
        line: 1,
        message: `Failed to parse memory state: ${memoryResult.error}`,
        action: 'verify'
      });
    } else {
      const requiredKeys = ['config', 'registry', 'auth', 'saveData', 'session', 'cache'];
      for (const key of requiredKeys) {
        if (!(key in memoryResult.data)) {
          findings.push({
            category: 'memory-schema',
            file: normalizeRelativePath(path.relative(root, memoryStatePath)),
            line: 1,
            message: `Memory schema missing key: ${key}`,
            action: 'verify'
          });
        }
      }
    }
  } else {
    findings.push({
      category: 'memory-schema',
      file: normalizeRelativePath(path.relative(root, memoryStatePath)),
      line: 1,
      message: 'Memory schema/state file not found.',
      action: 'verify'
    });
  }

  const codeFiles = await collectFiles(root, CODE_EXTENSIONS);
  const testFiles = codeFiles.filter(
    file => TEST_FILE_REGEX.test(path.basename(file)) || file.includes(`${path.sep}tests${path.sep}`)
  );
  const scanResults = await scanFiles(root, codeFiles);

  for (const item of scanResults.fileReadErrors) {
    findings.push({
      category: 'scan-error',
      file: item.file,
      line: item.line,
      message: item.message,
      action: 'verify'
    });
  }

  for (const item of scanResults.largeFiles) {
    findings.push({
      category: 'large-module',
      file: item.file,
      line: item.line,
      message: item.message,
      action: 'refactor'
    });
  }

  //audit Assumption: commented code older than threshold should be reviewed; risk: false positives; invariant: only aged comments flagged; handling: use blame age.
  for (const item of scanResults.commentedLines) {
    const ageDays = getLineAgeDays(root, item.file, item.line);
    if (ageDays !== null && ageDays > COMMENT_AGE_DAYS) {
      findings.push({
        category: 'commented-out',
        file: item.file,
        line: item.line,
        message: `Commented-out code older than ${COMMENT_AGE_DAYS} days: ${item.message}`,
        action: 'remove'
      });
    }
  }

  for (const item of scanResults.legacyMatches) {
    findings.push({
      category: 'legacy-pattern',
      file: item.file,
      line: item.line,
      message: item.message,
      action: 'refactor'
    });
  }

  const duplicateExports = buildDuplicateExportFindings(scanResults.exportMap);
  findings.push(...duplicateExports);

  const duplicateFiles = buildDuplicateFileFindings(scanResults.fileHashes);
  findings.push(...duplicateFiles);

  const unusedFindings = [];
  let unusedBlocked = false;
  const rootTsconfig = path.join(root, 'tsconfig.json');
  const rootTsconfigExists = await fs
    .access(rootTsconfig)
    .then(() => true)
    .catch(() => false);

  //audit Assumption: tsconfig indicates TypeScript project; risk: missing tsconfig; invariant: run tsc only when present; handling: check file exists.
  if (rootTsconfigExists) {
    const rootUnused = runTscUnused(root, rootTsconfig);
    unusedFindings.push(...rootUnused.findings);
    if (rootUnused.blocked) {
      unusedBlocked = true;
      findings.push({
        category: 'unused-check',
        file: normalizeRelativePath(path.relative(root, rootTsconfig)),
        line: 1,
        message: 'Unused analysis blocked: tsc failed before reporting unused symbols.',
        action: 'verify'
      });
    }
  }

  // backend-typescript removed - only check src/ (source of truth)

  findings.push(...unusedFindings);

  const mockFindings = await scanTestMocks(root, testFiles);
  findings.push(...mockFindings);

  const traceLogPath = path.join(root, LOG_DIR_NAME, 'arcanos_trace.log');
  const traceExists = await fs
    .access(traceLogPath)
    .then(() => true)
    .catch(() => false);

  //audit Assumption: trace log drives runtime usage detection; risk: missing log; invariant: missing trace flagged; handling: log missing trace as blocked.
  if (!traceExists) {
    findings.push({
      category: 'trace',
      file: normalizeRelativePath(path.relative(root, traceLogPath)),
      line: 1,
      message: 'Trace log missing; runtime usage audit blocked.',
      action: 'verify'
    });
  } else {
    const traceContent = await fs.readFile(traceLogPath, 'utf8');
    const traceMatches = Array.from(
      traceContent.matchAll(/([A-Za-z0-9_./-]+\.(ts|js|tsx|jsx))/g)
    ).map(match => match[1]);
    const referenced = new Set(traceMatches.map(match => normalizeRelativePath(match)));

    //audit Assumption: files not referenced in trace may be unused; risk: trace incomplete; invariant: flag for review; handling: log as verify.
    for (const filePath of codeFiles) {
      const relativePath = normalizeRelativePath(path.relative(root, filePath));
      if (relativePath.startsWith('tests/') || relativePath.includes('/tests/')) {
        continue;
      }
      if (!referenced.has(relativePath)) {
        findings.push({
          category: 'trace',
          file: relativePath,
          line: 1,
          message: 'File not referenced in runtime trace log.',
          action: 'verify'
        });
      }
    }
  }

  const rootOpenAi = await getOpenAiMajor(path.join(root, 'package.json'));

  // backend-typescript removed - only check root package.json (source of truth)

  //audit Assumption: daemon-python contains application logic; risk: missing source; invariant: log missing source; handling: record if no .py files.
  const daemonPythonPath = path.join(root, 'daemon-python');
  const daemonExists = await fs
    .access(daemonPythonPath)
    .then(() => true)
    .catch(() => false);
  if (daemonExists) {
    const daemonFiles = await collectFiles(daemonPythonPath, new Set(['.py']));
    if (daemonFiles.length === 0) {
      findings.push({
        category: 'daemon',
        file: normalizeRelativePath(path.relative(root, daemonPythonPath)),
        line: 1,
        message: 'Daemon directory contains no Python source files (compiled artifacts only).',
        action: 'verify'
      });
    }
  }

  //audit Assumption: findings should include merge context; risk: missing file info; invariant: mergeTouched boolean set; handling: annotate when file is in recent change set.
  for (const finding of findings) {
    finding.mergeTouched = recentChangeSet.has(finding.file);
  }

  const { updatedState, findings: enrichedFindings } = applyConsecutiveCounts(previousState, findings);

  //audit Assumption: unused findings drive clean streak; risk: stale state; invariant: reset streak when unused present or check blocked; handling: update streak based on current unused count.
  const unusedCount = enrichedFindings.filter(item => item.category === 'unused').length;
  if (!unusedBlocked && unusedCount === 0) {
    updatedState.unusedCleanStreak = previousState.unusedCleanStreak + 1;
  } else {
    updatedState.unusedCleanStreak = 0;
  }

  await saveAuditState(statePath, updatedState);

  const summary = {
    totalFindings: enrichedFindings.length,
    unusedFindings: unusedCount,
    unusedCheckBlocked: unusedBlocked,
    autoRemoveCandidates: enrichedFindings.filter(item => item.autoRemoveCandidate).length
  };

  const lintResult = runCommand('npm run lint', root);
  const typeCheckResult = runCommand('npm run type-check', root);
  const lintStrictOk = lintResult.ok && typeCheckResult.ok;

  const manifestOk = manifestPaths.length > 0 && !enrichedFindings.some(item => item.category === 'manifest');
  const memoryOk = !enrichedFindings.some(item => item.category === 'memory-schema');
  const unusedCleanOk = updatedState.unusedCleanStreak >= 2;

  const clean = lintStrictOk && manifestOk && memoryOk && unusedCleanOk && enrichedFindings.length === 0;

  const status = clean ? 'CLEAN' : 'NEEDS_ATTENTION';

  const result = {
    workspace: root,
    timestamp: new Date().toISOString(),
    mergeCommits,
    summary,
    lintStrictOk,
    manifestOk,
    memoryOk,
    unusedCleanOk,
    unusedCheckBlocked: unusedBlocked,
    status,
    findings: enrichedFindings
  };

  await fs.writeFile(latestPath, JSON.stringify(result, null, 2));

  const timestampSlug = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `continuous-audit-${timestampSlug}.json`);
  await fs.writeFile(logPath, JSON.stringify(result, null, 2));

  return result;
}

/**
 * Main entry point.
 * Purpose: Run audits across workspaces for a set number of cycles.
 * Inputs: process argv.
 * Outputs: exit code 0 on clean, 1 on issues.
 * Edge cases: multiple workspaces.
 */
async function main() {
  const workspaces = parseWorkspaceArgs(process.argv);
  const cycles = parseCycleCount(process.argv);
  const flags = parseFlags(process.argv);
  let overallStatus = 'CLEAN';
  let depth = 0;

  // Recursive refactoring loop
  while ((flags.recursive || flags.autoFix) && depth < flags.maxDepth) {
    const cycleResults = [];

    for (const workspace of workspaces) {
      const result = await auditWorkspace(workspace);
      cycleResults.push(result);

      // Auto-fix if enabled
      if (flags.autoFix && result.status !== 'CLEAN' && result.findings.length > 0) {
        const checkpoint = await createGitCheckpoint(workspace);
        const fixesApplied = await applyAutoFixes(workspace, result.findings);

        if (fixesApplied.length > 0) {
          console.log(`🔧 Applied ${fixesApplied.length} auto-fixes (syntax-validated)`);
          
          const validation = await validateChanges(workspace);
          if (!validation.passed) {
            console.log('❌ Validation failed, rolling back...');
            if (checkpoint) {
              await rollbackToCheckpoint(workspace, checkpoint);
              console.log('✅ Rolled back to checkpoint');
            }
          } else {
            console.log('✅ Auto-fixes validated successfully');
          }
        }
      }
    }

    const anyNeedsAttention = cycleResults.some(result => result.status !== 'CLEAN');
    if (anyNeedsAttention) {
      overallStatus = 'NEEDS_ATTENTION';
      depth++;
      if (flags.recursive) {
        console.log(`🔄 Recursive iteration ${depth}/${flags.maxDepth}`);
      }
      continue;
    } else {
      overallStatus = 'CLEAN';
      break;
    }
  }

  // Fallback to cycle-based loop
  if (!flags.recursive && !flags.autoFix) {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const cycleResults = [];
      for (const workspace of workspaces) {
        const result = await auditWorkspace(workspace);
        cycleResults.push(result);
      }
      const anyNeedsAttention = cycleResults.some(result => result.status !== 'CLEAN');
      if (anyNeedsAttention) {
        overallStatus = 'NEEDS_ATTENTION';
      } else {
        break;
      }
    }
  }

  const exitCode = overallStatus === 'CLEAN' ? 0 : 1;
  console.log(`STATUS: ${overallStatus}`);
  process.exit(exitCode);
}

main();
