/**
 * Git Service for ARCANOS
 * Handles git operations including PR checkout, merging, and force push operations
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { sleep } from '@shared/sleep.js';

const execFileAsync = promisify(execFile);

export interface PROptions {
  patch?: unknown;
  branchName?: string;
  commitMessage?: string;
  forcePush?: boolean;
  verifyLock?: boolean;
  prNumber?: number;
  targetBranch?: string;
}

export interface PRResult {
  success: boolean;
  message: string;
  branch?: string;
  commitHash?: string;
  error?: string;
}

export interface GitOperationResult {
  success: boolean;
  output: string;
  error?: string;
}

const SAFE_REF_PATTERN = /^[A-Za-z0-9._\/-]+$/;
const SAFE_COMMIT_HASH_PATTERN = /^[a-fA-F0-9]{7,64}$/;

/**
 * Validate git ref names used in command arguments.
 *
 * Purpose: ensure branch/base/target refs are safe and deterministic.
 * Inputs/outputs: raw ref string -> boolean validity.
 * Edge cases: rejects dangerous tokens (`..`, `@{`, leading/trailing slash, leading dash).
 */
function isValidGitRefName(ref: string): boolean {
  if (!ref || !SAFE_REF_PATTERN.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.startsWith('-')) return false;
  return true;
}

/**
 * Clamp and sanitize free-text CLI args passed to external tools.
 *
 * Purpose: preserve user/LLM text while preventing null-byte injection and oversized args.
 * Inputs/outputs: raw text + max length -> safe argument string.
 * Edge cases: returns empty string for undefined/null values.
 */
function sanitizeCliTextArg(value: string | undefined | null, maxLen: number): string {
  const asString = String(value ?? '');
  return asString.replace(/\0/g, '').slice(0, maxLen);
}

/**
 * Execute a process with argument array (no shell interpolation).
 *
 * Purpose: prevent shell injection for git/gh invocations.
 * Inputs/outputs: command binary + args -> structured operation result.
 * Edge cases: captures stdout/stderr even on non-zero exit codes.
 */
async function executeProcessCommand(command: string, args: string[], workingDir?: string): Promise<GitOperationResult> {
  try {
    const options = {
      cwd: workingDir,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    };
    const { stdout, stderr } = await execFileAsync(command, args, options);
    const out = String(stdout ?? '').trim();
    const err = String(stderr ?? '').trim();
    return {
      success: true,
      output: out,
      error: err || undefined
    };
  } catch (error: unknown) {
    const processError = error as { stdout?: string; stderr?: string; message?: string };
    const out = String(processError.stdout ?? '').trim();
    const err = String(processError.stderr ?? '').trim();
    return {
      success: false,
      output: out,
      error: err || resolveErrorMessage(error, 'Unknown process command error')
    };
  }
}

type RetryOptions = { attempts: number; baseDelayMs: number; maxDelayMs: number; jitterMs: number };
const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 750, maxDelayMs: 8000, jitterMs: 250 };

async function retry<T>(fn: (attempt: number) => Promise<T>, opts: Partial<RetryOptions> = {}): Promise<T> {
  const o: RetryOptions = { ...DEFAULT_RETRY, ...opts };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === o.attempts) break;
      const exp = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * o.jitterMs);
      await sleep(exp + jitter);
    }
  }
  throw lastErr;
}

async function executeProcessCommandWithRetry(
  command: string,
  args: string[],
  workingDir?: string,
  opts?: Partial<RetryOptions>
): Promise<GitOperationResult> {
  return retry(async () => {
    const res = await executeProcessCommand(command, args, workingDir);
    if (!res.success) {
      const commandSummary = `Command failed: ${command} ${args.join(' ')}`.trim();
      const errorMessage = String(res.error ?? '').trim();
      const genericError =
        errorMessage.length === 0 ||
        errorMessage === 'Unknown process command error' ||
        errorMessage === 'Unknown error';
      throw new Error(genericError ? commandSummary : `${commandSummary} (${errorMessage})`);
    }
    return res;
  }, opts);
}

