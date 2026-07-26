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
