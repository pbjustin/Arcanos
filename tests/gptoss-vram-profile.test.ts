import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildProfileResult,
  parseNvidiaSmiCsv,
  resolveVramProfile,
  selectBestGpu,
  selectVramProfile,
} from '../scripts/gptoss/vram-profile.mjs';

const scriptPath = join(process.cwd(), 'scripts', 'gptoss', 'vram-profile.mjs');

describe('gptoss VRAM profile selection', () => {
  it('selects profile boundaries from available VRAM MiB', () => {
    expect(selectVramProfile(16000)).toBe('performance');
    expect(selectVramProfile(14500)).toBe('performance');
    expect(selectVramProfile(14499)).toBe('balanced');
    expect(selectVramProfile(12500)).toBe('balanced');
    expect(selectVramProfile(12499)).toBe('shared');
    expect(selectVramProfile(10500)).toBe('shared');
    expect(selectVramProfile(10499)).toBe('defer');
  });

  it('chooses the GPU with most free VRAM and breaks ties by lower index', () => {
    const selected = selectBestGpu([
      { index: 2, name: 'later', totalMiB: 24_576, usedMiB: 16_384, freeMiB: 8_192 },
      { index: 1, name: 'tie-winner', totalMiB: 24_576, usedMiB: 8_192, freeMiB: 16_384 },
      { index: 3, name: 'tie-loser', totalMiB: 24_576, usedMiB: 8_192, freeMiB: 16_384 },
    ]);

    expect(selected).toMatchObject({ index: 1, name: 'tie-winner', freeMiB: 16_384 });
  });

  it('parses nvidia-smi CSV rows and rejects malformed memory values', () => {
    expect(parseNvidiaSmiCsv('0, RTX 4090, 24576, 1024, 23552\n')).toEqual([
      {
        index: 0,
        name: 'RTX 4090',
        totalMiB: 24_576,
        usedMiB: 1_024,
        freeMiB: 23_552,
      },
    ]);

    expect(() => parseNvidiaSmiCsv('0, RTX 4090, not-a-number, 1024, 23552')).toThrow(
      /GPU total memory/,
    );
  });

  it('returns a defer profile when nvidia-smi is missing', async () => {
    const result = await resolveVramProfile({
      nvidiaSmiPath: 'definitely-missing-nvidia-smi-for-arcanos-tests',
      timeoutMs: 50,
    });

    expect(result).toMatchObject({
      ok: false,
      profile: 'defer',
      source: 'nvidia-smi',
      freeMiB: 0,
      totalMiB: 0,
      selectedGpu: null,
    });
    expect(typeof result.error).toBe('string');
    expect(result.error).not.toHaveLength(0);
  });

  it('builds the deterministic JSON result shape', () => {
    const result = buildProfileResult({
      source: 'mock',
      gpus: [{ index: 0, name: 'mock-gpu', totalMiB: 24_576, usedMiB: 576, freeMiB: 24_000 }],
    });

    expect(Object.keys(result)).toEqual([
      'ok',
      'profile',
      'freeMiB',
      'totalMiB',
      'maxSeqLength',
      'vllmGpuMemoryUtilization',
      'vllmCpuOffloadGb',
      'trainingAllowed',
      'servingAllowed',
      'reason',
      'recommendedNextCommand',
      'source',
      'selectedGpu',
      'thresholdsMiB',
      'gpus',
      'error',
    ]);
    expect(result).toMatchObject({
      ok: true,
      profile: 'performance',
      freeMiB: 24_000,
      source: 'mock',
      totalMiB: 24_576,
      maxSeqLength: 2048,
      vllmGpuMemoryUtilization: 0.9,
      vllmCpuOffloadGb: 0,
      trainingAllowed: true,
      servingAllowed: true,
      error: null,
    });
  });

  it('prints JSON from the CLI with mock VRAM input', () => {
    const completed = spawnSync(
      process.execPath,
      [scriptPath, '--json', '--mock-free-mib', '24576', '--mock-total-mib', '32768'],
      { encoding: 'utf8' },
    );

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');

    const parsed = JSON.parse(completed.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      profile: 'performance',
      source: 'mock',
      freeMiB: 24_576,
      totalMiB: 32_768,
      maxSeqLength: 2048,
      vllmGpuMemoryUtilization: 0.9,
      vllmCpuOffloadGb: 0,
      trainingAllowed: true,
      selectedGpu: {
        index: 0,
        name: 'mock-gpu',
        totalMiB: 32_768,
        usedMiB: 8_192,
        freeMiB: 24_576,
      },
      error: null,
    });
  });

  it('returns JSON when live nvidia-smi lookup fails', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-gptoss-vram-'));
    const missingPath = join(tempDir, 'missing-nvidia-smi');

    try {
      const completed = spawnSync(
        process.execPath,
        [scriptPath, '--json', '--nvidia-smi', missingPath, '--timeout-ms', '50'],
        { encoding: 'utf8' },
      );

      expect(completed.status).toBe(2);
      expect(completed.stderr).toBe('');

      const parsed = JSON.parse(completed.stdout);
      expect(parsed).toMatchObject({
        ok: false,
        profile: 'defer',
        source: 'nvidia-smi',
        freeMiB: 0,
        totalMiB: 0,
        trainingAllowed: false,
        servingAllowed: false,
        selectedGpu: null,
      });
      expect(typeof parsed.error).toBe('string');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
