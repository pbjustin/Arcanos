import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCondition } from './tutor-migration.mjs';
import { checkPluginPrivateBoundary } from './check-plugin-private-boundary.mjs';

/** Content never leaves this process. Checks working files and changed index blobs. */
export async function checkTutorPrivateBoundary(inputRoot) {
  return checkPluginPrivateBoundary(inputRoot, 'arcanos-tutor');
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
