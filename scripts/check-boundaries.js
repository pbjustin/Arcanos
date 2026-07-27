import madge from 'madge';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findLayerAccessViolations,
  getProtectedLayerFiles,
  runCliCheck as runLayerAccessCheck,
  scanFileForLayerAccessViolations
} from './check-cef-layer-access.js';

export {
  findLayerAccessViolations,
  getProtectedLayerFiles,
  scanFileForLayerAccessViolations
};

const currentScriptPath = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(currentScriptPath), '..');

export async function findCircularDependencies({
  repositoryRoot = REPOSITORY_ROOT,
  analyzeDependencies = madge
} = {}) {
  const result = await analyzeDependencies(path.join(repositoryRoot, 'src'), {
    baseDir: repositoryRoot,
    fileExtensions: ['ts'],
    tsConfig: path.join(repositoryRoot, 'tsconfig.json')
  });

  return result.circular();
}

export async function runBoundaryChecks({
  runLayerAccessCheck: checkLayerAccess = runLayerAccessCheck,
  findCycles = findCircularDependencies,
  log = console.log,
  error = console.error,
  markFailure = () => {
    process.exitCode = 1;
  }
} = {}) {
  checkLayerAccess();
  const circularDependencies = await findCycles();

  if (circularDependencies.length > 0) {
    error('check:circular-dependencies failed');
    error(JSON.stringify(circularDependencies, null, 2));
    markFailure();
    return circularDependencies;
  }

  log('check:circular-dependencies passed: No circular dependencies found.');
  return circularDependencies;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)) {
  try {
    await runBoundaryChecks();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check:boundaries failed to run: ${message}`);
    process.exitCode = 1;
  }
}
