import { describe, expect, it, jest } from '@jest/globals';
import { promisify } from 'util';

type GitServiceModule = typeof import('../src/services/git.js');
type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const execMock = jest.fn();
const execFileMock = jest.fn();

/**
 * Load git service with isolated child_process mocks.
 *
 * Purpose: drive branch-specific command behavior in deterministic tests.
 * Inputs/outputs: none -> imported git service module.
 * Edge cases: preserves stdout/stderr data across promise rejections.
 */
async function loadGitServiceModule(
  resolveErrorMessageMock?: (error: unknown, fallback?: string) => string
): Promise<GitServiceModule> {
  jest.resetModules();
  execMock.mockReset();
  execFileMock.mockReset();

  execMock[promisify.custom] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      execMock(...args, (error: Error | null, stdout?: string, stderr?: string) => {
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
      execFileMock(...args, (error: Error | null, stdout?: string, stderr?: string) => {
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

  if (resolveErrorMessageMock) {
    jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
      resolveErrorMessage: resolveErrorMessageMock
    }));
  }

  return await import('../src/services/git.js');
}

function callbackExecFile(callback: unknown, error: Error | null, stdout = '', stderr = ''): void {
  (callback as ExecFileCallback)(error, stdout, stderr);
}

describe('services/git additional coverage', () => {
  it('coerces undefined stdout and stderr to empty command output', async () => {
    const gitService = await loadGitServiceModule();
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: unknown) => {
      (callback as ExecFileCallback)(null);
    });

    const result = await gitService.checkoutBranch('main');

    expect(result.success).toBe(true);
    expect(result.output).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('handles process errors that omit stdout and stderr', async () => {
    const gitService = await loadGitServiceModule();
    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, callback: unknown) => {
      (callback as ExecFileCallback)(new Error('exec failed'));
    });

    const result = await gitService.checkoutBranch('main');

    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(typeof result.error).toBe('string');
    expect((result.error ?? '').length).toBeGreaterThan(0);
  });

  it('executes direct git command wrappers on success', async () => {
    const gitService = await loadGitServiceModule();
    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      if (command === 'gh' && args[0] === '--version') {
        callbackExecFile(callback, null, 'gh version 2.86.0', '');
        return;
      }
      callbackExecFile(callback, null, 'ok', '');
    });

    await expect(gitService.checkoutPR(541)).resolves.toMatchObject({ success: true });
    await expect(gitService.checkoutBranch('main')).resolves.toMatchObject({ success: true });
    await expect(gitService.hardReset()).resolves.toMatchObject({ success: true });
    await expect(gitService.hardResetToCommit('1234567')).resolves.toMatchObject({ success: true });
    await expect(gitService.mergeWithStrategy('origin/main', 'ours')).resolves.toMatchObject({ success: true });
  });

  it('rejects force push when dynamic current branch name is invalid', async () => {
    const gitService = await loadGitServiceModule();
    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      if (command === 'git' && args[0] === 'branch') {
        callbackExecFile(callback, null, '-invalid', '');
        return;
      }
      callbackExecFile(callback, null, 'ok', '');
    });

    const result = await gitService.forcePush('origin');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid branch name');
  });

  it('force pushes successfully with explicit valid branch', async () => {
    const gitService = await loadGitServiceModule();
    const commandCalls: Array<{ command: string; args: string[] }> = [];

    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      commandCalls.push({ command, args: [...args] });
      callbackExecFile(callback, null, 'ok', '');
    });

    const result = await gitService.forcePush('origin', 'main');
    expect(result.success).toBe(true);
    expect(commandCalls.some((entry) => entry.command === 'git' && entry.args[0] === 'push')).toBe(true);
  });

  it('covers executePRWorkflow happy path including commit hash resolution', async () => {
    const gitService = await loadGitServiceModule();

    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      if (command === 'gh' && args[0] === '--version') {
        callbackExecFile(callback, null, 'gh version 2.86.0', '');
        return;
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'checkout') {
        callbackExecFile(callback, null, 'checked out', '');
        return;
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        callbackExecFile(callback, null, 'deadbeef123', '');
        return;
      }
      callbackExecFile(callback, null, 'ok', '');
    });

    const result = await gitService.executePRWorkflow(541);
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('deadbeef123');
  });

  it('rejects invalid base and invalid branch prefix before PR creation', async () => {
    const gitService = await loadGitServiceModule();

    const invalidBaseResult = await gitService.createPullRequestFromPatch({
      title: 'x',
      body: 'y',
      base: 'bad..base',
      diff: 'diff --git a/a b/a'
    });
    expect(invalidBaseResult.success).toBe(false);
    expect(invalidBaseResult.error).toContain('Invalid base ref');

    const invalidPrefixResult = await gitService.createPullRequestFromPatch({
      title: 'x',
      body: 'y',
      branchPrefix: 'bad..prefix',
      diff: 'diff --git a/a b/a'
    });
    expect(invalidPrefixResult.success).toBe(false);
    expect(invalidPrefixResult.error).toContain('Invalid branch prefix');
  });

  it('rejects generated branch names when timestamp contains unsafe characters', async () => {
    const gitService = await loadGitServiceModule();
    const timestampSpy = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('unsafe value');
    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      if (command === 'gh' && args[0] === '--version') {
        callbackExecFile(callback, null, 'gh version 2.86.0', '');
        return;
      }
      if (command === 'git' && args[0] === 'status') {
        callbackExecFile(callback, null, '', '');
        return;
      }
      callbackExecFile(callback, null, 'ok', '');
    });

    try {
      const result = await gitService.createPullRequestFromPatch({
        title: 'x',
        body: 'y',
        branchPrefix: 'codex/coverage',
        diff: 'diff --git a/a b/a'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid generated branch ref');
    } finally {
      timestampSpy.mockRestore();
    }
  });

  it('retries push failures and falls back to base checkout on fatal apply error', async () => {
    const gitService = await loadGitServiceModule();
    const commandCalls: Array<{ command: string; args: string[] }> = [];

    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      commandCalls.push({ command, args: [...args] });

      if (command === 'gh' && args[0] === '--version') {
        callbackExecFile(callback, null, 'gh version 2.86.0', '');
        return;
      }
      if (command === 'git' && args[0] === 'status') {
        callbackExecFile(callback, null, '', '');
        return;
      }
      if (command === 'git' && args[0] === 'checkout' && args[1] === '-b') {
        callbackExecFile(callback, null, 'branch created', '');
        return;
      }
      if (command === 'git' && args[0] === 'apply') {
        callbackExecFile(callback, new Error('apply failed'), '', 'apply failed');
        return;
      }
      if (command === 'git' && args[0] === 'checkout' && args[1] === 'main') {
        callbackExecFile(callback, null, 'returned to main', '');
        return;
      }

      callbackExecFile(callback, null, 'ok', '');
    });

    const result = await gitService.createPullRequestFromPatch({
      title: 'x',
      body: 'y',
      base: 'main',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const oldValue = 1;\n+const oldValue = 2;\n'
    });

    expect(result.success).toBe(false);
    expect(
      commandCalls.some((entry) => entry.command === 'git' && entry.args[0] === 'checkout' && entry.args.includes('main'))
    ).toBe(true);
  });

  it('retries transient push failures and eventually succeeds', async () => {
    const gitService = await loadGitServiceModule();
    let pushAttempts = 0;

    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      if (command === 'gh' && args[0] === '--version') {
        callbackExecFile(callback, null, 'gh version 2.86.0', '');
        return;
      }
      if (command === 'git' && args[0] === 'status') {
        callbackExecFile(callback, null, '', '');
        return;
      }
      if (command === 'git' && args[0] === 'checkout' && args[1] === '-b') {
        callbackExecFile(callback, null, 'branch created', '');
        return;
      }
      if (command === 'git' && args[0] === 'apply') {
        callbackExecFile(callback, null, 'applied', '');
        return;
      }
      if (command === 'git' && args[0] === 'add') {
        callbackExecFile(callback, null, '', '');
        return;
      }
      if (command === 'git' && args[0] === 'commit') {
        callbackExecFile(callback, null, '[branch abc123] commit', '');
        return;
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        callbackExecFile(callback, null, 'abc1234', '');
        return;
      }
      if (command === 'git' && args[0] === 'push') {
        pushAttempts += 1;
        if (pushAttempts === 1) {
          callbackExecFile(callback, new Error('transient push failure'), '', 'transient push failure');
          return;
        }
        callbackExecFile(callback, null, 'pushed', '');
        return;
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        callbackExecFile(callback, null, 'https://github.com/pbjustin/Arcanos/pull/10000', '');
        return;
      }

      callbackExecFile(callback, null, 'ok', '');
    });

    const result = await gitService.createPullRequestFromPatch({
      title: 'retry push',
      body: 'retry push body',
      base: 'main',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const oldValue = 1;\n+const oldValue = 2;\n'
    });

    expect(result.success).toBe(true);
    expect(pushAttempts).toBe(2);
  });

  it('sanitizes nullish CLI text args and retries with fallback command error text', async () => {
    const gitService = await loadGitServiceModule(() => '');
    let pushAttempts = 0;
    const commandHistory: Array<{ command: string; args: string[] }> = [];

    execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: unknown) => {
      commandHistory.push({ command, args: [...args] });

      if (command === 'gh' && args[0] === '--version') {
        callbackExecFile(callback, null, 'gh version 2.86.0', '');
        return;
      }
      if (command === 'git' && args[0] === 'status') {
        callbackExecFile(callback, null, '', '');
        return;
      }
      if (command === 'git' && args[0] === 'checkout' && args[1] === '-b') {
        callbackExecFile(callback, null, 'branch created', '');
        return;
      }
      if (command === 'git' && args[0] === 'apply') {
        callbackExecFile(callback, null, 'applied', '');
        return;
      }
      if (command === 'git' && args[0] === 'add') {
        callbackExecFile(callback, null, '', '');
        return;
      }
      if (command === 'git' && args[0] === 'commit') {
        callbackExecFile(callback, null, '[branch abc123] commit', '');
        return;
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        callbackExecFile(callback, null, 'abc1234', '');
        return;
      }
      if (command === 'git' && args[0] === 'push') {
        pushAttempts += 1;
        if (pushAttempts === 1) {
          (callback as ExecFileCallback)(new Error('transient push failure'));
          return;
        }
        callbackExecFile(callback, null, 'pushed', '');
        return;
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        callbackExecFile(callback, null, 'https://github.com/pbjustin/Arcanos/pull/10001', '');
        return;
      }

      callbackExecFile(callback, null, 'ok', '');
    });

    const result = await gitService.createPullRequestFromPatch({
      base: 'main',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const oldValue = 1;\n+const oldValue = 2;\n',
      labels: ['coverage', undefined as unknown as string],
      title: undefined as unknown as string,
      body: undefined as unknown as string
    });

    expect(result.success).toBe(true);
    expect(pushAttempts).toBe(2);
    const commitCall = commandHistory.find((entry) => entry.command === 'git' && entry.args[0] === 'commit');
    expect(commitCall?.args[2]).toBe('');
  });
});
