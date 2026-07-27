import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { patchProposalTestUtils } from '@services/selfImprove/patchProposal.js';
import { findMissingPromptGuidanceSections } from '../src/shared/promptGuidance.js';

const temporaryDirectories: string[] = [];

async function createTemporaryRepository(): Promise<string> {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'arcanos-patch-paths-'));
  temporaryDirectories.push(repository);
  await fs.mkdir(path.join(repository, 'src'), { recursive: true });
  await fs.writeFile(path.join(repository, 'src', 'a.ts'), 'const oldValue = 1;\n', 'utf8');
  return repository;
}

function buildDiff(repositoryPath: string, eol = '\n'): string {
  return [
    `diff --git a/${repositoryPath} b/${repositoryPath}`,
    `--- a/${repositoryPath}`,
    `+++ b/${repositoryPath}`,
    '@@ -1,1 +1,1 @@',
    '-const oldValue = 1;',
    '+const oldValue = 2;'
  ].join(eol);
}

function buildAdditionDiff(repositoryPath: string): string {
  return [
    `diff --git a/${repositoryPath} b/${repositoryPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${repositoryPath}`,
    '@@ -0,0 +1,1 @@',
    '+const addedValue = 1;'
  ].join('\n');
}

function buildDeletionDiff(repositoryPath: string): string {
  return [
    `diff --git a/${repositoryPath} b/${repositoryPath}`,
    'deleted file mode 100644',
    `--- a/${repositoryPath}`,
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-const oldValue = 1;'
  ].join('\n');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('patchProposalTestUtils.parseJsonObjectFromModelOutput', () => {
  it('parses strict JSON output', () => {
    const parsed = patchProposalTestUtils.parseJsonObjectFromModelOutput('{"ok":true}') as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('parses fenced JSON output', () => {
    const parsed = patchProposalTestUtils.parseJsonObjectFromModelOutput('```json\n{"kind":"self_improve_patch"}\n```') as { kind: string };
    expect(parsed.kind).toBe('self_improve_patch');
  });

  it('parses JSON object wrapped in prose', () => {
    const parsed = patchProposalTestUtils.parseJsonObjectFromModelOutput('Model output follows:\n{"risk":"low","files":[]}\nDone.') as { risk: string };
    expect(parsed.risk).toBe('low');
  });

  it('throws when no valid JSON object exists', () => {
    expect(() => patchProposalTestUtils.parseJsonObjectFromModelOutput('not-json')).toThrow('Patch proposal is not valid JSON.');
  });

  it('rejects raw model output over its byte limit before JSON extraction', () => {
    const oversized = 'x'.repeat(
      patchProposalTestUtils.limits.maxModelOutputBytes + 1
    );

    expect(() =>
      patchProposalTestUtils.parseJsonObjectFromModelOutput(oversized)
    ).toThrow('exceeds the byte limit');
  });
});

describe('patchProposalTestUtils.buildPatchProposalPrompt', () => {
  it('renders the OpenAI-guided prompt contract and evidence rules', () => {
    const prompt = patchProposalTestUtils.buildPatchProposalPrompt({
      trigger: 'test-trigger',
      component: 'ai-gateway',
      context: {
        file: 'src/example.ts'
      },
      prohibitedPaths: ['.env', 'secrets/']
    });

    expect(findMissingPromptGuidanceSections(prompt)).toEqual([]);
    expect(prompt).toContain('Output ONLY valid JSON');
    expect(prompt).toContain('Do not guess repo structure');
    expect(prompt).toContain('Never route protected backend diagnostics through /gpt/:gptId.');
    expect(prompt).toContain('Do not invent a no-op, breadcrumb');
    expect(prompt).toContain('test-trigger');
  });
});

describe('patchProposalTestUtils.validateUnifiedDiffShape', () => {
  it('rejects diffs with placeholder lines', () => {
    const result = patchProposalTestUtils.validateUnifiedDiffShape(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '...'
      ].join('\n')
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('placeholder');
  });

  it('rejects diffs missing hunk header', () => {
    const result = patchProposalTestUtils.validateUnifiedDiffShape(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '+const x = 1;'
      ].join('\n')
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('hunk');
  });

  it('accepts a minimal valid unified diff', () => {
    const result = patchProposalTestUtils.validateUnifiedDiffShape(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-const oldValue = 1;',
        '+const oldValue = 2;'
      ].join('\n')
    );
    expect(result.valid).toBe(true);
  });
});

describe('patchProposalTestUtils.validateDiffPaths', () => {
  it('accepts a normalized existing repository path with CRLF diff lines', async () => {
    const repository = await createTemporaryRepository();

    const result = await patchProposalTestUtils.validateDiffPaths(
      buildDiff('src/a.ts', '\r\n'),
      [],
      repository
    );

    expect(result).toEqual({ valid: true, files: ['src/a.ts'] });
  });

  it('rejects traversal into a sibling whose name shares the repository prefix', async () => {
    const repository = await createTemporaryRepository();
    const sibling = `${repository}-sibling`;
    temporaryDirectories.push(sibling);
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, 'a.ts'), 'const oldValue = 1;\n', 'utf8');
    const siblingPath = `../${path.basename(sibling)}/a.ts`;

    const result = await patchProposalTestUtils.validateDiffPaths(
      buildDiff(siblingPath),
      [],
      repository
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid or non-normalized');
  });

  it.each([
    ['.env.local', ['.env*']],
    ['src/services/openai/unsafe.ts', ['src/services/openai/**']]
  ])('rejects prohibited path %s', async (repositoryPath, prohibitedPaths) => {
    const repository = await createTemporaryRepository();

    const result = await patchProposalTestUtils.validateDiffPaths(
      buildDiff(repositoryPath),
      prohibitedPaths,
      repository
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('prohibited');
  });

  it('rejects a path containing a directory symlink', async () => {
    const repository = await createTemporaryRepository();
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'arcanos-patch-outside-'));
    temporaryDirectories.push(outsideDirectory);
    await fs.writeFile(
      path.join(outsideDirectory, 'outside.ts'),
      'const oldValue = 1;\n',
      'utf8'
    );
    await fs.symlink(
      outsideDirectory,
      path.join(repository, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = await patchProposalTestUtils.validateDiffPaths(
      buildDiff('linked/outside.ts'),
      [],
      repository
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('symbolic link');
  });

  it('rejects a symlink in the leaf position', async () => {
    const repository = await createTemporaryRepository();
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'arcanos-patch-leaf-'));
    temporaryDirectories.push(outsideDirectory);
    await fs.symlink(
      outsideDirectory,
      path.join(repository, 'src', 'linked.ts'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = await patchProposalTestUtils.validateDiffPaths(
      buildDiff('src/linked.ts'),
      [],
      repository
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('symbolic link');
  });

  it('supports additions and deletions while validating only repository-side paths', async () => {
    const repository = await createTemporaryRepository();
    const additionDiff = buildAdditionDiff('src/added.ts');
    const deletionDiff = buildDeletionDiff('src/a.ts');

    expect(patchProposalTestUtils.validateUnifiedDiffShape(additionDiff).valid)
      .toBe(true);
    expect(patchProposalTestUtils.validateUnifiedDiffShape(deletionDiff).valid)
      .toBe(true);
    await expect(patchProposalTestUtils.validateDiffPaths(
      additionDiff,
      [],
      repository
    )).resolves.toEqual({ valid: true, files: ['src/added.ts'] });
    await expect(patchProposalTestUtils.validateDiffPaths(
      deletionDiff,
      [],
      repository
    )).resolves.toEqual({ valid: true, files: ['src/a.ts'] });
  });

  it('validates matching rename metadata and rejects an extended-header escape', async () => {
    const repository = await createTemporaryRepository();
    const renameDiff = [
      'diff --git a/src/a.ts b/src/b.ts',
      'similarity index 80%',
      'rename from src/a.ts',
      'rename to src/b.ts',
      '--- a/src/a.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-const oldValue = 1;',
      '+const oldValue = 2;'
    ].join('\n');

    await expect(patchProposalTestUtils.validateDiffPaths(
      renameDiff,
      [],
      repository
    )).resolves.toEqual({
      valid: true,
      files: ['src/a.ts', 'src/b.ts']
    });

    const escapedRename = renameDiff.replace(
      'rename from src/a.ts',
      'rename from ../outside.ts'
    );
    const escapedResult = await patchProposalTestUtils.validateDiffPaths(
      escapedRename,
      [],
      repository
    );
    expect(escapedResult.valid).toBe(false);
    expect(escapedResult.diagnosticCode).toBe('DIFF_PATH_INVALID');
  });
});

describe('patchProposalTestUtils.validateDiffResourceLimits', () => {
  it('counts repeated sections even when every section names the same file', () => {
    const repeatedDiff = Array.from(
      { length: patchProposalTestUtils.limits.maxPatchSections + 1 },
      () => buildDiff('src/a.ts')
    ).join('\n');

    expect(
      patchProposalTestUtils.validateDiffResourceLimits(repeatedDiff)
    ).toMatchObject({
      valid: false,
      diagnosticCode: 'DIFF_SECTION_LIMIT_EXCEEDED'
    });
  });

  it('rejects excessive hunks and oversized UTF-8 diffs', () => {
    const excessiveHunks = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      ...Array.from(
        { length: patchProposalTestUtils.limits.maxPatchHunks + 1 },
        () => '@@ -1,1 +1,1 @@\n-old\n+new'
      )
    ].join('\n');
    expect(
      patchProposalTestUtils.validateDiffResourceLimits(excessiveHunks)
    ).toMatchObject({
      valid: false,
      diagnosticCode: 'DIFF_HUNK_LIMIT_EXCEEDED'
    });

    const oversizedDiff = '😀'.repeat(
      Math.ceil(patchProposalTestUtils.limits.maxPatchDiffBytes / 4) + 1
    );
    expect(
      patchProposalTestUtils.validateDiffResourceLimits(oversizedDiff)
    ).toMatchObject({
      valid: false,
      diagnosticCode: 'DIFF_TOO_LARGE'
    });
  });
});

describe('patchProposalTestUtils.validateDiffWithGitApplyCheck', () => {
  it('checks an applicable patch without creating a patch file in the repository', async () => {
    const repository = await createTemporaryRepository();

    const result =
      await patchProposalTestUtils.validateDiffWithGitApplyCheck(
        buildDiff('src/a.ts'),
        repository
      );

    expect(result).toEqual({ valid: true });
    await expect(fs.readdir(repository)).resolves.toEqual(['src']);
    await expect(fs.readFile(path.join(repository, 'src', 'a.ts'), 'utf8'))
      .resolves.toBe('const oldValue = 1;\n');
  });
});
