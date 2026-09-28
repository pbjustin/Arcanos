// Compatibility entry point; the final Tutor package and release gates are canonical.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, validateArcanosTutorPackage } from './validate-arcanos-tutor-package.mjs';
export const validateTutorPilotPackage = validateArcanosTutorPackage;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    process.stderr.write('PACKAGE_INVALID: Tutor validation failed; no input contents are logged.\n');
    process.exitCode = 1;
  });
}
