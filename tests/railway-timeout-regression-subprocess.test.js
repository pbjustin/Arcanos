import { describe, expect, it, jest } from '@jest/globals';
import {
  RAILWAY_LOG_QUERY_MAX_BUFFER_BYTES,
  RAILWAY_LOG_QUERY_TIMEOUT_MS,
  buildRailwayExecOptions,
  queryRailwayLogs,
} from '../scripts/check-railway-timeout-regressions.js';

const config = {
  since: '15m',
  lines: 500,
  service: 'service-id',
  environment: 'production',
  timeoutLatencyMs: 90_000,
  failOnBudgetAbort: true,
};

describe('Railway timeout-regression log subprocess', () => {
  it('builds one fail-closed timeout and output policy', () => {
    expect(RAILWAY_LOG_QUERY_TIMEOUT_MS).toBe(30_000);
    expect(RAILWAY_LOG_QUERY_MAX_BUFFER_BYTES).toBe(4 * 1024 * 1024);
    expect(buildRailwayExecOptions()).toEqual({
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: RAILWAY_LOG_QUERY_MAX_BUFFER_BYTES,
      timeout: RAILWAY_LOG_QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('applies the policy to the Linux Railway invocation', () => {
    const execFileImplementation = jest.fn(() => '{"message":"ok"}\n');

    expect(
      queryRailwayLogs(config, {
        execFileImplementation,
        platform: 'linux',
      }),
    ).toBe('{"message":"ok"}\n');
    expect(execFileImplementation).toHaveBeenCalledWith(
      'railway',
      [
        'service',
        'logs',
        '--latest',
        '--since',
        '15m',
        '--lines',
        '500',
        '--json',
        '--service',
        'service-id',
        '--environment',
        'production',
      ],
      buildRailwayExecOptions(),
    );
  });

  it('applies the same limits to every Windows fallback', () => {
    const missingExecutable = Object.assign(new Error('missing'), {
      code: 'ENOENT',
    });
    const execFileImplementation = jest
      .fn()
      .mockImplementationOnce(() => {
        throw missingExecutable;
      })
      .mockImplementationOnce(() => {
        throw missingExecutable;
      })
      .mockReturnValueOnce('[]');

    expect(
      queryRailwayLogs(config, {
        execFileImplementation,
        existsImplementation: () => true,
        platform: 'win32',
        appData: 'C:\\bounded-app-data',
      }),
    ).toBe('[]');

    expect(execFileImplementation).toHaveBeenCalledTimes(3);
    for (const call of execFileImplementation.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          maxBuffer: RAILWAY_LOG_QUERY_MAX_BUFFER_BYTES,
          timeout: RAILWAY_LOG_QUERY_TIMEOUT_MS,
        }),
      );
      expect(call[2].shell).not.toBe(true);
    }
    expect(execFileImplementation.mock.calls[2][0]).toBe('powershell.exe');
    expect(execFileImplementation.mock.calls[2][1]).toEqual(
      expect.arrayContaining([
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'C:\\bounded-app-data\\npm\\railway.ps1',
      ]),
    );
  });

  it('propagates timeout and output-overflow failures', () => {
    for (const code of [
      'ETIMEDOUT',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    ]) {
      const failure = Object.assign(new Error(code), { code });
      expect(() =>
        queryRailwayLogs(config, {
          execFileImplementation: () => {
            throw failure;
          },
          platform: 'linux',
        }),
      ).toThrow(failure);
    }
  });
});
