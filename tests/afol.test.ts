import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { decide } from '../src/afol/engine.js';
import { evaluate } from '../src/afol/policies.js';
import { getStatus, resetHealth, simulateFailure } from '../src/afol/health.js';
import { clearLogs, configureLogger, getRecent, logError, resetLogger } from '../src/afol/logger.js';

function createTempLogPath(): string {
  const uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `afol-${uniqueId}.log`);
}

describe('AFOL engine orchestration', () => {
  let tempLogPath: string;

  beforeEach(() => {
    resetHealth();
    tempLogPath = createTempLogPath();
    configureLogger({ filePath: tempLogPath });
    clearLogs();
  });

  afterEach(() => {
    clearLogs();
    resetLogger();
    if (tempLogPath && fs.existsSync(tempLogPath)) {
      fs.unlinkSync(tempLogPath);
    }
  });

  test('decide uses primary route when services are healthy', async () => {
    const decision = await decide({ intent: 'ingest' });

    expect(decision.ok).toBe(true);
    expect(decision.route.name).toBe('primary');
    expect(decision.policy.primaryAvailable).toBe(true);
    expect(decision.policy.backupAvailable).toBe(true);
  });

  test('decide falls back to backup when primary services fail', async () => {
    simulateFailure('redis');
    const decision = await decide({ intent: 'ingest' });

    expect(decision.ok).toBe(true);
    expect(decision.route.name).toBe('backup');
    expect(decision.policy.primaryAvailable).toBe(false);
    expect(decision.policy.backupAvailable).toBe(true);
  });

  test('decide rejects when no services are available', async () => {
    simulateFailure('redis');
    simulateFailure('api');
    simulateFailure('postgres');

    const decision = await decide({ intent: 'ingest' });

    expect(decision.ok).toBe(false);
    expect(decision.route.name).toBe('reject');
    expect(decision.policy.backupAvailable).toBe(false);
  });

  test('logs decisions and exposes recent entries', async () => {
    await decide({ intent: 'sync' });
    const logs = getRecent();

    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1]?.decision?.route.name).toBeDefined();
  });

  test('policies evaluate snapshot consistently', () => {
    const healthySnapshot = getStatus();
    const policy = evaluate(healthySnapshot, 'ingest');

    expect(policy.allow).toBe(true);
    expect(policy.primaryAvailable).toBe(true);
    expect(policy.rationale).toBe('Primary path stable');
  });

  test('error logging captures context', () => {
    logError('test-context', new Error('failure'));
    const logs = getRecent();
    const lastEntry = logs[logs.length - 1];

    expect(lastEntry?.context).toBe('test-context');
    expect(lastEntry?.error).toBe('failure');
  });
});
