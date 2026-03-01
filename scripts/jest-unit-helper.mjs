import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const testPaths = args.filter(arg => !arg.startsWith('-'));
const options = args.filter(arg => arg.startsWith('-'));

const jestArgs = [
  '--experimental-vm-modules',
  'node_modules/jest/bin/jest.js',
  '--testPathIgnorePatterns=integration',
  ...options
];

if (testPaths.length > 0) {
  jestArgs.push('--runTestsByPath', ...testPaths);
}

const result = spawnSync(process.execPath, jestArgs, {
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
