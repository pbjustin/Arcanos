#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

function quoteForBash(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function windowsPathToWsl(path) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (!match) {
    return path.replace(/\\/g, '/');
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

const args = process.argv.slice(2);

if (process.platform === 'win32') {
  const distro = process.env.ARCANOS_WSL_DISTRO || 'Ubuntu-24.04';
  const cwd = windowsPathToWsl(process.cwd());
  const forwardedArgs = args.map(quoteForBash).join(' ');
  const command = [
    `cd ${quoteForBash(cwd)}`,
    'source /root/unsloth-gptoss-env/bin/activate',
    `python scripts/gptoss/eval-adapter-local.py ${forwardedArgs}`,
  ].join(' && ');
  const result = spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const command = [
  'source /root/unsloth-gptoss-env/bin/activate',
  `python scripts/gptoss/eval-adapter-local.py ${args.map(quoteForBash).join(' ')}`,
].join(' && ');
const result = spawnSync('bash', ['-lc', command], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
