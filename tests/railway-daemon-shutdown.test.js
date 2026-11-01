import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeCliBridgeDaemon } from '../scripts/start-railway-service.mjs';

describe('Railway CLI daemon shutdown logging', () => {
  let daemon;
  let log;
  let error;

  beforeEach(() => {
    daemon = new EventEmitter();
    daemon.kill = jest.fn(() => true);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(['SIGTERM', 'SIGINT'])('logs a forwarded %s exit at informational severity', (signal) => {
    const shutdown = observeCliBridgeDaemon(daemon);
    shutdown(signal);
    shutdown(signal);
    daemon.emit('exit', null, signal);

    expect(daemon.kill).toHaveBeenCalledTimes(1);
    expect(daemon.kill).toHaveBeenCalledWith(signal);
    expect(log).toHaveBeenCalledWith('[railway-launcher] daemon.stopped', expect.any(String));
    expect(JSON.parse(log.mock.calls[0][1])).toEqual({
      module: 'railway-launcher', reason: `signal_${signal}`, restartPolicy: 'no-restart'
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('recognizes a clean daemon drain after forwarded shutdown', () => {
    const shutdown = observeCliBridgeDaemon(daemon);
    shutdown('SIGTERM');
    daemon.emit('exit', 0, null);

    expect(log).toHaveBeenCalledWith('[railway-launcher] daemon.stopped', expect.any(String));
    expect(error).not.toHaveBeenCalled();
  });

  it.each([[null, 'SIGTERM'], [null, 'SIGINT'], [null, 'SIGKILL'], [0, null], [1, null]])(
    'keeps unexpected daemon exit code=%s signal=%s at error severity', (code, signal) => {
      observeCliBridgeDaemon(daemon);
      daemon.emit('exit', code, signal);

      expect(error).toHaveBeenCalledWith('[railway-launcher] daemon.unreachable', expect.any(String));
      expect(log).not.toHaveBeenCalled();
    }
  );

  it.each([[null, 'SIGKILL'], [null, 'SIGINT'], [1, null]])(
    'keeps abnormal code=%s signal=%s after requested SIGTERM at error severity', (code, signal) => {
      const shutdown = observeCliBridgeDaemon(daemon);
      shutdown('SIGTERM');
      daemon.emit('exit', code, signal);

      expect(error).toHaveBeenCalledWith('[railway-launcher] daemon.unreachable', expect.any(String));
      expect(log).not.toHaveBeenCalled();
    }
  );

  it('does not claim a shutdown was intentional when forwarding failed', () => {
    daemon.kill.mockReturnValue(false);
    const shutdown = observeCliBridgeDaemon(daemon);
    shutdown('SIGTERM');
    daemon.emit('exit', null, 'SIGTERM');

    expect(error).toHaveBeenCalledWith('[railway-launcher] daemon.unreachable', expect.any(String));
    expect(log).not.toHaveBeenCalled();
  });

  it('retains spawn failures even after shutdown intent and omits raw error text', () => {
    const shutdown = observeCliBridgeDaemon(daemon);
    shutdown('SIGTERM');
    daemon.emit('error', new Error('sensitive command or configuration detail'));

    expect(error).toHaveBeenCalledWith('[railway-launcher] daemon.unreachable', JSON.stringify({
      module: 'railway-launcher', reason: 'spawn_error', errorType: 'Error'
    }));
    expect(log).not.toHaveBeenCalled();
  });

  it('exercises the actual launcher entry with native disposable children and preserves error outcomes', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/railway-launcher-process.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [fixturePath, 'run'], {
      env: {}, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024
    });
    expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
      .toEqual({ error: undefined, status: 0, stderr: '' });
    const scenarios = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(scenarios.map(row => row.scenario)).toEqual([
      'SIGTERM', 'SIGINT', 'unexpected-exit', 'spawn-failure', 'failed-forward'
    ]);
    for (const row of scenarios) {
      expect(row.launcherExitCode).toBe(0);
      expect(row.remainingFixtureChildren).toBe(0);
      expect(row.daemonSeverity).toBe(row.scenario.startsWith('SIG') ? 'info' : 'error');
      expect(row.nativeChildren).toBe(row.scenario === 'spawn-failure' ? 1 : 2);
      expect(row.signalDelivery).toBe(process.platform === 'win32'
        ? 'signal_event_injection_and_ipc_web_drain' : 'native_os_signal');
      expect(row.forwardingFaultInjected).toBe(row.scenario === 'failed-forward');
    }
  }, 25_000);

  it('preserves the original fixture failure and removes its directory when child cleanup kill throws', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/railway-launcher-process.mjs', import.meta.url));
    const preloader = `
      import childProcess from 'node:child_process';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const nativeSpawn = childProcess.spawn;
      const nativeMkdtemp = fs.mkdtempSync;
      const nativeKill = process.kill;
      fs.mkdtempSync = (...args) => {
        const directory = nativeMkdtemp(...args);
        process.stdout.write(JSON.stringify({ fixtureDirectory: directory }) + '\\n');
        return directory;
      };
      childProcess.spawn = (...args) => {
        const launcher = nativeSpawn(...args);
        process.stdout.write(JSON.stringify({ fixturePid: launcher.pid }) + '\\n');
        launcher.on('message', message => {
          if (message.kind === 'fixture-spawn') process.stdout.write(JSON.stringify({ fixturePid: message.pid }) + '\\n');
        });
        const nativeSend = launcher.send.bind(launcher);
        const nativeChildKill = launcher.kill.bind(launcher);
        launcher.send = (message, ...rest) => {
          if (message?.kind === 'signal-event') throw new Error('synthetic-launcher-primary-failure');
          return nativeSend(message, ...rest);
        };
        launcher.kill = signal => {
          if (signal === 'SIGTERM' || signal === 'SIGINT') throw new Error('synthetic-launcher-primary-failure');
          return nativeChildKill(signal);
        };
        return launcher;
      };
      process.kill = (pid, signal) => {
        try { nativeKill(pid, signal); } catch { /* target may already have exited */ }
        throw Object.assign(new Error('synthetic-cleanup-EPERM'), { code: 'EPERM' });
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript;base64,${Buffer.from(preloader).toString('base64')}`, fixturePath, 'run'
    ], { env: {}, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    const observations = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    const { fixtureDirectory } = observations.find(row => row.fixtureDirectory);
    try {
      for (const { fixturePid } of observations.filter(row => row.fixturePid)) {
        let alive = true;
        const deadline = Date.now() + 2_000;
        while (alive && Date.now() < deadline) {
          try { process.kill(fixturePid, 0); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            alive = false;
          }
          if (alive) await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
        }
        expect(alive).toBe(false);
      }
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('synthetic-launcher-primary-failure');
      expect(result.stderr).toContain('cleanup.kill.failed');
      expect(result.stderr).not.toContain('synthetic-cleanup-EPERM');
      expect(existsSync(fixtureDirectory)).toBe(false);
    } finally {
      // Remove the test-owned directory even when the red regression exposes a leak.
      expect(dirname(resolve(fixtureDirectory))).toBe(resolve(tmpdir()));
      expect(basename(fixtureDirectory)).toMatch(/^arcanos-launcher-native-/u);
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
