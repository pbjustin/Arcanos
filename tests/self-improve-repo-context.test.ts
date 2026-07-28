import { describe, expect, it, jest } from '@jest/globals';
import { promisify } from 'util';

const execFileMock = jest.fn();
const applySecurityComplianceMock = jest.fn();

/**
 * Load repo-context module with mocked shell and compliance dependencies.
 *
 * Purpose: deterministically exercise sanitization and parse fallback branches.
 * Inputs/outputs: none -> imported repo-context module.
 * Edge cases: preserves promisified execFile semantics for success/failure command flows.
 */
async function loadRepoContextModule() {
  jest.resetModules();
  execFileMock.mockReset();
  applySecurityComplianceMock.mockReset();

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
    execFile: execFileMock
  }));

  jest.unstable_mockModule('@services/securityCompliance.js', () => ({
    applySecurityCompliance: applySecurityComplianceMock
  }));

  return await import('../src/services/selfImprove/repoContext.js');
}

describe('services/selfImprove/repoContext', () => {
  it('returns sanitized snippets when compliance output is parseable JSON', async () => {
    const repoContextModule = await loadRepoContextModule();
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: unknown) => {
      (callback as (err: Error | null, stdout?: string) => void)(
        null,
        'src/a.ts:12:const decision = "PATCH_PROPOSAL";\nsrc/a.ts:15:const drift = "medium";\n'
      );
    });
    applySecurityComplianceMock.mockImplementation((raw: string) => ({ content: raw }));

    const result = await repoContextModule.gatherRepoContext({
      keywords: ['PATCH_PROPOSAL', 'drift'],
      maxFiles: 2
    });

    expect(result.summary).toContain('git grep');
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]?.file).toBe('src/a.ts');
  });

  it('drops snippets when sanitized payload is not parseable JSON', async () => {
    const repoContextModule = await loadRepoContextModule();
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: unknown) => {
      (callback as (err: Error | null, stdout?: string) => void)(
        null,
        'src/a.ts:12:const decision = "PATCH_PROPOSAL";\n'
      );
    });
    applySecurityComplianceMock.mockReturnValue({ content: '{not-json' });

    const result = await repoContextModule.gatherRepoContext({
      keywords: ['PATCH_PROPOSAL']
    });

    expect(result.snippets).toEqual([]);
  });

  it('uses fixed-string grep and passes safe metacharacters and quotes as literal arguments', async () => {
    const repoContextModule = await loadRepoContextModule();
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: unknown) => {
      (callback as (err: Error | null, stdout?: string) => void)(null, '');
    });
    applySecurityComplianceMock.mockImplementation((raw: string) => ({ content: raw }));

    const keywords = [
      'alpha & whoami',
      'beta | calc "quoted"',
      "gamma 'single'",
      'line-one\r\nline-two',
      `oversized-${'x'.repeat(201)}`,
      'nul\0byte'
    ];
    await repoContextModule.gatherRepoContext({
      keywords,
      workingDir: 'C:\\safe-repository'
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ];
    expect(file).toBe('git');
    expect(args).toEqual([
      'grep',
      '-n',
      '--fixed-strings',
      '-e',
      keywords[0],
      '-e',
      keywords[1],
      '-e',
      keywords[2],
      '--',
      ':!dist',
      ':!node_modules',
      ':!workers/dist'
    ]);
    expect(options).toEqual(expect.objectContaining({
      cwd: 'C:\\safe-repository',
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }));
    expect(options.shell).toBeUndefined();
  });

  it('does not invoke git when every keyword is unsafe', async () => {
    const repoContextModule = await loadRepoContextModule();

    const result = await repoContextModule.gatherRepoContext({
      keywords: ['line\r\nbreak', 'nul\0byte', 'x'.repeat(201)]
    });

    expect(result).toEqual({
      summary: 'No repo context requested.',
      snippets: []
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
