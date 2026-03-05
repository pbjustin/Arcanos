import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type ProcessScenario = { stdout?: string; stderr?: string; error?: Error };
type ProcessCall = { file: string; args: string[] };

const processScenarios: ProcessScenario[] = [];
const processCalls: ProcessCall[] = [];

const execPromisifiedMock = jest.fn(async () => ({
  stdout: '',
  stderr: ''
}));

const execFilePromisifiedMock = jest.fn(
  async (file: string, args?: string[]) => {
    processCalls.push({ file, args: args ?? [] });

    const nextScenario = processScenarios.shift();
    if (!nextScenario) {
      throw new Error(`No process scenario configured for: ${file} ${(args ?? []).join(' ')}`.trim());
    }

    if (nextScenario.error) {
      throw nextScenario.error;
    }

    return {
      stdout: nextScenario.stdout,
      stderr: nextScenario.stderr
    };
  }
);

const execMock = jest.fn();
const execFileMock = jest.fn();
(execMock as any)[Symbol.for('nodejs.util.promisify.custom')] = execPromisifiedMock;
(execFileMock as any)[Symbol.for('nodejs.util.promisify.custom')] = execFilePromisifiedMock;

jest.unstable_mockModule('child_process', () => ({
  exec: execMock,
  execFile: execFileMock
}));

const gitService = await import('../src/services/git.js');
const {
  checkoutBranch,
  checkoutPR,
  createPullRequestFromPatch,
  executePRWorkflow,
  forcePush,
  generatePR,
  getCurrentBranch,
  hardResetToCommit,
  mergeWithStrategy
} = gitService;

function queueProcessScenario(scenario: ProcessScenario): void {
  processScenarios.push(scenario);
}

function normalizeCall(call: ProcessCall): string {
  return `${call.file} ${call.args.join(' ')}`.trim();
}

