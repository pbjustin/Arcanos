/** Run deterministic documentation checks without application or provider startup. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts/documentation-offline-guard.mjs');
const VALIDATORS = [
  ['documentation', 'scripts/check-documentation.mjs'],
  ['generated-indexes', 'scripts/reindex-codebase.js', '--check'],
  ['local-links', 'scripts/check-documentation-links.mjs', '--local-only'],
];
const CLEAN_ENVIRONMENT = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

/**
 * Keep OS isolation mandatory. The preload rejects accidental provider calls
 * before transport; the network namespace also contains native network access.
 * A read-only root prevents validators from publishing docs or persistent state.
 */
export function createSandboxCommand({ repositoryRoot = ROOT, nodeExecutable = process.execPath } = {}) {
  return {
    command: '/usr/bin/bwrap',
    args: [
      '--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--die-with-parent', '--cap-drop', 'ALL',
      '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--clearenv',
      ...Object.entries(CLEAN_ENVIRONMENT).flatMap(([key, value]) => ['--setenv', key, value]),
      '--chdir', repositoryRoot, '--', nodeExecutable,
      '--permission', '--allow-fs-read=*', '--allow-child-process',
      '--import', pathToFileURL(GUARD).href,
    ],
    options: {
      cwd: repositoryRoot,
      env: { ...CLEAN_ENVIRONMENT },
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      shell: false,
    },
  };
}

/**
 * No provider generation is attempted, even when validation succeeds. Only
 * fixed labels and exit codes enter evidence: child diagnostics may contain
 * attacker-controlled source text or credentials and must never be published.
 */
export function runOfflineValidation({ execute = spawnSync } = {}) {
  const checks = VALIDATORS.map(([name, script, ...args]) => {
    const sandbox = createSandboxCommand();
    let result;
    try {
      result = execute(sandbox.command, [...sandbox.args, path.join(ROOT, script), ...args], sandbox.options);
    } catch {
      return { name, status: 'failed', exitCode: null };
    }
    const exitCode = Number.isInteger(result?.status) ? result.status : null;
    return { name, status: exitCode === 0 && !result.error && !result.signal ? 'passed' : 'failed', exitCode };
  });
  return {
    schemaVersion: 1,
    validation: { status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed' },
    generation: { status: 'skipped', reason: 'Automatic documentation validation is provider-free.' },
    providerAccess: 'blocked',
    updates: [],
    publication: { requiresHumanReview: true },
    checks,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runOfflineValidation();
  try {
    writeFileSync('documentation-offline-validation.json', `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  } catch {
    console.error('Offline documentation evidence could not be written.');
    process.exitCode = 1;
  }
  console.log(`Offline documentation validation: ${report.validation.status}. Provider generation: skipped.`);
  for (const check of report.checks) console.log(`${check.name}: ${check.status}`);
  if (report.validation.status !== 'passed') process.exitCode = 1;
}
