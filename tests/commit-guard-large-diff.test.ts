import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temporaryRepositories: string[] = [];

function createTemporaryRepository(files: Record<string, string>): string {
  const temporaryRepository = mkdtempSync(
    path.join(tmpdir(), 'arcanos-commit-guard-')
  );
  temporaryRepositories.push(temporaryRepository);

  execFileSync('git', ['init', '--quiet'], {
    cwd: temporaryRepository,
    stdio: 'ignore',
  });
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(path.join(temporaryRepository, fileName), content, 'utf8');
    execFileSync('git', ['add', '--', fileName], {
      cwd: temporaryRepository,
      stdio: 'ignore',
    });
  }

  return temporaryRepository;
}

function runCommitGuard(temporaryRepository: string) {
  return spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'check-commit-guard.js')],
    {
      cwd: temporaryRepository,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }
  );
}

afterEach(() => {
  for (const repositoryPath of temporaryRepositories.splice(0)) {
    rmSync(repositoryPath, { force: true, recursive: true });
  }
});

describe('commit guard large staged diff handling', () => {
  it('scans a clean staged diff larger than the child-process default buffer', () => {
    const temporaryRepository = createTemporaryRepository({
      'large-safe-diff.txt': 'bounded safe staged content\n'.repeat(60_000),
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guard:commit passed');
    expect(result.stderr).toBe('');
  });

  it('accepts runtime credential references in source code', () => {
    const temporaryRepository = createTemporaryRepository({
      'safe-reference.ts': [
        'const token = configuredValues.RUNTIME_TOKEN;',
        "const authorization = resolveHeader(request, 'authorization');",
      ].join('\n'),
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guard:commit passed');
    expect(result.stderr).toBe('');
  });

  it('accepts Swift named arguments that reference runtime credential fields', () => {
    const temporaryRepository = createTemporaryRepository({
      'safe-reference.swift': [
        'let wire = Configuration(token: configuration.token, runId: configuration.runId)',
        'let wire = Configuration(token: config.token, runId: config.runId)',
      ].join('\n'),
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('guard:commit passed');
    expect(result.stderr).toBe('');
  });

  it.each(['"', '#"'])('still blocks a Swift %s literal passed to a sensitive named argument', (opener) => {
    const literal = ['production', 'credential-material', '1234567890'].join('-');
    const closer = opener === '#"' ? '"#' : '"';
    const temporaryRepository = createTemporaryRepository({
      'unsafe-literal.swift': `let wire = Configuration(token: ${opener}${literal}${closer}, runId: identifier)`,
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sensitive assignment for "token" appears to contain a literal secret'
    );
    expect(result.stderr).not.toContain(literal);
  });

  it('still blocks literal token signatures in Swift code', () => {
    const literal = ['ghp', 'a'.repeat(24)].join('_');
    const temporaryRepository = createTemporaryRepository({
      'unsafe-signature.swift': `let value = "${literal}"`,
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('potential GitHub token literal');
    expect(result.stderr).not.toContain(literal);
  });

  it('keeps unquoted sensitive values blocked outside source code', () => {
    const temporaryRepository = createTemporaryRepository({
      'unsafe-reference.txt': 'token: configuration.token',
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sensitive assignment for "token" appears to contain a literal secret'
    );
  });

  it('still blocks a quoted literal assigned to a sensitive source field', () => {
    const sensitiveAssignment = [
      'const ',
      ['access', 'Token'].join(''),
      " = '",
      ['production', 'credential-material', '1234567890'].join('-'),
      "';\n",
    ].join('');
    const temporaryRepository = createTemporaryRepository({
      'unsafe-literal.ts': sensitiveAssignment,
    });

    const result = runCommitGuard(temporaryRepository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sensitive assignment for "accessToken" appears to contain a literal secret'
    );
    expect(result.stderr).not.toContain('production-credential-material-1234567890');
  });
});
