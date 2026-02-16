#!/usr/bin/env node

/**
 * Commit guardrail script.
 *
 * Purpose:
 * - Block staged build/runtime artifacts.
 * - Block obvious secret/token leaks in staged additions.
 *
 * Inputs/outputs:
 * - Reads staged git data using `git diff --cached`.
 * - Exits with code 0 when clean, code 1 when violations are found.
 *
 * Edge cases:
 * - Gracefully handles empty staged sets.
 * - Treats unreadable git output as a hard failure to avoid silent bypass.
 */

import { execSync } from 'node:child_process';

const BLOCKED_STAGE_PATH_PATTERNS = [
  /^\.env$/i,
  /(^|\/)\.env$/i,
  /(^|\/)\.venv\//i,
  /^dist\//,
  /^workers\/dist\//,
  /^daemon-python\/dist\//,
  /^daemon-python\/build\//,
  /^daemon-python\/build_pyi\//,
  /^daemon-python\/cli\.err$/i,
  /^daemon-python\/debug_log\.txt$/i,
  /^cli\.err$/i,
  /^debug_log\.txt$/i,
];

const PLACEHOLDER_HINT_PATTERN =
  /\b(example|sample|placeholder|replace|changeme|mock|test|dummy|your-|redacted|xxxxx|<[^>]+>)\b/i;

const SECRET_LITERAL_PATTERNS = [
  { label: 'OpenAI key', regex: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { label: 'Bearer token', regex: /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/i },
  { label: 'JWT token', regex: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/ },
  { label: 'GitHub token', regex: /\bgh[pousr]_[a-zA-Z0-9]{20,}\b/i },
  { label: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
];

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(openai[_-]?api[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|token|secret|password|authorization)\b\s*[:=]\s*["'`]?([^"'`\s]+)/i;

/**
 * Run a git command and return stdout.
 *
 * @param {string} command - Shell command to run.
 * @returns {string}
 */
function runGitCommand(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    //audit Assumption: guardrail must fail closed when git state cannot be read; Failure risk: silent bypass; Invariant: unreadable staged diff blocks commit; Handling strategy: throw hard failure.
    throw new Error(`guard:commit failed while running "${command}": ${message}`);
  }
}

/**
 * Get staged files in a commit-safe format.
 *
 * @returns {string[]}
 */
function getStagedFiles() {
  const raw = runGitCommand('git diff --cached --name-only --diff-filter=ACMR -z');
  if (!raw) {
    return [];
  }
  //audit Assumption: NUL separator is authoritative for filenames with spaces; Failure risk: split errors; Invariant: filenames preserved; Handling strategy: split by NUL and filter empties.
  return raw.split('\u0000').filter(Boolean);
}

/**
 * Resolve staged added lines with file and approximate line references.
 *
 * @returns {Array<{file: string, line: number, text: string}>}
 */
function getStagedAddedLines() {
  const diff = runGitCommand('git diff --cached --unified=0 --no-color');
  if (!diff.trim()) {
    return [];
  }

  const addedLines = [];
  let currentFile = '(unknown)';
  let currentNewLine = 0;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice('+++ b/'.length).trim();
      currentNewLine = 0;
      continue;
    }

    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/\+(\d+)(?:,\d+)?/);
      //audit Assumption: malformed hunks can appear in edge diffs; Failure risk: line tracking drift; Invariant: best-effort location metadata; Handling strategy: fallback to zero on parse failure.
      currentNewLine = match ? Number.parseInt(match[1], 10) - 1 : 0;
      continue;
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      currentNewLine += 1;
      addedLines.push({
        file: currentFile,
        line: currentNewLine,
        text: rawLine.slice(1),
      });
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue;
    }

    if (!rawLine.startsWith('\\')) {
      currentNewLine += 1;
    }
  }

  return addedLines;
}

