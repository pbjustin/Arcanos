import { EventEmitter } from 'node:events';
import { describe, expect, it, jest } from '@jest/globals';
import {
  PROTECTED_DIGEST_GATE_ARGUMENTS,
  runRailwayServiceWithIntegrity,
  waitForStartupChild
} from '../scripts/start-railway-service-with-integrity.mjs';

function createChild(exitCode) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn();
  queueMicrotask(() => child.emit('exit', exitCode, null));
  return child;
}

describe('Railway protected-digest startup gate', () => {
  it('starts the canonical launcher only after the digest gate passes', async () => {
    const spawnChild = jest.fn()
      .mockImplementationOnce(() => createChild(0))
      .mockImplementationOnce(() => createChild(0));

    await expect(runRailwayServiceWithIntegrity({
      argv: ['--example'],
      spawnChild
    })).resolves.toBe(0);

    expect(spawnChild).toHaveBeenNthCalledWith(
      1,
      [...PROTECTED_DIGEST_GATE_ARGUMENTS]
    );
    expect(spawnChild).toHaveBeenNthCalledWith(2, [
      'scripts/start-railway-service.mjs',
      '--example'
    ]);
  });

  it('fails closed without starting the launcher when comparison fails', async () => {
    const spawnChild = jest.fn().mockImplementationOnce(() => createChild(1));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runRailwayServiceWithIntegrity({ spawnChild })).resolves.toBe(1);

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[railway-integrity-gate] protected digest comparison failed'
    );
    errorSpy.mockRestore();
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'does not cross the gate-to-launcher boundary after %s',
    async signal => {
      const signalTarget = new EventEmitter();
      const gateChild = new EventEmitter();
      gateChild.exitCode = null;
      gateChild.signalCode = null;
      gateChild.kill = jest.fn();
      const spawnChild = jest.fn().mockReturnValueOnce(gateChild);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = runRailwayServiceWithIntegrity({
        signalTarget,
        spawnChild
      });
      signalTarget.emit(signal);
      gateChild.emit('exit', null, signal);

      await expect(result).resolves.toBe(1);
      expect(gateChild.kill).toHaveBeenCalledWith(signal);
      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[railway-integrity-gate] startup interrupted'
      );
      expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
      expect(signalTarget.listenerCount('SIGINT')).toBe(0);
      errorSpy.mockRestore();
    }
  );

  it('resolves children that exited before listener installation', async () => {
    const child = new EventEmitter();
    child.exitCode = 17;
    child.signalCode = null;

    await expect(waitForStartupChild(child)).resolves.toBe(17);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });
});
