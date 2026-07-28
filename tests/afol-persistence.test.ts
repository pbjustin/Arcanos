import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import {
  configureAnalytics,
  getAnalyticsSnapshot,
  persistDecision,
  resetAnalytics,
} from '../src/core/afol/analytics.js';
import {
  clearLogs,
  configureLogger,
  getRecent,
  logDecision,
  logError,
  resetLogger,
} from '../src/core/afol/logger.js';
import {
  clampAfolPersistenceRecordLimit,
  projectAfolDecisionForPersistence,
  readUtf8Tail,
  resolveSafePersistenceTarget,
} from '../src/core/afol/persistence.js';
import type {
  AfolPersistedDecisionRecord,
  DecisionRecord,
  RouteName,
} from '../src/core/afol/types.js';

function buildDecision(
  sequence: number,
  options: {
    route?: RouteName;
    ok?: boolean;
    secret?: string;
  } = {}
): DecisionRecord {
  const route = options.route ?? 'primary';
  const secret = options.secret ?? `secret-${sequence}`;
  return {
    id: `afol-${sequence}`,
    ok: options.ok ?? true,
    policy: {
      allow: true,
      primaryAvailable: true,
      backupAvailable: false,
      rationale: `private rationale ${secret}`,
    },
    route: {
      name: route,
      reason: `private reason ${secret}`,
    },
    response: {
      route,
      input: `private prompt ${secret}`,
      output: `private completion ${secret}`,
      model: 'private-model',
      cached: sequence % 2 === 0,
      ...(options.ok === false
        ? { error: `provider error ${secret}` }
        : {}),
      metadata: {
        intent: `private intent ${secret}`,
        degraded: options.ok === false,
        nested: { secret },
      },
    },
    meta: {
      latencyMs: sequence * 10,
      timestamp: `2026-07-27T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    },
  };
}

describe('AFOL metadata-only persistence', () => {
  let temporaryDirectory: string;
  let analyticsPath: string;
  let logPath: string;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'arcanos-afol-persistence-')
    );
    analyticsPath = path.join(temporaryDirectory, 'analytics.json');
    logPath = path.join(temporaryDirectory, 'decisions.jsonl');
    await configureAnalytics({
      filePath: analyticsPath,
      recentLimit: 50,
    });
    await resetAnalytics();
    await configureLogger({
      filePath: logPath,
      retentionLimit: 100,
      tailBytes: 512 * 1_024,
    });
    await clearLogs();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('persists the same strict projection without prompts, outputs, intents, or errors', async () => {
    const sentinel = 'persisted-secret-sentinel';
    const projected = projectAfolDecisionForPersistence(
      buildDecision(1, { ok: false, secret: sentinel })
    );

    await expect(persistDecision(projected)).resolves.toBe(true);
    await expect(logDecision(projected)).resolves.toBe(true);

    const analyticsRaw = await fs.readFile(analyticsPath, 'utf8');
    const logRaw = await fs.readFile(logPath, 'utf8');
    const analytics = JSON.parse(analyticsRaw) as {
      recent: AfolPersistedDecisionRecord[];
    };

    expect(analytics.recent).toEqual([projected]);
    expect(JSON.parse(logRaw.trim())).toEqual(projected);
    for (const raw of [analyticsRaw, logRaw]) {
      expect(raw).not.toContain(sentinel);
      expect(raw).not.toContain('"input"');
      expect(raw).not.toContain('"output"');
      expect(raw).not.toContain('"intent"');
      expect(raw).not.toContain('"error"');
      expect(raw).not.toContain('"policy"');
      expect(raw).not.toContain('"metadata"');
    }

    const leftovers = (await fs.readdir(temporaryDirectory))
      .filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);

    if (process.platform !== 'win32') {
      const stats = await fs.stat(logPath);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('serializes concurrent writes and enforces configured retention', async () => {
    await configureAnalytics({
      filePath: analyticsPath,
      recentLimit: 2,
    });
    await configureLogger({
      filePath: logPath,
      retentionLimit: 2,
      tailBytes: 1_024,
    });
    const records = Array.from(
      { length: 5 },
      (_, index) => projectAfolDecisionForPersistence(
        buildDecision(index + 1)
      )
    );

    await Promise.all(records.map((record) => persistDecision(record)));
    await Promise.all(records.map((record) => logDecision(record)));

    const snapshot = await getAnalyticsSnapshot();
    const recentLogs = await getRecent(100);
    expect(snapshot.totals.decisions).toBe(5);
    expect(snapshot.recent.map((record) => record.id)).toEqual([
      'afol-4',
      'afol-5',
    ]);
    expect(recentLogs.map((record) => (
      record.kind === 'decision' ? record.id : record.kind
    ))).toEqual(['afol-4', 'afol-5']);
  });

  it('clamps zero retention to one and records only fixed error categories', async () => {
    const sentinel = 'raw-error-message-sentinel';
    await configureAnalytics({
      filePath: analyticsPath,
      recentLimit: 0,
    });
    await resetAnalytics();
    await configureLogger({
      filePath: logPath,
      retentionLimit: 0,
      tailBytes: 1_024,
    });
    await clearLogs();
    const first = projectAfolDecisionForPersistence(buildDecision(1));
    const second = projectAfolDecisionForPersistence(buildDecision(2));

    await persistDecision(first);
    await persistDecision(second);
    await logDecision(first);
    await logError(
      `attacker-controlled-context-${sentinel}`,
      new Error(sentinel)
    );

    expect((await getAnalyticsSnapshot()).recent).toEqual([second]);
    expect(await getRecent(10)).toEqual([{
      kind: 'error',
      timestamp: expect.any(String),
      category: 'internal_failure',
    }]);
    const rawLog = await fs.readFile(logPath, 'utf8');
    expect(rawLog).not.toContain(sentinel);
    expect(rawLog).not.toContain('attacker-controlled');
    expect(rawLog).not.toContain('"context"');
    expect(rawLog).not.toContain('"error":');
  });

  it('clamps analytics and log record limits at both documented bounds', () => {
    expect(clampAfolPersistenceRecordLimit(0, 50)).toBe(1);
    expect(clampAfolPersistenceRecordLimit(1_001, 50)).toBe(1_000);
    expect(clampAfolPersistenceRecordLimit(Number.NaN, 50)).toBe(50);
  });

  it('leaves both the old analytics file and memory state unchanged when replacement fails', async () => {
    const first = projectAfolDecisionForPersistence(buildDecision(1));
    const second = projectAfolDecisionForPersistence(buildDecision(2));
    await expect(persistDecision(first)).resolves.toBe(true);
    const beforeFile = await fs.readFile(analyticsPath, 'utf8');
    const beforeState = await getAnalyticsSnapshot();

    jest.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('sentinel rename failure'), {
        code: 'EACCES',
      })
    );

    await expect(persistDecision(second)).resolves.toBe(false);
    expect(await fs.readFile(analyticsPath, 'utf8')).toBe(beforeFile);
    expect(await getAnalyticsSnapshot()).toEqual(beforeState);
    expect(
      (await fs.readdir(temporaryDirectory))
        .filter((name) => name.endsWith('.tmp'))
    ).toEqual([]);
  });

  it('bounds log reads, skips malformed lines, and reprojects legacy records', async () => {
    const sentinel = 'legacy-secret-sentinel';
    const legacyDecision = {
      timestamp: '2026-07-27T12:00:01.000Z',
      input: `legacy prompt ${sentinel}`,
      decision: buildDecision(1, { secret: sentinel }),
    };
    const legacyError = {
      timestamp: '2026-07-27T12:00:02.000Z',
      context: 'decide',
      error: `legacy provider failure ${sentinel}`,
    };
    await fs.writeFile(
      logPath,
      [
        sentinel.repeat(200),
        '{malformed',
        JSON.stringify(legacyDecision),
        JSON.stringify(legacyError),
        '',
      ].join('\n'),
      'utf8'
    );
    await configureLogger({
      filePath: logPath,
      retentionLimit: 5,
      tailBytes: 1_024,
    });

    const openSpy = jest.spyOn(fs, 'open');
    await expect(getRecent(0)).resolves.toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();

    const readFileSpy = jest.spyOn(fs, 'readFile');
    const recent = await getRecent(5);
    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();

    expect(recent).toEqual([
      projectAfolDecisionForPersistence(buildDecision(1, {
        secret: sentinel,
      })),
      {
        kind: 'error',
        timestamp: '2026-07-27T12:00:02.000Z',
        category: 'decision_failed',
      },
    ]);

    await logDecision(projectAfolDecisionForPersistence(buildDecision(2)));
    const rewritten = await fs.readFile(logPath, 'utf8');
    expect(rewritten).not.toContain(sentinel);
    expect(rewritten).not.toContain('malformed');
    expect(rewritten).not.toContain('"context"');
    expect(rewritten).not.toContain('"error":');
  });

  it('orders configure and reset behind prior writes while keeping module queues independent', async () => {
    const secondLogPath = path.join(
      temporaryDirectory,
      'second-decisions.jsonl'
    );
    const originalRename = fs.rename.bind(fs);
    let releaseLogRename = (): void => {};
    const logRenameGate = new Promise<void>((resolve) => {
      releaseLogRename = resolve;
    });
    let gateLogRename = true;
    jest.spyOn(fs, 'rename').mockImplementation(
      async (source, destination) => {
        if (
          gateLogRename &&
          path.resolve(destination.toString()) === path.resolve(logPath)
        ) {
          await logRenameGate;
        }
        return originalRename(source, destination);
      }
    );

    const firstLog = logDecision(
      projectAfolDecisionForPersistence(buildDecision(1))
    );
    let configureSettled = false;
    const configure = configureLogger({
      filePath: secondLogPath,
      retentionLimit: 100,
    }).then(() => {
      configureSettled = true;
    });
    const secondLog = logDecision(
      projectAfolDecisionForPersistence(buildDecision(2))
    );

    const analyticsWrite = persistDecision(
      projectAfolDecisionForPersistence(buildDecision(3))
    );
    await expect(analyticsWrite).resolves.toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(configureSettled).toBe(false);

    gateLogRename = false;
    releaseLogRename();
    await Promise.all([firstLog, configure, secondLog]);
    expect(await fs.readFile(logPath, 'utf8')).toContain('"id":"afol-1"');
    expect(await fs.readFile(secondLogPath, 'utf8')).toContain(
      '"id":"afol-2"'
    );

    const resetGate = new Promise<void>((resolve) => {
      releaseLogRename = resolve;
    });
    let gateAnalyticsRename = true;
    jest.spyOn(fs, 'rename').mockRestore();
    jest.spyOn(fs, 'rename').mockImplementation(
      async (source, destination) => {
        if (
          gateAnalyticsRename &&
          path.resolve(destination.toString()) ===
            path.resolve(analyticsPath)
        ) {
          await resetGate;
        }
        return originalRename(source, destination);
      }
    );
    const pendingAnalyticsWrite = persistDecision(
      projectAfolDecisionForPersistence(buildDecision(4))
    );
    let resetSettled = false;
    const pendingReset = resetAnalytics().then((result) => {
      resetSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resetSettled).toBe(false);
    gateAnalyticsRename = false;
    releaseLogRename();
    await expect(pendingAnalyticsWrite).resolves.toBe(true);
    await expect(pendingReset).resolves.toBe(true);
    expect((await getAnalyticsSnapshot()).totals.decisions).toBe(0);
    expect(
      (JSON.parse(await fs.readFile(analyticsPath, 'utf8')) as {
        totals: { decisions: number };
      }).totals.decisions
    ).toBe(0);
  });

  it('orders analytics configure and logger reset behind their prior writes', async () => {
    const secondAnalyticsPath = path.join(
      temporaryDirectory,
      'second-analytics.json'
    );
    const originalRename = fs.rename.bind(fs);
    let releaseRename = (): void => {};
    const analyticsGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let gateAnalyticsRename = true;
    const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(
      async (source, destination) => {
        if (
          gateAnalyticsRename &&
          path.resolve(destination.toString()) ===
            path.resolve(analyticsPath)
        ) {
          await analyticsGate;
        }
        return originalRename(source, destination);
      }
    );

    const firstAnalyticsWrite = persistDecision(
      projectAfolDecisionForPersistence(buildDecision(1))
    );
    let configureSettled = false;
    const pendingConfigure = configureAnalytics({
      filePath: secondAnalyticsPath,
      recentLimit: 50,
    }).then(() => {
      configureSettled = true;
    });
    const secondAnalyticsWrite = persistDecision(
      projectAfolDecisionForPersistence(buildDecision(2))
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(configureSettled).toBe(false);
    gateAnalyticsRename = false;
    releaseRename();
    await Promise.all([
      firstAnalyticsWrite,
      pendingConfigure,
      secondAnalyticsWrite,
    ]);
    expect(await fs.readFile(analyticsPath, 'utf8')).toContain(
      '"id": "afol-1"'
    );
    expect(await fs.readFile(analyticsPath, 'utf8')).not.toContain(
      '"id": "afol-2"'
    );
    expect(await fs.readFile(secondAnalyticsPath, 'utf8')).toContain(
      '"id": "afol-2"'
    );
    renameSpy.mockRestore();

    const loggerGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    let gateLoggerRename = true;
    jest.spyOn(fs, 'rename').mockImplementation(
      async (source, destination) => {
        if (
          gateLoggerRename &&
          path.resolve(destination.toString()) === path.resolve(logPath)
        ) {
          await loggerGate;
        }
        return originalRename(source, destination);
      }
    );
    const pendingLogWrite = logDecision(
      projectAfolDecisionForPersistence(buildDecision(3))
    );
    let resetSettled = false;
    const pendingLoggerReset = resetLogger().then(() => {
      resetSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resetSettled).toBe(false);
    gateLoggerRename = false;
    releaseRename();
    await Promise.all([pendingLogWrite, pendingLoggerReset]);
    await configureLogger({
      filePath: logPath,
      retentionLimit: 100,
      tailBytes: 512 * 1_024,
    });
  });

  it('rejects unsafe targets and detects a target swap before reading bytes', async () => {
    await expect(
      resolveSafePersistenceTarget(path.parse(temporaryDirectory).root, {
        createParent: true,
      })
    ).rejects.toThrow('unsafe');

    const directoryTarget = path.join(temporaryDirectory, 'directory-target');
    await fs.mkdir(directoryTarget);
    await expect(
      resolveSafePersistenceTarget(directoryTarget)
    ).rejects.toThrow('unsafe');

    const symlinkSource = path.join(temporaryDirectory, 'symlink-source.jsonl');
    const symlinkTarget = path.join(temporaryDirectory, 'symlink-target.jsonl');
    await fs.writeFile(symlinkSource, 'safe source\n', 'utf8');
    let symlinkCreated = false;
    try {
      await fs.symlink(symlinkSource, symlinkTarget, 'file');
      symlinkCreated = true;
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    }
    if (symlinkCreated) {
      await expect(
        resolveSafePersistenceTarget(symlinkTarget)
      ).rejects.toThrow('unsafe');
    }

    const safeTarget = path.join(temporaryDirectory, 'race.jsonl');
    const originalTarget = path.join(temporaryDirectory, 'race-original.jsonl');
    const replacement = path.join(temporaryDirectory, 'race-replacement.jsonl');
    await fs.writeFile(safeTarget, '{"kind":"error"}\n', 'utf8');
    await fs.writeFile(
      replacement,
      'target-swap-secret-sentinel\n',
      'utf8'
    );
    const originalOpen = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementationOnce(
      async (filePath, flags, mode) => {
        await fs.rename(safeTarget, originalTarget);
        await fs.rename(replacement, safeTarget);
        return originalOpen(filePath, flags, mode);
      }
    );

    await expect(readUtf8Tail(safeTarget, 1_024)).rejects.toThrow('unsafe');
  });
});
