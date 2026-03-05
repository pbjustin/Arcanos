import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { EvidencePack } from '../src/services/governance/evidencePack.js';

let activeConfig = {
  selfImproveEvidenceDir: '',
  selfImprovePiiScrubEnabled: false,
  selfImproveRetentionDays: 1
};

const scrubForStorageMock = jest.fn(async (value: unknown) => value);
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => activeConfig
}));

jest.unstable_mockModule('@services/privacy/piiScrubber.js', () => ({
  scrubForStorage: scrubForStorageMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    warn: loggerWarnMock
  }
}));

const evidencePackModule = await import('../src/services/governance/evidencePack.js');

function createPack(id: string, createdAt: string): EvidencePack {
  return {
    id,
    createdAt,
    environment: 'development',
    autonomyLevel: 1,
    decision: 'PATCH_PROPOSAL',
    trigger: 'manual',
    context: { key: 'value' },
    evaluator: { score: 1 },
    actions: { proposed: true },
    rollback: { attempted: false },
    errors: { count: 0 }
  };
}

describe('services/governance/evidencePack', () => {
  let tempDir: string;

  beforeEach(async () => {
    scrubForStorageMock.mockClear();
    loggerWarnMock.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arcanos-evidence-'));
    activeConfig = {
      selfImproveEvidenceDir: tempDir,
      selfImprovePiiScrubEnabled: false,
      selfImproveRetentionDays: 1
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes evidence packs and prunes expired files', async () => {
    const expiredPath = path.join(tempDir, 'expired.json');
    await fs.writeFile(expiredPath, '{"expired":true}', 'utf8');
    const oldTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000);
    await fs.utimes(expiredPath, new Date(oldTimestamp), new Date(oldTimestamp));

    const outPath = await evidencePackModule.writeEvidencePack(
      createPack('cycle-1', '2026-03-05T12:00:00.000Z')
    );

    const outRaw = await fs.readFile(outPath, 'utf8');
    const outJson = JSON.parse(outRaw);
    const expiredExists = await fs.stat(expiredPath).then(() => true).catch(() => false);

    expect(outPath.startsWith(tempDir)).toBe(true);
    expect(outJson.id).toBe('cycle-1');
    expect(outJson.actions).toEqual({ proposed: true });
    expect(expiredExists).toBe(false);
    expect(scrubForStorageMock).toHaveBeenCalledTimes(5);
  });

  it('returns cleanly when prune target directory is missing', async () => {
    await expect(
      evidencePackModule.pruneEvidencePacks(path.join(tempDir, 'missing-folder'), 1)
    ).resolves.toBeUndefined();
  });
});
