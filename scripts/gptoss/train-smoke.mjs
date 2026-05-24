#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const candidates = process.platform === 'win32'
  ? [['python', []], ['py', ['-3']]]
  : [['python3', []], ['python', []]];

let lastResult = null;

for (const [bin, prefixArgs] of candidates) {
  const result = spawnSync(bin, [...prefixArgs, 'scripts/gptoss/train-smoke.py', ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error?.code === 'ENOENT') {
    lastResult = result;
    continue;
  }

  process.exit(result.status ?? 1);
}

process.stderr.write(`Unable to find Python interpreter for GPT-OSS smoke launcher: ${lastResult?.error?.message ?? 'not found'}\n`);
process.exit(1);
