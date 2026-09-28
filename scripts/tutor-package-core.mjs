import { createHash } from 'node:crypto';

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const text = value => typeof value === 'string' && value.trim().length > 0;
const requireCondition = (condition, code) => { if (!condition) throw new Error(code); };

/** Pure package primitives shared by the migration CLI and sealed synthetic preview. */
export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function packageFingerprint(files) {
  return digest(JSON.stringify([...files].map(([file, { sha256, sizeBytes }]) => ({ path: file, sha256, sizeBytes }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))));
}

export function assertArtifactDigest(actual, artifact) {
  requireCondition(actual.sha256 === artifact.sha256 && actual.sizeBytes === artifact.sizeBytes, 'ARTIFACT_DIGEST_MISMATCH');
}

export function tutorAppMapping(mapping, appId, allowMigratedAlias = false) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !equal(Object.keys(mapping), ['apps']) ||
    !mapping.apps || typeof mapping.apps !== 'object' || Array.isArray(mapping.apps)) return false;
  const aliases = Object.keys(mapping.apps);
  if (aliases.length !== 1 || !text(aliases[0]) || (!allowMigratedAlias && aliases[0] !== 'arcanos-tutor')) return false;
  const app = mapping.apps[aliases[0]];
  // The portable schema leaves this extension opaque. One optional app with
  // no conflicting required flag is enforced independently of schema validation.
  return app && typeof app === 'object' && !Array.isArray(app) && equal(Object.keys(app).sort(), ['id', 'optional']) &&
    app.id === appId && app.optional === true;
}

export function assertTutorAppMapping(mapping, appId, allowMigratedAlias = false) {
  requireCondition(tutorAppMapping(mapping, appId, allowMigratedAlias), 'APP_MAPPING_INVALID');
}

/** Identity/extension checks only; the CLI retains its separate pinned Ajv schema gate. */
export function assertTutorPackageManifestIdentity(manifest, expected) {
  requireCondition(manifest.name === expected.name && !/pilot/iu.test(manifest.description ?? '') &&
    equal(Object.keys(manifest.extensions ?? {}), ['com.openai']), 'MANIFEST_IDENTITY_INVALID');
  const extension = manifest.extensions['com.openai'];
  const interfaceFields = ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities', 'defaultPrompt'];
  requireCondition(equal(Object.keys(extension).sort(), ['apps', 'interface']) && extension.apps === './.app.json' &&
    Object.keys(extension.interface ?? {}).every(key => interfaceFields.includes(key)) && extension.interface.displayName === expected.displayName &&
    (extension.interface.capabilities === undefined || equal(extension.interface.capabilities, ['Read'])) &&
    (extension.interface.defaultPrompt === undefined || (Array.isArray(extension.interface.defaultPrompt) &&
      extension.interface.defaultPrompt.every(text))), 'OPENAI_EXTENSION_INVALID');
}
