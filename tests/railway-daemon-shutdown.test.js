import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
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
});
