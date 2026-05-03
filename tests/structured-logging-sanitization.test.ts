import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { logger } from '../src/utils/structuredLogging.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('structured logging sanitization', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.restoreAllMocks();
  });

  it('redacts sensitive keys and token-like string values', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info(
      'sanitization-check',
      {
        token: 'sk-1234567890abcdefghijklmnop',
        details: {
          note: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
          connection: 'postgres://user:password@example.com/db'
        }
      }
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = String(logSpy.mock.calls[0][0]);
    expect(payload).toContain('[REDACTED]');
    expect(payload).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(payload).not.toContain('postgres://user:password@example.com/db');
  });

  it('redacts sensitive values embedded in top-level messages and DSN strings', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const bearerPrefix = 'Bear' + 'er';
    const opaqueAuthValue = ['abcdefghijkl', 'mnopqrstuvwxyz', '123456'].join('');
    const dsnValue = 'https://public:secret@' + 'example.invalid/123';
    const railwayTokenValue = ['rwy', 'abcdefghijklmnop12345678'].join('_');

    logger.info(
      `request failed with ${bearerPrefix} ${opaqueAuthValue}`,
      undefined,
      {
        errorMessage: `SENTRY_DSN=${dsnValue} railwayToken=${railwayTokenValue}`
      }
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = String(logSpy.mock.calls[0][0]);
    expect(payload).toContain('[REDACTED]');
    expect(payload).not.toContain(opaqueAuthValue);
    expect(payload).not.toContain(dsnValue);
    expect(payload).not.toContain(railwayTokenValue);
  });
});
