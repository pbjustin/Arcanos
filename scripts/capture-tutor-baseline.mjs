import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBaseline, noSymlinkAncestors, requireCondition } from './tutor-migration.mjs';

async function main() {
  const args = process.argv.slice(2);
  let inputRoot;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--inputs' && args[index + 1]) inputRoot = path.resolve(args[++index]);
    else if (args[index] === '--output' && args[index + 1]) output = path.resolve(args[++index]);
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  requireCondition(inputRoot && output, 'INPUT_AND_OUTPUT_REQUIRED');
  await noSymlinkAncestors(inputRoot);
  await noSymlinkAncestors(path.dirname(output));
  requireCondition(!output.startsWith(`${inputRoot}${path.sep}`), 'OUTPUT_MUST_BE_SEPARATE');
  const inventory = await captureBaseline(inputRoot);
  // Exclusive create preserves a prior reviewed inventory. Explicitly review/move
  // the generated sanitized file rather than silently replacing repository evidence.
  await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write('BASELINE_CAPTURED: sanitized inventory written; review before committing.\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('BASELINE_INVALID: no private input or parser details are logged.\n');
    process.exitCode = 1;
  });
}
