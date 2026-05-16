#!/usr/bin/env node
/**
 * Purpose: Select a deterministic local GPU runtime profile from available VRAM.
 * Inputs/Outputs: Reads nvidia-smi or mock values, prints JSON or shell exports.
 * Edge cases: Falls back to defer when no GPU data is available or parsing fails.
 */

import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export const VRAM_PROFILE_THRESHOLDS_MIB = Object.freeze({
  performance: 14_500,
  balanced: 12_500,
  shared: 10_500,
  defer: 0,
});

export const PROFILE_NAMES = Object.freeze(['performance', 'balanced', 'shared', 'defer']);

export const PROFILE_RUNTIME_CONFIG = Object.freeze({
  performance: Object.freeze({
    maxSeqLength: 2048,
    vllmGpuMemoryUtilization: 0.9,
    vllmCpuOffloadGb: 0,
    trainingAllowed: true,
    servingAllowed: true,
  }),
  balanced: Object.freeze({
    maxSeqLength: 1024,
    vllmGpuMemoryUtilization: 0.78,
    vllmCpuOffloadGb: 2,
    trainingAllowed: true,
    servingAllowed: true,
  }),
  shared: Object.freeze({
    maxSeqLength: 512,
    vllmGpuMemoryUtilization: 0.65,
    vllmCpuOffloadGb: 4,
    trainingAllowed: 'smoke-only',
    servingAllowed: true,
  }),
  defer: Object.freeze({
    maxSeqLength: 0,
    vllmGpuMemoryUtilization: 0,
    vllmCpuOffloadGb: 0,
    trainingAllowed: false,
    servingAllowed: false,
  }),
});

export const DEFAULT_CONFIG = Object.freeze({
  format: 'json',
  nvidiaSmiPath: 'nvidia-smi',
  timeoutMs: 5_000,
});

function readNonNegativeInteger(rawValue, label) {
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }

  return Math.trunc(parsedValue);
}

function shellQuote(value) {
  return String(value).replaceAll("'", "'\"'\"'");
}

export function selectVramProfile(availableMiB, thresholdsMiB = VRAM_PROFILE_THRESHOLDS_MIB) {
  const normalizedAvailableMiB =
    Number.isFinite(availableMiB) && availableMiB > 0 ? Math.trunc(availableMiB) : 0;

  if (normalizedAvailableMiB >= thresholdsMiB.performance) {
    return 'performance';
  }

  if (normalizedAvailableMiB >= thresholdsMiB.balanced) {
    return 'balanced';
  }

  if (normalizedAvailableMiB >= thresholdsMiB.shared) {
    return 'shared';
  }

  return 'defer';
}

export function parseNvidiaSmiCsv(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, totalMiB, usedMiB, freeMiB] = line.split(',').map((value) => value.trim());

      return {
        index: readNonNegativeInteger(index, 'GPU index'),
        name,
        totalMiB: readNonNegativeInteger(totalMiB, 'GPU total memory'),
        usedMiB: readNonNegativeInteger(usedMiB, 'GPU used memory'),
        freeMiB: readNonNegativeInteger(freeMiB, 'GPU free memory'),
      };
    });
}

export function selectBestGpu(gpus) {
  const normalizedGpus = Array.isArray(gpus) ? gpus : [];
  if (normalizedGpus.length === 0) {
    return null;
  }

  return [...normalizedGpus].sort((left, right) => {
    if (right.freeMiB !== left.freeMiB) {
      return right.freeMiB - left.freeMiB;
    }

    return left.index - right.index;
  })[0];
}

export function buildProfileResult({
  gpus = [],
  source = 'unknown',
  error = null,
  thresholdsMiB = VRAM_PROFILE_THRESHOLDS_MIB,
} = {}) {
  const selectedGpu = selectBestGpu(gpus);
  const freeMiB = selectedGpu?.freeMiB ?? 0;
  const profile = selectVramProfile(freeMiB, thresholdsMiB);
  const runtimeConfig = PROFILE_RUNTIME_CONFIG[profile];
  const reason = buildProfileReason({ profile, freeMiB, thresholdsMiB, error });

  return {
    ok: error === null,
    profile,
    freeMiB,
    totalMiB: selectedGpu?.totalMiB ?? 0,
    maxSeqLength: runtimeConfig.maxSeqLength,
    vllmGpuMemoryUtilization: runtimeConfig.vllmGpuMemoryUtilization,
    vllmCpuOffloadGb: runtimeConfig.vllmCpuOffloadGb,
    trainingAllowed: runtimeConfig.trainingAllowed,
    servingAllowed: runtimeConfig.servingAllowed,
    reason,
    recommendedNextCommand: buildRecommendedNextCommand(profile),
    source,
    selectedGpu,
    thresholdsMiB,
    gpus,
    error,
  };
}

export function buildProfileReason({ profile, freeMiB, thresholdsMiB, error }) {
  if (error) {
    return `Unable to inspect NVIDIA GPU memory: ${error}`;
  }

  if (profile === 'performance') {
    return `Free VRAM ${freeMiB} MiB meets performance threshold ${thresholdsMiB.performance} MiB.`;
  }

  if (profile === 'balanced') {
    return `Free VRAM ${freeMiB} MiB meets balanced threshold ${thresholdsMiB.balanced} MiB.`;
  }

  if (profile === 'shared') {
    return `Free VRAM ${freeMiB} MiB meets shared threshold ${thresholdsMiB.shared} MiB; training is smoke-only unless explicitly overridden.`;
  }

  return `Free VRAM ${freeMiB} MiB is below shared threshold ${thresholdsMiB.shared} MiB; local GPT-OSS work is deferred.`;
}

