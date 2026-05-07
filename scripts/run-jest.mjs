import { spawnSync } from 'node:child_process';
import process from 'node:process';
import './test-env.mjs';

const forwardedArgs = process.argv.slice(2);
const hasWorkerOverride = forwardedArgs.some((arg) =>
  arg === '--runInBand'
  || arg === '-i'
  || arg === '--maxWorkers'
  || arg.startsWith('--maxWorkers=')
  || arg === '--workerIdleMemoryLimit'
  || arg.startsWith('--workerIdleMemoryLimit=')
);
const boundedWorkerArgs = hasWorkerOverride
  ? []
  : [
      `--maxWorkers=${process.env.JEST_MAX_WORKERS?.trim() || '50%'}`,
      `--workerIdleMemoryLimit=${process.env.JEST_WORKER_IDLE_MEMORY_LIMIT?.trim() || '768MB'}`
    ];

const jestArgs = [
  '--disable-warning=ExperimentalWarning',
  '--experimental-vm-modules',
  'node_modules/jest/bin/jest.js',
  ...boundedWorkerArgs,
  ...forwardedArgs
];

const result = spawnSync(process.execPath, jestArgs, {
  env: process.env,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
