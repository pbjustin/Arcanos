#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseProfileArgs, resolveVramProfile } from './vram-profile.mjs';

export function buildVllmServeCommand(result, model = 'openai/gpt-oss-20b') {
  if (result.profile === 'defer') {
    return null;
  }

  return [
    'wsl',
    '--',
    'bash',
    '-lc',
    `"source /root/vllm-env/bin/activate && vllm serve ${model} --gpu-memory-utilization ${result.vllmGpuMemoryUtilization} --cpu-offload-gb ${result.vllmCpuOffloadGb}"`,
  ].join(' ');
}

export function renderVllmCommand(result, model = 'openai/gpt-oss-20b') {
  const command = buildVllmServeCommand(result, model);
  return {
    ok: command !== null,
    profile: result.profile,
    freeMiB: result.freeMiB,
    totalMiB: result.totalMiB,
    vllmGpuMemoryUtilization: result.vllmGpuMemoryUtilization,
    vllmCpuOffloadGb: result.vllmCpuOffloadGb,
    command,
    reason: command === null ? result.reason : 'Command generated only; not executed.',
  };
}

function parseArgs(argv) {
  const modelIndex = argv.indexOf('--model');
  const model = modelIndex >= 0 ? argv[modelIndex + 1] : 'openai/gpt-oss-20b';
  const profileArgs = modelIndex >= 0
    ? argv.filter((_, index) => index !== modelIndex && index !== modelIndex + 1)
    : argv;

  return {
    model,
    profileConfig: parseProfileArgs(profileArgs),
  };
}

async function main() {
  const { model, profileConfig } = parseArgs(process.argv.slice(2));
  const result = await resolveVramProfile(profileConfig);
  const rendered = renderVllmCommand(result, model);
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);

  if (!result.ok) {
    process.exitCode = 2;
    return;
  }

  if (!rendered.ok) {
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
