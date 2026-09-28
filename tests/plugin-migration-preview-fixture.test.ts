import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actual = await import('../scripts/tutor-package-core.mjs');
const manifest = jest.fn(actual.assertTutorPackageManifestIdentity);
const mapping = jest.fn(actual.assertTutorAppMapping);
const artifact = jest.fn(actual.assertArtifactDigest);
const digest = jest.fn(actual.digest);
const fingerprint = jest.fn(actual.packageFingerprint);
jest.unstable_mockModule('../scripts/tutor-package-core.mjs', () => ({
  ...actual, assertTutorPackageManifestIdentity: manifest, assertTutorAppMapping: mapping,
  assertArtifactDigest: artifact, digest, packageFingerprint: fingerprint,
}));
const { assertPluginMigrationPreviewFixture } = await import('../src/shared/chatgpt/pluginMigrationPreviewFixture.js');
const FAILURE = 'PLUGIN_MIGRATION_PREVIEW_ASSERTION_FAILED';

beforeEach(() => {
  manifest.mockReset().mockImplementation(actual.assertTutorPackageManifestIdentity);
  mapping.mockReset().mockImplementation(actual.assertTutorAppMapping);
  artifact.mockReset().mockImplementation(actual.assertArtifactDigest);
  digest.mockReset().mockImplementation(actual.digest);
  fingerprint.mockReset().mockImplementation(actual.packageFingerprint);
});

describe('sealed synthetic plugin migration package foundation', () => {
  it('uses real shared primitives on one fixed synthetic package and thirteen exact-code negative checks', () => {
    expect(assertPluginMigrationPreviewFixture()).toBeUndefined();
    expect(manifest).toHaveBeenCalledTimes(5);
    expect(mapping).toHaveBeenCalledTimes(8);
    expect(artifact).toHaveBeenCalledTimes(3);
    expect(fingerprint).toHaveBeenCalledTimes(4);
    expect(manifest.mock.calls[0]).toEqual([
      expect.objectContaining({ name: 'plugin-test-fixture' }),
      { name: 'plugin-test-fixture', displayName: 'Plugin Test Fixture' },
    ]);
    expect(mapping.mock.calls[0]).toEqual([
      { apps: { 'plugin-test-fixture': { id: 'asdk_app_test_fixture', optional: true } } },
      'asdk_app_test_fixture', true,
    ]);
    expect(artifact.mock.calls[0]).toEqual([
      { sha256: '4788b45c0c038fbaacdfb9abc690bb0524d9c537bc0f22f8ed8d37d5adfa8e8a', sizeBytes: 100 },
      { sha256: '4788b45c0c038fbaacdfb9abc690bb0524d9c537bc0f22f8ed8d37d5adfa8e8a', sizeBytes: 100 },
    ]);
    const files = new Map(fingerprint.mock.calls[0][0]);
    expect([...files.keys()]).toEqual(['plugin.json', '.app.json', 'skills/plugin-test-fixture/SKILL.md']);
    expect(actual.packageFingerprint(files)).toBe('8dc6fd4d8478455096508253d6a5d30174a7c0150674e036a8326c71f8300039');
  });

  it.each(['manifest', 'optional app', 'artifact digest'])(
    'fails closed when the real %s rejection stops running', dependency => {
      if (dependency === 'manifest') manifest.mockImplementation(() => {});
      else if (dependency === 'optional app') mapping.mockImplementation(() => {});
      else artifact.mockImplementation(() => {});
      expect(assertPluginMigrationPreviewFixture).toThrow(FAILURE);
    });

  it('checks size independently of a matching digest', () => {
    artifact.mockImplementation((observed, expected) => {
      if (observed.sha256 !== expected.sha256) throw new Error('ARTIFACT_DIGEST_MISMATCH');
    });
    expect(assertPluginMigrationPreviewFixture).toThrow(FAILURE);
  });

  it('rejects a wrong digest implementation against a fixed independent expected hash', () => {
    digest.mockReturnValue('0'.repeat(64));
    expect(assertPluginMigrationPreviewFixture).toThrow(FAILURE);
  });

  it('rejects a constant fingerprint that misses changed bytes or path identity', () => {
    fingerprint.mockReturnValue('8dc6fd4d8478455096508253d6a5d30174a7c0150674e036a8326c71f8300039');
    expect(assertPluginMigrationPreviewFixture).toThrow(FAILURE);
  });

  it('requires the expected rejection code rather than accepting any exception', () => {
    mapping.mockImplementation((...args) => {
      try { actual.assertTutorAppMapping(...args); }
      catch { throw new Error('MOCK_UNRELATED_FAILURE'); }
    });
    expect(assertPluginMigrationPreviewFixture).toThrow(FAILURE);
  });

  it('does not expose unexpected dependency error text', () => {
    manifest.mockImplementation(() => { throw new Error('Mock internal dependency detail.'); });
    try {
      assertPluginMigrationPreviewFixture();
      throw new Error('Expected rejection.');
    } catch (error) {
      expect((error as Error).message).toBe(FAILURE);
    }
  });
});
