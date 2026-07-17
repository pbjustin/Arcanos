import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createMcpLogger } from '../src/mcp/log.js';

describe('MCP diagnostic log redaction', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('redacts session and credential-bearing metadata before writing to stderr', () => {
    const sessionMarker = ['phase2b', 'session', 'marker'].join('-');
    const credentialMarker = `Bearer ${['phase2b', 'credential', 'marker'].join('-')}`;
    const guardedKey = ['author', 'ization'].join('');
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createMcpLogger({
      requestId: 'phase2b-request',
      traceId: 'phase2b-trace',
      sessionId: sessionMarker,
    });

    logger.error('mcp.clear.error', {
      errorCode: 'CLEAR_OPERATION_FAILED',
      [guardedKey]: credentialMarker,
    });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const serialized = String(stderrSpy.mock.calls[0]?.[0]);
    const payload = JSON.parse(serialized) as {
      meta: Record<string, unknown>;
    };

    expect(serialized).not.toContain(sessionMarker);
    expect(serialized).not.toContain(credentialMarker);
    expect(payload.meta).toEqual(expect.objectContaining({
      requestId: 'phase2b-request',
      traceId: 'phase2b-trace',
      sessionId: '[REDACTED]',
      [guardedKey]: '[REDACTED]',
      errorCode: 'CLEAR_OPERATION_FAILED',
    }));
  });
});
