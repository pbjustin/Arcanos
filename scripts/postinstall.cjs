const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Run the existing auto-sync bootstrap when the setup script is present.
 * Inputs: repository root directory.
 * Outputs: none.
 * Edge cases: missing script or optional dependency failures are ignored.
 */
function runAutoSyncSetupIfAvailable(repositoryRootDirectory) {
  const autoSyncScriptPath = path.join(
    repositoryRootDirectory,
    'scripts',
    'setup-auto-sync.js',
  );

  //audit assumption: auto-sync is an optional convenience layer; install must not fail if it is unavailable.
  //audit failure risk: missing optional modules inside the setup script can throw during require().
  //audit expected invariant: production and CI installs still succeed when auto-sync assets are absent.
  //audit handling strategy: skip missing scripts and suppress module-not-found errors from optional setup code.
  if (!fs.existsSync(autoSyncScriptPath)) {
    return;
  }

  try {
    require(autoSyncScriptPath);
  } catch (error) {
    //audit assumption: only missing optional modules should be ignored here.
    //audit failure risk: swallowing unrelated exceptions would hide a real setup regression.
    //audit expected invariant: non-module resolution failures are surfaced to the installer.
    //audit handling strategy: rethrow everything except MODULE_NOT_FOUND.
    if (error && error.code === 'MODULE_NOT_FOUND') {
      return;
    }

    throw error;
  }
}

/**
 * Repair git-sourced minimatch installs that expose source files without built dist artifacts.
 * Inputs: repository root directory.
 * Outputs: none.
 * Edge cases: skipped when the dev dependency tree or local tshy binary is absent.
 */
function repairGitSourcedMinimatchBuild(repositoryRootDirectory) {
  const minimatchPackageDirectory = path.join(
    repositoryRootDirectory,
    'node_modules',
    '@typescript-eslint',
    'typescript-estree',
    'node_modules',
    'minimatch',
  );
  const minimatchPackageJsonPath = path.join(
    minimatchPackageDirectory,
    'package.json',
  );
  const minimatchCommonJsEntryPath = path.join(
    minimatchPackageDirectory,
    'dist',
    'commonjs',
    'index.js',
  );

  //audit assumption: production installs may omit the dev-only TypeScript-ESLint subtree entirely.
  //audit failure risk: blindly touching nested dev packages would fail clean production installs.
  //audit expected invariant: the repair only runs when the affected package is present.
  //audit handling strategy: return early when the nested package is not installed.
  if (!fs.existsSync(minimatchPackageJsonPath)) {
    return;
  }

  //audit assumption: a valid packaged minimatch install already contains its dist output.
  //audit failure risk: rebuilding an already-correct package adds unnecessary work and can mask drift.
  //audit expected invariant: when dist/commonjs/index.js exists, the package is runnable.
  //audit handling strategy: skip the repair path for already-built installs.
  if (fs.existsSync(minimatchCommonJsEntryPath)) {
    return;
  }

  const minimatchPackageDefinition = JSON.parse(
    fs.readFileSync(minimatchPackageJsonPath, 'utf8'),
  );

  //audit assumption: only the git-sourced minimatch 9.0.7 override needs a local rebuild.
  //audit failure risk: running tshy in an unexpected package directory could mutate unrelated dependencies.
  //audit expected invariant: the target package identity matches the known vulnerable subtree override.
  //audit handling strategy: fail closed when the package identity does not match the expected repair target.
  if (
    minimatchPackageDefinition.name !== 'minimatch' ||
    minimatchPackageDefinition.version !== '9.0.7'
  ) {
    return;
  }

  const typescriptCompilerPath = path.join(
    repositoryRootDirectory,
    'node_modules',
    'typescript',
    'bin',
    'tsc',
  );

  //audit assumption: the root TypeScript compiler is available on dev installs because typescript is a root devDependency.
  //audit failure risk: a missing compiler would leave the package in a source-only, non-runnable state.
  //audit expected invariant: if the affected package exists during a dev install, the local compiler should also exist.
  //audit handling strategy: throw a structured install error so the dependency tree is not left silently broken.
  if (!fs.existsSync(typescriptCompilerPath)) {
    throw new Error(
      'Cannot repair minimatch@9.0.7 because the local TypeScript compiler is unavailable.',
    );
  }

  runTypeScriptBuildForMinimatch({
    buildConfigPath: path.join(minimatchPackageDirectory, '.tshy', 'commonjs.json'),
    moduleKind: 'commonjs',
    moduleResolutionKind: 'node',
    outputDirectoryPath: path.join(minimatchPackageDirectory, 'dist', 'commonjs'),
    outputPackageType: 'commonjs',
    minimatchPackageDirectory,
    typescriptCompilerPath,
  });
  runTypeScriptBuildForMinimatch({
    buildConfigPath: path.join(minimatchPackageDirectory, '.tshy', 'esm.json'),
    moduleKind: 'nodenext',
    moduleResolutionKind: 'nodenext',
    outputDirectoryPath: path.join(minimatchPackageDirectory, 'dist', 'esm'),
    outputPackageType: 'module',
    minimatchPackageDirectory,
    typescriptCompilerPath,
  });

  //audit assumption: both module targets are required because consumers load both CJS and ESM exports.
  //audit failure risk: a partial build would keep one runtime path broken.
  //audit expected invariant: the CommonJS entry exists after the repair completes.
  //audit handling strategy: verify the expected artifact after both compiler runs finish.
  if (!fs.existsSync(minimatchCommonJsEntryPath)) {
    throw new Error(
      'minimatch@9.0.7 repair finished without producing dist/commonjs/index.js.',
    );
  }
}

