import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const fixturePath = path.join(repositoryRoot, 'tests/fixtures/dag-metrics-runtime.mjs');
const compiledPrerequisites = [
  'workers/taskRunners.js', 'agents/agentManager.js', 'utils/metrics.js',
  'platform/logging/logger.js', 'dag/artifactStore.js', 'jobs/jobSchema.js'
];

describe('compiled DAG metrics runtime', () => {
  it('bounds production-default metrics while preserving filesystem artifacts', () => {
    if (compiledPrerequisites.some(file => !existsSync(path.join(repositoryRoot, 'dist', file)))) {
      throw new Error('Compiled DAG metrics fixture requires a root build. Run npm run build before this test.');
    }
    const temporaryParent = realpathSync(os.tmpdir());
    const temporaryRoot = realpathSync(mkdtempSync(path.join(temporaryParent, 'arcanos-dag-metrics-jest-')));
    try {
      // Allow only OS essentials; credentials and NODE_OPTIONS never reach the child.
      const environment = Object.fromEntries(['SystemRoot', 'WINDIR']
        .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
      Object.assign(environment, {
        TEMP: temporaryRoot, TMP: temporaryRoot, TMPDIR: temporaryRoot,
        NODE_ENV: 'test', DISABLE_EXTERNAL_CALLS: 'true', RUN_WORKERS: 'false',
        USE_MOCK_SERVICES: 'true', ALLOW_MOCK_OPENAI: 'true',
        REDIS_SHARED_METRICS_ENABLED: 'false', OPENAI_API_KEY: 'test-openai-api-key'
      });
      const result = spawnSync(process.execPath, [fixturePath, '--repo-root', repositoryRoot], {
        cwd: temporaryRoot, env: environment, encoding: 'utf8', shell: false,
        windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024
      });
      expect({ status: result.status, signal: result.signal, error: result.error?.message,
        stderr: result.stderr }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
      expect(JSON.parse(result.stdout.trim())).toEqual({
        status: 'PASS', fixture: 'dag-metrics-compiled-runtime-v1', jobs: 256,
        checkpoints: [
          { completedPairs: 64, retainedDurationScalars: 2 },
          { completedPairs: 128, retainedDurationScalars: 2 }
        ],
        artifactsVerified: 256, artifactHydrations: 128,
        finalDurationsMs: [0, 0], finalTokenGauge: 0,
        providerAttempts: 0, networkAttempts: 0, temporaryArtifactsRemoved: true
      });
    } finally {
      expect(realpathSync(temporaryRoot)).toBe(temporaryRoot);
      expect(path.dirname(temporaryRoot)).toBe(temporaryParent);
      expect(path.basename(temporaryRoot).startsWith('arcanos-dag-metrics-jest-')).toBe(true);
      expect(lstatSync(temporaryRoot).isSymbolicLink()).toBe(false);
      rmSync(temporaryRoot, { recursive: true });
      expect(existsSync(temporaryRoot)).toBe(false);
    }
  }, 60_000);
});
