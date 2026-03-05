import { describe, expect, it, jest } from '@jest/globals';
import { promisify } from 'util';

const execMock = jest.fn();
const applySecurityComplianceMock = jest.fn();

/**
 * Load repo-context module with mocked shell and compliance dependencies.
 *
 * Purpose: deterministically exercise sanitization and parse fallback branches.
 * Inputs/outputs: none -> imported repo-context module.
 * Edge cases: preserves promisified exec semantics for success/failure command flows.
 */
async function loadRepoContextModule() {
  jest.resetModules();
  execMock.mockReset();
  applySecurityComplianceMock.mockReset();

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

  jest.unstable_mockModule('child_process', () => ({
    exec: execMock
  }));

  jest.unstable_mockModule('@services/securityCompliance.js', () => ({
    applySecurityCompliance: applySecurityComplianceMock
  }));

  return await import('../src/services/selfImprove/repoContext.js');
}

describe('services/selfImprove/repoContext', () => {
  it('returns sanitized snippets when compliance output is parseable JSON', async () => {
    const repoContextModule = await loadRepoContextModule();
    execMock.mockImplementation((_command: string, _options: unknown, callback: unknown) => {
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
    execMock.mockImplementation((_command: string, _options: unknown, callback: unknown) => {
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
});