/**
 * Determine if a value is clearly a placeholder/test token.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholder(value) {
  if (!value) {
    return true;
  }
  //audit Assumption: known placeholder markers are safe for docs/examples; Failure risk: false positives; Invariant: placeholders should not fail guard; Handling strategy: explicit allowlist pattern.
  return PLACEHOLDER_HINT_PATTERN.test(value);
}

/**
 * Determine if a value references runtime env instead of hardcoded secret text.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isRuntimeReference(value) {
  const normalized = value.trim();
  return (
    normalized.startsWith('$') ||
    normalized.startsWith('${') ||
    normalized.startsWith('process.env') ||
    normalized.startsWith('os.getenv') ||
    normalized.startsWith('env(')
  );
}

/**
 * Scan a staged added line for secret leak indicators.
 *
 * @param {{file: string, line: number, text: string}} lineEntry
 * @returns {string[]}
 */
function scanLineForSecretLeaks(lineEntry) {
  const findings = [];
  const candidateText = lineEntry.text.trim();

  //audit Assumption: empty additions cannot leak credentials; Failure risk: unnecessary noise; Invariant: skip empty lines; Handling strategy: early return.
  if (!candidateText) {
    return findings;
  }

  for (const pattern of SECRET_LITERAL_PATTERNS) {
    //audit Assumption: literal token signatures should always be blocked unless clearly placeholder; Failure risk: accidental secret commit; Invariant: high-signal literals fail guard; Handling strategy: add finding.
    if (pattern.regex.test(candidateText) && !isPlaceholder(candidateText)) {
      findings.push(
        `${lineEntry.file}:${lineEntry.line} potential ${pattern.label} literal in staged addition.`,
      );
    }
  }

  const assignmentMatch = candidateText.match(SENSITIVE_ASSIGNMENT_PATTERN);
  if (assignmentMatch) {
    const key = assignmentMatch[1] ?? 'sensitive_key';
    const rawValue = assignmentMatch[2] ?? '';
    const value = rawValue.replace(/^['"`]+|['"`]+$/g, '');

    const looksSensitive = value.length >= 12;
    const safeValue = isPlaceholder(value) || isRuntimeReference(value);

    //audit Assumption: long literal assignments to sensitive keys are likely secrets; Failure risk: secret exposure; Invariant: literal sensitive values must be blocked; Handling strategy: require placeholder/runtime-reference or fail.
    if (looksSensitive && !safeValue) {
      findings.push(
        `${lineEntry.file}:${lineEntry.line} sensitive assignment for "${key}" appears to contain a literal secret.`,
      );
    }
  }

  return findings;
}

/**
 * Main program entry.
 */
function main() {
  const stagedFiles = getStagedFiles();

  //audit Assumption: empty staged set should not fail pre-commit; Failure risk: blocking no-op commits; Invariant: no findings when nothing staged; Handling strategy: pass early.
  if (stagedFiles.length === 0) {
    console.log('guard:commit passed (no staged files)');
    return;
  }

  const blockedPaths = stagedFiles.filter((filePath) =>
    BLOCKED_STAGE_PATH_PATTERNS.some((pattern) => pattern.test(filePath)),
  );

  const findings = [];

  //audit Assumption: build/runtime artifacts should remain untracked; Failure risk: noisy diffs and accidental deploy artifacts; Invariant: blocked paths cannot be committed; Handling strategy: collect and fail.
  if (blockedPaths.length > 0) {
    for (const blockedPath of blockedPaths) {
      findings.push(`Blocked staged artifact path: ${blockedPath}`);
    }
  }

  for (const lineEntry of getStagedAddedLines()) {
    findings.push(...scanLineForSecretLeaks(lineEntry));
  }

  //audit Assumption: any finding should block commit; Failure risk: bypassing security gate; Invariant: zero findings required; Handling strategy: print all findings and exit non-zero.
  if (findings.length > 0) {
    console.error('\n[guard:commit] Commit blocked by guardrails:');
    for (const finding of findings) {
      console.error(` - ${finding}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('guard:commit passed');
}

main();
