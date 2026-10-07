import { writeFileSync } from 'node:fs';
import { createValidationBuildManifest } from './live-validation-bootstrap.mjs';
const [sha, role, output] = process.argv.slice(2);
const manifest = createValidationBuildManifest(process.cwd(), sha, role);
writeFileSync(output, JSON.stringify(manifest) + '\n', { mode: 0o444, flag: 'wx' });