export function buildRecommendedNextCommand(profile) {
  if (profile === 'defer') {
    return 'Close GPU-heavy applications or rerun with an explicit local override after reviewing memory pressure.';
  }

  return 'npm run gptoss:train:smoke:dry';
}

export function formatShellExports(result) {
  const selectedGpu = result.selectedGpu;
  const exports = {
    ARCANOS_GPTOSS_VRAM_PROFILE: result.profile,
    ARCANOS_GPTOSS_VRAM_FREE_MIB: result.freeMiB,
    ARCANOS_GPTOSS_VRAM_TOTAL_MIB: result.totalMiB,
    ARCANOS_GPTOSS_MAX_SEQ_LENGTH: result.maxSeqLength,
    ARCANOS_GPTOSS_VLLM_GPU_MEMORY_UTILIZATION: result.vllmGpuMemoryUtilization,
    ARCANOS_GPTOSS_VLLM_CPU_OFFLOAD_GB: result.vllmCpuOffloadGb,
    ARCANOS_GPTOSS_TRAINING_ALLOWED: result.trainingAllowed,
    ARCANOS_GPTOSS_SERVING_ALLOWED: result.servingAllowed,
    ARCANOS_GPTOSS_VRAM_SOURCE: result.source,
    ARCANOS_GPTOSS_GPU_INDEX: selectedGpu?.index ?? '',
    ARCANOS_GPTOSS_GPU_NAME: selectedGpu?.name ?? '',
  };

  return Object.entries(exports)
    .map(([key, value]) => `export ${key}='${shellQuote(value)}'`)
    .join('\n');
}

export function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--json') {
      config.format = 'json';
      continue;
    }

    if (flag === '--export') {
      config.format = 'export';
      continue;
    }

    if (flag === '--nvidia-smi' && typeof next === 'string' && next.trim().length > 0) {
      config.nvidiaSmiPath = next.trim();
      index += 1;
      continue;
    }

    if (flag === '--timeout-ms' && typeof next === 'string') {
      config.timeoutMs = readNonNegativeInteger(next, '--timeout-ms');
      index += 1;
      continue;
    }

    if (flag === '--mock-free-mib' && typeof next === 'string') {
      config.mockFreeMiB = readNonNegativeInteger(next, '--mock-free-mib');
      index += 1;
      continue;
    }

    if (flag === '--mock-total-mib' && typeof next === 'string') {
      config.mockTotalMiB = readNonNegativeInteger(next, '--mock-total-mib');
      index += 1;
      continue;
    }

    if (flag === '--mock-csv' && typeof next === 'string') {
      config.mockCsv = next;
      index += 1;
      continue;
    }

    if (flag === '--help' || flag === '-h') {
      config.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${flag}`);
  }

  return config;
}

export function buildMockGpus(config) {
  if (typeof config.mockCsv === 'string') {
    return parseNvidiaSmiCsv(config.mockCsv);
  }

  if (typeof config.mockFreeMiB === 'number') {
    const totalMiB =
      typeof config.mockTotalMiB === 'number'
        ? config.mockTotalMiB
        : Math.max(config.mockFreeMiB, 0);

    return [
      {
        index: 0,
        name: 'mock-gpu',
        totalMiB,
        usedMiB: Math.max(totalMiB - config.mockFreeMiB, 0),
        freeMiB: config.mockFreeMiB,
      },
    ];
  }

  return null;
}

export async function readNvidiaSmiGpus({
  nvidiaSmiPath = DEFAULT_CONFIG.nvidiaSmiPath,
  timeoutMs = DEFAULT_CONFIG.timeoutMs,
} = {}) {
  const { stdout } = await execFileAsync(
    nvidiaSmiPath,
    [
      '--query-gpu=index,name,memory.total,memory.used,memory.free',
      '--format=csv,noheader,nounits',
    ],
    { timeout: timeoutMs, windowsHide: true },
  );

  return parseNvidiaSmiCsv(stdout);
}

export async function resolveVramProfile(config = DEFAULT_CONFIG) {
  const mockGpus = buildMockGpus(config);
  if (mockGpus !== null) {
    return buildProfileResult({ gpus: mockGpus, source: 'mock' });
  }

  try {
    const gpus = await readNvidiaSmiGpus(config);
    return buildProfileResult({ gpus, source: 'nvidia-smi' });
  } catch (error) {
    return buildProfileResult({
      source: 'nvidia-smi',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function renderResult(result, format = DEFAULT_CONFIG.format) {
  if (format === 'export') {
    return `${formatShellExports(result)}\n`;
  }

  return `${JSON.stringify(result, null, 2)}\n`;
}

function usage() {
  return [
    'Usage: node scripts/gptoss/vram-profile.mjs [--json|--export] [--mock-free-mib N] [--mock-total-mib N]',
    '',
    'Options:',
    '  --json                 Print deterministic JSON output (default).',
    '  --export               Print POSIX shell export statements.',
    '  --mock-free-mib N      Use dry-run free VRAM instead of nvidia-smi.',
    '  --mock-total-mib N     Use dry-run total VRAM with --mock-free-mib.',
    '  --mock-csv CSV         Parse mock nvidia-smi CSV rows.',
    '  --nvidia-smi PATH      Override nvidia-smi executable path.',
    '  --timeout-ms N         Live nvidia-smi timeout in milliseconds.',
  ].join('\n');
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const result = await resolveVramProfile(config);
  process.stdout.write(renderResult(result, config.format));

  if (!result.ok) {
    process.exitCode = 2;
    return;
  }

  if (result.profile === 'defer') {
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
