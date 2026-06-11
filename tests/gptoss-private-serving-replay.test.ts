import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const scaffoldDir = join(process.cwd(), 'scripts', 'gptoss', 'private-serving');
const replayScript = join(scaffoldDir, 'private-serving-replay-protection.mjs');
const replayValidateScript = join(scaffoldDir, 'private-serving-replay-validate.mjs');
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');

const now = Date.parse('2026-06-06T12:00:00.000Z');
const timestamp = new Date(now).toISOString();
const bodyHash = 'a'.repeat(64);

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    keyId: 'phase5-replay-test-key',
    nonce: 'nonceReplayTest01',
    timestamp,
    requestId: 'phase5-4-replay-test',
    bodyHash,
    ...overrides,
  };
}

async function replayModule() {
  return await import(pathToFileURL(replayScript).href) as {
    createInMemoryReplayStore: (options?: Record<string, unknown>) => Record<string, unknown>;
    createReplayProtectionPolicy: (options?: Record<string, unknown>) => Record<string, unknown>;
    checkReplayProtection: (
      record: Record<string, unknown>,
      store: Record<string, unknown> | undefined,
      policy?: Record<string, unknown>,
    ) => Record<string, unknown>;
    pruneExpiredReplayEntries: (
      store: Record<string, unknown>,
      now: number,
      policy?: Record<string, unknown>,
    ) => Record<string, unknown>;
    getReplayStoreStats: (store: Record<string, unknown>) => Record<string, unknown>;
  };
}

describe('gptoss private serving replay protection', () => {
  it('accepts first nonce, rejects duplicate, and scopes nonce to key id', async () => {
    const replay = await replayModule();
    const store = replay.createInMemoryReplayStore();
    const policy = replay.createReplayProtectionPolicy({
      now,
      replayWindowSeconds: 300,
      maxFutureSkewSeconds: 60,
    });

    expect(replay.checkReplayProtection(record(), store, policy)).toMatchObject({
      ok: true,
      replayAccepted: true,
      implemented: true,
      keyId: 'phase5-replay-test-key',
      nonce: 'nonceReplayTest01',
      requestId: 'phase5-4-replay-test',
      bodyHash,
      recorded: true,
      denialReason: null,
    });
    expect(replay.checkReplayProtection(record(), store, policy)).toMatchObject({
      ok: false,
      replayAccepted: false,
      denialReason: 'replay_detected',
      recorded: false,
    });
    expect(replay.checkReplayProtection(record({
      keyId: 'phase5-replay-second-key',
      requestId: 'phase5-4-replay-second-key',
    }), store, policy)).toMatchObject({
      ok: true,
      replayAccepted: true,
      keyId: 'phase5-replay-second-key',
      nonce: 'nonceReplayTest01',
      recorded: true,
    });
  });

  it('rejects stale, future, invalid nonce, missing key, and unavailable store cases', async () => {
    const replay = await replayModule();
    const store = replay.createInMemoryReplayStore();
    const policy = replay.createReplayProtectionPolicy({
      now,
      replayWindowSeconds: 300,
      maxFutureSkewSeconds: 60,
    });

    expect(replay.checkReplayProtection(record({
      nonce: 'nonceReplayStale01',
      timestamp: new Date(now - 301000).toISOString(),
    }), store, policy)).toMatchObject({
      ok: false,
      denialReason: 'stale_timestamp',
    });
    expect(replay.checkReplayProtection(record({
      nonce: 'nonceReplayFuture01',
      timestamp: new Date(now + 61000).toISOString(),
    }), store, policy)).toMatchObject({
      ok: false,
      denialReason: 'future_timestamp',
    });
    expect(replay.checkReplayProtection(record({
      nonce: 'short',
    }), store, policy)).toMatchObject({
      ok: false,
      denialReason: 'invalid_nonce',
    });
    expect(replay.checkReplayProtection(record({
      keyId: '',
      nonce: 'nonceReplayNoKey01',
    }), store, policy)).toMatchObject({
      ok: false,
      denialReason: 'missing_key_id',
    });
    expect(replay.checkReplayProtection(record({
      nonce: 'nonceReplayNoStore',
    }), undefined, policy)).toMatchObject({
      ok: false,
      denialReason: 'replay_store_unavailable',
    });
  });

  it('prunes expired entries and reports deterministic store stats', async () => {
    const replay = await replayModule();
    const store = replay.createInMemoryReplayStore();
    const policy = replay.createReplayProtectionPolicy({
      now,
      replayWindowSeconds: 300,
      maxFutureSkewSeconds: 60,
    });

    replay.checkReplayProtection(record({
      nonce: 'nonceReplayStats01',
      timestamp: new Date(now - 290000).toISOString(),
    }), store, policy);
    replay.checkReplayProtection(record({
      keyId: 'phase5-replay-stats-key-b',
      nonce: 'nonceReplayStats02',
    }), store, policy);

    expect(replay.getReplayStoreStats(store)).toMatchObject({
      implemented: true,
      durable: false,
      available: true,
      entries: 2,
      keyIds: ['phase5-replay-stats-key-b', 'phase5-replay-test-key'],
      nonces: ['nonceReplayStats01', 'nonceReplayStats02'],
    });

    expect(replay.pruneExpiredReplayEntries(store, now + 12000, policy)).toMatchObject({
      ok: true,
      implemented: true,
      pruned: 1,
      denialReason: null,
    });
    expect(replay.getReplayStoreStats(store)).toMatchObject({
      entries: 1,
      keyIds: ['phase5-replay-stats-key-b'],
      nonces: ['nonceReplayStats02'],
    });
  });

  it('emits replay validation and readiness reports without external paths', () => {
    const replayReport = runNode(replayValidateScript, ['--no-write']);
    const readiness = runNode(readinessScript, ['--no-write']);
    const parsedReplay = JSON.parse(replayReport.stdout);
    const parsedReadiness = JSON.parse(readiness.stdout);
    const source = [
      replayScript,
      replayValidateScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(replayReport.status).toBe(0);
    expect(readiness.status).toBe(0);
    expect(parsedReplay).toMatchObject({
      ok: true,
      requestSigningImplemented: true,
      authBoundaryImplemented: true,
      replayProtectionImplemented: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      publicServerCreated: false,
      cloudReady: false,
      customGptReady: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      serverCreated: false,
    });
    expect(parsedReplay.replayProtectionDecision).toMatchObject({
      ok: true,
      replayAccepted: true,
      implemented: true,
      recorded: true,
      denialReason: null,
    });
    expect(parsedReadiness).toMatchObject({
      replayProtectionImplemented: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(source).not.toMatch(/api\.openai\.com|responses\.create|vllm\s+serve|\brailway\s+/i);
    expect(source).not.toMatch(/child_process|spawnSync|execSync|\btrain\b|fine-tune|finetune/i);
  });
});
