import { describe, expect, it } from '@jest/globals';

import { normalizeOpenAIError } from '../src/services/openaiClient.js';

describe('openai client error normalization', () => {
  it('redacts sensitive material from normalized error messages', () => {
    const bearerPrefix = 'Bear' + 'er';
    const opaqueAuthValue = ['abcdefghijkl', 'mnopqrstuvwxyz', '123456'].join('');
    const dsnValue = 'https://public:secret@' + 'example.invalid/123';
    const error = Object.assign(
      new Error(`Authorization: ${bearerPrefix} ${opaqueAuthValue} failed for SENTRY_DSN=${dsnValue}`),
      {
        status: 429,
        code: 'rate_limit_exceeded'
      }
    );

    const normalized = normalizeOpenAIError(error);

    expect(normalized).toEqual(expect.objectContaining({
      status: 429,
      code: 'rate_limit_exceeded',
      retryable: true
    }));
    expect(normalized.message).toBe('[REDACTED]');
    expect(normalized.message).not.toContain(opaqueAuthValue);
    expect(normalized.message).not.toContain(dsnValue);
  });
});