async function resolvePatchWorkspace(workingDir?: string): Promise<string> {
  const fs = await import('fs/promises');

  if (workingDir) {
    try {
      const stat = await fs.stat(workingDir);
      if (stat.isDirectory()) {
        return workingDir;
      }
    } catch {
      //audit Assumption: caller-provided working directories can be synthetic in tests or stale on disk; failure risk: patch-file creation fails before git apply runs; expected invariant: a writable directory exists for temporary patch materialization; handling strategy: fall back to process.cwd when the requested workingDir is unavailable.
    }
  }

  return process.cwd();
}

/**
 * Check if GitHub CLI is available
 */
async function checkGitHubCLI(): Promise<boolean> {
  try {
    const result = await executeProcessCommand('gh', ['--version']);
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Checkout a specific PR using GitHub CLI
 */
export async function checkoutPR(prNumber: number, workingDir?: string): Promise<GitOperationResult> {
  const hasGH = await checkGitHubCLI();
  
  if (!hasGH) {
    return {
      success: false,
      output: '',
      error: 'GitHub CLI (gh) is not available. Please install it to checkout PRs.'
    };
  }

  return executeProcessCommand('gh', ['pr', 'checkout', String(prNumber)], workingDir);
}

/**
 * Switch to a specific branch
 */
export async function checkoutBranch(branchName: string, workingDir?: string): Promise<GitOperationResult> {
  //audit Assumption: branch names must be valid refs before execution; risk: malformed refs and argument abuse; invariant: only safe refs reach git; handling: reject invalid branch names.
  if (!isValidGitRefName(branchName)) {
    return { success: false, output: '', error: `Invalid branch name: ${branchName}` };
  }
  return executeProcessCommand('git', ['checkout', branchName], workingDir);
}

/**
 * Perform a hard reset to HEAD
 */
export async function hardReset(workingDir?: string): Promise<GitOperationResult> {
  return executeProcessCommand('git', ['reset', '--hard', 'HEAD'], workingDir);
}

/**
 * Perform a hard reset to a specific commit hash
 */
export async function hardResetToCommit(commitHash: string, workingDir?: string): Promise<GitOperationResult> {
  //audit Assumption: commit hashes are strict hex refs; risk: unsafe arguments in reset command; invariant: only hex hashes allowed; handling: explicit regex validation.
  if (!SAFE_COMMIT_HASH_PATTERN.test(commitHash)) {
    return { success: false, output: '', error: `Invalid commit hash: ${commitHash}` };
  }
  return executeProcessCommand('git', ['reset', '--hard', commitHash], workingDir);
}

/**
 * Merge with a specific strategy
 */
export async function mergeWithStrategy(
  target: string, 
  strategy: string = 'ours', 
  workingDir?: string
): Promise<GitOperationResult> {
  //audit Assumption: strategy and target are limited to safe git tokens; risk: merge argument abuse; invariant: merge executes with validated refs only; handling: fail fast on invalid values.
  if (!isValidGitRefName(target)) {
    return { success: false, output: '', error: `Invalid merge target: ${target}` };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(strategy)) {
    return { success: false, output: '', error: `Invalid merge strategy: ${strategy}` };
  }
  return executeProcessCommand('git', ['merge', `--strategy=${strategy}`, target], workingDir);
}

/**
 * Force push to remote
 */
export async function forcePush(remote: string = 'origin', branch?: string, workingDir?: string): Promise<GitOperationResult> {
  const currentBranch = branch || await getCurrentBranch(workingDir);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    return { success: false, output: '', error: `Invalid remote name: ${remote}` };
  }
  if (!isValidGitRefName(currentBranch)) {
    return { success: false, output: '', error: `Invalid branch name: ${currentBranch}` };
  }
  return executeProcessCommand('git', ['push', '--force', remote, currentBranch], workingDir);
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(workingDir?: string): Promise<string> {
  const result = await executeProcessCommand('git', ['branch', '--show-current'], workingDir);
  return result.success ? result.output : 'main';
}

/**
 * Execute the specific workflow from the problem statement:
 * 1. gh pr checkout 541
 * 2. git checkout main
 * 3. git reset --hard HEAD
 * 4. git merge --strategy=ours origin/main
 * 5. git push --force
 */
export async function executePRWorkflow(
  prNumber: number = 541, 
  workingDir?: string
): Promise<PRResult> {
  const steps = [];
  let currentStep = '';

  try {
    // Step 1: Checkout PR
    currentStep = `Checking out PR ${prNumber}`;
    steps.push(currentStep);
    const checkoutResult = await checkoutPR(prNumber, workingDir);
    if (!checkoutResult.success) {
      throw new Error(`Failed to checkout PR: ${checkoutResult.error}`);
    }

    // Step 2: Switch to main branch
    currentStep = 'Switching to main branch';
    steps.push(currentStep);
    const mainResult = await checkoutBranch('main', workingDir);
    if (!mainResult.success) {
      throw new Error(`Failed to checkout main: ${mainResult.error}`);
    }

    // Step 3: Hard reset
    currentStep = 'Performing hard reset';
    steps.push(currentStep);
    const resetResult = await hardReset(workingDir);
    if (!resetResult.success) {
      throw new Error(`Failed to reset: ${resetResult.error}`);
    }

    // Step 4: Merge with ours strategy
    currentStep = 'Merging origin/main with ours strategy';
    steps.push(currentStep);
    const mergeResult = await mergeWithStrategy('origin/main', 'ours', workingDir);
    if (!mergeResult.success) {
      throw new Error(`Failed to merge: ${mergeResult.error}`);
    }

    // Step 5: Force push
    currentStep = 'Force pushing to remote';
    steps.push(currentStep);
    const pushResult = await forcePush('origin', 'main', workingDir);
    if (!pushResult.success) {
      throw new Error(`Failed to force push: ${pushResult.error}`);
    }

    // Get final commit hash
    const commitResult = await executeProcessCommand('git', ['rev-parse', 'HEAD'], workingDir);
    const commitHash = commitResult.success ? commitResult.output : undefined;

    return {
      success: true,
      message: `Successfully executed PR workflow for PR ${prNumber}. Steps completed: ${steps.join(' → ')}`,
      branch: 'main',
      commitHash
    };

  } catch (error: unknown) {
    return {
      success: false,
      message: `Failed at step: ${currentStep}`,
      error: resolveErrorMessage(error)
    };
  }
}

/**
 * Generate PR with enhanced options (for compatibility with existing documentation)
 */
export async function generatePR(options: PROptions): Promise<PRResult> {
  const {
    prNumber = 541,
    forcePush = false,
    verifyLock = true,
    branchName,
    commitMessage: _commitMessage,
    patch: _patch
  } = options;

  // If verifyLock is false, bypass any memory locking (stateless operation)
  if (!verifyLock) {
    console.log('🔓 Bypassing memory lock verification (stateless mode)');
  }

  // If forcePush is true, execute the workflow
  if (forcePush && prNumber) {
    return executePRWorkflow(prNumber);
  }

  // For other PR operations, provide a placeholder implementation
  return {
    success: true,
    message: `PR operation configured: ${JSON.stringify(options)}`,
    branch: branchName || 'main'
  };
}

/**
 * Get git repository status
 */
export async function getGitStatus(workingDir?: string): Promise<GitOperationResult> {
  return executeProcessCommand('git', ['status', '--porcelain'], workingDir);
}

/**
 * Check if repository is clean (no uncommitted changes)
 */
export async function isRepositoryClean(workingDir?: string): Promise<boolean> {
  const status = await getGitStatus(workingDir);
  return status.success && status.output.length === 0;
}


/**
 * Create a new branch, apply a unified diff, commit, push, and open a PR via GitHub CLI.
 *
 * Requires:
 * - git available
 * - gh CLI authenticated (gh auth status)
 *
 * Notes:
 * - This is an enterprise-safe actuator: it never auto-merges.
 */
export async function createPullRequestFromPatch(options: {
  branchPrefix?: string;
  title: string;
  body: string;
  base?: string;
  diff: string;
  workingDir?: string;
  commitMessage?: string;
  labels?: string[];
}): Promise<PRResult> {
  const {
    branchPrefix = 'arcanos/self-improve',
    title,
    body,
    base = 'main',
    diff,
    workingDir,
    commitMessage = title,
    labels = []
  } = options;

  //audit Assumption: base and branch prefix come from trusted policy config but may still be malformed; risk: invalid refs or unsafe CLI args; invariant: refs are validated before process execution; handling: reject invalid refs.
  if (!isValidGitRefName(base)) {
    return { success: false, message: 'Invalid PR base branch', error: `Invalid base ref: ${base}` };
  }
  if (!isValidGitRefName(branchPrefix)) {
    return { success: false, message: 'Invalid PR branch prefix', error: `Invalid branch prefix: ${branchPrefix}` };
  }

  const hasGH = await checkGitHubCLI();
  if (!hasGH) {
    return { success: false, message: 'GitHub CLI (gh) not available', error: 'Missing gh CLI' };
  }

  // Ensure repo is clean so we don't accidentally commit unrelated work
  const clean = await isRepositoryClean(workingDir);
  if (!clean) {
    return { success: false, message: 'Repository has uncommitted changes', error: 'Dirty working tree' };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `${branchPrefix}-${ts}`;
  if (!isValidGitRefName(branch)) {
    return { success: false, message: 'Failed to create PR from patch', error: `Invalid generated branch ref: ${branch}` };
  }

  try {
    // Create and checkout branch
    const br = await executeProcessCommand('git', ['checkout', '-b', branch], workingDir);
    if (!br.success) throw new Error(br.error || 'Failed to create branch');

    // Apply diff via temporary file
    const tmpName = `.arcanos_patch_${ts}.diff`;
    const fs = await import('fs/promises');
    const path = await import('path');
    const patchWorkspace = await resolvePatchWorkspace(workingDir);
    const tmpPath = path.join(patchWorkspace, tmpName);
    await fs.writeFile(tmpPath, diff, 'utf-8');

    const apply = await executeProcessCommand('git', ['apply', tmpPath], workingDir);
    // Cleanup temp file best-effort
    try { await fs.unlink(tmpPath); } catch {}
    if (!apply.success) throw new Error(apply.error || 'git apply failed');

    const add = await executeProcessCommand('git', ['add', '-A'], workingDir);
    if (!add.success) throw new Error(add.error || 'git add failed');

    const commit = await executeProcessCommand(
      'git',
      ['commit', '-m', sanitizeCliTextArg(commitMessage, 500)],
      workingDir
    );
    if (!commit.success) throw new Error(commit.error || 'git commit failed');

    const hashRes = await executeProcessCommand('git', ['rev-parse', 'HEAD'], workingDir);
    const commitHash = hashRes.success ? hashRes.output : undefined;

    await executeProcessCommandWithRetry('git', ['push', '-u', 'origin', branch], workingDir, { attempts: 4 });

    const safeLabels = labels
      .map(label => sanitizeCliTextArg(label, 120).trim())
      .filter(Boolean);

    const ghArgs = [
      'pr',
      'create',
      '--title',
      sanitizeCliTextArg(title, 240),
      '--body',
      sanitizeCliTextArg(body, 20_000),
      '--base',
      base,
      '--head',
      branch
    ];
    for (const label of safeLabels) {
      ghArgs.push('--label', label);
    }

    const pr = await executeProcessCommandWithRetry(
      'gh',
      ghArgs,
      workingDir,
      { attempts: 4 }
    );

    return {
      success: true,
      message: `PR created: ${pr.output}`,
      branch,
      commitHash
    };
  } catch (error: unknown) {
    // Try to return to base branch to avoid leaving the repo in a weird state.
    try { await executeProcessCommand('git', ['checkout', base], workingDir); } catch {}
    return { success: false, message: 'Failed to create PR from patch', error: resolveErrorMessage(error) };
  }
}
