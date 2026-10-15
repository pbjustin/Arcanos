import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SELF_HEAL_PREVIEW_ARTIFACT_PATH = 'scripts/self-heal-preview-artifact.json';
const ROOTS = Object.freeze([
  'dist', 'workers/dist', 'packages/protocol/dist', 'packages/cli/dist',
  'packages/arcanos-runtime/dist', 'packages/arcanos-openai/dist', 'scripts', 'config',
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function fail() { throw new Error('SELF_HEAL_PREVIEW_ARTIFACT_INVALID'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Hash the executable tree, never accepting links or a caller-selected manifest. */
export function createSelfHealPreviewArtifact({ sourceSha, rootPath = ROOT }) {
  if (typeof sourceSha !== 'string' || !SHA.test(sourceSha)) fail();
  const root = resolve(rootPath);
  const files = [];
  let totalBytes = 0;
  const visit = absolutePath => {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail();
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) visit(resolve(absolutePath, name));
      return;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail();
    const path = relative(root, absolutePath).split(sep).join('/');
    if (!path || path.startsWith('../') || path === '..') fail();
    if (path === SELF_HEAL_PREVIEW_ARTIFACT_PATH) return;
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES || files.length >= MAX_FILES) fail();
    files.push({ path, sha256: hash(readFileSync(absolutePath)) });
  };
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail();
    for (const path of ROOTS) {
      let parent = root;
      for (const component of path.split('/')) {
        parent = resolve(parent, component);
        if (lstatSync(parent).isSymbolicLink()) fail();
      }
      const absolutePath = resolve(root, path);
      if (!lstatSync(absolutePath).isDirectory()) fail();
      visit(absolutePath);
    }
    for (const path of ['package.json', 'package-lock.json']) visit(resolve(root, path));
  } catch {
    fail();
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { version: 1, sourceSha, compiledSha256: hash(JSON.stringify(files)), files };
}

export function writeSelfHealPreviewArtifact(options) {
  const artifact = createSelfHealPreviewArtifact(options);
  const outputPath = resolve(options.rootPath ?? ROOT, SELF_HEAL_PREVIEW_ARTIFACT_PATH);
  const text = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) fail();
  // Exclusive creation also rejects a link or stale manifest from an earlier build.
  writeFileSync(outputPath, text, { flag: 'wx', mode: 0o444 });
  return { sourceSha: artifact.sourceSha, compiledSha256: artifact.compiledSha256, fileCount: artifact.files.length };
}

export function verifySelfHealPreviewArtifact(options) {
  try {
    const manifestPath = resolve(options.rootPath ?? ROOT, SELF_HEAL_PREVIEW_ARTIFACT_PATH);
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) fail();
    const artifact = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Object.keys(artifact).sort().join(',') !== 'compiledSha256,files,sourceSha,version'
      || artifact.version !== 1 || artifact.sourceSha !== options.sourceSha
      || !DIGEST.test(artifact.compiledSha256) || !Array.isArray(artifact.files)) fail();
    const observed = createSelfHealPreviewArtifact(options);
    if (JSON.stringify(observed) !== JSON.stringify(artifact)) fail();
    return { sourceSha: observed.sourceSha, compiledSha256: observed.compiledSha256, fileCount: observed.files.length };
  } catch {
    fail();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || !['--write', '--verify'].includes(args[0]) || args[1] !== '--source-sha') fail();
    console.log(JSON.stringify((args[0] === '--write' ? writeSelfHealPreviewArtifact : verifySelfHealPreviewArtifact)({ sourceSha: args[2] })));
  } catch {
    console.error('SELF_HEAL_PREVIEW_ARTIFACT_INVALID');
    process.exitCode = 1;
  }
}
