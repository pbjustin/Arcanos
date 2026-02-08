import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  EXIT_CODES,
  executeConvergence,
  parseArgs,
  parseDuration,
  sha256,
  validateCriteriaConfig,
  validateFixAllowList
} from '../scripts/converge-plan.js';

describe('converge-plan utilities', () => {
  test('parseDuration supports ms/s/m/h', () => {
    expect(parseDuration('1500')).toBe(1500);
    expect(parseDuration('10s')).toBe(10000);
    expect(parseDuration('2m')).toBe(120000);
    expect(parseDuration('1h')).toBe(3600000);
  });

  test('parseDuration rejects invalid values', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('1d')).toThrow('Invalid duration');
  });

  test('parseArgs parses supported flags', () => {
    const options = parseArgs([
      '--max-iterations=3',
      '--iteration-timeout=90s',
      '--criteria-file',
      'custom.criteria.json',
      '--artifact-dir',
      'custom-artifacts',
      '--preview'
    ]);

    expect(options.maxIterations).toBe(3);
    expect(options.iterationTimeoutMs).toBe(90000);
    expect(options.criteriaFile).toBe('custom.criteria.json');
    expect(options.artifactDir).toBe('custom-artifacts');
    expect(options.preview).toBe(true);
  });

  test('sha256 is deterministic', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  test('validateCriteriaConfig rejects malformed criteria', () => {
    expect(() => validateCriteriaConfig({ criteria: [] })).toThrow('criteria must be a non-empty array');
  });

  test('validateFixAllowList rejects empty allow-list', () => {
    expect(() => validateFixAllowList({ approvedFixers: [] })).toThrow('approvedFixers cannot be empty');
  });
});

describe('converge-plan integration checks', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'converge-plan-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns CONFIG_INVALID for malformed criteria file', async () => {
    const criteriaPath = path.join(tempDir, 'criteria.json');
    const allowListPath = path.join(tempDir, 'allow.json');
    const artifactDir = path.join(tempDir, 'artifacts');

    await writeFile(criteriaPath, '{invalid json}', 'utf8');
    await writeFile(
      allowListPath,
      JSON.stringify({ version: 1, approvedFixers: ['npm run audit:fix'] }),
      'utf8'
    );

    const result = await executeConvergence({
      criteriaFile: criteriaPath,
      allowListFile: allowListPath,
      artifactDir
    });

    expect(result.exitCode).toBe(EXIT_CODES.CONFIG_INVALID);
    const latest = JSON.parse(await readFile(path.join(artifactDir, 'latest.json'), 'utf8'));
    expect(latest.exitCode).toBe(EXIT_CODES.CONFIG_INVALID);
  });

  test('returns ENV_FAILURE when required tool is missing', async () => {
    const criteriaPath = path.join(tempDir, 'criteria.json');
    const allowListPath = path.join(tempDir, 'allow.json');
    const artifactDir = path.join(tempDir, 'artifacts');

    await writeFile(
      criteriaPath,
      JSON.stringify({
        version: 1,
        requiredTools: {
          node: { command: 'node', minVersion: '18.0.0' },
          npm: { command: 'npm', minVersion: '8.0.0' },
          python: { commands: ['definitely-not-a-real-python-binary'], minVersion: '3.10.0' }
        },
        criteria: [{ id: 'noop', command: 'node -e "process.exit(0)"' }],
        autoFixers: [{ id: 'fix', command: 'npm run audit:fix' }]
      }),
      'utf8'
    );

    await writeFile(
      allowListPath,
      JSON.stringify({ version: 1, approvedFixers: ['npm run audit:fix'] }),
      'utf8'
    );

    const result = await executeConvergence({
      criteriaFile: criteriaPath,
      allowListFile: allowListPath,
      artifactDir,
      preview: true
    });

    expect(result.exitCode).toBe(EXIT_CODES.ENV_FAILURE);
  });
});
