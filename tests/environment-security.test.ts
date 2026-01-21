import {
  collectEnvironmentFingerprint,
  matchFingerprint,
  executeInSandbox,
  summarizeFingerprint,
  EnvironmentFingerprint
} from '../src/utils/environmentSecurity.js';
import type { EnvironmentFingerprintRecord } from '../src/config/environmentFingerprints.js';

describe('environment security utilities', () => {
  test('collectEnvironmentFingerprint provides stable structure', () => {
    const fingerprint = collectEnvironmentFingerprint();
    expect(typeof fingerprint.platform).toBe('string');
    expect(typeof fingerprint.nodeVersion).toBe('string');
    expect(typeof fingerprint.nodeMajor).toBe('number');
    expect(typeof fingerprint.hash).toBe('string');
    expect(fingerprint.hash.length).toBeGreaterThan(10);
  });

  test('matchFingerprint matches compatible record', () => {
    const fingerprint: EnvironmentFingerprint = {
      platform: 'linux',
      release: '6.0.0-test',
      arch: 'x64',
      nodeVersion: 'v20.10.0',
      nodeMajor: 20,
      packageVersion: '1.0.0',
      hash: 'hash'
    };

    const records: EnvironmentFingerprintRecord[] = [
      {
        id: 'test',
        label: 'Test',
        platform: 'linux',
        arch: 'x64',
        nodeMajors: [20],
        packageVersions: ['1.0.0'],
        releasePrefixes: ['6']
      }
    ];

    const match = matchFingerprint(fingerprint, records);
    expect(match).toBeDefined();
    expect(match?.id).toBe('test');
  });

  test('matchFingerprint rejects incompatible record', () => {
    const fingerprint: EnvironmentFingerprint = {
      platform: 'linux',
      release: '6.0.0-test',
      arch: 'arm64',
      nodeVersion: 'v20.10.0',
      nodeMajor: 20,
      packageVersion: '1.0.0',
      hash: 'hash'
    };

    const records: EnvironmentFingerprintRecord[] = [
      {
        id: 'test',
        label: 'Test',
        platform: 'linux',
        arch: 'x64',
        nodeMajors: [20]
      }
    ];

    const match = matchFingerprint(fingerprint, records);
    expect(match).toBeUndefined();
  });

  test('executeInSandbox runs isolated scripts', async () => {
    const result = await executeInSandbox("console.log('sandbox-ok')");
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('sandbox-ok');
    expect(result.timedOut).toBe(false);
  });

  test('summarizeFingerprint produces compact summary', () => {
    const fingerprint: EnvironmentFingerprint = {
      platform: 'linux',
      release: '6.0.0-test',
      arch: 'x64',
      nodeVersion: 'v20.10.0',
      nodeMajor: 20,
      packageVersion: '1.0.0',
      hash: '1234567890abcdef'
    };

    const summary = summarizeFingerprint(fingerprint);
    expect(summary).toContain('linux');
    expect(summary).toContain('node20');
    expect(summary).toContain('12345678');
  });
});
