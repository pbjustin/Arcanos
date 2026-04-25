import { spawnSync } from 'node:child_process';
import process from 'node:process';
import './test-env.mjs';

const jestArgs = [
  '--disable-warning=ExperimentalWarning',
  '--experimental-vm-modules',
  'node_modules/jest/bin/jest.js',
  ...process.argv.slice(2)
];

const result = spawnSync(process.execPath, jestArgs, {
  env: process.env,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
