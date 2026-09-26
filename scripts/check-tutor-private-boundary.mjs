import { readFile, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noSymlinkAncestors, readSafeFile, requireCondition } from './tutor-migration.mjs';

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  requireCondition(result.status === 0, 'PRIVATE_BOUNDARY_GIT_FAILED');
  return result.stdout;
}

/** Content never leaves this process. Checks working files and changed index blobs. */
export async function checkTutorPrivateBoundary(inputRoot) {
  inputRoot = path.resolve(inputRoot);
  requireCondition(path.basename(inputRoot) === 'arcanos-tutor' &&
    path.basename(path.dirname(inputRoot)) === '.local-migration', 'PRIVATE_INPUT_ROOT_REQUIRED');
  await noSymlinkAncestors(inputRoot);
  const root = path.dirname(path.dirname(inputRoot));
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--no-index', '--',
    '.local-migration/arcanos-tutor/'], { windowsHide: true });
  requireCondition(ignored.status === 0 && git(root, ['ls-files', '--', '.local-migration/']).length === 0,
    'PRIVATE_INPUT_TRACKED_OR_NOT_IGNORED');
  const raw = await readSafeFile(inputRoot, 'published-gpt.json');
  const source = JSON.parse(raw.content);
  const privateValues = [raw.content, source.instructions, JSON.stringify(source.instructions),
    JSON.stringify(source.representativeBehavior), ...source.representativeBehavior,
    ...source.instructions.split(/\r?\n\s*\r?\n/u).filter(value => value.length >= 80)]
    .filter(value => typeof value === 'string' && value.length >= 32);
  const scan = bytes => {
    const content = bytes.toString('utf8').replace(/\r\n/gu, '\n');
    requireCondition(!privateValues.some(value => content.includes(value.replace(/\r\n/gu, '\n'))),
      'PRIVATE_CONTENT_OUTSIDE_IGNORED_INPUTS');
  };
  const files = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean))];
  let inspected = 0;
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    requireCondition(absolute.startsWith(`${root}${path.sep}`), 'PRIVATE_BOUNDARY_PATH_ESCAPE');
    const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isFile()) continue;
    scan(await readFile(absolute));
    inspected += 1;
  }
  const staged = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const relative of staged) scan(git(root, ['show', `:${relative}`]));
  return { privacyBoundary: 'PASS', privateInputIgnored: true, privateInputTracked: false,
    inspectedWorkingFiles: inspected, inspectedStagedFiles: staged.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    requireCondition(args.length === 2 && args[0] === '--inputs', 'UNSUPPORTED_ARGUMENT');
    return checkTutorPrivateBoundary(args[1]);
  }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write('PRIVATE_BOUNDARY_INVALID: no private values or file details are logged.\n');
    process.exitCode = 1;
  });
}
