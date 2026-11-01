import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
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
});
