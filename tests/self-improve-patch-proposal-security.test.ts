import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execFileMock = jest.fn();
const callOpenAIMock = jest.fn();
const getEnvNumberMock = jest.fn((key: string, fallback: number) =>
  key === 'SELF_IMPROVE_PATCH_ATTEMPTS' ? 1 : fallback
);

execFileMock[promisify.custom] = (...args: unknown[]) =>
  new Promise((resolve, reject) => {
    execFileMock(...args, (error: Error | null, stdout = '', stderr = '') => {
      if (error) {
        const enrichedError = error as Error & { stdout?: string; stderr?: string };
        enrichedError.stdout = stdout;
        enrichedError.stderr = stderr;
        reject(enrichedError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

jest.unstable_mockModule('child_process', () => ({
  execFile: execFileMock
}));

jest.unstable_mockModule('@services/openai/chatFlow/index.js', () => ({
  callOpenAI: callOpenAIMock
}));

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getDefaultModel: () => 'test-model'
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: () => undefined,
  getEnvNumber: getEnvNumberMock
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({ selfImproveEnvironment: 'test' })
}));

jest.unstable_mockModule('@services/securityCompliance.js', () => ({
  applySecurityCompliance: (content: string) => ({ content })
}));

jest.unstable_mockModule('@shared/promptGuidance.js', () => ({
  renderPromptGuidanceSections: (sections: Record<string, unknown>) =>
    JSON.stringify(sections)
}));

const patchProposalModule = await import('../src/services/selfImprove/patchProposal.js');

function buildProposalOutput(diff: string, files: string[]): string {
  return JSON.stringify({
    kind: 'self_improve_patch',
    goal: 'Harden the self-improvement proposal boundary.',
    summary: 'Uses a validated patch proposal in the focused test.',
    risk: 'low',
    files,
    diff,
    commands: ['npm run type-check'],
    successMetrics: ['Focused validation passes']
  });
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

afterEach(() => {
  execFileMock.mockReset();
  callOpenAIMock.mockReset();
  getEnvNumberMock.mockClear();
  jest.restoreAllMocks();
});

describe('self-improve patch process boundary', () => {
  it('runs git apply through execFile and an OS temp file outside the repository', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: unknown) => {
        (callback as (error: Error | null, stdout?: string, stderr?: string) => void)(
          null,
          '',
          ''
        );
      }
    );

    const result =
      await patchProposalModule.patchProposalTestUtils.validateDiffWithGitApplyCheck(
        buildDiff('src/a & b.ts', '\r\n'),
        process.cwd()
      );

    expect(result).toEqual({ valid: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ];
    expect(file).toBe('git');
    expect(args.slice(0, 3)).toEqual(['apply', '--check', '--']);
    expect(args).toHaveLength(4);
    expect(path.isAbsolute(args[3]!)).toBe(true);
    expect(path.relative(process.cwd(), args[3]!).startsWith('..')).toBe(true);
    expect(options).toEqual(expect.objectContaining({
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }));
    expect(options.shell).toBeUndefined();
    await expect(fs.access(path.dirname(args[3]!))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('fails closed after exhausted model attempts without writing a fallback target', async () => {
    callOpenAIMock.mockResolvedValue({ output: 'not-json' });
    const writeFileSpy = jest.spyOn(fs, 'writeFile');
    const targetPath = path.join(
      process.cwd(),
      'src',
      'services',
      'selfImprove',
      'controller.ts'
    );
    const before = await fs.readFile(targetPath, 'utf8');

    await expect(patchProposalModule.generatePatchProposal({
      trigger: 'manual',
      component: 'src/services/selfImprove/controller.ts',
      prohibitedPaths: [],
      context: {}
    })).rejects.toThrow('Unable to generate a valid self-improve patch proposal after 1 attempts');

    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(before);
  });

  it('rejects a traversal proposal before invoking git', async () => {
    const traversalDiff = buildDiff('../outside.ts');
    callOpenAIMock.mockResolvedValue({
      output: buildProposalOutput(traversalDiff, ['../outside.ts'])
    });

    await expect(patchProposalModule.generatePatchProposal({
      trigger: 'manual',
      prohibitedPaths: [],
      context: {}
    })).rejects.toThrow('Last diagnostic: DIFF_PATH_INVALID');

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('preserves a valid proposal while deriving its trusted file list from the diff', async () => {
    const validDiff = buildDiff('src/services/selfImprove/controller.ts');
    callOpenAIMock.mockResolvedValue({
      output: buildProposalOutput(validDiff, ['unrelated-model-claim.ts'])
    });
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: unknown) => {
        (callback as (error: Error | null, stdout?: string, stderr?: string) => void)(
          null,
          '',
          ''
        );
      }
    );

    const result = await patchProposalModule.generatePatchProposal({
      trigger: 'manual',
      prohibitedPaths: [],
      context: {}
    });

    expect(result.diff).toBe(validDiff);
    expect(result.files).toEqual(['src/services/selfImprove/controller.ts']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose provider or process error text in retry-safe final diagnostics', async () => {
    const providerSecret = 'provider-secret-transport-detail';
    callOpenAIMock.mockRejectedValueOnce(new Error(providerSecret));

    const providerError = await patchProposalModule.generatePatchProposal({
      trigger: 'manual',
      prohibitedPaths: [],
      context: {}
    }).catch((error: unknown) => error as Error);
    expect(providerError.message).toContain('PROVIDER_REQUEST_FAILED');
    expect(providerError.message).not.toContain(providerSecret);

    const processSecret = 'git-stderr-sensitive-detail';
    const validDiff = buildDiff('src/services/selfImprove/controller.ts');
    callOpenAIMock.mockResolvedValueOnce({
      output: buildProposalOutput(validDiff, [
        'src/services/selfImprove/controller.ts'
      ])
    });
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _options: unknown, callback: unknown) => {
        const error = new Error('git failed');
        (callback as (error: Error, stdout?: string, stderr?: string) => void)(
          error,
          '',
          processSecret
        );
      }
    );

    const processError = await patchProposalModule.generatePatchProposal({
      trigger: 'manual',
      prohibitedPaths: [],
      context: {}
    }).catch((error: unknown) => error as Error);
    expect(processError.message).toContain('DIFF_GIT_APPLY_REJECTED');
    expect(processError.message).not.toContain(processSecret);
  });
});
