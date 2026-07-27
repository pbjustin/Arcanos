import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface RootPackageManifest {
  scripts?: Record<string, string>;
}

describe('root package script safety', () => {
  it('targets the compiled locations of the diagnostic command entry points', () => {
    const repositoryRoot = process.cwd();
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
    ) as RootPackageManifest;
    const scripts = manifest.scripts ?? {};

    expect(scripts['self-test']).toBe(
      'node --import ./scripts/register-esm-loader.mjs dist/core/commands/runSelfTest.js'
    );
    expect(scripts['daily-summary']).toBe(
      'node --import ./scripts/register-esm-loader.mjs dist/core/commands/runDailySummary.js'
    );
    expect(
      existsSync(
        path.join(repositoryRoot, 'src', 'core', 'commands', 'runSelfTest.ts')
      )
    ).toBe(true);
    expect(
      existsSync(
        path.join(repositoryRoot, 'src', 'core', 'commands', 'runDailySummary.ts')
      )
    ).toBe(true);
  });

  it('does not advertise or retain the retired credential-disclosing probe', () => {
    const repositoryRoot = process.cwd();
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
    ) as RootPackageManifest;
    const scripts = manifest.scripts ?? {};

    expect(scripts).not.toHaveProperty('probe');
    expect(Object.values(scripts)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\bscripts[\\/]probe\.js\b/u)])
    );
    expect(existsSync(path.join(repositoryRoot, 'scripts', 'probe.js'))).toBe(false);
  });
});
