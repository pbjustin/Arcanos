#!/usr/bin/env node
// Executable provider fixture: the production collector still uses execFile.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const variables = JSON.parse(readFileSync(process.env.FIXTURE_VARIABLES_FILE, 'utf8'));
const expected = ['variable', 'list', '--service', variables.RAILWAY_SERVICE_ID,
  '--environment', 'production', '--json'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error('FIXTURE_CLI_ARGUMENTS_INVALID');
  process.exit(2);
}
appendFileSync(process.env.FIXTURE_CLI_CALLS_FILE, 'variable-list\n');
writeFileSync(process.env.FIXTURE_CLI_PID_FILE, `${process.pid}\n`, { mode: 0o600 });
if (process.env.FIXTURE_CLI_MODE === 'oversized') {
  process.stdout.write('x'.repeat(1024 * 1024 + 8192));
} else if (process.env.FIXTURE_CLI_MODE === 'failure') {
  console.error(variables.PGPASSWORD);
  process.exitCode = 1;
} else if (process.env.FIXTURE_CLI_MODE === 'timeout') {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify(variables));
}
