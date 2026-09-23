import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const schemaFile = 'schemas/agent-plugins-1.0.0.schema.json';
const schemaDigest = '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883';
const skillFile = 'skills/arcanos-tutor-pilot/SKILL.md';
const allowedFiles = new Set([
  'README.md', 'plugin.json.template', 'connection.requirements.json',
  'regression-prompts.json', schemaFile, skillFile
]);
const allowedDirectories = new Set(['schemas', 'skills', 'skills/arcanos-tutor-pilot']);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/u,
  /\bBearer\s+[A-Za-z0-9_.~+/-]{12,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /(?:postgres(?:ql)?|redis):\/\/[^\s/]+:[^\s@]+@/iu
];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

/** Validate source staging only; account authorization cannot be established here. */
export async function validateTutorPilotPackage(root) {
  requireCondition(!(await lstat(root)).isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
  const canonicalRoot = await realpath(root);
  const files = new Map();
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(canonicalRoot, relative), { withFileTypes: true })) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(canonicalRoot, relativePath);
      const stat = await lstat(fullPath);
      requireCondition(!stat.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
      if (stat.isDirectory()) {
        requireCondition(allowedDirectories.has(relativePath), 'UNEXPECTED_DIRECTORY');
        await visit(relativePath);
      } else {
        requireCondition(stat.isFile() && allowedFiles.has(relativePath), 'UNEXPECTED_FILE');
        requireCondition(stat.size <= 64 * 1024, 'FILE_SIZE_EXCEEDED');
        const bytes = await readFile(fullPath);
        requireCondition(bytes.length <= 64 * 1024, 'FILE_SIZE_EXCEEDED');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        requireCondition(!secretPatterns.some(pattern => pattern.test(content)), 'POSSIBLE_CREDENTIAL');
        files.set(relativePath, { content, bytes });
      }
    }
  }
  await visit();
  requireCondition(files.size === allowedFiles.size, 'MISSING_REQUIRED_FILE');
  const parse = name => JSON.parse(files.get(name).content);
  // Git may check text out with CRLF on Windows; only line endings are normalized.
  requireCondition(digest(files.get(schemaFile).content.replace(/\r\n/gu, '\n')) === schemaDigest, 'SCHEMA_DIGEST_MISMATCH');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateManifest = ajv.compile(parse(schemaFile));
  const manifest = parse('plugin.json.template');
  requireCondition(validateManifest(manifest), 'MANIFEST_SCHEMA_INVALID');
  requireCondition(manifest.name === 'arcanos-tutor-pilot', 'MANIFEST_IDENTITY_INVALID');
  requireCondition(manifest.extensions === undefined, 'UNRESOLVED_EXTENSION_NOT_ALLOWED');

  const skill = files.get(skillFile).content;
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  requireCondition(frontmatter, 'SKILL_FRONTMATTER_MISSING');
  const metadata = yaml.load(frontmatter[1]);
  requireCondition(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'SKILL_METADATA_INVALID');
  requireCondition(metadata.name === 'arcanos-tutor-pilot', 'SKILL_NAME_INVALID');
  requireCondition(typeof metadata.description === 'string' && metadata.description.length > 0 && metadata.description.length <= 1024, 'SKILL_DESCRIPTION_INVALID');
  requireCondition(Object.keys(metadata).every(key => ['name', 'description'].includes(key)), 'SKILL_METADATA_INVALID');
  requireCondition(skill.slice(frontmatter[0].length).trim().length > 0, 'SKILL_BODY_MISSING');

  const requirements = parse('connection.requirements.json');
  requireCondition(requirements.status === 'pending_registration' && requirements.registeredAppId === null, 'UNVERIFIED_REGISTRATION');
  requireCondition(requirements.endpointPath === '/chatgpt/mcp' && requirements.toolName === 'arcanos_tutor', 'CONNECTION_CONTRACT_INVALID');
  requireCondition(Array.isArray(requirements.releaseBlockers) && requirements.releaseBlockers.length > 0 && requirements.releaseBlockers.every(item => typeof item === 'string'), 'RELEASE_BLOCKERS_MISSING');
  const regression = parse('regression-prompts.json');
  requireCondition(regression.status === 'prepared_not_run_in_chatgpt' && Array.isArray(regression.cases) && regression.cases.length > 0, 'REGRESSION_METADATA_INVALID');
  requireCondition(regression.cases.every(item => typeof item.id === 'string' && typeof item.prompt === 'string' && typeof item.expected === 'string'), 'REGRESSION_CASE_INVALID');

  return {
    sourceValidation: 'PASS',
    releaseStatus: 'BLOCKED',
    releaseBlockers: requirements.releaseBlockers,
    archiveWritten: false,
    distributionCandidates: [
      { path: 'plugin.json', source: 'plugin.json.template', sha256: digest(files.get('plugin.json.template').bytes) },
      { path: skillFile, source: skillFile, sha256: digest(files.get(skillFile).bytes) }
    ],
    validatedFileCount: files.size
  };
}

async function main() {
  const args = process.argv.slice(2);
  let root = fileURLToPath(new URL('../integrations/tutor-pilot/', import.meta.url));
  let release = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--release') release = true;
    else if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  const result = await validateTutorPilotPackage(root);
  if (release) {
    // This PR has no approved account/registration evidence and cannot emit a release.
    process.stdout.write(`${JSON.stringify({ ...result, code: 'RELEASE_BLOCKED' })}\n`);
    process.exitCode = 2;
  } else process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not print parser exceptions or file contents: they may contain rejected secrets.
    process.stderr.write('PACKAGE_INVALID: Tutor staging validation failed.\n');
    process.exitCode = 1;
  });
}
