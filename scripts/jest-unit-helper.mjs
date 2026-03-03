import { spawnSync } from 'node:child_process';
import process from 'node:process';

const jestArgs = [
  '--experimental-vm-modules',
  'node_modules/jest/bin/jest.js',
  '--testPathIgnorePatterns=integration',
  ...process.argv.slice(2),
];

const result = spawnSync(process.execPath, jestArgs, {
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