describe('git service', () => {
  beforeEach(() => {
    processScenarios.length = 0;
    processCalls.length = 0;
    execPromisifiedMock.mockClear();
    execFilePromisifiedMock.mockClear();
    jest.restoreAllMocks();
  });

  it('returns a helpful error when GitHub CLI is unavailable for PR checkout', async () => {
    queueProcessScenario({ error: new Error('gh missing') }); // gh --version

    const result = await checkoutPR(541);

    expect(result.success).toBe(false);
    expect(result.error).toContain('GitHub CLI (gh) is not available');
    expect(processCalls.map(normalizeCall)).toEqual(['gh --version']);
  });

  it('falls back to main when current branch resolution fails', async () => {
    queueProcessScenario({ error: new Error('branch read failed') });

    const branch = await getCurrentBranch();

    expect(branch).toBe('main');
    expect(processCalls.map(normalizeCall)).toEqual(['git branch --show-current']);
  });

  it('rejects unsafe branch names before checkout', async () => {
    const empty = await checkoutBranch('');
    const invalidChars = await checkoutBranch('feature$bad');
    const leadingSlash = await checkoutBranch('/feature');

    expect(empty.success).toBe(false);
    expect(invalidChars.success).toBe(false);
    expect(leadingSlash.success).toBe(false);
    expect(processCalls).toHaveLength(0);
  });

  it('handles successful process execution with undefined stdout/stderr values', async () => {
    queueProcessScenario({});

    const branch = await getCurrentBranch();

    expect(branch).toBe('');
    expect(processCalls.map(normalizeCall)).toEqual(['git branch --show-current']);
  });

  it('rejects invalid commit hashes before reset-to-commit execution', async () => {
    const result = await hardResetToCommit('not-a-valid-hash');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid commit hash');
    expect(processCalls).toHaveLength(0);
  });

  it('executes reset-to-commit when commit hash is valid', async () => {
    queueProcessScenario({ stdout: 'HEAD is now at abcdef1\n' });

    const result = await hardResetToCommit('abcdef1');

    expect(result.success).toBe(true);
    expect(processCalls.map(normalizeCall)).toEqual(['git reset --hard abcdef1']);
  });

  it('rejects invalid merge targets and merge strategies', async () => {
    const invalidTarget = await mergeWithStrategy('origin..main', 'ours');
    const invalidStrategy = await mergeWithStrategy('origin/main', 'ours;');

    expect(invalidTarget.success).toBe(false);
    expect(invalidTarget.error).toContain('Invalid merge target');
    expect(invalidStrategy.success).toBe(false);
    expect(invalidStrategy.error).toContain('Invalid merge strategy');
    expect(processCalls).toHaveLength(0);
  });

  it('rejects invalid force push remotes and branch names', async () => {
    const invalidRemote = await forcePush('origin;rm', 'main');
    const invalidBranch = await forcePush('origin', '/unsafe');

    expect(invalidRemote.success).toBe(false);
    expect(invalidRemote.error).toContain('Invalid remote name');
    expect(invalidBranch.success).toBe(false);
    expect(invalidBranch.error).toContain('Invalid branch name');
    expect(processCalls).toHaveLength(0);
  });

  it('uses the detected branch when force push branch argument is omitted', async () => {
    queueProcessScenario({ stdout: 'feature-123\n' }); // git branch --show-current
    queueProcessScenario({ stdout: 'pushed\n' }); // git push --force origin feature-123

    const result = await forcePush('origin', undefined, 'C:/repo');

    expect(result.success).toBe(true);
    expect(processCalls.map(normalizeCall)).toEqual([
      'git branch --show-current',
      'git push --force origin feature-123'
    ]);
  });

  it('completes the PR workflow and returns commit hash when all git steps pass', async () => {
    queueProcessScenario({ stdout: 'gh 2.0.0\n' }); // gh --version
    queueProcessScenario({ stdout: 'checked out\n' }); // gh pr checkout 541
    queueProcessScenario({ stdout: 'switched\n' }); // git checkout main
    queueProcessScenario({ stdout: 'reset\n' }); // git reset --hard HEAD
    queueProcessScenario({ stdout: 'merged\n' }); // git merge --strategy=ours origin/main
    queueProcessScenario({ stdout: 'pushed\n' }); // git push --force origin main
    queueProcessScenario({ stdout: 'abc123def\n' }); // git rev-parse HEAD

    const result = await executePRWorkflow(541, 'C:/repo');

    expect(result.success).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.commitHash).toBe('abc123def');
    expect(processCalls.map(normalizeCall)).toEqual([
      'gh --version',
      'gh pr checkout 541',
      'git checkout main',
      'git reset --hard HEAD',
      'git merge --strategy=ours origin/main',
      'git push --force origin main',
      'git rev-parse HEAD'
    ]);
  });

  it('reports the failing workflow step when a git command fails mid-flow', async () => {
    queueProcessScenario({ stdout: 'gh 2.0.0\n' }); // gh --version
    queueProcessScenario({ stdout: 'checked out\n' }); // gh pr checkout 541
    queueProcessScenario({ error: new Error('checkout failed') }); // git checkout main

    const result = await executePRWorkflow(541);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Switching to main branch');
    expect(result.error).toContain('Failed to checkout main');
  });

  it('executes force push workflow through generatePR when requested', async () => {
    queueProcessScenario({ stdout: 'gh 2.0.0\n' });
    queueProcessScenario({ stdout: 'checked out\n' });
    queueProcessScenario({ stdout: 'switched\n' });
    queueProcessScenario({ stdout: 'reset\n' });
    queueProcessScenario({ stdout: 'merged\n' });
    queueProcessScenario({ stdout: 'pushed\n' });
    queueProcessScenario({ stdout: 'deadbeef\n' });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await generatePR({ prNumber: 541, forcePush: true, verifyLock: false });

    expect(result.success).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('🔓 Bypassing memory lock verification (stateless mode)');
  });

  it('rejects pull request creation when base branch is invalid', async () => {
    const result = await createPullRequestFromPatch({
      title: 'Test PR',
      body: 'Body',
      base: '../invalid',
      diff: 'diff --git a/a b/a'
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Invalid PR base branch');
  });

  it('rejects pull request creation when branch prefix is invalid', async () => {
    const result = await createPullRequestFromPatch({
      title: 'Test PR',
      body: 'Body',
      branchPrefix: 'unsafe..prefix',
      diff: 'diff --git a/a b/a'
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Invalid PR branch prefix');
  });

  it('rejects pull request creation when generated branch ref is invalid', async () => {
    queueProcessScenario({ stdout: 'gh 2.0.0\n' }); // gh --version
    queueProcessScenario({ stdout: '' }); // git status --porcelain
    const isoSpy = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026@{bad}');

    const result = await createPullRequestFromPatch({
      title: 'Test PR',
      body: 'Body',
      branchPrefix: 'safeprefix',
      diff: 'diff --git a/a b/a'
    });

    isoSpy.mockRestore();
    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to create PR from patch');
    expect(result.error).toContain('Invalid generated branch ref');
  });

  it('refuses pull request creation when working tree is dirty', async () => {
    queueProcessScenario({ stdout: 'gh 2.0.0\n' }); // gh --version
    queueProcessScenario({ stdout: ' M src/file.ts\n' }); // git status --porcelain

    const result = await createPullRequestFromPatch({
      title: 'Test PR',
      body: 'Body',
      diff: 'diff --git a/a b/a'
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Dirty working tree');
  });

  it('returns failure after retried push errors and attempts rollback checkout', async () => {
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler, _ms?: number, ...args: any[]) => {
      if (typeof callback === 'function') {
        callback(...args);
      }
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    queueProcessScenario({ stdout: 'gh 2.0.0\n' }); // gh --version
    queueProcessScenario({ stdout: '' }); // git status --porcelain
    queueProcessScenario({ stdout: 'Switched to a new branch\n' }); // git checkout -b
    queueProcessScenario({ stdout: '' }); // git apply
    queueProcessScenario({ stdout: '' }); // git add -A
    queueProcessScenario({ stdout: '[branch] commit\n' }); // git commit
    queueProcessScenario({ stdout: 'abc123456789\n' }); // git rev-parse HEAD
    queueProcessScenario({ error: new Error('') }); // git push 1
    queueProcessScenario({ error: new Error('') }); // git push 2
    queueProcessScenario({ error: new Error('') }); // git push 3
    queueProcessScenario({ error: new Error('') }); // git push 4
    queueProcessScenario({ stdout: 'Switched to branch main\n' }); // rollback checkout

    const result = await createPullRequestFromPatch({
      title: 'Self Improve Test',
      body: 'Automated test PR body',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      workingDir: 'C:/pbjustin/Arcanos'
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to create PR from patch');
    expect(result.error).toContain('Command failed: git push -u origin');
    const pushCalls = processCalls.map(normalizeCall).filter((call) => call.startsWith('git push -u origin '));
    expect(pushCalls).toHaveLength(4);
    expect(processCalls.map(normalizeCall)).toContain('git checkout main');
    timeoutSpy.mockRestore();
  });

  it('creates a pull request from patch when git and gh commands succeed', async () => {
    queueProcessScenario({ stdout: 'gh 2.0.0\n' }); // gh --version
    queueProcessScenario({ stdout: '' }); // git status --porcelain
    queueProcessScenario({ stdout: 'Switched to a new branch\n' }); // git checkout -b
    queueProcessScenario({ stdout: '' }); // git apply
    queueProcessScenario({ stdout: '' }); // git add -A
    queueProcessScenario({ stdout: '[branch] commit\n' }); // git commit
    queueProcessScenario({ stdout: 'abc123456789\n' }); // git rev-parse HEAD
    queueProcessScenario({ stdout: 'pushed\n' }); // git push -u origin <branch>
    queueProcessScenario({ stdout: 'https://github.com/pbjustin/Arcanos/pull/999\n' }); // gh pr create

    const result = await createPullRequestFromPatch({
      title: 'Self Improve Test',
      body: 'Automated test PR body',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      workingDir: 'C:/pbjustin/Arcanos',
      labels: ['release', undefined as unknown as string, '']
    });

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe('abc123456789');
    expect(result.message).toContain('PR created:');

    const normalizedCalls = processCalls.map(normalizeCall);
    expect(normalizedCalls[0]).toBe('gh --version');
    expect(normalizedCalls[1]).toBe('git status --porcelain');
    expect(normalizedCalls).toContain('git add -A');
    expect(normalizedCalls.some((call) => call.startsWith('gh pr create --title'))).toBe(true);
  });
});
