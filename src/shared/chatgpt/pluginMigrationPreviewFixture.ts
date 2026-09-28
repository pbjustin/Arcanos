// eslint-disable-next-line no-restricted-imports -- Reviewed pure package core only; no migration CLI or private input graph.
import {
  assertArtifactDigest, assertTutorAppMapping, assertTutorPackageManifestIdentity, digest, packageFingerprint,
} from '../../../scripts/tutor-package-core.mjs';

const FAILURE = 'PLUGIN_MIGRATION_PREVIEW_ASSERTION_FAILED';
const identity = { name: 'plugin-test-fixture', displayName: 'Plugin Test Fixture' };
const appId = 'asdk_app_test_fixture';
const skill = '---\nname: plugin-test-fixture\ndescription: Synthetic fixture only.\n---\nUse only synthetic examples.\n';
// Fixed expectations make a broken hashing implementation fail instead of agreeing with itself.
const skillSha256 = '4788b45c0c038fbaacdfb9abc690bb0524d9c537bc0f22f8ed8d37d5adfa8e8a'; // gitleaks:allow -- synthetic fixture SHA-256
const fingerprint = '8dc6fd4d8478455096508253d6a5d30174a7c0150674e036a8326c71f8300039'; // gitleaks:allow -- synthetic fixture SHA-256

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function requireRejection(action: () => void, code: string): void {
  let rejected = false;
  try {
    action();
  } catch (error) {
    requireProof(error instanceof Error && error.message === code);
    rejected = true;
  }
  requireProof(rejected);
}

/**
 * One finite synthetic package exercises the same identity, optional-app and
 * digest primitives used by the migration CLI. No schema compiler, archive,
 * private composition, revision, approval, installed artifact or release gate runs.
 */
export function assertPluginMigrationPreviewFixture(): void {
  try {
    const manifest = {
      name: identity.name, version: '0.0.0', description: 'Synthetic package foundation fixture.',
      extensions: { 'com.openai': { apps: './.app.json',
        interface: { displayName: identity.displayName, capabilities: ['Read'] } } },
    };
    const app = { id: appId, optional: true };
    const mapping = { apps: { [identity.name]: app } };
    assertTutorPackageManifestIdentity(manifest, identity);
    // A migrated alias is already supported by the real CLI; the preview uses
    // an entirely synthetic alias and ID instead of an account registration.
    assertTutorAppMapping(mapping, appId, true);

    const sourceFiles: [string, string][] = [
      ['plugin.json', `${JSON.stringify(manifest)}\n`],
      ['.app.json', `${JSON.stringify(mapping)}\n`],
      ['skills/plugin-test-fixture/SKILL.md', skill],
    ];
    const files = new Map(sourceFiles.map(([name, bytes]) => [name,
      { sha256: digest(bytes), sizeBytes: Buffer.byteLength(bytes, 'utf8') }]));
    const actualSkill = files.get('skills/plugin-test-fixture/SKILL.md');
    requireProof(actualSkill !== undefined);
    assertArtifactDigest(actualSkill, { sha256: skillSha256, sizeBytes: 100 });
    requireProof(packageFingerprint(files) === fingerprint);
    requireProof(packageFingerprint(new Map([...files].reverse())) === fingerprint);
    const changed = new Map(files);
    changed.set('skills/plugin-test-fixture/SKILL.md', { ...actualSkill, sha256: digest(`${skill}Changed synthetic bytes.\n`) });
    requireProof(packageFingerprint(changed) !== fingerprint);
    const renamed = new Map(files);
    renamed.delete('skills/plugin-test-fixture/SKILL.md');
    renamed.set('skills/plugin-test-fixture/renamed.md', actualSkill);
    requireProof(packageFingerprint(renamed) !== fingerprint);

    requireRejection(() => assertTutorPackageManifestIdentity({ ...manifest, name: 'wrong-test-fixture' }, identity),
      'MANIFEST_IDENTITY_INVALID');
    requireRejection(() => assertTutorPackageManifestIdentity({ ...manifest, extensions: {} }, identity),
      'MANIFEST_IDENTITY_INVALID');
    for (const extension of [
      { ...manifest.extensions['com.openai'], apps: './unreviewed.json' },
      { ...manifest.extensions['com.openai'], interface: { displayName: 'Wrong Test Fixture' } },
    ]) requireRejection(() => assertTutorPackageManifestIdentity({ ...manifest,
      extensions: { 'com.openai': extension } }, identity), 'OPENAI_EXTENSION_INVALID');
    for (const invalidApp of [
      { id: appId }, { ...app, optional: false }, { ...app, optional: 'true' },
      { ...app, required: false }, { ...app, id: 'asdk_app_wrong_fixture' },
    ]) requireRejection(() => assertTutorAppMapping({ apps: { [identity.name]: invalidApp } }, appId, true),
      'APP_MAPPING_INVALID');
    requireRejection(() => assertTutorAppMapping({ apps: { [identity.name]: app, extra: app } }, appId, true),
      'APP_MAPPING_INVALID');
    requireRejection(() => assertTutorAppMapping(mapping, appId), 'APP_MAPPING_INVALID');
    requireRejection(() => assertArtifactDigest(changed.get('skills/plugin-test-fixture/SKILL.md')!,
      { sha256: skillSha256, sizeBytes: 100 }), 'ARTIFACT_DIGEST_MISMATCH');
    requireRejection(() => assertArtifactDigest({ ...actualSkill, sizeBytes: 101 },
      { sha256: skillSha256, sizeBytes: 100 }), 'ARTIFACT_DIGEST_MISMATCH');
  } catch {
    throw new Error(FAILURE);
  }
}
