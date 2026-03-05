import { describe, expect, it, jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

type GitServiceModule = typeof import('../src/services/git.js');
type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const execMock = jest.fn();
const execFileMock = jest.fn();

/**
 * Load git service with a child_process mock that preserves stdout/stderr
 * semantics used by util.promisify(execFile).
 *
 * Purpose: keep command behavior deterministic while exercising command safety logic.
 * Inputs/outputs: none -> imported git service module bound to current mock implementations.
 * Edge cases: error paths preserve stdout/stderr on thrown errors for command diagnostics.
 */
async function loadGitServiceModule(): Promise<GitServiceModule> {
  jest.resetModules();
  execMock.mockReset();
  execFileMock.mockReset();

  execMock[promisify.custom] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      execMock(...args, (error: Error | null, stdout = '', stderr = '') => {
        if (error) {
          const enrichedError = error as Error & { stdout?: string; stderr?: string };
          enrichedError.stdout = enrichedError.stdout ?? stdout;
          enrichedError.stderr = enrichedError.stderr ?? stderr;
          reject(enrichedError);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  execFileMock[promisify.custom] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      execFileMock(...args, (error: Error | null, stdout = '', stderr = '') => {
        if (error) {
          const enrichedError = error as Error & { stdout?: string; stderr?: string };
          enrichedError.stdout = enrichedError.stdout ?? stdout;
          enrichedError.stderr = enrichedError.stderr ?? stderr;
          reject(enrichedError);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  jest.unstable_mockModule('child_process', () => ({
    exec: execMock,
    execFile: execFileMock
  }));

  return await import('../src/services/git.js');
}

function runExecFileCallback(callback: unknown, error: Error | null, stdout = '', stderr = ''): void {
  (callback as ExecFileCallback)(error, stdout, stderr);
}

describe('services/git coverage hardening', () => {
  it('rejects unsafe git refs and strategy inputs before command execution', async () => {
    const gitService = await loadGitServiceModule();

    const invalidBranchResult = await gitService.checkoutBranch('../dangerous');
    expect(invalidBranchResult.success).toBe(false);
    expect(invalidBranchResult.error).toContain('Invalid branch name');

    const invalidCommitResult = await gitService.hardResetToCommit('not-a-hash');
    expect(invalidCommitResult.success).toBe(false);
    expect(invalidCommitResult.error).toContain('Invalid commit hash');

    const invalidMergeTargetResult = await gitService.mergeWithStrategy('bad..ref', 'ours');
    expect(invalidMergeTargetResult.success).toBe(false);
    expect(invalidMergeTargetResult.error).toContain('Invalid merge target');

    const invalidMergeStrategyResult = await gitService.mergeWithStrategy('origin/main', 'ours;rm');
    expect(invalidMergeStrategyResult.success).toBe(false);
    expect(invalidMergeStrategyResult.error).toContain('Invalid merge strategy');

    const invalidRemoteResult = await gitService.forcePush('origin;rm', 'main');
    expect(invalidRemoteResult.success).toBe(false);
    expect(invalidRemoteResult.error).toContain('Invalid remote name');

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('falls back to main when current branch lookup fails', async () => {
    const gitService = await loadGitServiceModule();

    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        const error = new Error('branch lookup failed') as Error & { stderr?: string };
        error.stderr = 'lookup failed';
        runExecFileCallback(callback, error, '', 'lookup failed');
      }
    );

    const branch = await gitService.getCurrentBranch('C:/repo');
    expect(branch).toBe('main');
  });

  it('returns a clear error when gh CLI is not available for checkoutPR', async () => {
    const gitService = await loadGitServiceModule();

    execFileMock.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: unknown) => {
        if (command === 'gh' && args[0] === '--version') {
          runExecFileCallback(callback, new Error('gh missing'), '', 'gh missing');
          return;
        }
        runExecFileCallback(callback, new Error(`unexpected command: ${command}`));
      }
    );

    const result = await gitService.checkoutPR(123);
    expect(result.success).toBe(false);
    expect(result.error).toContain('GitHub CLI (gh) is not available');
  });

  it('fails createPullRequestFromPatch when repository is dirty', async () => {
    const gitService = await loadGitServiceModule();

    execFileMock.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: unknown) => {
        if (command === 'gh' && args[0] === '--version') {
          runExecFileCallback(callback, null, 'gh version 2.86.0', '');
          return;
        }
        if (command === 'git' && args[0] === 'status') {
          runExecFileCallback(callback, new Error('dirty working tree'), '', 'dirty');
          return;
        }
        runExecFileCallback(callback, new Error(`unexpected command: ${command} ${args.join(' ')}`));
      }
    );

    const result = await gitService.createPullRequestFromPatch({
      title: 'Coverage gate',
      body: 'Body',
      base: 'main',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const oldValue = 1;\n+const oldValue = 2;\n',
      workingDir: process.cwd()
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Repository has uncommitted changes');
  });

  it('creates a PR from patch with sanitized command arguments', async () => {
    const gitService = await loadGitServiceModule();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcanos-git-pr-'));
    const commandHistory: Array<{ command: string; args: string[] }> = [];

    execFileMock.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: unknown) => {
        commandHistory.push({ command, args: [...args] });

        if (command === 'gh' && args[0] === '--version') {
          runExecFileCallback(callback, null, 'gh version 2.86.0', '');
          return;
        }
        if (command === 'git' && args[0] === 'status') {
          runExecFileCallback(callback, null, '', '');
          return;
        }
        if (command === 'git' && args[0] === 'checkout' && args[1] === '-b') {
          runExecFileCallback(callback, null, 'switched', '');
          return;
        }
        if (command === 'git' && args[0] === 'apply') {
          runExecFileCallback(callback, null, 'applied', '');
          return;
        }
        if (command === 'git' && args[0] === 'add') {
          runExecFileCallback(callback, null, '', '');
          return;
        }
        if (command === 'git' && args[0] === 'commit') {
          runExecFileCallback(callback, null, '[branch 1234567] message', '');
          return;
        }
        if (command === 'git' && args[0] === 'rev-parse') {
          runExecFileCallback(callback, null, '1234567890abcdef', '');
          return;
        }
        if (command === 'git' && args[0] === 'push') {
          runExecFileCallback(callback, null, 'pushed', '');
          return;
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
          runExecFileCallback(callback, null, 'https://github.com/pbjustin/Arcanos/pull/9999', '');
          return;
        }

        runExecFileCallback(callback, new Error(`unexpected command: ${command} ${args.join(' ')}`));
      }
    );

    try {
      const result = await gitService.createPullRequestFromPatch({
        branchPrefix: 'codex/coverage',
        title: 'Coverage\0 Title',
        body: 'Body\0 Text',
        base: 'main',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const oldValue = 1;\n+const oldValue = 2;\n',
        workingDir: tempDir,
        commitMessage: 'Commit\0 Message',
        labels: ['coverage', 'security\0check']
      });

      expect(result.success).toBe(true);
      expect(result.branch).toMatch(/^codex\/coverage-/);
      expect(result.commitHash).toBe('1234567890abcdef');

      const commitCall = commandHistory.find(
        (entry) => entry.command === 'git' && entry.args[0] === 'commit'
      );
      expect(commitCall).toBeDefined();
      expect(commitCall?.args[2]).toBe('Commit Message');

      const prCall = commandHistory.find(
        (entry) => entry.command === 'gh' && entry.args[0] === 'pr' && entry.args[1] === 'create'
      );
      expect(prCall).toBeDefined();
      expect(prCall?.args).toContain('Coverage Title');
      expect(prCall?.args).toContain('Body Text');
      expect(prCall?.args).toContain('coverage');
      expect(prCall?.args).toContain('securitycheck');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
