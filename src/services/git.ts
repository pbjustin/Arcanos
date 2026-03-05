/**
 * Git Service for ARCANOS
 * Handles git operations including PR checkout, merging, and force push operations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveErrorMessage } from "@core/lib/errors/index.js";

const execAsync = promisify(exec);

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

/**
 * Execute a git command safely with error handling
 */
async function executeGitCommand(command: string, workingDir?: string): Promise<GitOperationResult> {
  try {
    const options = workingDir ? { cwd: workingDir } : {};
    const { stdout, stderr } = await execAsync(command, options);
    
    return {
      success: true,
      output: stdout.trim(),
      error: stderr.trim() || undefined
    };
  } catch (error: unknown) {
    //audit Assumption: command failures should return error text
    return {
      success: false,
      output: '',
      error: resolveErrorMessage(error, 'Unknown git command error')
    };
  }
}


type RetryOptions = { attempts: number; baseDelayMs: number; maxDelayMs: number; jitterMs: number };
const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 750, maxDelayMs: 8000, jitterMs: 250 };

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

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

async function executeGitCommandWithRetry(command: string, workingDir?: string, opts?: Partial<RetryOptions>): Promise<GitOperationResult> {
  return retry(async () => {
    const res = await executeGitCommand(command, workingDir);
    if (!res.success) throw new Error(res.error || `Command failed: ${command}`);
    return res;
  }, opts);
}

/**
 * Check if GitHub CLI is available
 */
async function checkGitHubCLI(): Promise<boolean> {
  try {
    await execAsync('gh --version');
    return true;
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

  const command = `gh pr checkout ${prNumber}`;
  return executeGitCommand(command, workingDir);
}

/**
 * Switch to a specific branch
 */
export async function checkoutBranch(branchName: string, workingDir?: string): Promise<GitOperationResult> {
  const command = `git checkout ${branchName}`;
  return executeGitCommand(command, workingDir);
}

/**
 * Perform a hard reset to HEAD
 */
export async function hardReset(workingDir?: string): Promise<GitOperationResult> {
  const command = 'git reset --hard HEAD';
  return executeGitCommand(command, workingDir);
}

/**
 * Perform a hard reset to a specific commit hash
 */
export async function hardResetToCommit(commitHash: string, workingDir?: string): Promise<GitOperationResult> {
  const command = `git reset --hard ${commitHash}`;
  return executeGitCommand(command, workingDir);
}

/**
 * Merge with a specific strategy
 */
export async function mergeWithStrategy(
  target: string, 
  strategy: string = 'ours', 
  workingDir?: string
): Promise<GitOperationResult> {
  const command = `git merge --strategy=${strategy} ${target}`;
  return executeGitCommand(command, workingDir);
}

/**
 * Force push to remote
 */
export async function forcePush(remote: string = 'origin', branch?: string, workingDir?: string): Promise<GitOperationResult> {
  const currentBranch = branch || await getCurrentBranch(workingDir);
  const command = `git push --force ${remote} ${currentBranch}`;
  return executeGitCommand(command, workingDir);
}

/**
 * Get current branch name
 */
export async function getCurrentBranch(workingDir?: string): Promise<string> {
  const result = await executeGitCommand('git branch --show-current', workingDir);
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
    const commitResult = await executeGitCommand('git rev-parse HEAD', workingDir);
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
  return executeGitCommand('git status --porcelain', workingDir);
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

  try {
    // Create and checkout branch
    const br = await executeGitCommand(`git checkout -b ${branch}`, workingDir);
    if (!br.success) throw new Error(br.error || 'Failed to create branch');

    // Apply diff via temporary file
    const tmpName = `.arcanos_patch_${ts}.diff`;
    const fs = await import('fs/promises');
    const path = await import('path');
    const tmpPath = path.join(workingDir || process.cwd(), tmpName);
    await fs.writeFile(tmpPath, diff, 'utf-8');

    const apply = await executeGitCommand(`git apply ${tmpName}`, workingDir);
    // Cleanup temp file best-effort
    try { await fs.unlink(tmpPath); } catch {}
    if (!apply.success) throw new Error(apply.error || 'git apply failed');

    const add = await executeGitCommand('git add -A', workingDir);
    if (!add.success) throw new Error(add.error || 'git add failed');

    const commit = await executeGitCommand(`git commit -m "${commitMessage.replace(/"/g, '\"')}"`, workingDir);
    if (!commit.success) throw new Error(commit.error || 'git commit failed');

    const hashRes = await executeGitCommand('git rev-parse HEAD', workingDir);
    const commitHash = hashRes.success ? hashRes.output : undefined;

    const push = await executeGitCommandWithRetry(`git push -u origin ${branch}`, workingDir, { attempts: 4 });

    const labelArgs = labels.length ? ` --label "${labels.join(',').replace(/"/g, '\\"')}"` : '';

    const pr = await executeGitCommandWithRetry(
      `gh pr create --title "${title.replace(/"/g, '\"')}" --body "${body.replace(/"/g, '\"')}"${labelArgs} --base ${base} --head ${branch}`,
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
    try { await executeGitCommand(`git checkout ${base}`, workingDir); } catch {}
    return { success: false, message: 'Failed to create PR from patch', error: resolveErrorMessage(error) };
  }
}