/**
 * Build one minimatch module target with the local TypeScript compiler and emit its package type marker.
 * Inputs: build parameters for a single module target.
 * Outputs: none.
 * Edge cases: existing output directories are replaced before build.
 */
function runTypeScriptBuildForMinimatch({
  buildConfigPath,
  moduleKind,
  moduleResolutionKind,
  outputDirectoryPath,
  outputPackageType,
  minimatchPackageDirectory,
  typescriptCompilerPath,
}) {
  fs.rmSync(outputDirectoryPath, { force: true, recursive: true });

  const typescriptExecutionResult = spawnSync(
    process.execPath,
    [
      typescriptCompilerPath,
      '--project',
      buildConfigPath,
      '--module',
      moduleKind,
      '--moduleResolution',
      moduleResolutionKind,
      '--outDir',
      outputDirectoryPath,
    ],
    {
      cwd: minimatchPackageDirectory,
      stdio: 'inherit',
    },
  );

  //audit assumption: the root compiler can compile the git-sourced minimatch package without extra network activity.
  //audit failure risk: continuing after a failed compiler run would preserve a broken dependency tree.
  //audit expected invariant: each module target build exits successfully before its package marker is written.
  //audit handling strategy: propagate compiler process failures immediately and write package metadata only after success.
  if (typescriptExecutionResult.error) {
    throw typescriptExecutionResult.error;
  }

  if (typescriptExecutionResult.status !== 0) {
    throw new Error(
      `TypeScript failed while repairing minimatch@9.0.7 ${moduleKind} output (exit code ${typescriptExecutionResult.status}).`,
    );
  }

  const outputPackageJsonPath = path.join(outputDirectoryPath, 'package.json');
  fs.writeFileSync(
    outputPackageJsonPath,
    `${JSON.stringify({ type: outputPackageType }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Execute postinstall tasks in a deterministic order.
 * Inputs: none.
 * Outputs: process exit code via thrown errors.
 * Edge cases: optional auto-sync setup is non-fatal; dependency repair is fatal when required.
 */
function main() {
  const repositoryRootDirectory = process.cwd();

  runAutoSyncSetupIfAvailable(repositoryRootDirectory);
  repairGitSourcedMinimatchBuild(repositoryRootDirectory);
}

main();
