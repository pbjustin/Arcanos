import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const TRANSITION_SHIMS = [
  'scripts/notion-authority-root-probe.mjs',
  'scripts/notion-root-status-diagnostic.mjs',
  'scripts/notion-wiki-root-compat.mjs',
] as const;

describe('legacy Notion startup preload shims', () => {
  it('keeps the tracked Railway start path on the integrity wrapper without preloads', () => {
    const railway = JSON.parse(
      readFileSync(path.resolve('railway.json'), 'utf8')
    ) as {
      deploy?: {
        startCommand?: unknown;
        healthcheckPath?: unknown;
        healthcheckTimeout?: unknown;
      };
    };

    expect(railway.deploy).toEqual(expect.objectContaining({
      startCommand: 'node scripts/start-railway-service-with-integrity.mjs',
      healthcheckPath: '/readyz',
      healthcheckTimeout: 300,
    }));
    expect(String(railway.deploy?.startCommand)).not.toMatch(
      /notion-(?:authority-root-probe|root-status-diagnostic|wiki-root-compat)\.mjs/u
    );
  });

  it.each(TRANSITION_SHIMS)(
    'imports %s without network, global fetch, environment, or logging effects',
    script => {
      const moduleUrl = pathToFileURL(path.resolve(script)).href;
      const probe = String.raw`
        const calls = [];
        const logs = [];
        const sentinelFetch = async (...args) => {
          calls.push(args);
          throw new Error('NETWORK_CALL_FORBIDDEN');
        };
        globalThis.fetch = sentinelFetch;
        process.env.NODE_OPTIONS = 'transition-shim-sentinel';
        const originalInfo = console.info;
        console.info = (...args) => logs.push(args);
        await import(${JSON.stringify(moduleUrl)} + '?behavior-test=1');
        console.info = originalInfo;
        if (globalThis.fetch !== sentinelFetch) throw new Error('FETCH_MUTATED');
        if (process.env.NODE_OPTIONS !== 'transition-shim-sentinel') {
          throw new Error('NODE_OPTIONS_MUTATED');
        }
        if (calls.length !== 0) throw new Error('NETWORK_CALLED');
        if (logs.length !== 0) throw new Error('LOGGED_PROVIDER_STATE');
      `;

      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', probe],
        { encoding: 'utf8', timeout: 10_000 }
      );

      expect({
        status: result.status,
        signal: result.signal,
        stderr: result.stderr,
        stdout: result.stdout,
      }).toEqual({
        status: 0,
        signal: null,
        stderr: '',
        stdout: '',
      });
    }
  );
});
